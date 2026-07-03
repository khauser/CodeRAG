// Removes leaked per-project labels that carry a throwaway reindex id, e.g.
// `Project___coderag_reindex__<ts>_<branch>_<Type>`.
//
// These labels are the residue of an older atomic --reindex swap that renamed
// the project_id PROPERTY but left the per-project LABEL untouched (see the
// comment in src/graph/neo4j-client.ts#renameProject). The nodes themselves are
// LIVE (correct project_id + correct Project_<realId>_<Type> label), so we must
// only REMOVE the stale label — never delete the nodes.
//
// Usage:
//   node scripts/purge-reindex-labels.mjs            (dry-run: lists what it would do)
//   node scripts/purge-reindex-labels.mjs --apply    (actually removes the labels)
import 'dotenv/config';
import neo4j from 'neo4j-driver';

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'neo4j';

const APPLY = process.argv.includes('--apply');
const PREFIX = 'Project___coderag_reindex__';
const BATCH_SIZE = 5000;

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

async function main() {
  const session = driver.session();
  try {
    console.log(`Connecting to ${uri} as ${user} ...`);
    console.log(APPLY ? 'Mode: APPLY (labels will be removed)' : 'Mode: DRY-RUN (no changes; pass --apply to remove)');

    const res = await session.run('CALL db.labels() YIELD label RETURN label ORDER BY label');
    const stale = res.records
      .map(r => r.get('label'))
      .filter(l => l.startsWith(PREFIX));

    if (stale.length === 0) {
      console.log('No stale labels found. Nothing to do.');
      return;
    }

    console.log(`Found ${stale.length} stale label(s):`);
    for (const label of stale) {
      const c = await session.run(`MATCH (n:\`${label}\`) RETURN count(n) AS c`);
      console.log(`   ${label}: ${c.records[0].get('c').toString()} node(s)`);
    }

    if (!APPLY) {
      console.log('\nDry-run complete. Re-run with --apply to remove these labels.');
      return;
    }

    for (const label of stale) {
      let removed = 0;
      let batchTotal;
      do {
        const r = await session.run(
          `MATCH (n:\`${label}\`)
           WITH n LIMIT ${BATCH_SIZE}
           REMOVE n:\`${label}\`
           RETURN count(n) AS removed`
        );
        batchTotal = r.records[0]?.get('removed')?.toNumber?.() ?? 0;
        removed += batchTotal;
        if (batchTotal > 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } while (batchTotal > 0);
      console.log(`   Removed label ${label} from ${removed} node(s).`);
    }

    console.log('✅ Stale reindex labels removed. Live nodes preserved.');
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(err => {
  console.error('Purge failed:', err);
  process.exitCode = 1;
});
