import { Neo4jClient } from '../../graph/neo4j-client.js';

export interface FindNodesByAnnotationParams {
  project?: string;
  annotation_name: string;
  framework?: string;
  category?: string;
  node_type?: 'class' | 'interface' | 'enum' | 'exception' | 'function' | 'method' | 'field' | 'package' | 'module';
}

export async function findNodesByAnnotation(
  neo4jClient: Neo4jClient,
  params: FindNodesByAnnotationParams
) {
  const { annotation_name, framework, category, node_type } = params;
  const projectId = params.project;

  // Normalize: ensure we search both with and without '@' prefix
  const withAt = annotation_name.startsWith('@') ? annotation_name : '@' + annotation_name;
  const withoutAt = annotation_name.startsWith('@') ? annotation_name.substring(1) : annotation_name;

  // Strategy 1: Use ANNOTATED_WITH edges (preferred graph model)
  let query = `
    MATCH (n:CodeNode)-[:ANNOTATED_WITH]->(a:CodeNode {type: 'annotation'})
    WHERE (a.name = $withAt OR a.name = $withoutAt)
  `;

  const queryParams: any = { withAt, withoutAt };

  if (projectId) {
    query += ` AND n.project_id = $project_id`;
    queryParams.project_id = projectId;
  }

  if (framework) {
    query += ` AND a.attributes_json CONTAINS $framework`;
    queryParams.framework = framework;
  }

  if (category) {
    query += ` AND a.attributes_json CONTAINS $category`;
    queryParams.category = category;
  }

  if (node_type) {
    query += ` AND n.type = $node_type`;
    queryParams.node_type = node_type;
  }

  query += `
    RETURN n, a as matched_annotation
    ORDER BY n.qualified_name
    LIMIT 200
  `;

  let result = await neo4jClient.runQuery(query, queryParams);

  // Strategy 2: Fallback — search annotations stored in attributes_json
  if (!result.records || result.records.length === 0) {
    let fallbackQuery = `
      MATCH (n:CodeNode)
      WHERE n.attributes_json CONTAINS $withoutAt
    `;
    const fallbackParams: any = { withoutAt };

    if (projectId) {
      fallbackQuery += ` AND n.project_id = $project_id`;
      fallbackParams.project_id = projectId;
    }

    if (node_type) {
      fallbackQuery += ` AND n.type = $node_type`;
      fallbackParams.node_type = node_type;
    }

    fallbackQuery += `
      RETURN n, null as matched_annotation
      ORDER BY n.qualified_name
      LIMIT 200
    `;

    result = await neo4jClient.runQuery(fallbackQuery, fallbackParams);
  }

  return {
    nodes: result.records?.map(record => {
      const nodeProps = record.get('n').properties;
      const annotation = record.get('matched_annotation');
      return {
        ...nodeProps,
        matched_annotation: annotation?.properties ?? annotation ?? null
      };
    }) || [],
    total_count: result.records?.length || 0
  };
}

export const findNodesByAnnotationTool = {
  name: 'find_nodes_by_annotation',
  description: 'Find code nodes (classes, methods, etc.) that have specific annotations/decorators',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'Project name or identifier to scope the operation to'
      },
      annotation_name: {
        type: 'string',
        description: 'The annotation/decorator name to search for (e.g., @Component, @Override, staticmethod)'
      },
      framework: {
        type: 'string',
        description: 'Optional: Filter by framework (e.g., Spring, Angular, Flask, Django)'
      },
      category: {
        type: 'string',
        description: 'Optional: Filter by annotation category (e.g., web, testing, injection, persistence)'
      },
      node_type: {
        type: 'string',
        enum: ['class', 'interface', 'enum', 'exception', 'function', 'method', 'field', 'package', 'module'],
        description: 'Optional: Filter by node type'
      }
    },
    required: ['annotation_name']
  }
};