import { Neo4jClient } from '../../graph/neo4j-client.js';

export interface FindNodesByAnnotationParams {
  project?: string;
  annotation_name: string;
  framework?: string;
  category?: string;
  node_type?: 'class' | 'interface' | 'enum' | 'exception' | 'function' | 'method' | 'field' | 'package' | 'module';
}

/**
 * Structure-only projection of a CodeNode's stored properties. Explicitly enumerates
 * the fields that may leave the server so that internal ML artifacts
 * (`semantic_embedding`, `embedding_*`) can NEVER leak — regardless of whether the
 * optional `node_type` filter is set. This was the source of a confirmed embedding
 * leak (~2.2 MB responses) in the previously unfiltered `...nodeProps` spread.
 */
function projectNodeProps(props: any): Record<string, any> {
  if (!props || typeof props !== 'object') return {};
  const toNumber = (v: any) =>
    v && typeof v.toNumber === 'function' ? v.toNumber() : v;
  return {
    id: props.id,
    project_id: props.project_id,
    type: props.type,
    name: props.name,
    qualified_name: props.qualified_name,
    description: props.description,
    source_file: props.source_file,
    start_line: toNumber(props.start_line),
    end_line: toNumber(props.end_line),
    modifiers: props.modifiers || [],
    is_abstract: props.is_abstract ?? false,
    attributes_json: props.attributes_json
  };
}

/**
 * Cypher map projection for a CodeNode variable. By returning an explicit map instead
 * of the whole node, Neo4j never loads or transfers the large `semantic_embedding`
 * column (3072 floats/node) — reducing DB→server transfer, not just the MCP payload.
 */
function nodeProjectionCypher(alias: string): string {
  return `{
    id: ${alias}.id,
    project_id: ${alias}.project_id,
    type: ${alias}.type,
    name: ${alias}.name,
    qualified_name: ${alias}.qualified_name,
    description: ${alias}.description,
    source_file: ${alias}.source_file,
    start_line: ${alias}.start_line,
    end_line: ${alias}.end_line,
    modifiers: ${alias}.modifiers,
    is_abstract: ${alias}.is_abstract,
    attributes_json: ${alias}.attributes_json
  }`;
}

/** Cypher map projection for a matched annotation node (structure only). */
function annotationProjectionCypher(alias: string): string {
  return `{
    id: ${alias}.id,
    name: ${alias}.name,
    type: ${alias}.type,
    qualified_name: ${alias}.qualified_name,
    attributes_json: ${alias}.attributes_json
  }`;
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
    RETURN ${nodeProjectionCypher('n')} AS n, ${annotationProjectionCypher('a')} AS matched_annotation
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
      RETURN ${nodeProjectionCypher('n')} AS n, null as matched_annotation
      ORDER BY n.qualified_name
      LIMIT 200
    `;

    result = await neo4jClient.runQuery(fallbackQuery, fallbackParams);
  }

  return {
    nodes: result.records?.map(record => {
      // Accept both an explicit Cypher map (real query) and a Neo4j Node with
      // `.properties` (used by unit-test mocks). Either way, only structural fields
      // are exposed — embeddings are already excluded by the Cypher projection.
      const rawNode = record.get('n');
      const nodeProps = projectNodeProps(rawNode?.properties ?? rawNode);
      const annotation = record.get('matched_annotation');
      const annotationProps = annotation?.properties
        ? projectNodeProps(annotation.properties)
        : annotation ?? null;
      return {
        ...nodeProps,
        matched_annotation: annotationProps
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