// Mock the entire neo4j-driver module
const mockDriver = {
  verifyConnectivity: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
  session: jest.fn()
};

const mockSession = {
  run: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
  executeWrite: jest.fn().mockImplementation((work) => work({}))
};

const mockResult = {
  records: []
};

const mockNeo4j = {
  driver: jest.fn().mockReturnValue(mockDriver),
  auth: {
    basic: jest.fn().mockReturnValue({})
  }
};

jest.mock('neo4j-driver', () => ({
  __esModule: true,
  default: mockNeo4j
}));

import { Neo4jClient, DEFAULT_BRANCH } from '../../src/graph/neo4j-client.js';
import { ProjectContext } from '../../src/types.js';

describe('Neo4jClient', () => {
  let client: Neo4jClient;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Set up default mock behaviors
    mockDriver.session.mockReturnValue(mockSession);
    mockSession.run.mockResolvedValue(mockResult);
    mockResult.records = [
      {
        get: jest.fn().mockReturnValue({ properties: { health: 1 } })
      }
    ];

    // Recreate client
    const config = { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'test' };
    client = new Neo4jClient(config);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    test('should create client with provided config', () => {
      const config = { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'test' };
      const newClient = new Neo4jClient(config);
      expect(newClient).toBeInstanceOf(Neo4jClient);
    });

    test('should create client with default project config', () => {
      const config = { uri: 'bolt://localhost:7687', user: 'neo4j', password: 'test' };
      const newClient = new Neo4jClient(config);
      expect(newClient).toBeInstanceOf(Neo4jClient);
    });
  });

  describe('connect', () => {
    test('should connect successfully', async () => {
      await client.connect();
      expect(mockNeo4j.driver).toHaveBeenCalledWith(
        'bolt://localhost:7687',
        {},
        expect.objectContaining({
          maxConnectionPoolSize: 50,
          connectionAcquisitionTimeout: 60_000,
          connectionTimeout: 20_000,
          maxConnectionLifetime: 60 * 60 * 1000
        })
      );
      expect(mockDriver.verifyConnectivity).toHaveBeenCalled();
    });

    test('should throw error on connection failure', async () => {
      mockDriver.verifyConnectivity.mockRejectedValueOnce(new Error('Connection failed'));
      await expect(client.connect()).rejects.toThrow('Connection failed');
    });
  });

  describe('disconnect', () => {
    test('should disconnect successfully', async () => {
      await client.connect();
      await client.disconnect();
      expect(mockDriver.close).toHaveBeenCalled();
    });

    test('should handle disconnect when not connected', async () => {
      await client.disconnect();
      expect(mockDriver.close).not.toHaveBeenCalled();
    });
  });

  describe('getSession', () => {
    test('should return session when connected', async () => {
      await client.connect();
      const session = client.getSession();
      expect(session).toBe(mockSession);
      expect(mockDriver.session).toHaveBeenCalled();
    });

    test('should throw error when not connected', () => {
      expect(() => client.getSession()).toThrow('Neo4J driver not connected. Call connect() first.');
    });
  });

  describe('runQuery', () => {
    test('should run query successfully', async () => {
      await client.connect();
      const result = await client.runQuery('RETURN 1', {});
      expect(mockSession.run).toHaveBeenCalledWith('RETURN 1', {});
      expect(mockSession.close).toHaveBeenCalled();
      expect(result).toBe(mockResult);
    });

    test('should close session after query', async () => {
      await client.connect();
      await client.runQuery('RETURN 1', {});
      expect(mockSession.close).toHaveBeenCalled();
    });
  });

  describe('runTransaction', () => {
    test('should run transaction successfully', async () => {
      await client.connect();
      const workFunction = jest.fn().mockResolvedValue('result');
      const result = await client.runTransaction(workFunction);
      
      expect(mockSession.executeWrite).toHaveBeenCalledWith(workFunction);
      expect(mockSession.close).toHaveBeenCalled();
      expect(result).toBe('result');
    });
  });

  describe('healthCheck', () => {
    test('should return true for healthy connection', async () => {
      await client.connect();
      const isHealthy = await client.healthCheck();
      expect(isHealthy).toBe(true);
      expect(mockSession.run).toHaveBeenCalledWith('RETURN 1 as health', {});
    });

    test('should return false for unhealthy connection', async () => {
      await client.connect();
      mockSession.run.mockRejectedValueOnce(new Error('Query failed'));
      const isHealthy = await client.healthCheck();
      expect(isHealthy).toBe(false);
    });
  });

  describe('initializeDatabase', () => {
    test('should create constraints and indexes', async () => {
      await client.connect();
      await client.initializeDatabase();
      expect(mockSession.run).toHaveBeenCalledTimes(13); // Number of constraints + indexes
    });
  });

  describe('project management', () => {
    test('should create project successfully', async () => {
      await client.connect();
      const project: ProjectContext = {
        project_id: 'test-project',
        name: 'Test Project',
        description: 'A test project'
      };

      const mockRecord = {
        get: jest.fn().mockReturnValue({
          properties: {
            project_id: 'test-project',
            name: 'Test Project',
            description: 'A test project',
            created_at: { toStandardDate: () => new Date() },
            updated_at: { toStandardDate: () => new Date() }
          }
        })
      };

      mockResult.records = [mockRecord];
      
      const result = await client.createProject(project);
      expect(result.project_id).toBe('test-project');
      expect(result.name).toBe('Test Project');
    });

    test('should get project successfully', async () => {
      await client.connect();
      const mockRecord = {
        get: jest.fn().mockReturnValue({
          properties: {
            project_id: 'test-project',
            name: 'Test Project',
            description: 'A test project',
            created_at: { toStandardDate: () => new Date() },
            updated_at: { toStandardDate: () => new Date() }
          }
        })
      };

      mockResult.records = [mockRecord];
      
      const result = await client.getProject('test-project');
      expect(result).not.toBeNull();
      expect(result?.project_id).toBe('test-project');
    });

    test('should return null for non-existent project', async () => {
      await client.connect();
      mockResult.records = [];
      
      const result = await client.getProject('non-existent');
      expect(result).toBeNull();
    });

    test('should list projects successfully', async () => {
      await client.connect();
      const mockRecord = {
        get: jest.fn().mockReturnValue({
          properties: {
            project_id: 'test-project',
            name: 'Test Project',
            description: 'A test project',
            created_at: { toStandardDate: () => new Date() },
            updated_at: { toStandardDate: () => new Date() }
          }
        })
      };

      mockResult.records = [mockRecord];
      
      const projects = await client.listProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].project_id).toBe('test-project');
    });

    test('should delete project successfully', async () => {
      await client.connect();
      mockResult.records = [{ get: jest.fn().mockReturnValue(1) }];
      
      const deleted = await client.deleteProject('test-project');
      expect(deleted).toBe(true);
    });
  });

  describe('renameProject (atomic swap)', () => {
    test('should no-op when ids are equal or empty', async () => {
      await client.connect();
      mockSession.run.mockClear();
      await client.renameProject('same', 'same');
      await client.renameProject('', 'target');
      await client.renameProject('source', '');
      expect(mockSession.run).not.toHaveBeenCalled();
    });

    test('should rebrand nodes/edges and move the ProjectContext to the new id', async () => {
      await client.connect();

      const upd = (n: number) => ({ records: [{ get: () => ({ toNumber: () => n }) }] });
      // Default: every batched loop terminates immediately (0 updated). Individual
      // batches are exercised below via mockResolvedValueOnce for the first few calls.
      mockSession.run.mockReset();
      mockSession.run.mockResolvedValue(upd(0));
      mockSession.run
        .mockResolvedValueOnce({ records: [] })   // delete stale target context
        .mockResolvedValueOnce(upd(5))            // first per-type label-swap batch
        .mockResolvedValueOnce(upd(0));           // ...done

      await client.renameProject('__coderag_reindex__123', 'owner-repo@develop');

      const calls = mockSession.run.mock.calls.map((c: any[]) => c[0] as string);
      expect(calls[0]).toMatch(/MATCH \(p:ProjectContext \{project_id: \$newId\}\) DELETE p/);

      // Per-project labels must be swapped, not just the project_id property:
      // the stale temp label is removed and the correct target label is added.
      expect(calls.some((q: string) =>
        q.includes('REMOVE n:`Project___coderag_reindex__123_Class`') &&
        q.includes('SET n:`Project_owner_repo_develop_Class`'))).toBe(true);

      // Safety-net property re-point for any untyped/legacy nodes still remains.
      expect(calls.some((q: string) => q.includes('MATCH (n:CodeNode {project_id: $oldId})'))).toBe(true);
      // Relationships are matched by pattern (they carry no label).
      expect(calls.some((q: string) => q.includes('-[r {project_id: $oldId}]->'))).toBe(true);

      const moveQuery = calls[calls.length - 1];
      expect(moveQuery).toMatch(/SET p.project_id = \$newId/);
      expect(moveQuery).toMatch(/p.base_project_id = \$base/);
      expect(moveQuery).toMatch(/p.branch = \$branch/);

      const moveParams = mockSession.run.mock.calls[mockSession.run.mock.calls.length - 1][1];
      expect(moveParams).toEqual(expect.objectContaining({
        oldId: '__coderag_reindex__123',
        newId: 'owner-repo@develop',
        base: 'owner-repo',
        branch: 'develop'
      }));
    });
  });

  describe('utility methods', () => {
    test('should generate project label', () => {
      const label = client.getProjectLabel('test-project', 'class');
      // Hyphens should be replaced with underscores for valid Neo4j labels
      expect(label).toBe('Project_test_project_Class');
    });

    test('should generate project scoped ID', () => {
      const scopedId = client.generateProjectScopedId('test-project', 'entity-123');
      expect(scopedId).toBe('test-project:entity-123');
    });

    test('should parse project scoped ID', () => {
      const parsed = client.parseProjectScopedId('test-project:entity-123');
      expect(parsed.projectId).toBe('test-project');
      expect(parsed.entityId).toBe('entity-123');
    });

    test('should parse project scoped ID with colons in entity ID', () => {
      const parsed = client.parseProjectScopedId('test-project:namespace:class:method');
      expect(parsed.projectId).toBe('test-project');
      expect(parsed.entityId).toBe('namespace:class:method');
    });
  });

  describe('resolveProjectId', () => {
    it('should return exact match immediately', async () => {
      await client.connect();
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: () => 'my-project' }]
      });

      const resolved = await client.resolveProjectId('my-project');
      expect(resolved).toBe('my-project');
    });

    it('should resolve suffix match when exact match fails', async () => {
      await client.connect();
      // First call: exact match fails
      mockSession.run.mockResolvedValueOnce({ records: [] });
      // Second call: list all project IDs
      mockSession.run.mockResolvedValueOnce({
        records: [
          { get: () => 'org/repo-my-project' },
          { get: () => 'other/something-else' }
        ]
      });

      const resolved = await client.resolveProjectId('my-project');
      expect(resolved).toBe('org/repo-my-project');
    });

    it('should return input as-is when no match found', async () => {
      await client.connect();
      mockSession.run.mockResolvedValueOnce({ records: [] });
      mockSession.run.mockResolvedValueOnce({ records: [] });

      const resolved = await client.resolveProjectId('unknown');
      expect(resolved).toBe('unknown');
    });

    it('should use cache on second call', async () => {
      await client.connect();
      mockSession.run.mockResolvedValueOnce({
        records: [{ get: () => 'cached-project' }]
      });

      await client.resolveProjectId('cached-project');
      // Second call - should NOT trigger another DB query
      const callCount = mockSession.run.mock.calls.length;
      const resolved = await client.resolveProjectId('cached-project');
      expect(resolved).toBe('cached-project');
      expect(mockSession.run.mock.calls.length).toBe(callCount);
    });
  });

  describe('branch helpers', () => {
    describe('normalizeBranch', () => {
      test('falls back to default branch for empty/undefined input', () => {
        expect(Neo4jClient.normalizeBranch(undefined)).toBe(DEFAULT_BRANCH);
        expect(Neo4jClient.normalizeBranch(null)).toBe(DEFAULT_BRANCH);
        expect(Neo4jClient.normalizeBranch('')).toBe(DEFAULT_BRANCH);
        expect(Neo4jClient.normalizeBranch('   ')).toBe(DEFAULT_BRANCH);
      });

      test('maps slashes to underscores and trims', () => {
        expect(Neo4jClient.normalizeBranch('feature/CR-1234')).toBe('feature_CR-1234');
        expect(Neo4jClient.normalizeBranch('  release/2024/q1  ')).toBe('release_2024_q1');
      });

      test('leaves simple branch names unchanged', () => {
        expect(Neo4jClient.normalizeBranch('develop')).toBe('develop');
      });
    });

    describe('composeProjectId', () => {
      test('produces no suffix for the default branch (backward compatible)', () => {
        expect(Neo4jClient.composeProjectId('owner/repo')).toBe('owner/repo');
        expect(Neo4jClient.composeProjectId('owner/repo', DEFAULT_BRANCH)).toBe('owner/repo');
      });

      test('appends the normalized branch as a suffix', () => {
        expect(Neo4jClient.composeProjectId('owner/repo', 'develop')).toBe('owner/repo@develop');
        expect(Neo4jClient.composeProjectId('owner/repo', 'feature/x')).toBe('owner/repo@feature_x');
      });
    });

    describe('parseProjectId', () => {
      test('treats an id without suffix as the default branch', () => {
        expect(Neo4jClient.parseProjectId('owner/repo')).toEqual({ base: 'owner/repo', branch: DEFAULT_BRANCH });
      });

      test('splits a composed id into base and branch', () => {
        expect(Neo4jClient.parseProjectId('owner/repo@develop')).toEqual({ base: 'owner/repo', branch: 'develop' });
      });

      test('uses the last separator so bases with @ are handled', () => {
        expect(Neo4jClient.parseProjectId('a@b@develop')).toEqual({ base: 'a@b', branch: 'develop' });
      });

      test('round-trips with composeProjectId', () => {
        const id = Neo4jClient.composeProjectId('owner/repo', 'feature/x');
        expect(Neo4jClient.parseProjectId(id)).toEqual({ base: 'owner/repo', branch: 'feature_x' });
      });
    });

    describe('getDefaultBranch', () => {
      const original = process.env.CODERAG_DEFAULT_BRANCH;
      afterEach(() => {
        if (original === undefined) delete process.env.CODERAG_DEFAULT_BRANCH;
        else process.env.CODERAG_DEFAULT_BRANCH = original;
      });

      test('returns "main" when env is not set', () => {
        delete process.env.CODERAG_DEFAULT_BRANCH;
        expect(Neo4jClient.getDefaultBranch()).toBe('main');
      });

      test('honors CODERAG_DEFAULT_BRANCH and normalizes it', () => {
        process.env.CODERAG_DEFAULT_BRANCH = 'release/2024';
        expect(Neo4jClient.getDefaultBranch()).toBe('release_2024');
      });
    });

    describe('getBranchFallbacks', () => {
      const original = process.env.CODERAG_BRANCH_FALLBACKS;
      afterEach(() => {
        if (original === undefined) delete process.env.CODERAG_BRANCH_FALLBACKS;
        else process.env.CODERAG_BRANCH_FALLBACKS = original;
      });

      test('defaults to develop,main', () => {
        delete process.env.CODERAG_BRANCH_FALLBACKS;
        expect(Neo4jClient.getBranchFallbacks()).toEqual(['develop', 'main']);
      });

      test('parses a comma-separated list and always ends with the default branch', () => {
        process.env.CODERAG_BRANCH_FALLBACKS = 'staging, release/x';
        expect(Neo4jClient.getBranchFallbacks()).toEqual(['staging', 'release_x', 'main']);
      });

      test('does not duplicate the default branch when already present', () => {
        process.env.CODERAG_BRANCH_FALLBACKS = 'develop,main';
        expect(Neo4jClient.getBranchFallbacks()).toEqual(['develop', 'main']);
      });
    });
  });

  describe('resolveProjectAndBranch', () => {
    const originalDefault = process.env.CODERAG_DEFAULT_BRANCH;
    const originalFallbacks = process.env.CODERAG_BRANCH_FALLBACKS;

    afterEach(() => {
      if (originalDefault === undefined) delete process.env.CODERAG_DEFAULT_BRANCH;
      else process.env.CODERAG_DEFAULT_BRANCH = originalDefault;
      if (originalFallbacks === undefined) delete process.env.CODERAG_BRANCH_FALLBACKS;
      else process.env.CODERAG_BRANCH_FALLBACKS = originalFallbacks;
    });

    function mockKnownProjects(ids: string[]) {
      jest.spyOn(client, 'getKnownProjectIds').mockResolvedValue(ids);
    }

    test('serves the requested branch when it is indexed', async () => {
      delete process.env.CODERAG_DEFAULT_BRANCH;
      mockKnownProjects(['intershop-com/Products-icm-as', 'intershop-com/Products-icm-as@develop']);

      const result = await client.resolveProjectAndBranch('icm-as', 'develop');
      expect(result.projectId).toBe('intershop-com/Products-icm-as@develop');
      expect(result.base).toBe('intershop-com/Products-icm-as');
      expect(result.requestedBranch).toBe('develop');
      expect(result.resolvedBranch).toBe('develop');
      expect(result.fallbackUsed).toBe(false);
      expect(result.available).toBe(true);
      expect(result.availableBranches).toEqual(['develop', 'main']);
    });

    test('resolves the default branch (no suffix) when no branch is requested', async () => {
      delete process.env.CODERAG_DEFAULT_BRANCH;
      mockKnownProjects(['intershop-com/Products-icm-as', 'intershop-com/Products-icm-as@develop']);

      const result = await client.resolveProjectAndBranch('icm-as');
      expect(result.projectId).toBe('intershop-com/Products-icm-as');
      expect(result.requestedBranch).toBe('main');
      expect(result.resolvedBranch).toBe('main');
      expect(result.fallbackUsed).toBe(false);
      expect(result.available).toBe(true);
    });

    test('falls back when the requested feature branch is not indexed', async () => {
      delete process.env.CODERAG_DEFAULT_BRANCH;
      delete process.env.CODERAG_BRANCH_FALLBACKS; // -> develop, main
      mockKnownProjects(['intershop-com/Products-icm-as', 'intershop-com/Products-icm-as@develop']);

      const result = await client.resolveProjectAndBranch('icm-as', 'feature/CR-1234');
      expect(result.requestedBranch).toBe('feature_CR-1234');
      expect(result.resolvedBranch).toBe('develop');
      expect(result.projectId).toBe('intershop-com/Products-icm-as@develop');
      expect(result.fallbackUsed).toBe(true);
      expect(result.available).toBe(true);
    });

    test('falls back to main when develop is not indexed', async () => {
      delete process.env.CODERAG_DEFAULT_BRANCH;
      delete process.env.CODERAG_BRANCH_FALLBACKS;
      mockKnownProjects(['intershop-com/Products-icm-as']);

      const result = await client.resolveProjectAndBranch('icm-as', 'feature/x');
      expect(result.resolvedBranch).toBe('main');
      expect(result.projectId).toBe('intershop-com/Products-icm-as');
      expect(result.fallbackUsed).toBe(true);
      expect(result.available).toBe(true);
    });

    test('accepts a fully composed id with an inline branch', async () => {
      delete process.env.CODERAG_DEFAULT_BRANCH;
      mockKnownProjects(['intershop-com/Products-icm-as', 'intershop-com/Products-icm-as@develop']);

      const result = await client.resolveProjectAndBranch('intershop-com/Products-icm-as@develop');
      expect(result.resolvedBranch).toBe('develop');
      expect(result.projectId).toBe('intershop-com/Products-icm-as@develop');
      expect(result.fallbackUsed).toBe(false);
    });

    test('explicit branch arg overrides an inline branch', async () => {
      delete process.env.CODERAG_DEFAULT_BRANCH;
      mockKnownProjects(['intershop-com/Products-icm-as', 'intershop-com/Products-icm-as@develop']);

      const result = await client.resolveProjectAndBranch('intershop-com/Products-icm-as@develop', 'main');
      expect(result.requestedBranch).toBe('main');
      expect(result.resolvedBranch).toBe('main');
      expect(result.projectId).toBe('intershop-com/Products-icm-as');
    });

    test('honors CODERAG_DEFAULT_BRANCH when no branch is requested', async () => {
      process.env.CODERAG_DEFAULT_BRANCH = 'develop';
      mockKnownProjects(['intershop-com/Products-icm-as', 'intershop-com/Products-icm-as@develop']);

      const result = await client.resolveProjectAndBranch('icm-as');
      expect(result.requestedBranch).toBe('develop');
      expect(result.resolvedBranch).toBe('develop');
      expect(result.projectId).toBe('intershop-com/Products-icm-as@develop');
    });

    test('reports unavailable when no branch variant is indexed', async () => {
      delete process.env.CODERAG_DEFAULT_BRANCH;
      delete process.env.CODERAG_BRANCH_FALLBACKS;
      mockKnownProjects(['some-other/project@develop']);

      const result = await client.resolveProjectAndBranch('unknown', 'feature/x');
      expect(result.available).toBe(false);
      expect(result.resolvedBranch).toBe('feature_x');
    });

    test('self-heals a stale cache: re-fetches when the requested branch looks missing', async () => {
      delete process.env.CODERAG_DEFAULT_BRANCH;
      delete process.env.CODERAG_BRANCH_FALLBACKS; // -> develop, main

      // Simulate a warm, non-expired cache primed BEFORE "develop" was indexed by
      // another process. The first (cached) read lacks "develop"; a forced refresh
      // returns the up-to-date list including it.
      (client as any).knownProjectIds = ['icm-as'];
      (client as any).knownProjectIdsAt = Date.now();
      jest.spyOn(client, 'getKnownProjectIds').mockImplementation(
        async (forceRefresh?: boolean) =>
          forceRefresh ? ['icm-as', 'icm-as@develop'] : ['icm-as']
      );

      const result = await client.resolveProjectAndBranch('icm-as', 'develop');
      expect(result.resolvedBranch).toBe('develop');
      expect(result.projectId).toBe('icm-as@develop');
      expect(result.fallbackUsed).toBe(false);
      expect(result.available).toBe(true);
    });
  });
});
