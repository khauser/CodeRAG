// Quick write-test: confirms the Neo4j database is online AND writable
// (i.e. it has left the read-only panic state). Safe: creates and immediately
// deletes a throwaway node, then prints the database access mode.
import 'dotenv/config';
import neo4j from 'neo4j-driver';

const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || 'neo4j';

const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
  connectionTimeout: 20000,
});

async function main() {
  console.log(`Connecting to ${uri} as ${user} ...`);
  const session = driver.session();
  try {
    // 1) Show access mode of the default database.
    const dbs = await session.run('SHOW DATABASES YIELD name, currentStatus, access RETURN name, currentStatus, access');
    for (const r of dbs.records) {
      console.log(`   DB '${r.get('name')}': status=${r.get('currentStatus')}, access=${r.get('access')}`);
    }

    // 2) Actual write test.
    await session.run('CREATE (t:_WriteTest {ts: timestamp()})');
    const del = await session.run('MATCH (t:_WriteTest) DELETE t RETURN count(*) AS removed');
    console.log(`✅ WRITE OK — database is read-write (cleaned up ${del.records[0].get('removed')} test node).`);
  } catch (err) {
    console.error('❌ WRITE FAILED:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch(err => {
  console.error('Verify failed:', err);
  process.exitCode = 1;
});
