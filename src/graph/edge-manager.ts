import { Neo4jClient } from './neo4j-client.js';
import { CodeEdge, QueryResult } from '../types.js';

export class EdgeManager {
  constructor(private client: Neo4jClient) {}

  async addEdge(edge: CodeEdge): Promise<CodeEdge> {
    let query = `
      MATCH (source:CodeNode {id: $source, project_id: $project_id}),
            (target:CodeNode {id: $target, project_id: $project_id})
      CREATE (source)-[r:${edge.type.toUpperCase()} {
        id: $id,
        project_id: $project_id,
        type: $type,
        attributes_json: $attributes_json
      }]->(target)
      RETURN r, source.id as sourceId, target.id as targetId
    `;

    const params = {
      id: edge.id,
      project_id: edge.project_id,
      type: edge.type,
      source: edge.source,
      target: edge.target,
      attributes_json: JSON.stringify(edge.attributes || {})
    };

    let result = await this.client.runQuery(query, this.ensurePlainObject(params));

    // If the exact target isn't found and this is an implements relationship,
    // try to find the interface by name within the same project
    if (result.records.length === 0 && edge.type === 'implements') {
      result = await this.addEdgeFuzzyImplements(edge, params);
    }

    if (result.records.length === 0) {
      throw new Error('Failed to create edge - source or target node not found');
    }

    return this.recordToEdge(result.records[0]);
  }

  /**
   * Batch-inserts edges grouped by type using UNWIND for high throughput.
   * All edges of the same type are sent in a single Cypher query instead of
   * individual round-trips, reducing N queries to ceil(N/batchSize) * numTypes.
   *
   * Returns the number of successfully stored edges and an array of errors.
   */
  async addEdgesBatch(
    edges: CodeEdge[],
    batchSize = 100
  ): Promise<{ stored: number; errors: Array<{ edge: CodeEdge; error: string }> }> {
    if (edges.length === 0) return { stored: 0, errors: [] };

    // Group edges by relationship type (Cypher requires a static type token)
    const byType = new Map<string, CodeEdge[]>();
    for (const edge of edges) {
      const t = edge.type.toUpperCase();
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(edge);
    }

    let totalStored = 0;
    const errors: Array<{ edge: CodeEdge; error: string }> = [];

    for (const [type, typeEdges] of byType) {
      for (let i = 0; i < typeEdges.length; i += batchSize) {
        const batch = typeEdges.slice(i, i + batchSize);
        const project_id = batch[0].project_id;

        const rows = batch.map(e => ({
          id: e.id,
          type: e.type,
          source: e.source,
          target: e.target,
          attributes_json: JSON.stringify(e.attributes || {})
        }));

        // UNWIND lets Neo4j process the whole batch in one transaction.
        // If a MATCH fails (nodes not found), that row is simply skipped —
        // we detect missing rows by comparing returned IDs against input.
        const query = `
          UNWIND $rows AS row
          MATCH (source:CodeNode {id: row.source, project_id: $project_id}),
                (target:CodeNode {id: row.target, project_id: $project_id})
          CREATE (source)-[r:${type} {
            id: row.id,
            project_id: $project_id,
            type: row.type,
            attributes_json: row.attributes_json
          }]->(target)
          RETURN row.id AS id
        `;

        try {
          const result = await this.client.runQuery(
            query,
            this.ensurePlainObject({ rows, project_id })
          );
          const storedIds = new Set<string>(result.records.map((r: any) => r.get('id')));
          totalStored += storedIds.size;

          // For implements, try fuzzy fallback for edges not created
          if (type === 'IMPLEMENTS') {
            for (const edge of batch) {
              if (!storedIds.has(edge.id)) {
                try {
                  const params = {
                    id: edge.id,
                    project_id: edge.project_id,
                    type: edge.type,
                    source: edge.source,
                    target: edge.target,
                    attributes_json: JSON.stringify(edge.attributes || {})
                  };
                  const fuzzyResult = await this.addEdgeFuzzyImplements(edge, params);
                  if (fuzzyResult.records.length > 0) totalStored++;
                } catch {
                  // silently skip — interface not in project scope
                }
              }
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const edge of batch) {
            errors.push({ edge, error: message });
          }
        }
      }
    }

    return { stored: totalStored, errors };
  }

  private async addEdgeFuzzyImplements(edge: CodeEdge, params: Record<string, any>) {
    const targetName = edge.target.split('.').pop();
    const query = `
      MATCH (source:CodeNode {id: $source, project_id: $project_id}),
            (target:Interface {project_id: $project_id})
      WHERE target.name = $targetName
      CREATE (source)-[r:IMPLEMENTS {
        id: $id,
        project_id: $project_id,
        type: $type,
        attributes_json: $attributes_json
      }]->(target)
      RETURN r, source.id as sourceId, target.id as targetId
    `;
    return this.client.runQuery(query, this.ensurePlainObject({ ...params, targetName }));
  }

  async updateEdge(edgeId: string, projectId: string, updates: Partial<CodeEdge>): Promise<CodeEdge> {
    const setParts: string[] = [];
    const parameters: Record<string, any> = { id: edgeId };

    Object.entries(updates).forEach(([key, value], index) => {
      if (key !== 'id' && key !== 'source' && key !== 'target' && value !== undefined) {
        const paramKey = `update_${index}`;
        setParts.push(`r.${key} = $${paramKey}`);
        parameters[paramKey] = value;
      }
    });

    if (setParts.length === 0) {
      throw new Error('No valid updates provided');
    }

    const query = `
      MATCH (source)-[r {id: $id, project_id: $project_id}]->(target)
      SET ${setParts.join(', ')}
      RETURN r, source.id as sourceId, target.id as targetId
    `;

    parameters.project_id = projectId;

    const result = await this.client.runQuery(query, parameters);

    if (result.records.length === 0) {
      throw new Error(`Edge with id ${edgeId} not found`);
    }

    return this.recordToEdge(result.records[0]);
  }

  async getEdge(edgeId: string, projectId: string): Promise<CodeEdge | null> {
    const query = `
      MATCH (source)-[r {id: $id, project_id: $project_id}]->(target)
      RETURN r, source.id as sourceId, target.id as targetId
    `;
    
    const result = await this.client.runQuery(query, { id: edgeId, project_id: projectId });

    if (result.records.length === 0) {
      return null;
    }

    return this.recordToEdge(result.records[0]);
  }

  async deleteEdge(edgeId: string, projectId: string): Promise<boolean> {
    const query = `
      MATCH ()-[r {id: $id, project_id: $project_id}]->()
      DELETE r
      RETURN count(r) as deleted
    `;

    const result = await this.client.runQuery(query, { id: edgeId, project_id: projectId });
    return result.records[0].get('deleted').toNumber() > 0;
  }

  async findEdgesByType(type: CodeEdge['type'], projectId: string): Promise<CodeEdge[]> {
    const query = `
      MATCH (source)-[r:${type.toUpperCase()} {project_id: $project_id}]->(target)
      RETURN r, source.id as sourceId, target.id as targetId
    `;
    
    const result = await this.client.runQuery(query, { project_id: projectId });
    return result.records.map(record => this.recordToEdge(record));
  }

  async findEdgesBySource(sourceId: string, projectId: string): Promise<CodeEdge[]> {
    const query = `
      MATCH (source {id: $sourceId, project_id: $project_id})-[r {project_id: $project_id}]->(target)
      RETURN r, source.id as sourceId, target.id as targetId
    `;
    
    const result = await this.client.runQuery(query, { sourceId, project_id: projectId });
    return result.records.map(record => this.recordToEdge(record));
  }

  async findEdgesByTarget(targetId: string, projectId: string): Promise<CodeEdge[]> {
    const query = `
      MATCH (source)-[r {project_id: $project_id}]->(target {id: $targetId, project_id: $project_id})
      RETURN r, source.id as sourceId, target.id as targetId
    `;
    
    const result = await this.client.runQuery(query, { targetId, project_id: projectId });
    return result.records.map(record => this.recordToEdge(record));
  }

  async findEdgesBetween(sourceId: string, targetId: string, projectId: string): Promise<CodeEdge[]> {
    const query = `
      MATCH (source {id: $sourceId, project_id: $project_id})-[r {project_id: $project_id}]->(target {id: $targetId, project_id: $project_id})
      RETURN r, source.id as sourceId, target.id as targetId
    `;
    
    const result = await this.client.runQuery(query, { sourceId, targetId, project_id: projectId });
    return result.records.map(record => this.recordToEdge(record));
  }

  async getAllEdges(projectId: string): Promise<CodeEdge[]> {
    const query = `
      MATCH (source)-[r {project_id: $project_id}]->(target)
      RETURN r, source.id as sourceId, target.id as targetId
      LIMIT 1000
    `;
    
    const result = await this.client.runQuery(query, { project_id: projectId });
    return result.records.map(record => this.recordToEdge(record));
  }

  // Complex queries for code analysis
  async findClassesThatCallMethod(methodName: string, projectId: string): Promise<string[]> {
    // Try two strategies: direct CALLS edges, and also name-based matching
    const query = `
      MATCH (caller:CodeNode {type: 'class', project_id: $project_id})-[:CONTAINS]->(m1:CodeNode {type: 'method', project_id: $project_id})
      -[:CALLS]->(m2:CodeNode {project_id: $project_id})
      WHERE m2.name = $methodName OR m2.qualified_name CONTAINS $methodName
      RETURN DISTINCT caller.name as className, caller.qualified_name as qualifiedName
      ORDER BY className
    `;
    
    const result = await this.client.runQuery(query, { methodName, project_id: projectId });
    return result.records.map(record => record.get('qualifiedName') ?? record.get('className'));
  }

  async findClassesThatImplementInterface(interfaceName: string, projectId: string): Promise<string[]> {
    const query = `
      MATCH (target:CodeNode {project_id: $project_id})
      WHERE (target.name = $interfaceName OR target.qualified_name = $interfaceName OR target.id = $interfaceName)
        AND target.type IN ['interface', 'class']
      MATCH (class:CodeNode {type: 'class', project_id: $project_id})-[r:IMPLEMENTS|EXTENDS {project_id: $project_id}]->(target)
      WHERE target.type = 'interface' OR target.is_abstract = true
      RETURN class.name as className, class.qualified_name as qualifiedName
      ORDER BY className
    `;

    const result = await this.client.runQuery(query, { interfaceName, project_id: projectId });
    return result.records.map(record => record.get('qualifiedName') ?? record.get('className'));
  }

  async findInheritanceHierarchy(className: string, projectId: string): Promise<string[]> {
    const query = `
      MATCH (child:CodeNode {project_id: $project_id})
      WHERE child.name = $className OR child.qualified_name = $className
      MATCH path = (child)-[:EXTENDS*]->(ancestor:CodeNode)
      WHERE ALL(r IN relationships(path) WHERE r.project_id = $project_id)
        AND ALL(node IN nodes(path) WHERE node.project_id = $project_id)
      RETURN [node IN nodes(path) | node.name] as hierarchy
      ORDER BY length(path) DESC
      LIMIT 1
    `;
    
    const result = await this.client.runQuery(query, { className, project_id: projectId });
    return result.records.length > 0 ? result.records[0].get('hierarchy') : [];
  }

  /**
   * Find all methods declared by a specific class
   * Uses the CONTAINS relationship: (:Class)-[:CONTAINS]->(:Method)
   */
  async findMethodsOfClass(className: string, projectId: string): Promise<{ name: string; qualifiedName: string; returnType?: string }[]> {
    const query = `
      MATCH (class:CodeNode {type: 'class', project_id: $project_id})-[:CONTAINS {project_id: $project_id}]->
      (method:CodeNode {type: 'method', project_id: $project_id})
      WHERE class.name = $className OR class.qualified_name = $className
      RETURN method.name as name, method.qualified_name as qualifiedName, method.attributes_json as attributes
      ORDER BY name
    `;
    
    const result = await this.client.runQuery(query, { className, project_id: projectId });
    return result.records.map(record => {
      const attributes = record.get('attributes') ? JSON.parse(record.get('attributes')) : {};
      return {
        name: record.get('name'),
        qualifiedName: record.get('qualifiedName'),
        returnType: attributes.return_type
      };
    });
  }

  /**
   * Find all fields declared by a specific class
   * Uses the CONTAINS relationship: (:Class)-[:CONTAINS]->(:Field)
   */
  async findFieldsOfClass(className: string, projectId: string): Promise<{ name: string; qualifiedName: string; type?: string }[]> {
    const query = `
      MATCH (class:CodeNode {type: 'class', project_id: $project_id})-[:CONTAINS {project_id: $project_id}]->
      (field:CodeNode {type: 'field', project_id: $project_id})
      WHERE class.name = $className OR class.qualified_name = $className
      RETURN field.name as name, field.qualified_name as qualifiedName, field.attributes_json as attributes
      ORDER BY name
    `;
    
    const result = await this.client.runQuery(query, { className, project_id: projectId });
    return result.records.map(record => {
      const attributes = record.get('attributes') ? JSON.parse(record.get('attributes')) : {};
      return {
        name: record.get('name'),
        qualifiedName: record.get('qualifiedName'),
        type: attributes.field_type
      };
    });
  }

  /**
   * Find the class that contains/declares a specific method
   */
  async findClassOfMethod(methodName: string, projectId: string): Promise<{ name: string; qualifiedName: string } | null> {
    const query = `
      MATCH (class:CodeNode {type: 'class', project_id: $project_id})-[:CONTAINS {project_id: $project_id}]->
      (method:CodeNode {type: 'method', project_id: $project_id})
      WHERE method.name = $methodName OR method.qualified_name = $methodName
      RETURN class.name as name, class.qualified_name as qualifiedName
      LIMIT 1
    `;
    
    const result = await this.client.runQuery(query, { methodName, project_id: projectId });
    if (result.records.length === 0) {
      return null;
    }
    return {
      name: result.records[0].get('name'),
      qualifiedName: result.records[0].get('qualifiedName')
    };
  }

  /**
   * Find all classes annotated with a specific annotation.
   * Annotations may be on the class itself OR on fields/methods contained by the class.
   * Annotation names are stored with '@' prefix (e.g., "@Inject").
   */
  async findClassesAnnotatedWith(annotationName: string, projectId: string): Promise<string[]> {
    // Normalize: ensure we search both with and without '@' prefix
    const withAt = annotationName.startsWith('@') ? annotationName : '@' + annotationName;
    const withoutAt = annotationName.startsWith('@') ? annotationName.substring(1) : annotationName;

    const query = `
      MATCH (class:CodeNode {type: 'class', project_id: $project_id})-[:CONTAINS]->(member:CodeNode {project_id: $project_id})
      -[:ANNOTATED_WITH]->(annotation:CodeNode {project_id: $project_id})
      WHERE annotation.name = $withAt OR annotation.name = $withoutAt
      RETURN DISTINCT class.name as className, class.qualified_name as qualifiedName
      ORDER BY className
      UNION
      MATCH (class:CodeNode {type: 'class', project_id: $project_id})
      -[:ANNOTATED_WITH]->(annotation:CodeNode {project_id: $project_id})
      WHERE annotation.name = $withAt OR annotation.name = $withoutAt
      RETURN DISTINCT class.name as className, class.qualified_name as qualifiedName
      ORDER BY className
    `;
    
    const result = await this.client.runQuery(query, { withAt, withoutAt, project_id: projectId });
    return result.records.map(record => record.get('qualifiedName') || record.get('className'));
  }

  /**
   * Find all methods annotated with a specific annotation
   */
  async findMethodsAnnotatedWith(annotationName: string, projectId: string): Promise<string[]> {
    const withAt = annotationName.startsWith('@') ? annotationName : '@' + annotationName;
    const withoutAt = annotationName.startsWith('@') ? annotationName.substring(1) : annotationName;

    const query = `
      MATCH (method:CodeNode {type: 'method', project_id: $project_id})-[:ANNOTATED_WITH]->
      (annotation:CodeNode {project_id: $project_id})
      WHERE annotation.name = $withAt OR annotation.name = $withoutAt
      RETURN DISTINCT method.name as methodName, method.qualified_name as qualifiedName
      ORDER BY methodName
    `;
    
    const result = await this.client.runQuery(query, { withAt, withoutAt, project_id: projectId });
    return result.records.map(record => record.get('qualifiedName') || record.get('methodName'));
  }

  /**
   * Find all annotations used on a specific class (directly or on its members)
   */
  async findAnnotationsOnClass(className: string, projectId: string): Promise<string[]> {
    const query = `
      MATCH (class:CodeNode {type: 'class', project_id: $project_id})
      WHERE class.name = $className OR class.qualified_name = $className
      OPTIONAL MATCH (class)-[:ANNOTATED_WITH]->(a1:CodeNode {type: 'annotation'})
      OPTIONAL MATCH (class)-[:CONTAINS]->(member:CodeNode)-[:ANNOTATED_WITH]->(a2:CodeNode {type: 'annotation'})
      WITH collect(DISTINCT a1.name) + collect(DISTINCT a2.name) as allAnnotations
      UNWIND allAnnotations as annotationName
      WITH DISTINCT annotationName WHERE annotationName IS NOT NULL
      RETURN annotationName
      ORDER BY annotationName
    `;
    
    const result = await this.client.runQuery(query, { className, project_id: projectId });
    return result.records.map(record => record.get('annotationName'));
  }

  /**
   * Find all annotations used on a specific method
   */
  async findAnnotationsOnMethod(methodName: string, projectId: string): Promise<string[]> {
    const query = `
      MATCH (method:CodeNode {type: 'method', project_id: $project_id})-[:ANNOTATED_WITH]->
      (annotation:CodeNode {type: 'annotation', project_id: $project_id})
      WHERE method.name = $methodName OR method.qualified_name = $methodName
      RETURN DISTINCT annotation.name as annotationName
      ORDER BY annotationName
    `;
    
    const result = await this.client.runQuery(query, { methodName, project_id: projectId });
    return result.records.map(record => record.get('annotationName'));
  }

  /**
   * Find all elements (classes and methods) annotated with a specific framework annotation
   */
  async findElementsByFrameworkAnnotation(framework: string, projectId: string): Promise<{ type: string; name: string; annotation: string }[]> {
    const query = `
      MATCH (element:CodeNode {project_id: $project_id})-[:ANNOTATED_WITH]->
      (annotation:CodeNode {type: 'annotation', project_id: $project_id})
      WHERE annotation.attributes_json CONTAINS $framework
      RETURN element.type as type, element.name as name, element.qualified_name as qualifiedName, annotation.name as annotation
      ORDER BY element.type, element.name
    `;
    
    const result = await this.client.runQuery(query, { framework, project_id: projectId });
    return result.records.map(record => ({
      type: record.get('type'),
      name: record.get('qualifiedName') || record.get('name'),
      annotation: record.get('annotation')
    }));
  }

  // Cross-project methods (use with caution)
  async findEdgesByTypeAcrossProjects(type: CodeEdge['type']): Promise<CodeEdge[]> {
    const query = `
      MATCH (source)-[r:${type.toUpperCase()}]->(target)
      RETURN r, source.id as sourceId, target.id as targetId
      ORDER BY r.project_id
    `;
    
    const result = await this.client.runQuery(query);
    return result.records.map(record => this.recordToEdge(record));
  }

  async getAllEdgesAcrossProjects(): Promise<CodeEdge[]> {
    const query = `
      MATCH (source)-[r]->(target)
      RETURN r, source.id as sourceId, target.id as targetId
      ORDER BY r.project_id, r.type
      LIMIT 1000
    `;
    
    const result = await this.client.runQuery(query);
    return result.records.map(record => this.recordToEdge(record));
  }

  async findCrossProjectDependencies(): Promise<CodeEdge[]> {
    const query = `
      MATCH (source:CodeNode)-[r]->(target:CodeNode)
      WHERE source.project_id <> target.project_id
      RETURN r, source.id as sourceId, target.id as targetId
      ORDER BY source.project_id, target.project_id
    `;
    
    const result = await this.client.runQuery(query);
    return result.records.map(record => this.recordToEdge(record));
  }

  private recordToEdge(record: any): CodeEdge {
    const relationship = record.get('r');
    const properties = relationship.properties;
    
    return {
      id: properties.id,
      project_id: properties.project_id,
      type: properties.type,
      source: record.get('sourceId'),
      target: record.get('targetId'),
      attributes: properties.attributes_json ? JSON.parse(properties.attributes_json) : {}
    };
  }

  private ensurePlainObject(value: any): any {
    if (value === null || value === undefined) {
      return value;
    }
    
    // Handle Maps first (before JSON serialization)
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
    
    // Try JSON serialization for other complex objects
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return value;
    }
  }
}