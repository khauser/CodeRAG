// Diagnostic: for every stale `Project___coderag_reindex__*` label, show the
// actual project_id + type of the nodes wearing it. This tells us whether the
// nodes are LIVE (project_id already points at the real target, so we only need
// to drop the stale label) or ORPHANS (project_id still = temp id, delete them).
import 'dotenv/config';
import neo4j from 'neo4j-driver';

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'neo4j';
const PREFIX = 'Project___coderag_reindex__';

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));

async function main() {
  const session = driver.session();
  try {
    console.log(`Connecting to ${uri} as ${user} ...`);
    const res = await session.run('CALL db.labels() YIELD label RETURN label ORDER BY label');
    const stale = res.records.map(r => r.get('label')).filter(l => l.startsWith(PREFIX));

    if (stale.length === 0) {
      console.log('No stale labels found.');
      return;
    }

    for (const label of stale) {
      const combos = await session.run(
        `MATCH (n:\`${label}\`)
         RETURN DISTINCT n.project_id AS pid, n.type AS type, count(n) AS cnt
         ORDER BY pid, type`
      );
      console.log(`\n${label}:`);
      for (const rec of combos.records) {
        const pid = rec.get('pid');
        const orphan = typeof pid === 'string' && pid.includes('__coderag_reindex__');
        console.log(`   project_id="${pid}"  type=${rec.get('type')}  count=${rec.get('cnt').toString()}  ${orphan ? '⚠️ ORPHAN' : '✅ LIVE'}`);
      }
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(err => { console.error('Inspect failed:', err); process.exitCode = 1; });
