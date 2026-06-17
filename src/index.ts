#!/usr/bin/env node

import { getConfig } from './config.js';
import { Neo4jClient } from './graph/neo4j-client.js';
import { StdioHandler } from './mcp/stdio-handler.js';
import { HTTPHandler } from './mcp/http-handler.js';
import { SemanticSearchManager } from './services/semantic-search-manager.js';

async function main() {
  try {
    // Get configuration
    const config = getConfig();
    
    // Initialize Neo4J client
    const client = new Neo4jClient(config);
    await client.connect();
    await client.initializeDatabase();
    // Prime caches so the first user request doesn't hit the cold-start timeout.
    await client.warmup();

    // Ensure the Neo4j vector index for semantic search exists on every startup.
    // This is idempotent (CREATE ... IF NOT EXISTS) and guarantees that
    // db.index.vector.queryNodes can run even if a scan or the
    // initialize_semantic_search tool was never invoked. Failures here must not
    // prevent the server from starting (e.g. semantic search disabled).
    try {
      const semanticSearchManager = new SemanticSearchManager(client);
      await semanticSearchManager.initializeVectorIndexes();
    } catch (error) {
      console.error('Vector index initialization on startup failed (continuing):', error);
    }

    // Determine server mode from command line arguments
    const args = process.argv.slice(2);
    const mode = args.includes('--http') || args.includes('--sse') ? 'http' : 'stdio';
    const port = args.includes('--port') ? 
      parseInt(args[args.indexOf('--port') + 1]) || 3000 : 3000;

    if (mode === 'http') {
      // Start HTTP server with official MCP SDK
      const httpHandler = new HTTPHandler(client, port);
      await httpHandler.start();
    } else {
      // Start STDIO server (default)
      const stdioHandler = new StdioHandler(client);
      await stdioHandler.start();
    }

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.error('Shutting down...');
      await client.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.error('Shutting down...');
      await client.disconnect();
      process.exit(0);
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Only run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}