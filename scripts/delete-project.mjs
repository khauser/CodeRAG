// Deletes a single project (by EXACT project_id) from the CodeRAG graph.
// Removes its relationships, CodeNodes and the ProjectContext in batches so it
// stays safe on very large projects. Read-only preview first, then deletes.
//
// Usage:
//   node scripts/delete-project.mjs <exact_project_id>
//
// Note: branch variants are SEPARATE project_ids. Deleting "icm-as" does NOT
// touch "icm-as@develop". Run again with the other id to remove a branch.
import 'dotenv/config';
import neo4j from 'neo4j-driver';

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'neo4j';

const projectId = process.argv[2];
if (!projectId) {
  console.error('Usage: node scripts/delete-project.mjs <exact_project_id>');
  process.exit(1);
}

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
const BATCH_SIZE = 10000;

async function deleteBatched(session, query, params, label) {
  let total = 0;
  for (;;) {
    const res = await session.run(query, params);
    const deleted = res.records[0]?.get('deleted')?.toNumber?.() ?? 0;
    if (deleted <= 0) break;
    total += deleted;
    console.log(`   ${label}: deleted ${deleted} (running total ${total})...`);
    await new Promise(r => setTimeout(r, 100));
  }
  return total;
}

async function main() {
  const session = driver.session();
  const params = { id: projectId };
  try {
    console.log(`Connecting to ${uri} as ${user} ...`);
    console.log(`Target project_id (exact): "${projectId}"`);

    const preview = await session.run(
      `MATCH (n:CodeNode {project_id: $id}) RETURN count(n) AS c`,
      params
    );
    const nodeCount = preview.records[0]?.get('c')?.toNumber?.() ?? 0;
    console.log(`About to purge: ${nodeCount} CodeNodes (plus relationships & ProjectContext).`);

    // Phase 1: relationships carrying this project_id.
    await deleteBatched(
      session,
      `MATCH ()-[r {project_id: $id}]-()
       WITH r LIMIT ${BATCH_SIZE}
       DELETE r
       RETURN count(*) AS deleted`,
      params,
      'Relationships'
    );

    // Phase 2: CodeNodes (DETACH removes any remaining rels too).
    await deleteBatched(
      session,
      `MATCH (n:CodeNode {project_id: $id})
       WITH n LIMIT ${BATCH_SIZE}
       DETACH DELETE n
       RETURN count(*) AS deleted`,
      params,
      'CodeNodes'
    );

    // Phase 3: the ProjectContext node.
    await deleteBatched(
      session,
      `MATCH (p:ProjectContext {project_id: $id})
       WITH p LIMIT ${BATCH_SIZE}
       DETACH DELETE p
       RETURN count(*) AS deleted`,
      params,
      'ProjectContext'
    );

    // Verify.
    const after = await session.run(
      `MATCH (n:CodeNode {project_id: $id}) RETURN count(n) AS c`,
      params
    );
    const remaining = after.records[0]?.get('c')?.toNumber?.() ?? 0;
    console.log(`\n✅ Delete complete. Remaining CodeNodes for "${projectId}": ${remaining}`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(err => {
  console.error('Delete failed:', err);
  process.exitCode = 1;
});
