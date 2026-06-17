#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from '../config.js';
import { Neo4jClient, DEFAULT_BRANCH } from '../graph/neo4j-client.js';
import { CodebaseScanner } from '../scanner/codebase-scanner.js';
import { MetricsManager } from '../analysis/metrics-manager.js';
import { ScanConfig, Language } from '../scanner/types.js';

const program = new Command();

program
  .name('coderag-scan')
  .description(`Scan a codebase and populate the CodeRAG graph database

Authentication for private repositories:
  Set environment variables:
  - GITHUB_TOKEN for GitHub repositories
  - GITLAB_TOKEN for GitLab repositories  
  - BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD for Bitbucket
  - AZURE_DEVOPS_PAT for Azure Repos (Personal Access Token)
  
Examples:
  coderag-scan ./my-project
  coderag-scan https://github.com/owner/repo.git
  GITHUB_TOKEN=ghp_xxx coderag-scan https://github.com/private/repo.git
  AZURE_DEVOPS_PAT=xxx coderag-scan https://dev.azure.com/org/project/_git/repo`)
  .version('1.0.0');

program
  .argument('<project-path>', 'Path to the project directory to scan or Git URL')
  .option('-p, --project-id <id>', 'Project ID for multi-project separation')
  .option('-n, --project-name <name>', 'Project name (defaults to project ID or directory name)')
  .option('-l, --languages <languages>', 'Comma-separated list of languages to scan (auto-detected if not specified)')
  .option('-e, --exclude <paths>', 'Comma-separated list of paths to exclude', 'node_modules,dist,build')
  .option('--include-tests', 'Include test files in the scan', false)
  .option('--clear-graph', 'Clear existing graph data for this project before scanning', false)
  .option('--clear-all', 'Clear ALL graph data (all projects) before scanning', false)
  .option('--reindex', 'Atomic blue-green reindex: scan into a temporary project, then swap it into the target project_id only after a successful scan (no query downtime, safe to abort). Recommended for refreshing an existing branch.', false)
  .option('-y, --yes', 'Skip safety confirmations (e.g. --clear-all on a non-default branch)', false)
  .option('--analyze', 'Run quality analysis after scanning', false)
  .option('--output-report', 'Generate and save a scan report', false)
  .option('--validate-only', 'Only validate the project structure without scanning', false)
  .option('--branch <branch>', 'Branch to index. Folded into the project_id so Neo4j can hold multiple branches in parallel (default "main" = no suffix). Also used as the checkout branch for remote repos.', 'main')
  .option('--no-cleanup', 'Keep temporary files after scanning (for debugging)')
  .option('--use-cache', 'Enable repository caching for faster subsequent scans', false)
  .option('--clear-cache', 'Clear git repository cache before scanning', false)
  .option('--no-embeddings', 'Skip automatic embedding generation after scan')
  .option('-v, --verbose', 'Show detailed progress information', false)
  .action(async (projectPath: string, options) => {
    // Tracks the temporary project_id created for an atomic --reindex so it can be
    // cleaned up if the scan fails before the swap completes.
    let reindexTempId: string | null = null;
    let client: Neo4jClient | null = null;
    try {
      console.log(`🚀 CodeRAG Scanner v1.0.0`);

      // Initialize Neo4j connection first for git URL validation
      const config = getConfig();
      client = new Neo4jClient(config);
      await client.connect();
      console.log(`🔗 Connected to Neo4j: ${config.uri}`);
      
      // Initialize scanner with authentication configuration
      const scanner = new CodebaseScanner(client);
      
      // Configure git authentication from environment variables
      const gitAuthConfig = {
        github: {
          token: process.env.GITHUB_TOKEN
        },
        gitlab: {
          token: process.env.GITLAB_TOKEN,
          host: process.env.GITLAB_HOST
        },
        bitbucket: {
          username: process.env.BITBUCKET_USERNAME,
          appPassword: process.env.BITBUCKET_APP_PASSWORD
        },
        azure: {
          pat: process.env.AZURE_DEVOPS_PAT,
          organization: process.env.AZURE_DEVOPS_ORG
        }
      };
      
      scanner.updateGitAuthConfig(gitAuthConfig);
      
      // Handle cache clearing for remote repositories
      if (options.clearCache && options.useCache) {
        console.log(`🧹 Clearing git repository cache...`);
        await scanner.clearCache();
      }
      
      let resolvedPath: string;
      let isRemote = false;
      let gitUrl: string | undefined;

      // Check if input is a git URL
      if (scanner.isGitUrl(projectPath)) {
        console.log(`🌐 Remote repository detected: ${projectPath}`);
        
        // Validate remote repository
        console.log(`🔍 Validating remote repository...`);
        const isValid = await scanner.validateRemoteRepository(projectPath);
        if (!isValid) {
          console.error(`❌ Remote repository is not accessible: ${projectPath}`);
          await client.disconnect();
          process.exit(1);
        }
        
        isRemote = true;
        gitUrl = projectPath;
        resolvedPath = ''; // Will be set during cloning
        console.log(`✅ Remote repository is accessible`);
      } else {
        // Handle as local path
        resolvedPath = path.resolve(projectPath);
        
        if (!fs.existsSync(resolvedPath)) {
          console.error(`❌ Project path does not exist: ${resolvedPath}`);
          await client.disconnect();
          process.exit(1);
        }
        
        console.log(`📁 Local project: ${resolvedPath}`);
      }

      // Get project ID (for remote repos, extract from URL)
      let projectId = options.projectId;
      if (!projectId) {
        if (isRemote && gitUrl) {
          const parsedUrl = scanner.parseGitUrl(gitUrl);
          projectId = `${parsedUrl.owner}-${parsedUrl.repo}`;
        } else {
          projectId = path.basename(resolvedPath);
        }
      }

      // Get recommended scan configuration with auto-detection
      if (isRemote) {
        console.log(`🔍 Remote repository will be analyzed after cloning...`);
      } else {
        console.log(`🔍 Analyzing project structure and detecting languages...`);
      }
      
      let recommendation;
      if (!isRemote) {
        recommendation = await scanner.getRecommendedScanConfig(resolvedPath, projectId);
        
        console.log(`\n📋 Project Analysis:`);
        recommendation.suggestions.forEach(suggestion => console.log(`  ${suggestion}`));
        
        // Show detected project metadata
        if (recommendation.projectMetadata.length > 0) {
          console.log(`\n📦 Project Metadata:`);
          recommendation.projectMetadata.forEach(meta => {
            console.log(`  📄 ${meta.name || 'Unnamed'} (${meta.language})`);
            if (meta.version) console.log(`    Version: ${meta.version}`);
            if (meta.description) console.log(`    Description: ${meta.description}`);
            if (meta.framework) console.log(`    Framework: ${meta.framework}`);
            if (meta.buildSystem) console.log(`    Build System: ${meta.buildSystem}`);
          });
        }
        
        if (!recommendation.scanConfig.languages?.length) {
          console.error(`\n❌ No supported languages detected. Please check the project structure.`);
          await client.disconnect();
          process.exit(1);
        }
      }
      
      if (options.validateOnly) {
        if (isRemote) {
          console.log(`\n✅ Remote repository validation completed.`);
        } else {
          console.log(`\n✅ Project structure validation completed.`);
        }
        await client.disconnect();
        return;
      }
      
      // Use recommended configuration or defaults for remote repositories
      let languages: Language[];
      let excludePaths: string[];
      let projectName: string;
      
      if (isRemote) {
        // For remote repositories, use CLI options or sensible defaults
        languages = options.languages ? 
          options.languages.split(',').map((l: string) => l.trim()) as Language[] : 
          ['typescript', 'javascript', 'java', 'python']; // Default to all supported languages
          
        excludePaths = options.exclude ? 
          options.exclude.split(',').map((p: string) => p.trim()) :
          ['node_modules', 'dist', 'build', '.git'];
          
        projectName = options.projectName || projectId;
      } else {
        // For local repositories, use recommendation
        languages = options.languages ? 
          options.languages.split(',').map((l: string) => l.trim()) as Language[] : 
          recommendation!.scanConfig.languages || [];
          
        excludePaths = options.exclude ? 
          options.exclude.split(',').map((p: string) => p.trim()) :
          recommendation!.scanConfig.excludePaths || ['node_modules', 'dist', 'build'];
          
        projectName = options.projectName || 
          recommendation!.scanConfig.projectName || 
          projectId;
      }
      
      console.log(`📋 Project ID: ${projectId}`);
      console.log(`📋 Project Name: ${projectName}`);

      // Fold the branch into the project ID so Neo4j can hold multiple branches in
      // parallel. The default branch ("main") produces no suffix (backward compatible);
      // any other branch becomes "<base>@<branch>" (slashes normalized to underscores).
      const branchName = options.branch || 'main';
      const baseProjectId = projectId;
      projectId = Neo4jClient.composeProjectId(baseProjectId, branchName);
      const normalizedBranch = Neo4jClient.normalizeBranch(branchName);
      if (projectId !== baseProjectId) {
        projectName = `${projectName} (${normalizedBranch})`;
        console.log(`🌿 Branch: ${normalizedBranch} → project_id: ${projectId}`);
      }

      // Prepare scan configuration
      const scanConfig: ScanConfig = {
        projectPath: resolvedPath,
        projectId,
        projectName,
        languages,
        excludePaths,
        includeTests: options.includeTests,
        outputProgress: options.verbose,
        // Remote repository settings
        isRemote,
        gitUrl,
        gitBranch: options.branch,
        cleanupTemp: !options.noCleanup,
        useCache: options.useCache,
        cacheOptions: {
          forceRefresh: options.clearCache
        },
        // Embedding settings
        skipEmbeddings: options.embeddings === false
      };

      console.log(`\n⚙️ Scan Configuration:`);
      if (isRemote) {
        console.log(`  Git URL: ${gitUrl}`);
        console.log(`  Branch: ${options.branch}`);
      }
      console.log(`  Languages: ${languages.join(', ')}`);
      console.log(`  Include tests: ${options.includeTests ? 'yes' : 'no'}`);
      console.log(`  Exclude paths: ${excludePaths.join(', ')}`);

      // Clear graph if requested / set up atomic reindex.
      // The branch this scan targets (default branch => no project_id suffix).
      const targetProjectId = projectId;

      if (options.reindex) {
        // Blue-green swap: scan into a throwaway project_id, then atomically
        // rebrand it onto the target after a successful scan. Clear flags are
        // redundant here because the swap fully replaces the target.
        if (options.clearAll || options.clearGraph) {
          console.warn(`ℹ️  --clear-graph/--clear-all are ignored with --reindex (the swap replaces the target project atomically).`);
        }
        // Carry the target branch on the temp id so the transient ProjectContext
        // (visible via list_projects while the scan runs) already reports the
        // correct branch instead of defaulting to "main". The default branch
        // produces no suffix, keeping the temp id backward compatible.
        reindexTempId = Neo4jClient.composeProjectId(`__coderag_reindex__${Date.now()}`, branchName);
        console.log(`🟦 Atomic reindex enabled.`);
        console.log(`   Building into temporary project: ${reindexTempId}`);
        console.log(`   Target after swap:               ${targetProjectId}`);
        // Make sure no stale temp data exists from a previous aborted run.
        await scanner.clearGraph(reindexTempId);
        scanConfig.projectId = reindexTempId;
        scanConfig.projectName = projectName;
      } else if (options.clearAll) {
        // Guard against the common mistake of wiping the ENTIRE database
        // (all projects AND all branches) while indexing a specific branch.
        if (normalizedBranch !== DEFAULT_BRANCH && !options.yes) {
          console.error(`\n❌ Refusing --clear-all while indexing branch '${normalizedBranch}'.`);
          console.error(`   --clear-all deletes ALL projects and ALL branches, not just '${normalizedBranch}'.`);
          console.error(`   • To replace only this branch safely, use:  --reindex   (atomic swap)`);
          console.error(`   • To clear only this branch, use:           --clear-graph`);
          console.error(`   • If you really mean to wipe the whole database, re-run with: --yes`);
          await client.disconnect();
          process.exit(1);
        }
        if (normalizedBranch !== DEFAULT_BRANCH) {
          console.warn(`⚠️  --clear-all is wiping the ENTIRE database (all projects/branches) while indexing branch '${normalizedBranch}'.`);
        }
        await scanner.clearGraph(); // Clear all data
      } else if (options.clearGraph) {
        await scanner.clearGraph(projectId); // Clear only this project
      }

      // Initialize database schema
      await client.initializeDatabase();

      // Perform the scan
      console.log(`\n🔄 Starting codebase scan...`);
      const result = await scanner.scanProject(scanConfig);

      // Atomic reindex swap: only now that the scan succeeded do we replace the
      // live target. Old target data is cleared, then the temp project is
      // rebranded onto the target id (queries see no empty window).
      if (options.reindex && reindexTempId) {
        console.log(`\n🔁 Swapping freshly indexed data into '${targetProjectId}'...`);
        await scanner.clearGraph(targetProjectId);
        await client.renameProject(reindexTempId, targetProjectId);
        reindexTempId = null; // swap done; nothing to clean up anymore
        console.log(`✅ Swap complete. '${targetProjectId}' now serves the new index.`);
      }

      // Generate and display report
      const report = await scanner.generateScanReport(result);
      console.log(report);

      // Save report if requested
      if (options.outputReport) {
        const reportPath = path.join(resolvedPath, 'coderag-scan-report.txt');
        await fs.promises.writeFile(reportPath, report);
        console.log(`📄 Report saved to: ${reportPath}`);
      }

      // Run quality analysis if requested
      if (options.analyze) {
        console.log(`\n🔬 Running quality analysis...`);
        const metricsManager = new MetricsManager(client);
        const summary = await metricsManager.calculateProjectSummary();
        const issues = await metricsManager.findArchitecturalIssues();

        console.log(`\n📊 QUALITY ANALYSIS RESULTS`);
        console.log(`═══════════════════════════`);
        console.log(`📈 Project Metrics:`);
        console.log(`  Total Classes: ${summary.totalClasses}`);
        console.log(`  Total Methods: ${summary.totalMethods}`);
        console.log(`  Total Packages: ${summary.totalPackages}`);
        console.log(`  Average Coupling: ${summary.averageMetrics.avgCBO.toFixed(2)}`);
        console.log(`  Average RFC: ${summary.averageMetrics.avgRFC.toFixed(2)}`);
        console.log(`  Average DIT: ${summary.averageMetrics.avgDIT.toFixed(2)}`);

        console.log(`\n⚠️ Issues Found: ${issues.length}`);
        if (issues.length > 0) {
          issues.slice(0, 5).forEach((issue, index) => {
            console.log(`  ${index + 1}. [${issue.severity.toUpperCase()}] ${issue.description}`);
          });
          if (issues.length > 5) {
            console.log(`  ... and ${issues.length - 5} more issues`);
          }
        }

      }

      console.log(`\n✅ Scan completed successfully!`);
      client.disconnect().catch(() => {}).finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000);

    } catch (error) {
      console.error(`\n❌ Scan failed:`, error instanceof Error ? error.message : String(error));
      if (options.verbose) {
        console.error(error instanceof Error ? error.stack : error);
      }
      // Clean up the temporary reindex project so a failed run leaves no orphan.
      if (reindexTempId && client) {
        try {
          console.error(`🧹 Cleaning up temporary reindex project '${reindexTempId}'...`);
          const scanner = new CodebaseScanner(client);
          await scanner.clearGraph(reindexTempId);
          await client.deleteProject(reindexTempId);
        } catch (cleanupError) {
          console.error(`⚠️  Failed to clean up temporary project '${reindexTempId}':`, cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        }
      }
      process.exit(1);
    }
  });

// Add a command to clear the graph
program
  .command('clear')
  .description(`Clear data from the CodeRAG graph database

Scope:
  • No options              → clears the ENTIRE database (all projects & branches)
  • --project-id <id>       → clears only that project (default branch)
  • --project-id <id> --branch <b> → clears only that project's branch (project_id "<id>@<b>")

Examples:
  coderag-scan clear --force
  coderag-scan clear -p icm-as --force
  coderag-scan clear -p icm-as --branch develop --force`)
  .option('-p, --project-id <id>', 'Clear only this project (branch-aware when combined with --branch)')
  .option('--branch <branch>', 'Branch to clear. Folded into the project_id (default "main" = no suffix). Requires --project-id.')
  .option('-f, --force', 'Force clear without confirmation', false)
  .action(async (options) => {
    let client: Neo4jClient | null = null;
    try {
      if (options.branch && !options.projectId) {
        console.error(`❌ --branch requires --project-id (it scopes the clear to a specific project's branch).`);
        process.exit(1);
      }

      const config = getConfig();
      client = new Neo4jClient(config);
      await client.connect();

      const scanner = new CodebaseScanner(client);

      // Determine the scope of the clear: whole DB vs. a single (branch-aware) project.
      let targetProjectId: string | undefined;
      let scopeDescription: string;

      if (options.projectId) {
        const resolved = await client.resolveProjectAndBranch(options.projectId, options.branch);
        targetProjectId = resolved.projectId;
        if (!resolved.available) {
          console.warn(`⚠️  No indexed data found for "${options.projectId}"${options.branch ? ` (branch "${options.branch}")` : ''}. Nothing may be deleted.`);
        } else if (resolved.fallbackUsed) {
          // The requested branch isn't indexed; resolution fell back to another branch.
          // Refuse to silently clear a DIFFERENT branch than the user asked for.
          console.error(`\n❌ Branch "${resolved.requestedBranch}" is not indexed for "${resolved.base}".`);
          console.error(`   Refusing to clear the fallback branch "${resolved.resolvedBranch}" instead.`);
          console.error(`   Available indexed project_id resolved to: ${resolved.projectId}`);
          console.error(`   Re-run with the exact --branch that exists, or omit --branch to target the default branch.`);
          await client.disconnect();
          process.exit(1);
        }
        scopeDescription = `project "${targetProjectId}"`;
      } else {
        scopeDescription = `the ENTIRE database (all projects & branches)`;
      }

      if (!options.force) {
        console.log(`⚠️  This will permanently delete ${scopeDescription}.`);
        console.log(`Use --force flag to confirm this action.`);
        await client.disconnect();
        process.exit(1);
      }

      // clearGraph(undefined) wipes everything; clearGraph(projectId) scopes to one project.
      await scanner.clearGraph(targetProjectId);

      console.log(`✅ Cleared ${scopeDescription}.`);
      client.disconnect().catch(() => {}).finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000);

    } catch (error) {
      console.error(`❌ Failed to clear graph:`, error instanceof Error ? error.message : String(error));
      if (client) {
        await client.disconnect().catch(() => {});
      }
      process.exit(1);
    }
  });

// Add a command to validate project structure
program
  .command('validate <project-path>')
  .description('Validate project structure and detect languages')
  .action(async (projectPath: string) => {
    try {
      const resolvedPath = path.resolve(projectPath);
      
      const config = getConfig();
      const client = new Neo4jClient(config);
      await client.connect();

      const scanner = new CodebaseScanner(client);
      const validation = await scanner.validateProjectStructure(resolvedPath);

      console.log(`📁 Project: ${resolvedPath}`);
      console.log(`✅ Valid: ${validation.isValid ? 'Yes' : 'No'}`);
      console.log(`🔤 Languages detected: ${validation.detectedLanguages.join(', ') || 'None'}`);
      console.log(`\n📋 Analysis:`);
      validation.suggestions.forEach(suggestion => console.log(`  ${suggestion}`));

      await client.disconnect();

    } catch (error) {
      console.error(`❌ Validation failed:`, error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Separate command for generating embeddings
program
  .command('embeddings')
  .description(`Generate or update semantic embeddings for code entities

Environment variables for embedding configuration:
  SEMANTIC_SEARCH_PROVIDER  - 'openai', 'ollama', or 'disabled' (required)
  OPENAI_API_KEY            - API key for OpenAI
  OPENAI_BASE_URL           - Custom base URL (e.g., LM Studio: http://localhost:1234/v1)
  OLLAMA_BASE_URL           - Ollama server URL (default: http://localhost:11434)
  EMBEDDING_MODEL           - Model name (e.g., 'text-embedding-3-small', 'nomic-embed-text')
  EMBEDDING_BATCH_SIZE      - Batch size for API calls (default: 200 for OpenAI, 50 for local)
  EMBEDDING_PARALLEL_REQUESTS - Parallel requests for local providers (default: 10)
  EMBED_ENTITY_TYPES        - Comma-separated entity types to embed (default: class,interface,method,function,enum)
  
Examples:
  coderag-scan embeddings                           # Update all embeddings
  coderag-scan embeddings -p my-project             # Update embeddings for specific project
  coderag-scan embeddings --types class,interface   # Only embed classes and interfaces
  coderag-scan embeddings -p icm-as --branch develop # Only embed a specific branch`)
  .option('-p, --project-id <id>', 'Project ID to scope the embedding update to')
  .option('--branch <branch>', 'Branch to scope the embedding update to. Folded into the project_id (default "main" = no suffix). Requires --project-id.')
  .option('-t, --types <types>', 'Comma-separated list of node types to embed (class,interface,enum,function,method)')
  .action(async (options) => {
    try {
      console.log(`🧠 CodeRAG Embedding Generator`);

      // Check if semantic search is enabled
      const { getSemanticSearchConfig } = await import('../config.js');
      const semanticConfig = getSemanticSearchConfig();
      
      if (semanticConfig.provider === 'disabled') {
        console.error(`❌ Semantic search is disabled. Set SEMANTIC_SEARCH_PROVIDER to 'openai' or 'ollama'.`);
        process.exit(1);
      }

      console.log(`📡 Provider: ${semanticConfig.provider}`);
      console.log(`🤖 Model: ${semanticConfig.model}`);
      console.log(`📦 Batch size: ${semanticConfig.batch_size}`);
      if (semanticConfig.provider === 'ollama') {
        console.log(`🔀 Parallel requests: ${semanticConfig.parallel_requests}`);
      }

      // Initialize Neo4j connection
      const config = getConfig();
      const client = new Neo4jClient(config);
      await client.connect();
      console.log(`🔗 Connected to Neo4j: ${config.uri}`);

      // Initialize services
      const { EmbeddingService } = await import('../services/embedding-service.js');
      const { SemanticSearchManager } = await import('../services/semantic-search-manager.js');
      
      const embeddingService = new EmbeddingService();
      const semanticSearchManager = new SemanticSearchManager(client, embeddingService);

      // Parse node types
      const nodeTypes = options.types 
        ? options.types.split(',').map((t: string) => t.trim())
        : undefined;

      if (nodeTypes) {
        console.log(`📋 Entity types: ${nodeTypes.join(', ')}`);
      }

      // Resolve the branch-aware project_id when a project is scoped.
      let targetProjectId: string | undefined = options.projectId;
      if (options.branch && !options.projectId) {
        console.error(`❌ --branch requires --project-id (it scopes the embedding update to a specific project's branch).`);
        await client.disconnect();
        process.exit(1);
      }
      if (options.projectId) {
        const resolved = await client.resolveProjectAndBranch(options.projectId, options.branch);
        targetProjectId = resolved.projectId;
        if (resolved.fallbackUsed) {
          console.warn(`⚠️  Branch "${resolved.requestedBranch}" is not indexed for "${resolved.base}". Falling back to "${resolved.resolvedBranch}".`);
        }
        if (!resolved.available) {
          console.warn(`⚠️  No indexed data found for "${options.projectId}"${options.branch ? ` (branch "${options.branch}")` : ''}. Embedding update may affect nothing.`);
        }
        console.log(`🎯 Target project_id: ${targetProjectId}`);
      }

      // Update embeddings
      const result = await semanticSearchManager.updateEmbeddings(
        targetProjectId,
        nodeTypes
      );

      console.log(`\n✅ Embedding generation completed!`);
      console.log(`   Updated: ${result.updated}`);
      console.log(`   Failed: ${result.failed}`);

      await client.disconnect();

    } catch (error) {
      console.error(`❌ Embedding generation failed:`, error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();

export default program;