// Discovery helper: list project_ids that match a substring (case-insensitive),
// with node/edge/context counts. Read-only. Usage:
//   node scripts/find-projects.mjs <substring>
import 'dotenv/config';
import neo4j from 'neo4j-driver';

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'neo4j';
const needle = (process.argv[2] || '').toLowerCase();

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

async function main() {
  const session = driver.session();
  try {
    console.log(`Connecting to ${uri} as ${user} ...`);

    const ctx = await session.run('MATCH (p:ProjectContext) RETURN p.project_id AS pid ORDER BY pid');
    const nodes = await session.run(
      `MATCH (n:CodeNode)
       RETURN n.project_id AS pid, count(n) AS nodes
       ORDER BY pid`
    );

    const nodeCounts = new Map();
    for (const r of nodes.records) nodeCounts.set(r.get('pid'), r.get('nodes').toNumber());

    const allIds = new Set([
      ...ctx.records.map(r => r.get('pid')),
      ...nodeCounts.keys(),
    ].filter(Boolean));

    console.log(`\nAll project_ids (${allIds.size}):`);
    for (const id of [...allIds].sort()) {
      console.log(`   ${id}  (CodeNodes: ${nodeCounts.get(id) ?? 0})`);
    }

    if (needle) {
      const matches = [...allIds].filter(id => id.toLowerCase().includes(needle)).sort();
      console.log(`\nMatches for "${needle}" (${matches.length}):`);
      for (const id of matches) {
        console.log(`   ${id}  (CodeNodes: ${nodeCounts.get(id) ?? 0})`);
      }
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(err => {
  console.error('Discovery failed:', err);
  process.exitCode = 1;
});
