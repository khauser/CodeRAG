import { Neo4jClient } from '../../graph/neo4j-client.js';

export interface AnalyzeTestingAnnotationsParams {
  project: string;
  framework?: string;
  include_coverage_analysis?: boolean;
}

export async function analyzeTestingAnnotations(
  neo4jClient: Neo4jClient,
  params: AnalyzeTestingAnnotationsParams
) {
  const { project, framework, include_coverage_analysis = false } = params;
  
  // Use ANNOTATED_WITH edges and annotation node attributes (category stored in attributes_json)
  let query = `
    MATCH (n:CodeNode)-[:ANNOTATED_WITH]->(a:CodeNode {type: 'annotation'})
    WHERE n.project_id = $project
    AND a.attributes_json IS NOT NULL
    WITH n, a, apoc.convert.fromJsonMap(a.attributes_json) AS attrs
    WHERE attrs.category = 'testing'
  `;
  
  const queryParams: any = { project };
  
  if (framework) {
    query += ` AND attrs.framework = $framework`;
    queryParams.framework = framework;
  }
  
  query += `
    WITH n,
         collect({name: a.name, framework: attrs.framework, category: attrs.category}) as test_annotations
    
    RETURN n.qualified_name as test_entity,
           n.type as entity_type,
           n.source_file as source_file,
           test_annotations,
           size(test_annotations) as annotation_count
    ORDER BY annotation_count DESC, test_entity
  `;
  
  const result = await neo4jClient.runQuery(query, queryParams);
  
  const testEntities = result.records?.map(record => {
    const annotationCount = record.get('annotation_count');
    return {
      test_entity: record.get('test_entity'),
      entity_type: record.get('entity_type'),
      source_file: record.get('source_file'),
      test_annotations: record.get('test_annotations'),
      annotation_count: typeof annotationCount === 'object' && annotationCount.toNumber ? annotationCount.toNumber() : Number(annotationCount)
    };
  }) || [];
  
  // Get testing framework statistics
  const frameworkStatsQuery = `
    MATCH (n:CodeNode)-[:ANNOTATED_WITH]->(a:CodeNode {type: 'annotation'})
    WHERE a.attributes_json IS NOT NULL
    WITH n, a, apoc.convert.fromJsonMap(a.attributes_json) AS attrs
    WHERE attrs.category = 'testing' AND attrs.framework IS NOT NULL
    WITH attrs.framework as framework,
         a.name as annotation_name,
         count(DISTINCT n) as usage_count
    RETURN framework,
           collect({name: annotation_name, count: usage_count}) as annotations,
           sum(usage_count) as total_usage
    ORDER BY total_usage DESC
  `;
  
  const frameworkResult = await neo4jClient.runQuery(frameworkStatsQuery);
  const frameworkStats = frameworkResult.records?.map(record => {
    const totalUsage = record.get('total_usage');
    return {
      framework: record.get('framework'),
      annotations: record.get('annotations'),
      total_usage: typeof totalUsage === 'object' && totalUsage.toNumber ? totalUsage.toNumber() : Number(totalUsage)
    };
  }) || [];
  
  let coverageAnalysis = null;
  
  if (include_coverage_analysis) {
    // Analyze test coverage by looking for non-test methods without corresponding test methods
    const coverageQuery = `
      MATCH (method:CodeNode)
      WHERE method.project_id = $project
      AND method.type = 'method'
      AND NOT method.qualified_name CONTAINS 'test'
      AND NOT method.qualified_name CONTAINS 'Test'
      AND NOT EXISTS {
        MATCH (method)-[:ANNOTATED_WITH]->(a:CodeNode {type: 'annotation'})
        WHERE a.attributes_json CONTAINS 'testing'
      }
      
      OPTIONAL MATCH (testMethod:CodeNode)
      WHERE testMethod.project_id = $project
      AND testMethod.type = 'method'
      AND EXISTS {
        MATCH (testMethod)-[:ANNOTATED_WITH]->(ta:CodeNode {type: 'annotation'})
        WHERE ta.attributes_json CONTAINS 'testing'
      }
      AND (testMethod.qualified_name CONTAINS method.name 
           OR testMethod.name CONTAINS method.name)
      
      WITH method, count(testMethod) as test_count
      
      RETURN 
        count(method) as total_methods,
        sum(CASE WHEN test_count > 0 THEN 1 ELSE 0 END) as methods_with_tests,
        sum(CASE WHEN test_count = 0 THEN 1 ELSE 0 END) as methods_without_tests,
        round(100.0 * sum(CASE WHEN test_count > 0 THEN 1 ELSE 0 END) / count(method)) as coverage_percentage
    `;
    
    const coverageResult = await neo4jClient.runQuery(coverageQuery, queryParams);
    const coverageRecord = coverageResult.records?.[0];
    
    if (coverageRecord) {
      const toNum = (val: any) => typeof val === 'object' && val.toNumber ? val.toNumber() : Number(val);
      coverageAnalysis = {
        total_methods: toNum(coverageRecord.get('total_methods')),
        methods_with_tests: toNum(coverageRecord.get('methods_with_tests')),
        methods_without_tests: toNum(coverageRecord.get('methods_without_tests')),
        coverage_percentage: toNum(coverageRecord.get('coverage_percentage'))
      };
    }
  }
  
  return {
    test_entities: testEntities,
    framework_statistics: frameworkStats,
    coverage_analysis: coverageAnalysis,
    summary: {
      total_test_entities: testEntities.length,
      frameworks_used: frameworkStats.length,
      total_testing_annotations: frameworkStats.reduce((sum, fs) => sum + fs.total_usage, 0)
    }
  };
}

export async function findUntestableCode(neo4jClient: Neo4jClient, params: { project: string }) {
  const { project } = params;
  
  const query = `
    MATCH (n:CodeNode)
    WHERE n.project_id = $project
    AND n.type IN ['method', 'function']
    AND NOT EXISTS {
      MATCH (n)-[:ANNOTATED_WITH]->(a:CodeNode {type: 'annotation'})
      WHERE a.attributes_json CONTAINS 'testing'
    }
    
    // Look for methods that are private or have testing-unfriendly patterns
    WITH n,
         CASE 
           WHEN any(modifier IN coalesce(n.modifiers, []) WHERE modifier = 'private') THEN 'private'
           WHEN any(modifier IN coalesce(n.modifiers, []) WHERE modifier = 'static') THEN 'static'
           WHEN n.qualified_name CONTAINS '__' THEN 'private_python'
           ELSE 'public'
         END as testability_concern
    
    WHERE testability_concern <> 'public'
    
    RETURN testability_concern,
           collect({
             qualified_name: n.qualified_name,
             type: n.type,
             source_file: n.source_file
           }) as methods,
           count(n) as count
    ORDER BY count DESC
  `;
  
  const result = await neo4jClient.runQuery(query, { project });
  
  const testabilityIssues = result.records?.map(record => {
    const count = record.get('count');
    return {
      concern: record.get('testability_concern'),
      methods: record.get('methods'),
      count: typeof count === 'object' && count.toNumber ? count.toNumber() : Number(count)
    };
  }) || [];

  return {
    testability_issues: testabilityIssues,
    total_concerning_methods: testabilityIssues.reduce((sum, issue) => sum + issue.count, 0)
  };
}

export const analyzeTestingAnnotationsTool = {
  name: 'analyze_testing_annotations',
  description: 'Analyze testing patterns and coverage based on test annotations/decorators',
  inputSchema: {
    type: 'object',
    properties: {
      framework: {
        type: 'string',
        description: 'Optional: Filter by testing framework (e.g., JUnit, Pytest, Jest)'
      },
      include_coverage_analysis: {
        type: 'boolean',
        description: 'Whether to include test coverage analysis',
        default: false
      }
    },
    required: []
  }
};

export const findUntestableCodeTool = {
  name: 'find_untestable_code',
  description: 'Find code patterns that may be difficult to test (private methods, static methods, etc.)',
  inputSchema: {
    type: 'object',
    properties: {},
    required: []
  }
};