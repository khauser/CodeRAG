// One-shot utility to (re)create the semantic_embeddings vector index.
// Usage: node scripts/create-vector-index.mjs
import 'dotenv/config';
import neo4j from 'neo4j-driver';

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'neo4j';

// text-embedding-3-large => 3072. Override with EMBEDDING_DIMENSIONS if needed.
const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-large';
const defaultDims = model === 'text-embedding-3-large' ? 3072 : 1536;
const dimensions = parseInt(process.env.EMBEDDING_DIMENSIONS || String(defaultDims), 10);

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

async function main() {
  const session = driver.session();
  try {
    console.log(`Connecting to ${uri} as ${user} ...`);
    console.log(`Creating vector index 'semantic_embeddings' (dimensions=${dimensions}, model=${model}) ...`);

    await session.run(
      `CREATE VECTOR INDEX semantic_embeddings IF NOT EXISTS
       FOR (n:CodeNode)
       ON (n.semantic_embedding)
       OPTIONS { indexConfig: {
         \`vector.dimensions\`: $dimensions,
         \`vector.similarity_function\`: 'cosine'
       } }`,
      { dimensions: neo4j.int(dimensions) }
    );

    // Wait for the index to come online.
    await session.run(`CALL db.awaitIndex('semantic_embeddings', 300)`).catch(() => {});

    const res = await session.run(
      `SHOW INDEXES YIELD name, type, state, properties, options
       WHERE name = 'semantic_embeddings'
       RETURN name, type, state, properties, options`
    );

    if (res.records.length === 0) {
      console.error('❌ Index not found after creation. Check Neo4j version supports vector indexes (>= 5.13).');
      process.exitCode = 1;
    } else {
      const r = res.records[0];
      console.log('✅ Index present:');
      console.log('   name      :', r.get('name'));
      console.log('   type      :', r.get('type'));
      console.log('   state     :', r.get('state'));
      console.log('   properties:', r.get('properties'));
      console.log('   options   :', JSON.stringify(r.get('options')));
    }

    // Report how many nodes actually carry an embedding so we can spot dimension mismatches.
    const count = await session.run(
      `MATCH (n:CodeNode) WHERE n.semantic_embedding IS NOT NULL
       RETURN count(n) AS withEmbedding`
    );
    console.log('   nodes with embedding:', count.records[0].get('withEmbedding').toString());
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(err => {
  console.error('Failed to create vector index:', err);
  process.exitCode = 1;
});
