// One-shot utility to remove aborted atomic-reindex temp projects.
// These carry a project_id that starts with "__coderag_reindex__" and are
// never live projects, so it is safe to purge them entirely.
//
// Usage:
//   node scripts/cleanup-reindex.mjs                       (purges ALL __coderag_reindex__* temps)
//   node scripts/cleanup-reindex.mjs <exact_project_id>    (purges only that project_id)
import 'dotenv/config';
import neo4j from 'neo4j-driver';

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'neo4j';

const arg = process.argv[2];

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
  try {
    console.log(`Connecting to ${uri} as ${user} ...`);

    // Build the predicate: exact match if an id was passed, otherwise prefix.
    const where = arg
      ? '$id IS NOT NULL AND x.project_id = $id'
      : "x.project_id STARTS WITH '__coderag_reindex__'";
    const params = { id: arg ?? null };

    // Show what we are about to delete.
    const preview = await session.run(
      `MATCH (n:CodeNode) WHERE ${where.replace(/x\./g, 'n.')}
       RETURN n.project_id AS pid, count(n) AS nodes
       ORDER BY pid`,
      params
    );
    if (preview.records.length === 0) {
      console.log(arg
        ? `No CodeNodes found for project_id '${arg}'. Nothing to delete (will still purge any matching ProjectContext).`
        : `No __coderag_reindex__* CodeNodes found. Will still purge any matching ProjectContext.`);
    } else {
      console.log('About to purge:');
      for (const r of preview.records) {
        console.log(`   ${r.get('pid')}: ${r.get('nodes').toString()} CodeNodes`);
      }
    }

    // Phase 1: relationships carrying the temp project_id.
    await deleteBatched(
      session,
      `MATCH ()-[r]-() WHERE ${where.replace(/x\./g, 'r.')}
       WITH r LIMIT ${BATCH_SIZE}
       DELETE r
       RETURN count(*) AS deleted`,
      params,
      'Relationships'
    );

    // Phase 2: CodeNodes.
    await deleteBatched(
      session,
      `MATCH (n:CodeNode) WHERE ${where.replace(/x\./g, 'n.')}
       WITH n LIMIT ${BATCH_SIZE}
       DETACH DELETE n
       RETURN count(*) AS deleted`,
      params,
      'CodeNodes'
    );

    // Phase 3: the ProjectContext node(s).
    await deleteBatched(
      session,
      `MATCH (p:ProjectContext) WHERE ${where.replace(/x\./g, 'p.')}
       WITH p LIMIT ${BATCH_SIZE}
       DETACH DELETE p
       RETURN count(*) AS deleted`,
      params,
      'ProjectContext'
    );

    console.log('✅ Cleanup complete.');
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(err => {
  console.error('Cleanup failed:', err);
  process.exitCode = 1;
});
