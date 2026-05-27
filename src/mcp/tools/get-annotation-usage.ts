import { Neo4jClient } from '../../graph/neo4j-client.js';

export interface GetAnnotationUsageParams {
  category?: string;
  framework?: string;
  include_deprecated?: boolean;
  group_by?: 'annotation' | 'category' | 'framework';
}

export async function getAnnotationUsage(
  neo4jClient: Neo4jClient,
  params: GetAnnotationUsageParams = {}
) {
  const { category, framework, include_deprecated = true, group_by = 'annotation' } = params;
  
  // Use ANNOTATED_WITH edges and annotation node attributes (framework, category stored in attributes_json)
  let query = `
    MATCH (n:CodeNode)-[:ANNOTATED_WITH]->(a:CodeNode {type: 'annotation'})
    WHERE a.name IS NOT NULL
  `;
  
  const queryParams: any = {};
  
  if (category) {
    query += ` AND a.attributes_json CONTAINS $category`;
    queryParams.category = category;
  }
  
  if (framework) {
    query += ` AND a.attributes_json CONTAINS $framework`;
    queryParams.framework = framework;
  }
  
  if (!include_deprecated) {
    query += ` AND a.name <> '@Deprecated' AND a.name <> 'deprecated'`;
  }

  // We need to extract framework/category from attributes_json at runtime
  query += `
    WITH n, a,
         apoc.convert.fromJsonMap(a.attributes_json) AS attrs
  `;

  // Add post-parse filters for exact category/framework match
  if (category) {
    query += ` WHERE attrs.category = $category`;
  }
  if (framework) {
    query += ` ${category ? 'AND' : 'WHERE'} attrs.framework = $framework`;
  }
  
  switch (group_by) {
    case 'category':
      query += `
        WITH attrs.category as grouping_key,
             a.name as annotation_name,
             attrs.framework as framework,
             count(DISTINCT n) as usage_count,
             collect(DISTINCT n.type) as node_types,
             collect(DISTINCT n.qualified_name) as sample_nodes
        WHERE grouping_key IS NOT NULL
        RETURN grouping_key as category,
               collect({
                 name: annotation_name,
                 framework: framework,
                 usage_count: usage_count,
                 node_types: node_types,
                 sample_nodes: sample_nodes[0..3]
               }) as annotations,
               sum(usage_count) as total_usage
        ORDER BY total_usage DESC
      `;
      break;
      
    case 'framework':
      query += `
        WITH attrs.framework as grouping_key,
             a.name as annotation_name,
             attrs.category as category,
             count(DISTINCT n) as usage_count,
             collect(DISTINCT n.type) as node_types,
             collect(DISTINCT n.qualified_name) as sample_nodes
        WHERE grouping_key IS NOT NULL
        RETURN grouping_key as framework,
               collect({
                 name: annotation_name,
                 category: category,
                 usage_count: usage_count,
                 node_types: node_types,
                 sample_nodes: sample_nodes[0..3]
               }) as annotations,
               sum(usage_count) as total_usage
        ORDER BY total_usage DESC
      `;
      break;
      
    default: // 'annotation'
      query += `
        WITH a.name as grouping_key,
             attrs.framework as framework,
             attrs.category as category,
             a.type as annotation_type,
             count(DISTINCT n) as usage_count,
             collect(DISTINCT n.type) as node_types,
             collect(DISTINCT n.qualified_name) as sample_nodes
        RETURN grouping_key as annotation_name,
               framework,
               category,
               annotation_type,
               usage_count,
               node_types,
               sample_nodes[0..5] as sample_nodes
        ORDER BY usage_count DESC
      `;
  }
  
  const result = await neo4jClient.runQuery(query, queryParams);
  
  if (group_by === 'annotation') {
    return {
      annotations: result.records?.map(record => ({
        annotation_name: record.get('annotation_name'),
        framework: record.get('framework'),
        category: record.get('category'),
        annotation_type: record.get('annotation_type'),
        usage_count: record.get('usage_count'),
        node_types: record.get('node_types'),
        sample_nodes: record.get('sample_nodes')
      })) || [],
      total_annotations: result.records?.length || 0
    };
  } else {
    const groupKey = group_by === 'category' ? 'category' : 'framework';
    return {
      groups: result.records?.map(record => ({
        [groupKey]: record.get(groupKey),
        annotations: record.get('annotations'),
        total_usage: record.get('total_usage')
      })) || [],
      total_groups: result.records?.length || 0
    };
  }
}

export const getAnnotationUsageTool = {
  name: 'get_annotation_usage',
  description: 'Get comprehensive statistics on annotation/decorator usage patterns across the codebase',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description: 'Optional: Filter by annotation category (e.g., web, testing, injection, persistence)'
      },
      framework: {
        type: 'string',
        description: 'Optional: Filter by framework (e.g., Spring, Angular, Flask, Django)'
      },
      include_deprecated: {
        type: 'boolean',
        description: 'Whether to include deprecated annotations in results',
        default: true
      },
      group_by: {
        type: 'string',
        enum: ['annotation', 'category', 'framework'],
        description: 'How to group the results',
        default: 'annotation'
      }
    },
    required: []
  }
};