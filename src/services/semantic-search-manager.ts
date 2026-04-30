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
        dimensions: this.config.dimensions 
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

  async semanticSearch(params: SemanticSearchParams): Promise<SemanticSearchResult[]> {
    if (!this.embeddingService.isEnabled()) {
      throw new Error('Semantic search is disabled');
    }

    // Generate embedding for the query
    const queryEmbedding = await this.embeddingService.generateEmbedding(params.query);
    if (!queryEmbedding) {
      throw new Error('Failed to generate embedding for query');
    }

    // Build the search query
    const limit = neo4j.int(Math.floor(params.limit || 10));
    const threshold = params.similarity_threshold || this.config.similarity_threshold;
    
    let whereClause = 'n.semantic_embedding IS NOT NULL';
    const queryParams: Record<string, any> = {
      queryVector: queryEmbedding.vector,
      limit: limit,
      threshold: threshold
    };

    // Add project filter
    if (params.project_id) {
      whereClause += ' AND n.project_id = $projectId';
      queryParams.projectId = params.project_id;
    }

    // Add node type filter
    if (params.node_types && params.node_types.length > 0) {
      whereClause += ' AND n.type IN $nodeTypes';
      queryParams.nodeTypes = params.node_types;
    }

    const searchQuery = `
      MATCH (n:CodeNode)
      WHERE ${whereClause}
      WITH n, vector.similarity.cosine(n.semantic_embedding, $queryVector) AS similarity
      WHERE similarity >= $threshold
      RETURN n, similarity
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

    // Find similar nodes
    const similarQuery = `
      MATCH (n:CodeNode)
      WHERE n.semantic_embedding IS NOT NULL 
        AND n.project_id = $projectId 
        AND n.id <> $nodeId
      WITH n, vector.similarity.cosine(n.semantic_embedding, $targetEmbedding) AS similarity
      WHERE similarity >= $threshold
      RETURN n, similarity
      ORDER BY similarity DESC
      LIMIT $limit
    `;

    const result = await this.neo4jClient.runQuery(similarQuery, {
      projectId,
      nodeId,
      targetEmbedding,
      threshold: this.config.similarity_threshold,
      limit: limitInt
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

    // Get nodes that need embedding updates
    const query = `
      MATCH (n:CodeNode)
      WHERE ${whereClause}
      RETURN n
      ORDER BY n.id
    `;

    const result = await this.neo4jClient.runQuery(query, queryParams);
    const nodes = result.records.map(record => this.neo4jRecordToCodeNode(record.get('n')));

    console.log(`🧠 Generating embeddings for ${nodes.length} entities...`);

    let updated = 0;
    let failed = 0;

    // Process nodes in batches
    const batchSize = this.config.batch_size;
    const totalBatches = Math.ceil(nodes.length / batchSize);
    const startTime = Date.now();
    let processedBatches = 0;

    for (let i = 0; i < nodes.length; i += batchSize) {
      const batch = nodes.slice(i, i + batchSize);
      
      try {
        // Fetch context for class/interface/enum nodes, then extract semantic content
        const texts = await Promise.all(batch.map(async (node) => {
          if (node.type === 'class' || node.type === 'interface' || node.type === 'enum') {
            const context = await this.fetchNodeContext(node);
            return this.embeddingService.extractSemanticContent(node, context);
          }
          return this.embeddingService.extractSemanticContent(node);
        }));
        
        // Generate embeddings
        const embeddings = await this.embeddingService.generateEmbeddings(texts);
        
        // Update nodes with embeddings
        for (let j = 0; j < batch.length; j++) {
          const node = batch[j];
          const embedding = embeddings[j];
          
          if (embedding) {
            try {
              await this.addEmbeddingToNode(node.id, node.project_id, embedding);
              updated++;
            } catch (error) {
              console.error(`Failed to update embedding for node ${node.id}:`, error);
              failed++;
            }
          } else {
            failed++;
          }
        }
      } catch (error) {
        console.error(`Failed to process batch starting at index ${i}:`, error);
        failed += batch.length;
      }

      processedBatches++;
      
      // Show progress with ETA every 10 batches or on last batch
      if (processedBatches % 10 === 0 || processedBatches === totalBatches) {
        const elapsedMs = Date.now() - startTime;
        const avgMsPerBatch = elapsedMs / processedBatches;
        const remainingBatches = totalBatches - processedBatches;
        const etaMs = avgMsPerBatch * remainingBatches;
        const etaStr = this.formatDuration(etaMs);
        const percent = Math.round((processedBatches / totalBatches) * 100);
        
        console.log(`⏳ Progress: ${percent}% (${updated + failed}/${nodes.length}) | ETA: ${etaStr}`);
      }
    }

    console.log(`✅ Embedding update completed. Updated: ${updated}, Failed: ${failed}`);
    return { updated, failed };
  }

  /**
   * Fetches enrichment context for a class/interface/enum node from the graph.
   * Queries EXTENDS, IMPLEMENTS, and CONTAINS edges plus child node metadata
   * to build a {@link NodeContext} used for class-level summary embeddings.
   *
   * @param node the class/interface/enum code node
   * @returns enrichment context gathered from graph relationships
   */
  private async fetchNodeContext(node: CodeNode): Promise<NodeContext> {
    const context: NodeContext = {};

    try {
      // Fetch superclass (EXTENDS edge)
      const extendsResult = await this.neo4jClient.runQuery(
        `MATCH (n:CodeNode {id: $id, project_id: $projectId})-[:EXTENDS]->(parent:CodeNode)
         RETURN parent.name AS name LIMIT 1`,
        { id: node.id, projectId: node.project_id }
      );
      if (extendsResult.records.length > 0) {
        context.superclass = extendsResult.records[0].get('name');
      }

      // Fetch implemented interfaces (IMPLEMENTS edges)
      const implResult = await this.neo4jClient.runQuery(
        `MATCH (n:CodeNode {id: $id, project_id: $projectId})-[:IMPLEMENTS]->(iface:CodeNode)
         RETURN iface.name AS name`,
        { id: node.id, projectId: node.project_id }
      );
      if (implResult.records.length > 0) {
        context.implemented_interfaces = implResult.records.map(r => r.get('name'));
      }

      // Fetch child methods (CONTAINS edges to method children)
      const methodsResult = await this.neo4jClient.runQuery(
        `MATCH (n:CodeNode {id: $id, project_id: $projectId})-[:CONTAINS]->(m:CodeNode)
         WHERE m.type = 'method'
         RETURN m.name AS name, m.modifiers AS modifiers`,
        { id: node.id, projectId: node.project_id }
      );
      if (methodsResult.records.length > 0) {
        const publicMethods: string[] = [];
        const privateMethods: string[] = [];
        for (const r of methodsResult.records) {
          const name = r.get('name');
          const modifiers: string[] = r.get('modifiers') || [];
          if (modifiers.includes('public')) {
            publicMethods.push(name);
          } else if (modifiers.includes('private')) {
            privateMethods.push(name);
          }
        }
        if (publicMethods.length > 0) {
          context.public_methods = publicMethods;
        }
        if (privateMethods.length > 0) {
          context.important_private_methods = privateMethods;
        }
      }

      // Fetch injected dependencies (fields with @Inject annotation)
      const depsResult = await this.neo4jClient.runQuery(
        `MATCH (n:CodeNode {id: $id, project_id: $projectId})-[:CONTAINS]->(f:CodeNode)
         WHERE f.type = 'field'
         RETURN f.name AS name, f.attributes AS attributes`,
        { id: node.id, projectId: node.project_id }
      );
      if (depsResult.records.length > 0) {
        const injected: string[] = [];
        const repos: string[] = [];
        for (const r of depsResult.records) {
          const attrs = r.get('attributes');
          const parsed = attrs ? (typeof attrs === 'string' ? JSON.parse(attrs) : attrs) : {};
          const annotations: Array<{ name: string }> = parsed?.annotations || [];
          const isInjected = annotations.some(a =>
            a.name === '@Inject' || a.name === '@Autowired'
          );
          if (isInjected) {
            const fieldName = r.get('name');
            injected.push(fieldName);
            if (fieldName.toLowerCase().includes('repository')) {
              repos.push(fieldName);
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

      // Derive module from source_file path
      if (node.source_file) {
        const moduleMatch = node.source_file.match(/(?:^|[/\\])((?:bc|ac|app|pf|ft|sld|init|orm)_[^/\\]+)/);
        if (moduleMatch) {
          context.module = moduleMatch[1];
        }
      }

      // Derive architectural role from naming conventions and annotations
      context.architectural_role = this.inferArchitecturalRole(node);

    } catch (error) {
      console.warn(`Failed to fetch context for node ${node.id}:`, error instanceof Error ? error.message : 'Unknown error');
    }

    return context;
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
