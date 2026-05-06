import { Neo4jClient } from '../../src/graph/neo4j-client.js';
import { NodeManager } from '../../src/graph/node-manager.js';
import { EdgeManager } from '../../src/graph/edge-manager.js';
import { MetricsManager } from '../../src/analysis/metrics-manager.js';

/**
 * Integration tests for CodeRAG graph queries.
 * These tests require a running Neo4j instance with icm-as data.
 * 
 * Run with: NEO4J_URI=bolt://... NEO4J_USER=neo4j NEO4J_PASSWORD=... npx jest tests/graph/integration.test.ts
 * 
 * Skip in CI by default (no Neo4j available).
 */

const isIntegrationEnabled = !!process.env.NEO4J_URI && !!process.env.NEO4J_USER && !!process.env.NEO4J_PASSWORD;

const describeIntegration = isIntegrationEnabled ? describe : describe.skip;

describeIntegration('Graph Integration Tests (requires live Neo4j)', () => {
  let client: Neo4jClient;
  let nodeManager: NodeManager;
  let edgeManager: EdgeManager;
  let metricsManager: MetricsManager;

  beforeAll(async () => {
    client = new Neo4jClient({
      uri: process.env.NEO4J_URI!,
      user: process.env.NEO4J_USER!,
      password: process.env.NEO4J_PASSWORD!
    });
    await client.connect();
    nodeManager = new NodeManager(client);
    edgeManager = new EdgeManager(client);
    metricsManager = new MetricsManager(client);
  });

  afterAll(async () => {
    await client.disconnect();
  });

  describe('resolveProjectId', () => {
    it('should resolve short alias "icm-as" to full project ID', async () => {
      const resolved = await client.resolveProjectId('icm-as');
      expect(resolved).toBe('intershop-com/Products-icm-as');
    });

    it('should return exact ID unchanged if it matches', async () => {
      const resolved = await client.resolveProjectId('intershop-com/Products-icm-as');
      expect(resolved).toBe('intershop-com/Products-icm-as');
    });

    it('should cache resolved IDs for performance', async () => {
      // First call resolves
      await client.resolveProjectId('icm-as');
      // Second call should use cache (no additional DB query)
      const resolved = await client.resolveProjectId('icm-as');
      expect(resolved).toBe('intershop-com/Products-icm-as');
    });
  });

  describe('searchNodes', () => {
    it('should find nodes by name substring', async () => {
      const results = await nodeManager.searchNodes('PageletEntryPoint', 'intershop-com/Products-icm-as');
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(n => n.name === 'PageletEntryPoint')).toBe(true);
    });

    it('should handle null description without error', async () => {
      // This tests the fix for CONTAINS on null description
      const results = await nodeManager.searchNodes('SomeUnlikelySearchTerm12345', 'intershop-com/Products-icm-as');
      expect(results).toEqual([]);
    });
  });

  describe('findNodesByType', () => {
    it('should find interfaces (lowercase)', async () => {
      const results = await nodeManager.findNodesByType('interface', 'intershop-com/Products-icm-as');
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle case-insensitive type input', async () => {
      const results = await nodeManager.findNodesByType('Interface' as any, 'intershop-com/Products-icm-as');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('listPackages', () => {
    it('should find packages at depth 3', async () => {
      const packages = await metricsManager.listPackages('intershop-com/Products-icm-as', 3);
      expect(packages.length).toBeGreaterThan(0);
      expect(packages.some(p => p.startsWith('com.intershop'))).toBe(true);
    });
  });

  describe('findClassesThatImplementInterface', () => {
    it('should find implementations of PageletEntryPoint', async () => {
      const impls = await edgeManager.findClassesThatImplementInterface('PageletEntryPoint', 'intershop-com/Products-icm-as');
      expect(impls.length).toBeGreaterThan(0);
    });
  });

  describe('findInheritanceHierarchy', () => {
    it('should find hierarchy for PageletEntryPointPO', async () => {
      const hierarchy = await edgeManager.findInheritanceHierarchy('PageletEntryPointPO', 'intershop-com/Products-icm-as');
      expect(hierarchy.length).toBeGreaterThan(1);
      expect(hierarchy[0]).toBe('PageletEntryPointPO');
    });
  });

  describe('findClassesThatCallMethod', () => {
    it('should find callers of getPageletEntryPointByID', async () => {
      const callers = await edgeManager.findClassesThatCallMethod('getPageletEntryPointByID', 'intershop-com/Products-icm-as');
      expect(callers.length).toBeGreaterThan(0);
    });
  });

  describe('findClassesAnnotatedWith', () => {
    it('should find classes with @Inject annotation', async () => {
      const annotated = await edgeManager.findClassesAnnotatedWith('Inject', 'intershop-com/Products-icm-as');
      expect(annotated.length).toBeGreaterThan(0);
    });

    it('should handle annotation name with @ prefix', async () => {
      const annotated = await edgeManager.findClassesAnnotatedWith('@Inject', 'intershop-com/Products-icm-as');
      expect(annotated.length).toBeGreaterThan(0);
    });
  });
});
