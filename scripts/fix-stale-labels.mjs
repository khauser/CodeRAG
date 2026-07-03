// One-shot migration to repair stale per-project labels left behind by older
// atomic --reindex swaps.
//
// Background:
//   Every CodeNode carries a per-project label `Project_<sanitizedProjectId>_<Type>`
//   in addition to :CodeNode. The old renameProject() only re-pointed the
//   `project_id` PROPERTY during a blue-green swap and never updated the LABEL,
//   so nodes kept a throwaway label like:
//       Project___coderag_reindex__1781770697456_develop_Class
//   even though their project_id was correctly set to e.g. "icm-as@develop".
//
// This script finds every such stale label, derives the correct label from each
// node's actual project_id + type, removes the stale label and adds the correct one.
//
// Usage:
//   node scripts/fix-stale-labels.mjs            (apply the fix)
//   node scripts/fix-stale-labels.mjs --dry-run  (only report what would change)
import 'dotenv/config';
import neo4j from 'neo4j-driver';

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'neo4j';

const dryRun = process.argv.includes('--dry-run');

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

const BATCH_SIZE = 10000;
const STALE_PREFIX = 'Project___coderag_reindex__';

// Mirror of Neo4jClient.getProjectLabel — keep in sync.
function getProjectLabel(projectId, nodeType) {
  const sanitized = projectId.replace(/[^a-zA-Z0-9_]/g, '_');
  const type = nodeType.charAt(0).toUpperCase() + nodeType.slice(1);
  return `Project_${sanitized}_${type}`;
}

async function main() {
  const session = driver.session();
  try {
    console.log(`Connecting to ${uri} as ${user} ...`);
    console.log(dryRun ? '🔎 DRY RUN — no changes will be written.\n' : '');

    // 1) Enumerate stale labels.
    const labelsRes = await session.run('CALL db.labels() YIELD label RETURN label');
    const staleLabels = labelsRes.records
      .map(r => r.get('label'))
      .filter(l => l.startsWith(STALE_PREFIX));

    if (staleLabels.length === 0) {
      console.log('✅ No stale __coderag_reindex__ labels found. Nothing to do.');
      return;
    }

    console.log(`Found ${staleLabels.length} stale label(s):`);
    staleLabels.forEach(l => console.log(`   • ${l}`));
    console.log('');

    let grandTotal = 0;

    for (const staleLabel of staleLabels) {
      // 2) Distinct (project_id, type) combos still wearing this stale label.
      const combos = await session.run(
        `MATCH (n:\`${staleLabel}\`)
         RETURN DISTINCT n.project_id AS pid, n.type AS type, count(n) AS cnt`,
        {}
      );

      for (const rec of combos.records) {
        const pid = rec.get('pid');
        const type = rec.get('type');
        const cnt = rec.get('cnt')?.toNumber?.() ?? 0;

        if (!pid || !type) {
          console.warn(`   ⚠️  Skipping ${cnt} node(s) under ${staleLabel} with missing project_id/type.`);
          continue;
        }

        const newLabel = getProjectLabel(pid, type);
        console.log(`   ${staleLabel}  →  ${newLabel}  (${cnt} nodes, project_id="${pid}")`);

        if (dryRun) {
          grandTotal += cnt;
          continue;
        }

        // 3) Batched label swap for this combo.
        let updated = 0;
        do {
          const res = await session.run(
            `MATCH (n:\`${staleLabel}\`)
             WHERE n.project_id = $pid AND n.type = $type
             WITH n LIMIT ${BATCH_SIZE}
             REMOVE n:\`${staleLabel}\`
             SET n:\`${newLabel}\`
             RETURN count(n) AS updated`,
            { pid, type }
          );
          updated = res.records[0]?.get('updated')?.toNumber?.() ?? 0;
          grandTotal += updated;
          if (updated > 0) {
            await new Promise(r => setTimeout(r, 50));
          }
        } while (updated > 0);
      }
    }

    console.log('');
    console.log(dryRun
      ? `🔎 DRY RUN complete. ${grandTotal} node(s) would be relabeled.`
      : `✅ Migration complete. Relabeled ${grandTotal} node(s).`);
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exitCode = 1;
});
