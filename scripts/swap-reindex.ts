// Completes an interrupted atomic --reindex swap.
//
// Replays exactly what `coderag-scan ... --reindex` does after a successful
// scan: clear the live target project, then rebrand the temp project onto it
// (CodeNode + relationship project_id rewrite + ProjectContext move).
//
// Run with tsx so it uses the current src/ logic (incl. the edge-rebrand fix):
//   npx tsx scripts/swap-reindex.ts <tempProjectId> <targetProjectId>
//
// Defaults are the temp/target from the aborted icm-as run.
import 'dotenv/config';
import { getConfig } from '../src/config.js';
import { Neo4jClient } from '../src/graph/neo4j-client.js';
import { CodebaseScanner } from '../src/scanner/codebase-scanner.js';

const tempId = process.argv[2] || '__coderag_reindex__1781716432289@develop';
const targetId = process.argv[3] || 'icm-as@develop';

async function counts(client: Neo4jClient, projectId: string) {
  const nodes = await client.runQuery(
    'MATCH (n:CodeNode {project_id: $projectId}) RETURN count(n) AS c',
    { projectId }
  );
  const rels = await client.runQuery(
    'MATCH ()-[r {project_id: $projectId}]->() RETURN count(r) AS c',
    { projectId }
  );
  const ctx = await client.runQuery(
    'MATCH (p:ProjectContext {project_id: $projectId}) RETURN count(p) AS c',
    { projectId }
  );
  const num = (res: any) => res.records[0]?.get('c')?.toNumber?.() ?? res.records[0]?.get('c') ?? 0;
  return { nodes: num(nodes), rels: num(rels), ctx: num(ctx) };
}

async function main() {
  const config = getConfig();
  const client = new Neo4jClient(config);
  await client.connect();
  console.log(`🔗 Connected to Neo4j: ${config.uri}`);

  try {
    const scanner = new CodebaseScanner(client);

    console.log(`\n🔎 Pre-swap state:`);
    const before = await counts(client, tempId);
    const targetBefore = await counts(client, targetId);
    console.log(`   temp   '${tempId}': ${before.nodes} nodes, ${before.rels} rels, ${before.ctx} ctx`);
    console.log(`   target '${targetId}': ${targetBefore.nodes} nodes, ${targetBefore.rels} rels, ${targetBefore.ctx} ctx`);

    if (before.nodes === 0 && before.rels === 0) {
      console.error(`\n❌ Temp project '${tempId}' has no data — nothing to swap. Aborting.`);
      process.exitCode = 1;
      return;
    }

    // 1) Clear the live target (mirrors scan.ts swap step 1).
    console.log(`\n🗑️  Clearing target project '${targetId}'...`);
    await scanner.clearGraph(targetId);

    // 2) Rebrand temp -> target (mirrors scan.ts swap step 2).
    console.log(`\n🔁 Rebranding '${tempId}' -> '${targetId}'...`);
    await client.renameProject(tempId, targetId);

    console.log(`\n✅ Post-swap state:`);
    const after = await counts(client, targetId);
    const tempAfter = await counts(client, tempId);
    console.log(`   target '${targetId}': ${after.nodes} nodes, ${after.rels} rels, ${after.ctx} ctx`);
    console.log(`   temp   '${tempId}': ${tempAfter.nodes} nodes, ${tempAfter.rels} rels, ${tempAfter.ctx} ctx (should be 0)`);

    if (tempAfter.nodes === 0 && tempAfter.rels === 0 && after.nodes > 0) {
      console.log(`\n🎉 Swap complete. '${targetId}' now serves the freshly indexed data.`);
    } else {
      console.warn(`\n⚠️  Swap finished but counts look unexpected — please review above.`);
    }
  } finally {
    await client.disconnect();
  }
}

main().catch(err => {
  console.error('Swap failed:', err);
  process.exitCode = 1;
});
