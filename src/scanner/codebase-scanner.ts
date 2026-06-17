import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { Neo4jClient } from '../graph/neo4j-client.js';
import { NodeManager } from '../graph/node-manager.js';
import { EdgeManager } from '../graph/edge-manager.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { SemanticSearchManager } from '../services/semantic-search-manager.js';
import { getSemanticSearchConfig } from '../config.js';
import { TypeScriptParser } from './parsers/typescript-parser.js';
import { JavaParser } from './parsers/java-parser.js';
import { PythonParser } from './parsers/python-parser.js';
import { PipelineParser } from './parsers/pipeline-parser.js';
import { 
  ScanConfig, 
  ParseResult, 
  LanguageParser, 
  ParsedEntity, 
  ParsedRelationship,
  Language,
  ProjectDetectionResult 
} from './types.js';
import { ProjectLanguageDetector } from './detection/language-detector.js';
import { ProjectBuildFileDetector } from './detection/build-file-detector.js';
import { GitRepositoryManager, GitAuthConfig } from './git/index.js';

export class CodebaseScanner {
  private parsers: Map<Language, LanguageParser>;
  private nodeManager: NodeManager;
  private edgeManager: EdgeManager;
  private embeddingService: EmbeddingService;
  private semanticSearchManager: SemanticSearchManager;
  private languageDetector: ProjectLanguageDetector;
  private buildFileDetector: ProjectBuildFileDetector;
  private gitManager: GitRepositoryManager;

  constructor(private client: Neo4jClient) {
    this.nodeManager = new NodeManager(client);
    this.edgeManager = new EdgeManager(client);
    this.embeddingService = new EmbeddingService();
    this.semanticSearchManager = new SemanticSearchManager(client, this.embeddingService);
    this.languageDetector = new ProjectLanguageDetector();
    this.buildFileDetector = new ProjectBuildFileDetector();
    this.gitManager = new GitRepositoryManager();
    
    // Initialize parsers
    this.parsers = new Map();
    const tsParser = new TypeScriptParser();
    this.parsers.set('typescript', tsParser);
    this.parsers.set('javascript', tsParser);
    this.parsers.set('java', new JavaParser());
    this.parsers.set('python', new PythonParser());
  }

  async scanProject(config: ScanConfig): Promise<ParseResult> {
    const startTime = Date.now();
    
    let actualProjectPath = config.projectPath;
    let isTemporaryPath = false;

    // Handle remote repository cloning
    if (config.isRemote && config.gitUrl) {
      console.log(`🔍 Starting remote codebase scan for project '${config.projectId}': ${config.gitUrl}`);
      
      try {
        actualProjectPath = await this.gitManager.cloneRepository(config.gitUrl, {
          branch: config.gitBranch,
          depth: 1, // Shallow clone for efficiency
          singleBranch: true,
          tempDir: config.tempDir,
          useCache: config.useCache,
          cacheOptions: config.cacheOptions,
          progressCallback: config.outputProgress ? (progress) => {
            console.log(`📊 ${progress.message} ${progress.percentage ? `(${Math.round(progress.percentage)}%)` : ''}`);
          } : undefined
        });
        isTemporaryPath = true;
        console.log(`📥 Repository cloned to: ${actualProjectPath}`);
      } catch (error) {
        throw new Error(`Failed to clone remote repository: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else {
      console.log(`🔍 Starting local codebase scan for project '${config.projectId}': ${config.projectPath}`);
    }
    
    // Create updated config with actual path
    const actualConfig: ScanConfig = {
      ...config,
      projectPath: actualProjectPath
    };
    
    // Ensure project exists in database
    await this.ensureProjectExists(actualConfig);
    
    const allErrors: any[] = [];
    let filesProcessed = 0;
    let totalEntities = 0;
    let totalRelationships = 0;

    try {
      // Find all source files
      const files = await this.findSourceFiles(actualConfig);
      console.log(`📁 Found ${files.length} source files`);

      // Process and store files in streaming batches to avoid heap overflow
      const fileBatchSize = 50;
      const storeBatchSize = 1000; // Store to DB every N files
      let pendingEntities: ParsedEntity[] = [];
      let pendingRelationships: ParsedRelationship[] = [];

      for (let i = 0; i < files.length; i += fileBatchSize) {
        const batch = files.slice(i, i + fileBatchSize);
        const batchResults = await Promise.all(
          batch.map(file => this.processFile(file, actualConfig))
        );

        for (const result of batchResults) {
          if (result) {
            for (const entity of result.entities) {
              pendingEntities.push(entity);
            }
            for (const rel of result.relationships) {
              pendingRelationships.push(rel);
            }
            for (const err of result.errors) {
              allErrors.push(err);
            }
            filesProcessed++;
          }
        }

        // Store incrementally to keep memory usage bounded
        if (filesProcessed % storeBatchSize < fileBatchSize && pendingEntities.length > 0) {
          console.log(`💾 Storing batch: ${pendingEntities.length} entities, ${pendingRelationships.length} relationships (${filesProcessed}/${files.length} files)...`);
          const storeErrors = await this.storeInGraph(pendingEntities, pendingRelationships, actualConfig.skipEmbeddings);
          for (const err of storeErrors) {
            allErrors.push(err);
          }
          totalEntities += pendingEntities.length;
          totalRelationships += pendingRelationships.length;
          pendingEntities = [];
          pendingRelationships = [];
        }

        if (actualConfig.outputProgress && i % 1000 < fileBatchSize) {
          console.log(`📊 Processed ${Math.min(i + fileBatchSize, files.length)}/${files.length} files`);
        }
      }

      // Store remaining entities/relationships
      if (pendingEntities.length > 0) {
        console.log(`💾 Storing final batch: ${pendingEntities.length} entities, ${pendingRelationships.length} relationships...`);
        const storeErrors = await this.storeInGraph(pendingEntities, pendingRelationships, actualConfig.skipEmbeddings);
        for (const err of storeErrors) {
          allErrors.push(err);
        }
        totalEntities += pendingEntities.length;
        totalRelationships += pendingRelationships.length;
        pendingEntities = [];
        pendingRelationships = [];
      }

      const processingTimeMs = Date.now() - startTime;
      
      const result: ParseResult = {
        entities: [],
        relationships: [],
        errors: allErrors,
        stats: {
          filesProcessed,
          entitiesFound: totalEntities,
          relationshipsFound: totalRelationships,
          processingTimeMs
        }
      };

      console.log(`✅ Scan completed successfully!`);
      console.log(`   Files processed: ${filesProcessed}`);
      console.log(`   Entities found: ${totalEntities}`);
      console.log(`   Relationships found: ${totalRelationships}`);
      console.log(`   Processing time: ${(processingTimeMs / 1000).toFixed(2)}s`);
      
      if (allErrors.length > 0) {
        console.log(`⚠️  Warnings/Errors: ${allErrors.length}`);
      }

      return result;

    } catch (error) {
      console.error(`❌ Scan failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      // Cleanup temporary directory for remote repositories
      if (isTemporaryPath && (config.cleanupTemp !== false)) {
        try {
          await this.gitManager.cleanup(actualProjectPath);
        } catch (cleanupError) {
          console.warn(`⚠️  Failed to cleanup temporary directory: ${cleanupError instanceof Error ? cleanupError.message : 'Unknown error'}`);
        }
      }
    }
  }

  async clearGraph(projectId?: string): Promise<void> {
    const BATCH_SIZE = 2000;

    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const deleteBatched = async (
      relQuery: string,
      nodeQuery: string,
      params: Record<string, unknown>,
      label: string
    ): Promise<void> => {
      // Phase 1: delete relationships in batches
      let relCount = 0;
      let batchCount = 0;
      do {
        const result = await this.client.runQuery(relQuery, params);
        relCount = result.records[0]?.get('deleted')?.toNumber?.() || result.records[0]?.get('deleted') || 0;
        batchCount++;
        if (relCount > 0) {
          console.log(`   Rel batch ${batchCount}: deleted ${relCount} relationships...`);
          await sleep(100); // Allow Neo4j to flush WAL between batches
        }
      } while (relCount > 0);

      // Phase 2: delete nodes in batches (no relationships remain, so DELETE is safe)
      let nodeCount = 0;
      batchCount = 0;
      do {
        const result = await this.client.runQuery(nodeQuery, params);
        nodeCount = result.records[0]?.get('deleted')?.toNumber?.() || result.records[0]?.get('deleted') || 0;
        batchCount++;
        if (nodeCount > 0) {
          console.log(`   Node batch ${batchCount}: deleted ${nodeCount} nodes...`);
          await sleep(100); // Allow Neo4j to flush WAL between batches
        }
      } while (nodeCount > 0);

      console.log(`✅ ${label} graph data cleared`);
    };

    if (projectId) {
      console.log(`🗑️  Clearing graph data for project '${projectId}'...`);
      await deleteBatched(
        `MATCH (n:CodeNode {project_id: $project_id})-[r]-()
         WITH r LIMIT ${BATCH_SIZE}
         DELETE r
         RETURN count(*) as deleted`,
        `MATCH (n:CodeNode {project_id: $project_id})
         WITH n LIMIT ${BATCH_SIZE}
         DELETE n
         RETURN count(*) as deleted`,
        { project_id: projectId },
        `Project '${projectId}'`
      );
    } else {
      console.log(`🗑️  Clearing all graph data...`);
      await deleteBatched(
        `MATCH ()-[r]-()
         WITH r LIMIT ${BATCH_SIZE}
         DELETE r
         RETURN count(*) as deleted`,
        `MATCH (n)
         WITH n LIMIT ${BATCH_SIZE}
         DELETE n
         RETURN count(*) as deleted`,
        {},
        'All'
      );
    }
  }

  private async ensureProjectExists(config: ScanConfig): Promise<void> {
    try {
      // Check if project already exists
      const existingProject = await this.client.getProject(config.projectId);
      
      if (!existingProject) {
        // Create new project
        console.log(`📋 Creating project '${config.projectId}'...`);
        await this.client.createProject({
          project_id: config.projectId,
          name: config.projectName || config.projectId,
          description: `Scanned from ${config.projectPath}`
        });
        console.log(`✅ Project '${config.projectId}' created`);
      } else {
        console.log(`📋 Using existing project '${config.projectId}'`);
      }
    } catch (error) {
      console.warn(`⚠️ Failed to create/verify project: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async validateProjectStructure(projectPath: string): Promise<ProjectDetectionResult> {
    // Check if path exists
    if (!fs.existsSync(projectPath)) {
      return {
        isValid: false,
        suggestions: [`Project path does not exist: ${projectPath}`],
        detectedLanguages: [],
        projectMetadata: [],
        subProjects: [],
        isMonoRepo: false
      };
    }

    try {
      // Use the new comprehensive detection system
      const result = await this.buildFileDetector.detect(projectPath);
      
      // If no build files found, fallback to file extension detection
      if (result.detectedLanguages.length === 0) {
        const extensionLanguages = await this.languageDetector.detectFromFileExtensions(projectPath);
        result.detectedLanguages = extensionLanguages;
        result.suggestions.push('💡 No build files detected - using file extension detection');
        
        if (extensionLanguages.length === 0) {
          result.suggestions.push('⚠️ No source files found - check project path and file extensions');
          result.isValid = false;
        } else {
          result.isValid = true;
        }
      }

      // Add recommendations for project structure
      const srcDirExists = fs.existsSync(path.join(projectPath, 'src'));
      if (!srcDirExists && result.detectedLanguages.length > 0) {
        result.suggestions.push('💡 Consider organizing code in a src/ directory for better analysis');
      }

      // Add language validation warnings
      const validation = this.languageDetector.validateLanguages(result.detectedLanguages);
      result.suggestions.push(...validation.warnings);

      return result;
    } catch (error) {
      return {
        isValid: false,
        suggestions: [`❌ Failed to analyze project structure: ${error instanceof Error ? error.message : String(error)}`],
        detectedLanguages: [],
        projectMetadata: [],
        subProjects: [],
        isMonoRepo: false
      };
    }
  }

  /**
   * Get recommended scan configuration with auto-detected languages and metadata
   */
  async getRecommendedScanConfig(projectPath: string, projectId?: string): Promise<{
    scanConfig: Partial<ScanConfig>;
    projectMetadata: any[];
    suggestions: string[];
  }> {
    const detection = await this.validateProjectStructure(projectPath);
    const recommendation = await this.languageDetector.getRecommendedScanConfig(projectPath);

    const scanConfig: Partial<ScanConfig> = {
      projectPath,
      projectId: projectId || path.basename(projectPath),
      languages: recommendation.languages,
      excludePaths: recommendation.excludePaths,
      includeTests: recommendation.includeTests
    };

    // Extract project name from metadata if available
    const primaryMetadata = detection.projectMetadata.find(m => 
      m.language === recommendation.primaryLanguage
    ) || detection.projectMetadata[0];

    if (primaryMetadata?.name) {
      scanConfig.projectName = primaryMetadata.name;
    }

    return {
      scanConfig,
      projectMetadata: detection.projectMetadata,
      suggestions: [...detection.suggestions, ...recommendation.suggestions]
    };
  }

  private async findSourceFiles(config: ScanConfig): Promise<string[]> {
    const patterns = this.getFilePatterns(config.languages, config.includeTests);
    const excludePatterns = [
      'node_modules/**',
      'dist/**',
      'build/**',
      '.git/**',
      'coverage/**',
      '**/*.d.ts',
      ...(config.excludePaths || [])
    ];

    if (!config.includeTests) {
      excludePatterns.push('**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**');
    }

    const files: string[] = [];
    
    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: config.projectPath,
        ignore: excludePatterns,
        absolute: true
      });
      for (const match of matches) {
        files.push(match);
      }
    }

    // Remove duplicates and sort
    return [...new Set(files)].sort();
  }

  private getFilePatterns(languages: Language[], includeTests: boolean = false): string[] {
    const patterns: string[] = [];
    
    if (languages.includes('typescript')) {
      patterns.push('**/*.ts', '**/*.tsx');
    }
    if (languages.includes('javascript')) {
      patterns.push('**/*.js', '**/*.jsx');
    }
    if (languages.includes('java')) {
      // For Java, include ALL .java files to support various project structures:
      // - Standard Maven/Gradle: src/main/java, src/test/java
      // - Legacy projects: src/**/*.java
      // - Multi-module projects: modules/*/src/**/*.java
      // - Non-standard structures: any .java file
      patterns.push('**/*.java');
      // Note: Test files are excluded by excludePatterns if includeTests is false
    }
    if (languages.includes('python')) {
      patterns.push('**/*.py');
    }
    if (languages.includes('csharp')) {
      patterns.push('**/*.cs');
    }

    return patterns;
  }

  private async processFile(filePath: string, config: ScanConfig): Promise<{
    entities: ParsedEntity[];
    relationships: ParsedRelationship[];
    errors: any[];
  } | null> {
    try {
      // Find appropriate parser
      const parser = this.findParser(filePath);
      if (!parser) {
        return null;
      }

      // Read file content
      const content = await fs.promises.readFile(filePath, 'utf-8');
      
      // Convert to relative path for storage (avoids storing temporary absolute paths)
      const relativePath = path.relative(config.projectPath, filePath).replace(/\\/g, '/');
      
      // Parse the file
      const result = await parser.parseFile(relativePath, content, config.projectId);
      
      return result;

    } catch (error) {
      const errorRelativePath = path.relative(config.projectPath, filePath).replace(/\\/g, '/');
      console.warn(`⚠️ Failed to process ${errorRelativePath}: ${error instanceof Error ? error.message : String(error)}`);
      return {
        entities: [],
        relationships: [],
        errors: [{
          file: errorRelativePath,
          message: error instanceof Error ? error.message : String(error),
          severity: 'error'
        }]
      };
    }
  }

  private findParser(filePath: string): LanguageParser | null {
    for (const parser of this.parsers.values()) {
      if (parser.canParse(filePath)) {
        return parser;
      }
    }
    return null;
  }

  private async storeInGraph(entities: ParsedEntity[], relationships: ParsedRelationship[], skipEmbeddings?: boolean): Promise<any[]> {
    console.log(`📥 Storing entities...`);
    const errors: any[] = [];
    
    // Deduplicate entities by ID + project_id
    const entityMap = new Map<string, ParsedEntity>();
    for (const entity of entities) {
      const key = `${entity.project_id}:${entity.id}`;
      if (!entityMap.has(key)) {
        entityMap.set(key, entity);
      }
    }
    const deduplicatedEntities = Array.from(entityMap.values());
    
    console.log(`📥 Deduplicated ${entities.length} entities to ${deduplicatedEntities.length}`);
    
    // Debug: log entity type counts
    const entityTypeCounts = deduplicatedEntities.reduce((acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log(`📋 Entity types:`, entityTypeCounts);
    
    // Store entities using batch UNWIND for high throughput
    const successfullyStoredEntities: ParsedEntity[] = [];
    const nodeBatchResult = await this.nodeManager.addNodesBatch(
      deduplicatedEntities.map(entity => ({
        id: entity.id,
        project_id: entity.project_id,
        type: entity.type as any,
        name: entity.name,
        qualified_name: entity.qualified_name,
        description: entity.description,
        source_file: entity.source_file,
        start_line: entity.start_line,
        end_line: entity.end_line,
        modifiers: entity.modifiers,
        is_abstract: (entity.modifiers || []).includes('abstract'),
        attributes: entity.attributes
      }))
    );

    // Track successfully stored entities for embedding generation
    const failedEntityIds = new Set(nodeBatchResult.errors.map(e => e.node.id));
    for (const entity of deduplicatedEntities) {
      if (!failedEntityIds.has(entity.id)) {
        successfullyStoredEntities.push(entity);
      }
    }

    for (const { node, error } of nodeBatchResult.errors) {
      console.warn(`Failed to store entity ${node.id}: ${error}`);
      errors.push({
        type: 'node_creation_error',
        entity_id: node.id,
        message: error,
        severity: 'error'
      });
    }

    console.log(`🔗 Storing relationships...`);
    
    // Deduplicate relationships by ID + project_id
    const relationshipMap = new Map<string, ParsedRelationship>();
    for (const relationship of relationships) {
      const key = `${relationship.project_id}:${relationship.id}`;
      if (!relationshipMap.has(key)) {
        relationshipMap.set(key, relationship);
      }
    }
    const deduplicatedRelationships = Array.from(relationshipMap.values());
    
    // Check if relationship sources/targets exist in entities
    const entityIds = new Set(deduplicatedEntities.map(e => e.id));

    // For every edge whose target is not in the current scan (e.g. a framework
    // interface shipped as a JAR, or a method in another cartridge), create a
    // lightweight stub node so the edge can be stored and later queried.
    // We use the project_id of the source entity as the owner.
    const stubsToStore: ParsedEntity[] = [];
    for (const r of deduplicatedRelationships) {
      if (!entityIds.has(r.target)) {
        // Determine stub type based on edge type
        let stubType: 'class' | 'interface' | 'method';
        if (r.type === 'implements' || r.type === 'extends') {
          stubType = 'interface';
        } else if (r.type === 'calls') {
          stubType = 'method';
        } else if (r.type === 'references') {
          stubType = 'class';
        } else {
          // Skip other edge types (contains, belongs_to, etc.) — their targets
          // should always be in the same scan batch
          continue;
        }

        // Derive project_id from the source entity
        const sourceEntity = deduplicatedEntities.find(e => e.id === r.source);
        const projectId = sourceEntity?.project_id ?? r.project_id;
        const stub: ParsedEntity = {
          id: r.target,
          project_id: projectId,
          type: stubType,
          name: r.target.split('.').pop() ?? r.target,
          qualified_name: r.target,
          source_file: 'external',
          modifiers: [],
          annotations: []
        };
        entityIds.add(r.target); // prevent duplicates in subsequent loop iterations
        stubsToStore.push(stub);
      }
    }

    if (stubsToStore.length > 0) {
      console.log(`📋 Creating ${stubsToStore.length} stub nodes for external/cross-cartridge targets`);
      await this.nodeManager.addNodesBatch(
        stubsToStore.map(stub => ({
          id: stub.id,
          project_id: stub.project_id,
          type: stub.type as any,
          name: stub.name,
          qualified_name: stub.qualified_name,
          source_file: stub.source_file,
          modifiers: stub.modifiers,
          attributes: {}
        }))
      );
    }

    // Filter out relationships where source doesn't exist.
    // Targets for implements, extends, calls, and references edges are now
    // guaranteed to exist (either scanned or stub).
    const storableRelationships = deduplicatedRelationships.filter(r => {
      if (!entityIds.has(r.source)) return false;
      if (!entityIds.has(r.target)) return false;
      return true;
    });

    // Count skipped relationships by type for informational logging
    const skippedByType: Record<string, number> = {};
    for (const r of deduplicatedRelationships) {
      if (!entityIds.has(r.source) || !entityIds.has(r.target)) {
        skippedByType[r.type] = (skippedByType[r.type] || 0) + 1;
      }
    }

    const totalSkipped = deduplicatedRelationships.length - storableRelationships.length;
    if (totalSkipped > 0) {
      console.log(`📋 Skipping ${totalSkipped} relationships with external/missing targets:`);
      for (const [type, count] of Object.entries(skippedByType).sort((a, b) => b[1] - a[1])) {
        console.log(`   - ${type}: ${count}`);
      }
    }
    
    console.log(`📋 Storing ${storableRelationships.length} relationships`);

    // Batch-insert relationships grouped by type using UNWIND queries.
    // This replaces the previous one-by-one approach and reduces DB round-trips
    // from N to ceil(N / 500) * numTypes.
    const edgeBatchResult = await this.edgeManager.addEdgesBatch(
      storableRelationships.map(r => ({
        id: r.id,
        project_id: r.project_id,
        type: r.type as any,
        source: r.source,
        target: r.target,
        attributes: r.attributes
      }))
    );

    const storedCount = edgeBatchResult.stored;

    for (const { edge, error } of edgeBatchResult.errors) {
      if (!error.includes('already exists')) {
        console.warn(`Failed to store relationship ${edge.id}: ${error}`);
        errors.push({
          type: 'edge_creation_error',
          relationship_id: edge.id,
          source: edge.source,
          target: edge.target,
          message: error,
          severity: 'error'
        });
      }
    }

    // Generate embeddings if semantic search is enabled and not skipped
    if (skipEmbeddings) {
      console.log(`🧠 Skipping embedding generation (--no-embeddings flag)`);
    } else if (this.embeddingService.isEnabled()) {
      console.log(`🧠 Generating semantic embeddings for ${successfullyStoredEntities.length} entities...`);
      try {
        // Ensure the Neo4j vector index exists before embeddings are written.
        // Without this index, db.index.vector.queryNodes (used by semantic search
        // and get_similar_code) fails at query time. The CREATE ... IF NOT EXISTS
        // statement is idempotent, so calling it on every scan is safe and cheap.
        await this.semanticSearchManager.initializeVectorIndexes();

        const embeddingResult = await this.generateEmbeddingsForEntities(successfullyStoredEntities);
        console.log(`✅ Generated embeddings for ${embeddingResult.successful} entities (${embeddingResult.failed} failed)`);
        
        if (embeddingResult.failed > 0) {
          errors.push({
            type: 'embedding_generation_error',
            message: `Failed to generate embeddings for ${embeddingResult.failed} entities`,
            severity: 'warning'
          });
        }
      } catch (error) {
        console.warn(`⚠️ Failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`);
        errors.push({
          type: 'embedding_generation_error',
          message: error instanceof Error ? error.message : String(error),
          severity: 'warning'
        });
      }
    } else {
      console.log(`🧠 Semantic search disabled, skipping embedding generation`);
    }
    
    return errors;
  }

  async generateScanReport(result: ParseResult): Promise<string> {
    const { stats, entities, relationships, errors } = result;
    
    // Analyze entities by type
    const entityTypes = entities.reduce((acc, entity) => {
      acc[entity.type] = (acc[entity.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Analyze relationships by type
    const relationshipTypes = relationships.reduce((acc, rel) => {
      acc[rel.type] = (acc[rel.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Find largest classes (by method count)
    const classMethodCounts = relationships
      .filter(r => r.type === 'contains' && entities.find(e => e.id === r.target)?.type === 'method')
      .reduce((acc, r) => {
        acc[r.source] = (acc[r.source] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    const topClasses = Object.entries(classMethodCounts)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5)
      .map(([classId, count]) => {
        const entity = entities.find(e => e.id === classId);
        return `  • ${entity?.name || classId}: ${count} methods`;
      });

    const report = `
📊 CODEBASE SCAN REPORT
═══════════════════════

📈 STATISTICS
  Files processed: ${stats.filesProcessed}
  Entities found: ${stats.entitiesFound}
  Relationships found: ${stats.relationshipsFound}
  Processing time: ${(stats.processingTimeMs / 1000).toFixed(2)}s
  ${errors.length > 0 ? `Errors/Warnings: ${errors.length}` : ''}

🏗️ ENTITY BREAKDOWN
${Object.entries(entityTypes)
  .sort(([,a], [,b]) => b - a)
  .map(([type, count]) => `  • ${type}: ${count}`)
  .join('\n')}

🔗 RELATIONSHIP BREAKDOWN
${Object.entries(relationshipTypes)
  .sort(([,a], [,b]) => b - a)
  .map(([type, count]) => `  • ${type}: ${count}`)
  .join('\n')}

🏆 LARGEST CLASSES (by method count)
${topClasses.join('\n') || '  No classes found'}

${errors.length > 0 ? `
⚠️ ISSUES DETECTED
${errors.slice(0, 10).map(e => `  • ${e.file_path}: ${e.message}`).join('\n')}
${errors.length > 10 ? `  ... and ${errors.length - 10} more` : ''}
` : '✅ No issues detected'}

`;

    return report;
  }

  private async generateEmbeddingsForEntities(entities: ParsedEntity[]): Promise<{ successful: number; failed: number }> {
    let successful = 0;
    let failed = 0;

    // Get config for entity type filtering
    const semanticConfig = getSemanticSearchConfig();
    const allowedTypes = semanticConfig.embed_entity_types || ['class', 'interface', 'method', 'function', 'enum'];

    // Filter entities that would benefit from embeddings
    const relevantEntities = entities.filter(entity => 
      allowedTypes.includes(entity.type as any) &&
      (entity.description || entity.name || entity.qualified_name)
    );

    if (relevantEntities.length === 0) {
      return { successful: 0, failed: 0 };
    }

    console.log(`📊 Filtering: ${entities.length} total → ${relevantEntities.length} entities to embed (types: ${allowedTypes.join(', ')})`);

    // Process in batches to avoid overwhelming the API
    const batchSize = semanticConfig.batch_size || 50;
    const totalBatches = Math.ceil(relevantEntities.length / batchSize);
    const startTime = Date.now();
    let processedBatches = 0;

    for (let i = 0; i < relevantEntities.length; i += batchSize) {
      const batch = relevantEntities.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      
      try {
        // Extract semantic content for the batch
        const contents = batch.map(entity => this.embeddingService.extractSemanticContent(entity));
        
        // Generate embeddings
        const embeddings = await this.embeddingService.generateEmbeddings(contents);
        
        // Store embeddings
        for (let j = 0; j < batch.length; j++) {
          const entity = batch[j];
          const embedding = embeddings[j];
          
          if (embedding) {
            try {
              await this.semanticSearchManager.addEmbeddingToNode(
                entity.id, 
                entity.project_id, 
                embedding
              );
              successful++;
            } catch (error) {
              console.warn(`Failed to store embedding for entity ${entity.id}:`, error);
              failed++;
            }
          } else {
            failed++;
          }
        }
      } catch (error) {
        console.warn(`Failed to process embedding batch starting at index ${i}:`, error);
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
        
        console.log(`⏳ Progress: ${percent}% (${successful + failed}/${relevantEntities.length}) | ETA: ${etaStr}`);
      }
    }

    return { successful, failed };
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

  async scanRemoteRepository(
    gitUrl: string, 
    config: Omit<ScanConfig, 'projectPath' | 'isRemote' | 'gitUrl'>
  ): Promise<ParseResult> {
    const remoteConfig: ScanConfig = {
      ...config,
      projectPath: '', // Will be set by cloning
      isRemote: true,
      gitUrl,
      cleanupTemp: true
    };
    
    return this.scanProject(remoteConfig);
  }

  /**
   * Store a relationship with retry logic for handling Neo4j deadlocks
   */
  private async storeRelationshipWithRetry(
    relationship: ParsedRelationship, 
    maxRetries: number
  ): Promise<void> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.edgeManager.addEdge({
          id: relationship.id,
          project_id: relationship.project_id,
          type: relationship.type as any,
          source: relationship.source,
          target: relationship.target,
          attributes: relationship.attributes
        });
        return; // Success
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Check if it's a deadlock/lock error that's worth retrying
        const isDeadlock = lastError.message.includes('DeadlockDetected') ||
                          lastError.message.includes("can't acquire") ||
                          lastError.message.includes('ExclusiveLock') ||
                          lastError.message.includes('ForsetiClient');
        
        if (isDeadlock && attempt < maxRetries) {
          // Wait with exponential backoff before retry
          const waitMs = Math.min(100 * Math.pow(2, attempt), 2000);
          await new Promise(resolve => setTimeout(resolve, waitMs));
          continue;
        }
        
        // Not a deadlock or max retries reached, throw the error
        throw lastError;
      }
    }
    
    throw lastError || new Error('Failed to store relationship after retries');
  }

  async validateRemoteRepository(gitUrl: string): Promise<boolean> {
    try {
      await this.gitManager.validateRepository(gitUrl);
      return true;
    } catch {
      return false;
    }
  }

  isGitUrl(url: string): boolean {
    return this.gitManager.isGitUrl(url);
  }

  parseGitUrl(url: string) {
    return this.gitManager.parseGitUrl(url);
  }

  updateGitAuthConfig(authConfig: GitAuthConfig): void {
    this.gitManager.updateAuthConfig(authConfig);
  }

  async clearCache(): Promise<void> {
    await this.gitManager.clearCache();
  }

  async getCacheStats() {
    return this.gitManager.getCacheStats();
  }
}