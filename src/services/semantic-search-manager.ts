import neo4j from 'neo4j-driver';
import { Neo4jClient } from '../graph/neo4j-client.js';
import { EmbeddingService, NodeContext } from './embedding-service.js';
import { CodeNode, SemanticSearchParams, SemanticSearchResult, SemanticEmbedding } from '../types.js';
import { getSemanticSearchConfig } from '../config.js';

export class SemanticSearchManager {
  private neo4jClient: Neo4jClient;
  private embeddingService: EmbeddingService;
  private config: ReturnType<typeof getSemanticSearchConfig>;

  constructor(neo4jClient: Neo4jClient, embeddingService?: EmbeddingService) {
    this.neo4jClient = neo4jClient;
    this.embeddingService = embeddingService || new EmbeddingService();
    this.config = getSemanticSearchConfig();
  }

  async initializeVectorIndexes(): Promise<void> {
    if (!this.embeddingService.isEnabled()) {
      console.log('Semantic search disabled, skipping vector index initialization');
      return;
    }

    try {
      // Create vector index for semantic embeddings
      const indexQuery = `
        CREATE VECTOR INDEX semantic_embeddings IF NOT EXISTS
        FOR (n:CodeNode)
        ON (n.semantic_embedding)
        OPTIONS {
          indexConfig: {
            \`vector.dimensions\`: $dimensions,
            \`vector.similarity_function\`: 'cosine'
          }
        }
      `;

      await this.neo4jClient.runQuery(indexQuery, { 
        // Bolt encodes plain JS numbers as Neo4j Floats (e.g. 3072.0), but the vector
        // index config requires an INTEGER for `vector.dimensions`. Wrap with neo4j.int
        // so it is sent as an integer and the CREATE VECTOR INDEX call is accepted.
        dimensions: neo4j.int(this.config.dimensions) 
      });

      console.log('Vector indexes initialized successfully');
    } catch (error) {
      console.error('Failed to initialize vector indexes:', error);
      throw error;
    }
  }

  async addEmbeddingToNode(nodeId: string, projectId: string, embedding: SemanticEmbedding): Promise<void> {
    const query = `
      MATCH (n:CodeNode {id: $nodeId, project_id: $projectId})
      SET n.semantic_embedding = $vector,
          n.embedding_model = $model,
          n.embedding_version = $version,
          n.embedding_created_at = $createdAt
      RETURN n
    `;

    const result = await this.neo4jClient.runQuery(query, {
      nodeId,
      projectId,
      vector: embedding.vector,
      model: embedding.model,
      version: embedding.version,
      createdAt: embedding.created_at.toISOString()
    });

    if (result.records.length === 0) {
      throw new Error(`Node not found: ${nodeId} in project ${projectId}`);
    }
  }

  /**
   * Persists embeddings for many nodes in a SINGLE Neo4j round-trip via UNWIND.
   * Drastically reduces network round-trips compared to writing nodes one by one.
   *
   * @param items embeddings to persist, each tied to a node id and project id
   * @returns the number of nodes successfully updated
   */
  async addEmbeddingsToNodes(
    items: Array<{ nodeId: string; projectId: string; embedding: SemanticEmbedding }>
  ): Promise<number> {
    if (items.length === 0) {
      return 0;
    }

    const rows = items.map(it => ({
      nodeId: it.nodeId,
      projectId: it.projectId,
      vector: it.embedding.vector,
      model: it.embedding.model,
      version: it.embedding.version,
      createdAt: it.embedding.created_at.toISOString()
    }));

    const query = `
      UNWIND $rows AS row
      MATCH (n:CodeNode {id: row.nodeId, project_id: row.projectId})
      SET n.semantic_embedding = row.vector,
          n.embedding_model = row.model,
          n.embedding_version = row.version,
          n.embedding_created_at = row.createdAt
      RETURN count(n) AS updated
    `;

    const result = await this.neo4jClient.runQuery(query, { rows });
    const updated = result.records[0]?.get('updated');
    return typeof updated === 'object' && updated !== null && 'toNumber' in updated
      ? (updated as any).toNumber()
      : Number(updated || 0);
  }

  async semanticSearch(params: SemanticSearchParams): Promise<SemanticSearchResult[]> {
    if (!this.embeddingService.isEnabled()) {
      throw new Error('Semantic search is disabled');
    }

    // Generate embedding for the query
    const queryEmbedding = await this.embeddingService.generateEmbedding(params.query);
    if (!queryEmbedding) {
      throw new Error('Failed to generate embedding for query');
    }

    // Build the search query using the native vector index for performance
    const limit = neo4j.int(Math.floor(params.limit || 10));
    const threshold = params.similarity_threshold || this.config.similarity_threshold;
    
    const queryParams: Record<string, any> = {
      queryVector: queryEmbedding.vector,
      limit: limit,
      threshold: threshold
    };

    // Use db.index.vector.queryNodes for fast ANN search via the vector index,
    // then apply post-filters for project_id and node_types.
    let postFilter = '';
    if (params.project_id) {
      postFilter += ' AND node.project_id = $projectId';
      queryParams.projectId = params.project_id;
    }
    if (params.node_types && params.node_types.length > 0) {
      postFilter += ' AND node.type IN $nodeTypes';
      queryParams.nodeTypes = params.node_types;
    }

    // Request more candidates from the index to compensate for post-filtering
    const indexCandidates = neo4j.int(Math.floor((params.limit || 10) * 5));
    queryParams.indexCandidates = indexCandidates;

    const searchQuery = `
      CALL db.index.vector.queryNodes('semantic_embeddings', $indexCandidates, $queryVector)
      YIELD node, score AS similarity
      WHERE similarity >= $threshold${postFilter}
      RETURN node AS n, similarity
      ORDER BY similarity DESC
      LIMIT $limit
    `;

    try {
      const result = await this.neo4jClient.runQuery(searchQuery, queryParams);
      
      return result.records.map(record => {
        const node = this.neo4jRecordToCodeNode(record.get('n'));
        const similarity = record.get('similarity');
        
        return {
          node,
          similarity_score: similarity,
          matched_content: this.embeddingService.extractSemanticContent(node)
        };
      });
    } catch (error) {
      console.error('Semantic search query failed:', error);
      throw new Error(`Semantic search failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async hybridSearch(params: SemanticSearchParams, graphContext?: {
    includeRelationships?: boolean;
    maxHops?: number;
  }): Promise<SemanticSearchResult[]> {
    // First perform semantic search
    const semanticResults = await this.semanticSearch(params);
    
    if (!graphContext?.includeRelationships) {
      return semanticResults;
    }

    // Enhance results with graph context
    const enhancedResults: SemanticSearchResult[] = [];
    const maxHops = graphContext.maxHops || 2;

    for (const result of semanticResults) {
      // Get related nodes within maxHops
      const contextQuery = `
        MATCH (n:CodeNode {id: $nodeId, project_id: $projectId})
        MATCH (n)-[*1..${maxHops}]-(related:CodeNode)
        WHERE related.project_id = $projectId
        RETURN DISTINCT related
        LIMIT 5
      `;

      try {
        const contextResult = await this.neo4jClient.runQuery(contextQuery, {
          nodeId: result.node.id,
          projectId: result.node.project_id
        });

        const relatedNodes = contextResult.records.map(record => 
          this.neo4jRecordToCodeNode(record.get('related'))
        );

        // Enhance the matched content with related context
        const contextualContent = [
          result.matched_content,
          ...relatedNodes.map(node => `Related: ${node.name} (${node.type})`)
        ].join(' | ');

        enhancedResults.push({
          ...result,
          matched_content: contextualContent
        });
      } catch (error) {
        console.warn(`Failed to get graph context for node ${result.node.id}:`, error);
        enhancedResults.push(result);
      }
    }

    return enhancedResults;
  }

  async getSimilarNodes(nodeId: string, projectId: string, limit: number = 5): Promise<SemanticSearchResult[]> {
    const limitInt = neo4j.int(Math.floor(limit));
    // Get the embedding of the target node
    const nodeQuery = `
      MATCH (n:CodeNode {id: $nodeId, project_id: $projectId})
      WHERE n.semantic_embedding IS NOT NULL
      RETURN n.semantic_embedding AS embedding, n
    `;

    const nodeResult = await this.neo4jClient.runQuery(nodeQuery, { nodeId, projectId });
    
    if (nodeResult.records.length === 0) {
      throw new Error(`Node not found or has no embedding: ${nodeId}`);
    }

    const targetEmbedding = nodeResult.records[0].get('embedding');
    const targetNode = this.neo4jRecordToCodeNode(nodeResult.records[0].get('n'));

    // Find similar nodes using vector index for fast ANN search
    // Request extra candidates to compensate for filtering out the source node and project filter
    const indexCandidates = neo4j.int(Math.floor(limit * 5));
    const similarQuery = `
      CALL db.index.vector.queryNodes('semantic_embeddings', $indexCandidates, $targetEmbedding)
      YIELD node, score AS similarity
      WHERE node.project_id = $projectId AND node.id <> $nodeId AND similarity >= $threshold
      RETURN node AS n, similarity
      ORDER BY similarity DESC
      LIMIT $limit
    `;

    const result = await this.neo4jClient.runQuery(similarQuery, {
      projectId,
      nodeId,
      targetEmbedding,
      threshold: this.config.similarity_threshold,
      limit: limitInt,
      indexCandidates
    });

    return result.records.map(record => {
      const node = this.neo4jRecordToCodeNode(record.get('n'));
      const similarity = record.get('similarity');
      
      return {
        node,
        similarity_score: similarity,
        matched_content: this.embeddingService.extractSemanticContent(node)
      };
    });
  }

  async updateEmbeddings(projectId?: string, nodeTypes?: string[]): Promise<{ updated: number; failed: number }> {
    if (!this.embeddingService.isEnabled()) {
      throw new Error('Semantic search is disabled');
    }

    let whereClause = '1=1';
    const queryParams: Record<string, any> = {};

    if (projectId) {
      whereClause += ' AND n.project_id = $projectId';
      queryParams.projectId = projectId;
    }

    if (nodeTypes && nodeTypes.length > 0) {
      whereClause += ' AND n.type IN $nodeTypes';
      queryParams.nodeTypes = nodeTypes;
    }

    // Count the matching nodes up front (cheap) so we can show progress/ETA without
    // having to load every node into memory at once.
    const countResult = await this.neo4jClient.runQuery(
      `MATCH (n:CodeNode) WHERE ${whereClause} RETURN count(n) AS total`,
      queryParams
    );
    const totalRaw = countResult.records[0]?.get('total');
    const totalNodes = typeof totalRaw === 'object' && totalRaw !== null && 'toNumber' in totalRaw
      ? (totalRaw as any).toNumber()
      : Number(totalRaw || 0);

    console.log(`🧠 Generating embeddings for ${totalNodes} entities...`);

    let updated = 0;
    let failed = 0;

    // Process nodes in batches. Rather than loading every matching node into memory
    // (which can OOM on large projects with hundreds of thousands of entities), we
    // stream them page-by-page using keyset pagination on n.id. Only one batch is
    // ever resident in memory at a time.
    const batchSize = this.config.batch_size;
    const totalBatches = Math.max(1, Math.ceil(totalNodes / batchSize));
    const startTime = Date.now();
    let processedBatches = 0;
    let lastId: string | null = null;

    const pageQuery = `
      MATCH (n:CodeNode)
      WHERE ${whereClause}${' AND n.id > $lastId'}
      RETURN n
      ORDER BY n.id
      LIMIT $pageSize
    `;
    const pageSize = neo4j.int(batchSize);

    while (true) {
      // Keyset pagination: fetch the next page of nodes after the last id we saw.
      const pageParams: Record<string, any> = {
        ...queryParams,
        pageSize,
        lastId: lastId ?? ''
      };
      const pageResult = await this.neo4jClient.runQuery(pageQuery, pageParams);
      if (pageResult.records.length === 0) {
        break;
      }

      const batch = pageResult.records.map(record => this.neo4jRecordToCodeNode(record.get('n')));
      lastId = batch[batch.length - 1].id;

      try {
        // Fetch context for all class/interface/enum nodes in the batch with a SINGLE
        // round-trip to Neo4j (instead of 4 sequential queries per node). This avoids
        // hundreds of thousands of network round-trips to a remote database.
        const enrichNodes = batch.filter(
          n => n.type === 'class' || n.type === 'interface' || n.type === 'enum'
        );
        const contextMap = await this.fetchNodeContextsBatch(enrichNodes);

        const texts = batch.map((node) => {
          if (node.type === 'class' || node.type === 'interface' || node.type === 'enum') {
            const context = contextMap.get(node.id) || {};
            return this.embeddingService.extractSemanticContent(node, context);
          }
          return this.embeddingService.extractSemanticContent(node);
        });
        
        // Generate embeddings
        const embeddings = await this.embeddingService.generateEmbeddings(texts);

        // Collect successfully generated embeddings, then persist them in a
        // SINGLE round-trip instead of one write per node.
        const toWrite: Array<{ nodeId: string; projectId: string; embedding: SemanticEmbedding }> = [];
        for (let j = 0; j < batch.length; j++) {
          const node = batch[j];
          const embedding = embeddings[j];
          if (embedding) {
            toWrite.push({ nodeId: node.id, projectId: node.project_id, embedding });
          } else {
            failed++;
          }
        }

        try {
          const written = await this.addEmbeddingsToNodes(toWrite);
          updated += written;
          // Any rows that matched no node count as failures
          failed += toWrite.length - written;
        } catch (error) {
          console.error(`Failed to persist embeddings for batch ending at id ${lastId}:`, error);
          failed += toWrite.length;
        }
      } catch (error) {
        console.error(`Failed to process batch ending at id ${lastId}:`, error);
        failed += batch.length;
      }

      processedBatches++;
      
      // Show progress with ETA every 10 batches or on last batch
      if (processedBatches % 10 === 0 || processedBatches === totalBatches) {
        const elapsedMs = Date.now() - startTime;
        const avgMsPerBatch = elapsedMs / processedBatches;
        const remainingBatches = Math.max(0, totalBatches - processedBatches);
        const etaMs = avgMsPerBatch * remainingBatches;
        const etaStr = this.formatDuration(etaMs);
        const percent = Math.min(100, Math.round((processedBatches / totalBatches) * 100));
        
        console.log(`⏳ Progress: ${percent}% (${updated + failed}/${totalNodes}) | ETA: ${etaStr}`);
      }

      // The final page is shorter than a full batch, so stop once we've drained it.
      if (batch.length < batchSize) {
        break;
      }
    }

    console.log(`✅ Embedding update completed. Updated: ${updated}, Failed: ${failed}`);
    return { updated, failed };
  }

  /**
   * Fetches enrichment context for a batch of class/interface/enum nodes in a SINGLE
   * Neo4j round-trip, using pattern comprehensions to gather EXTENDS, IMPLEMENTS and
   * CONTAINS (method/field) data per node. This replaces the previous approach of
   * issuing 4 sequential queries per node, which caused hundreds of thousands of
   * round-trips against a remote database.
   *
   * @param nodes the class/interface/enum code nodes to enrich
   * @returns a map of node id to its {@link NodeContext}
   */
  private async fetchNodeContextsBatch(nodes: CodeNode[]): Promise<Map<string, NodeContext>> {
    const contextMap = new Map<string, NodeContext>();
    if (nodes.length === 0) {
      return contextMap;
    }

    // Always derive the cheap, DB-free parts (module + architectural role) locally.
    for (const node of nodes) {
      const context: NodeContext = {};
      if (node.source_file) {
        const moduleMatch = node.source_file.match(/(?:^|[/\\])((?:bc|ac|app|pf|ft|sld|init|orm)_[^/\\]+)/);
        if (moduleMatch) {
          context.module = moduleMatch[1];
        }
      }
      context.architectural_role = this.inferArchitecturalRole(node);
      contextMap.set(node.id, context);
    }

    try {
      const items = nodes.map(n => ({ id: n.id, projectId: n.project_id }));
      const result = await this.neo4jClient.runQuery(
        `UNWIND $items AS item
         MATCH (n:CodeNode {id: item.id, project_id: item.projectId})
         RETURN n.id AS id,
           [(n)-[:EXTENDS]->(p:CodeNode) | p.name][0] AS superclass,
           [(n)-[:IMPLEMENTS]->(i:CodeNode) | i.name] AS interfaces,
           [(n)-[:CONTAINS]->(m:CodeNode) WHERE m.type = 'method' | {name: m.name, modifiers: m.modifiers}] AS methods,
           [(n)-[:CONTAINS]->(f:CodeNode) WHERE f.type = 'field' | {name: f.name, attributes: f.attributes}] AS fields`,
        { items }
      );

      for (const record of result.records) {
        const id = record.get('id');
        const context = contextMap.get(id) || {};

        // Superclass (EXTENDS)
        const superclass = record.get('superclass');
        if (superclass) {
          context.superclass = superclass;
        }

        // Implemented interfaces (IMPLEMENTS)
        const interfaces: string[] = (record.get('interfaces') || []).filter(Boolean);
        if (interfaces.length > 0) {
          context.implemented_interfaces = interfaces;
        }

        // Child methods (CONTAINS -> method)
        const methods: Array<{ name: string; modifiers: string[] }> = record.get('methods') || [];
        if (methods.length > 0) {
          const publicMethods: string[] = [];
          const privateMethods: string[] = [];
          for (const m of methods) {
            const modifiers: string[] = m.modifiers || [];
            if (modifiers.includes('public')) {
              publicMethods.push(m.name);
            } else if (modifiers.includes('private')) {
              privateMethods.push(m.name);
            }
          }
          if (publicMethods.length > 0) {
            context.public_methods = publicMethods;
          }
          if (privateMethods.length > 0) {
            context.important_private_methods = privateMethods;
          }
        }

        // Injected dependencies (CONTAINS -> field with @Inject/@Autowired)
        const fields: Array<{ name: string; attributes: any }> = record.get('fields') || [];
        if (fields.length > 0) {
          const injected: string[] = [];
          const repos: string[] = [];
          for (const f of fields) {
            const attrs = f.attributes;
            const parsed = attrs ? (typeof attrs === 'string' ? JSON.parse(attrs) : attrs) : {};
            const annotations: Array<{ name: string }> = parsed?.annotations || [];
            const isInjected = annotations.some(a => a.name === '@Inject' || a.name === '@Autowired');
            if (isInjected) {
              injected.push(f.name);
              if (f.name.toLowerCase().includes('repository')) {
                repos.push(f.name);
              }
            }
          }
          if (injected.length > 0) {
            context.injected_dependencies = injected;
          }
          if (repos.length > 0) {
            context.repositories_used = repos;
          }
        }

        contextMap.set(id, context);
      }
    } catch (error) {
      console.warn(`Failed to fetch batch context:`, error instanceof Error ? error.message : 'Unknown error');
    }

    return contextMap;
  }

  /**
   * Infers the architectural role of a class/interface/enum based on naming conventions
   * and known annotation patterns.
   *
   * @param node the code node
   * @returns a human-readable architectural role description, or undefined
   */
  private inferArchitecturalRole(node: CodeNode): string | undefined {
    const name = node.name || '';
    const annotations = node.attributes?.annotations?.map((a: any) => a.name) || [];

    if (name.endsWith('Resource') || annotations.includes('@Path')) return 'REST resource';
    if (name.endsWith('Request')) return 'REST request handler';
    if (name.endsWith('Handler') && !name.endsWith('HandlerImpl')) return 'Handler interface';
    if (name.endsWith('HandlerImpl')) return 'Handler implementation';
    if (name.endsWith('BORepository')) return 'Business object repository';
    if (name.endsWith('BO') && node.type === 'interface') return 'Business object interface';
    if (name.endsWith('BOImpl')) return 'Business object implementation';
    if (name.endsWith('PO')) return 'Persistent object';
    if (name.endsWith('POKey')) return 'Persistent object key';
    if (name.endsWith('DataRO') || name.endsWith('InfoRO')) return 'Resource object (DTO)';
    if (name.endsWith('Module') || name.endsWith('CartridgeModule')) return 'Guice module';
    if (name.endsWith('Mapper')) return 'Object mapper';
    if (name.endsWith('Service')) return 'Application service';

    return undefined;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return 'less than 1s';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  private neo4jRecordToCodeNode(record: any): CodeNode {
    const properties = record.properties;
    
    return {
      id: properties.id,
      project_id: properties.project_id,
      type: properties.type,
      name: properties.name,
      qualified_name: properties.qualified_name,
      description: properties.description,
      source_file: properties.source_file,
      start_line: properties.start_line ? parseInt(properties.start_line) : undefined,
      end_line: properties.end_line ? parseInt(properties.end_line) : undefined,
      modifiers: properties.modifiers,
      attributes: properties.attributes ? JSON.parse(properties.attributes) : undefined
    };
  }
}
