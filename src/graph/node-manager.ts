import { Neo4jClient } from './neo4j-client.js';
import { CodeNode, QueryResult } from '../types.js';

export class NodeManager {
  constructor(private client: Neo4jClient) {}

  async addNode(node: CodeNode): Promise<CodeNode> {
    // Get the proper node label based on type and project
    const nodeLabel = this.getNodeLabel(node.type);
    const projectLabel = this.client.getProjectLabel(node.project_id, node.type);
    
    const query = `
      MERGE (n:CodeNode { project_id: $project_id, id: $id })
      SET n:${nodeLabel}:${projectLabel},
          n.type = $type,
          n.name = $name,
          n.qualified_name = $qualified_name,
          n.description = $description,
          n.source_file = $source_file,
          n.start_line = $start_line,
          n.end_line = $end_line,
          n.modifiers = $modifiers,
          n.is_abstract = $is_abstract,
          n.attributes_json = $attributes_json
      RETURN n
    `;

    const modifiers: string[] = node.modifiers || [];
    const params = {
      id: node.id,
      project_id: node.project_id,
      type: node.type,
      name: node.name,
      qualified_name: node.qualified_name,
      description: node.description || null,
      source_file: node.source_file || null,
      start_line: node.start_line || null,
      end_line: node.end_line || null,
      modifiers: this.ensurePlainObject(modifiers),
      is_abstract: node.is_abstract ?? modifiers.includes('abstract'),
      attributes_json: JSON.stringify(node.attributes || {})
    };

    const result = await this.client.runQuery(query, this.ensurePlainObject(params));

    if (result.records.length === 0) {
      throw new Error('Failed to create node');
    }

    return this.recordToNode(result.records[0].get('n'));
  }

  /**
   * Batch-inserts nodes using UNWIND for high throughput.
   * Nodes are grouped by type (since Cypher requires static labels) and inserted
   * in batches to reduce DB round-trips from N individual CREATEs to ceil(N/batchSize) * numTypes.
   *
   * Returns the number of successfully stored nodes and an array of errors.
   */
  async addNodesBatch(
    nodes: CodeNode[],
    batchSize = 200
  ): Promise<{ stored: number; errors: Array<{ node: CodeNode; error: string }> }> {
    if (nodes.length === 0) return { stored: 0, errors: [] };

    // Group nodes by type (label combination depends on type)
    const byType = new Map<string, CodeNode[]>();
    for (const node of nodes) {
      const t = node.type;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(node);
    }

    let totalStored = 0;
    const errors: Array<{ node: CodeNode; error: string }> = [];

    for (const [type, typeNodes] of byType) {
      const nodeLabel = this.getNodeLabel(type as CodeNode['type']);

      for (let i = 0; i < typeNodes.length; i += batchSize) {
        const batch = typeNodes.slice(i, i + batchSize);
        const projectId = batch[0].project_id;
        const projectLabel = this.client.getProjectLabel(projectId, type as CodeNode['type']);

        const rows = batch.map(n => ({
          id: n.id,
          project_id: n.project_id,
          type: n.type,
          name: n.name,
          qualified_name: n.qualified_name,
          description: n.description || null,
          source_file: n.source_file || null,
          start_line: n.start_line || null,
          end_line: n.end_line || null,
          modifiers: n.modifiers || [],
          is_abstract: n.is_abstract ?? (n.modifiers || []).includes('abstract'),
          attributes_json: JSON.stringify(n.attributes || {})
        }));

        // MERGE (not CREATE) on the constraint-backed key (:CodeNode {project_id, id}).
        // This makes the batch idempotent: duplicate IDs across batches (e.g. shared
        // packages/classes spanning multiple file batches) update the existing node
        // instead of aborting the whole transaction with a ConstraintValidation error.
        // Aborting previously triggered a fallback to 200 individual inserts, which is
        // catastrophically slow over a high-latency/VPN connection to the remote DB.
        // The MERGE key uses the unique constraint on :CodeNode(project_id, id) so it
        // stays index-backed; the type/project labels are added afterwards via SET.
        const query = `
          UNWIND $rows AS row
          MERGE (n:CodeNode { project_id: row.project_id, id: row.id })
          SET n:${nodeLabel}:${projectLabel},
              n.type = row.type,
              n.name = row.name,
              n.qualified_name = row.qualified_name,
              n.description = row.description,
              n.source_file = row.source_file,
              n.start_line = row.start_line,
              n.end_line = row.end_line,
              n.modifiers = row.modifiers,
              n.is_abstract = row.is_abstract,
              n.attributes_json = row.attributes_json
          RETURN row.id AS id
        `;

        try {
          const result = await this.client.runQuery(
            query,
            this.ensurePlainObject({ rows })
          );
          totalStored += result.records.length;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // With MERGE, constraint violations no longer occur. This fallback now only
          // guards against transient/other errors by retrying nodes individually.
          if (message.includes('already exists') || message.includes('ConstraintValidation')) {
            for (const node of batch) {
              try {
                await this.addNode(node);
                totalStored++;
              } catch (innerError) {
                const innerMsg = innerError instanceof Error ? innerError.message : String(innerError);
                if (!innerMsg.includes('already exists')) {
                  errors.push({ node, error: innerMsg });
                } else {
                  totalStored++; // Already exists counts as stored
                }
              }
            }
          } else {
            for (const node of batch) {
              errors.push({ node, error: message });
            }
          }
        }
      }
    }

    return { stored: totalStored, errors };
  }

  /**
   * Batch-inserts *stub* nodes for external / cross-cartridge reference targets.
   *
   * Unlike {@link addNodesBatch}, this uses `ON CREATE SET` semantics so that a
   * stub NEVER overwrites a node that was already parsed from real source code.
   * Previously, a stub (type='class', source_file='external') stored after a
   * real node had been scanned in an earlier run would clobber the real node's
   * type (e.g. downgrading an `interface`/`enum` to `class`) and mark it
   * `external`. With ON CREATE SET, existing nodes are left untouched and only
   * genuinely new (truly external) targets receive stub properties.
   *
   * Returns the number of nodes processed (created or already existing).
   */
  async addStubNodesBatch(
    nodes: CodeNode[],
    batchSize = 200
  ): Promise<{ stored: number; errors: Array<{ node: CodeNode; error: string }> }> {
    if (nodes.length === 0) return { stored: 0, errors: [] };

    const byType = new Map<string, CodeNode[]>();
    for (const node of nodes) {
      const t = node.type;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(node);
    }

    let totalStored = 0;
    const errors: Array<{ node: CodeNode; error: string }> = [];

    for (const [type, typeNodes] of byType) {
      const nodeLabel = this.getNodeLabel(type as CodeNode['type']);

      for (let i = 0; i < typeNodes.length; i += batchSize) {
        const batch = typeNodes.slice(i, i + batchSize);
        const projectId = batch[0].project_id;
        const projectLabel = this.client.getProjectLabel(projectId, type as CodeNode['type']);

        const rows = batch.map(n => ({
          id: n.id,
          project_id: n.project_id,
          type: n.type,
          name: n.name,
          qualified_name: n.qualified_name,
          source_file: n.source_file || 'external',
          modifiers: n.modifiers || [],
          is_abstract: n.is_abstract ?? false,
          attributes_json: JSON.stringify(n.attributes || {})
        }));

        // ON CREATE SET only: never overwrite a real, already-parsed node.
        const query = `
          UNWIND $rows AS row
          MERGE (n:CodeNode { project_id: row.project_id, id: row.id })
          ON CREATE SET n:${nodeLabel}:${projectLabel},
              n.type = row.type,
              n.name = row.name,
              n.qualified_name = row.qualified_name,
              n.source_file = row.source_file,
              n.modifiers = row.modifiers,
              n.is_abstract = row.is_abstract,
              n.attributes_json = row.attributes_json
          RETURN row.id AS id
        `;

        try {
          const result = await this.client.runQuery(
            query,
            this.ensurePlainObject({ rows })
          );
          totalStored += result.records.length;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const node of batch) {
            errors.push({ node, error: message });
          }
        }
      }
    }

    return { stored: totalStored, errors };
  }

  async updateNode(nodeId: string, projectId: string, updates: Partial<CodeNode>): Promise<CodeNode> {
    const setParts: string[] = [];
    const parameters: Record<string, any> = { id: nodeId };

    Object.entries(updates).forEach(([key, value], index) => {
      if (key !== 'id' && value !== undefined) {
        const paramKey = `update_${index}`;
        setParts.push(`n.${key} = $${paramKey}`);
        parameters[paramKey] = value;
      }
    });

    if (setParts.length === 0) {
      throw new Error('No valid updates provided');
    }

    const query = `
      MATCH (n:CodeNode {id: $id, project_id: $project_id})
      SET ${setParts.join(', ')}
      RETURN n
    `;

    parameters.project_id = projectId;

    const result = await this.client.runQuery(query, parameters);

    if (result.records.length === 0) {
      throw new Error(`Node with id ${nodeId} not found`);
    }

    return this.recordToNode(result.records[0].get('n'));
  }

  async getNode(nodeId: string, projectId: string): Promise<CodeNode | null> {
    const query = 'MATCH (n:CodeNode {id: $id, project_id: $project_id}) RETURN n';
    const result = await this.client.runQuery(query, { id: nodeId, project_id: projectId });

    if (result.records.length === 0) {
      return null;
    }

    return this.recordToNode(result.records[0].get('n'));
  }

  async deleteNode(nodeId: string, projectId: string): Promise<boolean> {
    const query = `
      MATCH (n:CodeNode {id: $id, project_id: $project_id})
      DETACH DELETE n
      RETURN count(n) as deleted
    `;

    const result = await this.client.runQuery(query, { id: nodeId, project_id: projectId });
    return result.records[0].get('deleted').toNumber() > 0;
  }

  async findNodesByType(type: CodeNode['type'], projectId: string): Promise<CodeNode[]> {
    // Normalize type to lowercase for consistent matching
    const normalizedType = type.toLowerCase();
    const query = 'MATCH (n:CodeNode {type: $type, project_id: $project_id}) RETURN n ORDER BY n.name';
    const result = await this.client.runQuery(query, { type: normalizedType, project_id: projectId });

    return result.records.map(record => this.recordToNode(record.get('n')));
  }

  async findNodesByName(name: string, projectId: string): Promise<CodeNode[]> {
    const query = 'MATCH (n:CodeNode {project_id: $project_id}) WHERE n.name CONTAINS $name RETURN n ORDER BY n.name';
    const result = await this.client.runQuery(query, { name, project_id: projectId });

    return result.records.map(record => this.recordToNode(record.get('n')));
  }

  async findNodesByQualifiedName(qualifiedName: string, projectId: string): Promise<CodeNode[]> {
    const query = 'MATCH (n:CodeNode {qualified_name: $qualified_name, project_id: $project_id}) RETURN n';
    const result = await this.client.runQuery(query, { qualified_name: qualifiedName, project_id: projectId });

    return result.records.map(record => this.recordToNode(record.get('n')));
  }

  async searchNodes(searchTerm: string, projectId: string): Promise<CodeNode[]> {
    // Fast path: use the full-text index `codeNodeSearch` (created in
    // Neo4jClient.initializeDatabase). Plain CONTAINS matching is not backed by the
    // range indexes, so on large projects (e.g. icm-as) it scans every CodeNode —
    // including large description fields — and exceeds the MCP request timeout.
    // The full-text index turns this into an indexed lookup. Wildcards (`*term*`) keep
    // the previous substring semantics so partial names still match.
    const lucene = NodeManager.buildFulltextQuery(searchTerm);
    if (lucene) {
      const fulltextQuery = `
        CALL db.index.fulltext.queryNodes('codeNodeSearch', $lucene) YIELD node, score
        WHERE node.project_id = $project_id
        RETURN node AS n
        ORDER BY
          CASE WHEN node.name = $searchTerm THEN 0
               WHEN node.name STARTS WITH $searchTerm THEN 1
               WHEN node.name CONTAINS $searchTerm THEN 2
               ELSE 3 END,
          score DESC,
          node.name
        LIMIT 100
      `;
      try {
        const result = await this.client.runQuery(fulltextQuery, {
          lucene,
          searchTerm,
          project_id: projectId
        });
        return result.records.map(record => this.recordToNode(record.get('n')));
      } catch (error) {
        // Full-text index missing (e.g. legacy DB not yet re-initialized) or query
        // rejected — fall back to the CONTAINS query below for correctness.
        console.error('Full-text search failed, falling back to CONTAINS:', error);
      }
    }

    return this.searchNodesContains(searchTerm, projectId);
  }

  /**
   * Builds a Lucene query string for the `codeNodeSearch` full-text index that
   * preserves the substring semantics of the previous CONTAINS-based search.
   * Each whitespace-separated term is escaped and wrapped in wildcards (`*term*`).
   * Returns undefined when the search term contains no usable characters.
   */
  private static buildFulltextQuery(searchTerm: string): string | undefined {
    const terms = (searchTerm || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(term => {
        // Escape Lucene special characters so identifiers like "Foo(int)" are safe.
        const escaped = term.replace(/([+\-!(){}\[\]^"~*?:\\/]|&&|\|\|)/g, '\\$1');
        return `*${escaped}*`;
      });
    if (terms.length === 0) return undefined;
    return terms.join(' AND ');
  }

  /**
   * Original substring search using CONTAINS. Retained as a fallback for databases
   * whose full-text index has not been created yet.
   */
  private async searchNodesContains(searchTerm: string, projectId: string): Promise<CodeNode[]> {
    const query = `
      MATCH (n:CodeNode {project_id: $project_id})
      WHERE n.name CONTAINS $searchTerm 
         OR n.qualified_name CONTAINS $searchTerm 
         OR (n.description IS NOT NULL AND n.description CONTAINS $searchTerm)
      RETURN n
      ORDER BY 
        CASE WHEN n.name = $searchTerm THEN 0
             WHEN n.name STARTS WITH $searchTerm THEN 1
             WHEN n.name CONTAINS $searchTerm THEN 2
             ELSE 3 END,
        n.name
      LIMIT 100
    `;

    const result = await this.client.runQuery(query, { searchTerm, project_id: projectId });
    return result.records.map(record => this.recordToNode(record.get('n')));
  }

  async getAllNodes(projectId: string): Promise<CodeNode[]> {
    const query = 'MATCH (n:CodeNode {project_id: $project_id}) RETURN n ORDER BY n.type, n.name LIMIT 1000';
    const result = await this.client.runQuery(query, { project_id: projectId });

    return result.records.map(record => this.recordToNode(record.get('n')));
  }

  // Cross-project methods (use with caution)
  async findNodesByTypeAcrossProjects(type: CodeNode['type']): Promise<CodeNode[]> {
    const query = 'MATCH (n:CodeNode {type: $type}) RETURN n ORDER BY n.project_id, n.name';
    const result = await this.client.runQuery(query, { type });
    return result.records.map(record => this.recordToNode(record.get('n')));
  }

  async searchNodesAcrossProjects(searchTerm: string): Promise<CodeNode[]> {
    const query = `
      MATCH (n:CodeNode)
      WHERE n.name CONTAINS $searchTerm 
         OR n.qualified_name CONTAINS $searchTerm 
         OR n.description CONTAINS $searchTerm
      RETURN n
      ORDER BY n.project_id, n.name
      LIMIT 100
    `;

    const result = await this.client.runQuery(query, { searchTerm });
    return result.records.map(record => this.recordToNode(record.get('n')));
  }

  async getAllNodesAcrossProjects(): Promise<CodeNode[]> {
    const query = 'MATCH (n:CodeNode) RETURN n ORDER BY n.project_id, n.type, n.name LIMIT 1000';
    const result = await this.client.runQuery(query);
    return result.records.map(record => this.recordToNode(record.get('n')));
  }

  private recordToNode(record: any): CodeNode {
    const properties = record.properties;
    return {
      id: properties.id,
      project_id: properties.project_id,
      type: properties.type,
      name: properties.name,
      qualified_name: properties.qualified_name,
      description: properties.description,
      source_file: properties.source_file,
      start_line: typeof properties.start_line?.toNumber === 'function' ? properties.start_line.toNumber() : properties.start_line,
      end_line: typeof properties.end_line?.toNumber === 'function' ? properties.end_line.toNumber() : properties.end_line,
      modifiers: properties.modifiers || [],
      is_abstract: properties.is_abstract ?? false,
      attributes: properties.attributes_json ? JSON.parse(properties.attributes_json) : {}
    };
  }

  private getNodeLabel(type: CodeNode['type']): string {
    // Capitalize the first letter and handle special cases
    switch (type) {
      case 'class': return 'Class';
      case 'interface': return 'Interface';
      case 'enum': return 'Enum';
      case 'method': return 'Method';
      case 'function': return 'Function';
      case 'field': return 'Field';
      case 'module': return 'Module';
      case 'package': return 'Package';
      default: return 'CodeNode';
    }
  }

  private ensurePlainObject(value: any): any {
    // Force JSON serialization to ensure completely plain objects
    try {
      if (value === null || value === undefined) {
        return value;
      }
      // JSON serialization will convert Maps, Sets, and other complex objects to plain objects
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      // Fallback to original logic if JSON serialization fails
      if (value instanceof Map) {
        const obj: any = {};
        for (const [k, v] of value.entries()) {
          obj[k] = this.ensurePlainObject(v);
        }
        return obj;
      }
      if (Array.isArray(value)) {
        return value.map(item => this.ensurePlainObject(item));
      }
      if (value && typeof value === 'object' && value.constructor === Object) {
        const obj: any = {};
        for (const [k, v] of Object.entries(value)) {
          obj[k] = this.ensurePlainObject(v);
        }
        return obj;
      }
      return value;
    }
  }
}