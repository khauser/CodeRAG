import { Neo4jClient } from '../../graph/neo4j-client.js';

export interface FindDeprecatedCodeParams {
  include_dependencies?: boolean;
  node_type?: 'class' | 'interface' | 'enum' | 'exception' | 'function' | 'method' | 'field' | 'package' | 'module';
}

export async function findDeprecatedCode(
  neo4jClient: Neo4jClient,
  params: FindDeprecatedCodeParams = {}
) {
  const { include_dependencies = false, node_type } = params;
  
  const queryParams: any = {};

  // Strategy 1: Use ANNOTATED_WITH edges to annotation nodes (preferred graph model)
  let query = `
    MATCH (n:CodeNode)-[:ANNOTATED_WITH]->(a:CodeNode {type: 'annotation'})
    WHERE a.name IN ['@Deprecated', 'Deprecated', 'deprecated', '@deprecated']
  `;
  
  if (node_type) {
    query += ` AND n.type = $node_type`;
    queryParams.node_type = node_type;
  }
  
  if (include_dependencies) {
    query += `
      OPTIONAL MATCH (n)<-[r:CALLS|REFERENCES|EXTENDS|IMPLEMENTS]-(dependentNode)
      WITH n, a,
           collect(DISTINCT {
             node: dependentNode.qualified_name,
             relationship: type(r),
             type: dependentNode.type
           }) as dependencies
      RETURN n,
             a as deprecation_annotation,
             dependencies,
             size(dependencies) as dependency_count
      ORDER BY dependency_count DESC, n.qualified_name
    `;
  } else {
    query += `
      RETURN n,
             a as deprecation_annotation
      ORDER BY n.qualified_name
    `;
  }
  
  let result = await neo4jClient.runQuery(query, queryParams);

  // Strategy 2: Fallback — search in attributes_json for deprecated markers
  if (!result.records || result.records.length === 0) {
    let fallbackQuery = `
      MATCH (n:CodeNode)
      WHERE (n.attributes_json CONTAINS 'Deprecated' OR n.attributes_json CONTAINS 'deprecated')
    `;
    const fallbackParams: any = {};

    if (node_type) {
      fallbackQuery += ` AND n.type = $node_type`;
      fallbackParams.node_type = node_type;
    }

    if (include_dependencies) {
      fallbackQuery += `
        OPTIONAL MATCH (n)<-[r:CALLS|REFERENCES|EXTENDS|IMPLEMENTS]-(dependentNode)
        WITH n,
             collect(DISTINCT {
               node: dependentNode.qualified_name,
               relationship: type(r),
               type: dependentNode.type
             }) as dependencies
        RETURN n,
               null as deprecation_annotation,
               dependencies,
               size(dependencies) as dependency_count
        ORDER BY dependency_count DESC, n.qualified_name
      `;
    } else {
      fallbackQuery += `
        RETURN n,
               null as deprecation_annotation
        ORDER BY n.qualified_name
      `;
    }

    result = await neo4jClient.runQuery(fallbackQuery, fallbackParams);
  }
  
  return {
    deprecated_nodes: result.records?.map(record => {
      const node = record.get('n').properties;
      const deprecationAnnotation = record.get('deprecation_annotation');
      const response: any = {
        ...node,
        deprecation_info: deprecationAnnotation?.properties ?? deprecationAnnotation ?? null
      };
      
      if (include_dependencies) {
        response.dependencies = record.get('dependencies') || [];
        response.dependency_count = record.get('dependency_count') || 0;
      }
      
      return response;
    }) || [],
    total_count: result.records?.length || 0
  };
}

export async function findUsageOfDeprecatedCode(
  neo4jClient: Neo4jClient,
  params: { include_usage_details?: boolean } = {}
) {
  const { include_usage_details = false } = params;
  
  // Strategy 1: Use ANNOTATED_WITH edges (preferred graph model)
  let query = `
    MATCH (deprecated:CodeNode)-[:ANNOTATED_WITH]->(a:CodeNode {type: 'annotation'})
    WHERE a.name IN ['@Deprecated', 'Deprecated', 'deprecated', '@deprecated']
    MATCH (deprecated)<-[r:CALLS|REFERENCES|EXTENDS|IMPLEMENTS]-(using)
    
    ${include_usage_details ? `
      RETURN deprecated.qualified_name as deprecated_node,
             deprecated.type as deprecated_type,
             a as deprecation_info,
             collect({
               using_node: using.qualified_name,
               using_type: using.type,
               relationship: type(r),
               source_file: using.source_file
             }) as usage_details,
             count(using) as usage_count
      ORDER BY usage_count DESC
    ` : `
      RETURN deprecated.qualified_name as deprecated_node,
             deprecated.type as deprecated_type,
             count(using) as usage_count
      ORDER BY usage_count DESC
    `}
  `;
  
  let result = await neo4jClient.runQuery(query);

  // Strategy 2: Fallback — search in attributes_json
  if (!result.records || result.records.length === 0) {
    let fallbackQuery = `
      MATCH (deprecated:CodeNode)
      WHERE (deprecated.attributes_json CONTAINS 'Deprecated' OR deprecated.attributes_json CONTAINS 'deprecated')
      MATCH (deprecated)<-[r:CALLS|REFERENCES|EXTENDS|IMPLEMENTS]-(using)
      
      ${include_usage_details ? `
        RETURN deprecated.qualified_name as deprecated_node,
               deprecated.type as deprecated_type,
               null as deprecation_info,
               collect({
                 using_node: using.qualified_name,
                 using_type: using.type,
                 relationship: type(r),
                 source_file: using.source_file
               }) as usage_details,
               count(using) as usage_count
        ORDER BY usage_count DESC
      ` : `
        RETURN deprecated.qualified_name as deprecated_node,
               deprecated.type as deprecated_type,
               count(using) as usage_count
        ORDER BY usage_count DESC
      `}
    `;

    result = await neo4jClient.runQuery(fallbackQuery);
  }
  
  return {
    deprecated_usage: result.records?.map(record => {
      const response: any = {
        deprecated_node: record.get('deprecated_node'),
        deprecated_type: record.get('deprecated_type'),
        usage_count: record.get('usage_count')
      };
      
      if (include_usage_details) {
        const depInfo = record.get('deprecation_info');
        response.deprecation_info = depInfo?.properties ?? depInfo ?? null;
        response.usage_details = record.get('usage_details');
      }
      
      return response;
    }) || [],
    total_deprecated_items: result.records?.length || 0
  };
}

export const findDeprecatedCodeTool = {
  name: 'find_deprecated_code',
  description: 'Find all code elements marked as deprecated and optionally their dependencies',
  inputSchema: {
    type: 'object',
    properties: {
      include_dependencies: {
        type: 'boolean',
        description: 'Whether to include information about what depends on deprecated code',
        default: false
      },
      node_type: {
        type: 'string',
        enum: ['class', 'interface', 'enum', 'exception', 'function', 'method', 'field', 'package', 'module'],
        description: 'Optional: Filter by node type'
      }
    },
    required: []
  }
};

export const findUsageOfDeprecatedCodeTool = {
  name: 'find_usage_of_deprecated_code',
  description: 'Find code that uses deprecated elements and assess migration impact',
  inputSchema: {
    type: 'object',
    properties: {
      include_usage_details: {
        type: 'boolean',
        description: 'Whether to include detailed information about each usage',
        default: false
      }
    },
    required: []
  }
};