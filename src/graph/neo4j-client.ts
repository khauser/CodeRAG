import neo4j, { Driver, Session, Result } from 'neo4j-driver';
import { Neo4jConfig, ProjectConfig, ProjectContext } from '../types.js';

/**
 * The branch that is stored WITHOUT a suffix in the project_id.
 * Scanning this branch produces a plain project_id (e.g. "owner-repo"),
 * which keeps pre-branch data fully backward compatible.
 */
export const DEFAULT_BRANCH = 'main';

/** Separator between the base project id and the branch in a composed project_id. */
export const BRANCH_SEPARATOR = '@';

/**
 * All node `type` values that receive a per-project label
 * (`Project_<sanitizedProjectId>_<NodeType>`) at insert time.
 * Must cover the full CodeNode.type union (see src/types.ts), because the
 * per-project label is always derived from the raw node.type (capitalized) by
 * getProjectLabel — independent of NodeManager.getNodeLabel. Keeping this in sync
 * lets an atomic --reindex swap rebrand every per-project label, not just the
 * project_id property.
 */
export const NODE_TYPES = [
  'class',
  'interface',
  'enum',
  'exception',
  'function',
  'method',
  'field',
  'package',
  'module',
  'annotation'
] as const;

/** Result of resolving a (project, branch) pair against the graph. */
export interface ResolvedProject {
  /** Full project_id to query (base or base@branch). */
  projectId: string;
  /** Resolved base project id without branch suffix. */
  base: string;
  /** Branch that was requested (normalized). */
  requestedBranch: string;
  /** Branch that is actually served (may differ when a fallback was used). */
  resolvedBranch: string;
  /** True when the requested branch was not indexed and a fallback was used. */
  fallbackUsed: boolean;
  /** True when the resolved branch actually exists in the graph. */
  available: boolean;
  /** All branches that are indexed for the resolved base project. */
  availableBranches: string[];
}

export class Neo4jClient {
  private driver: Driver | null = null;
  private projectConfig: ProjectConfig;
  private projectIdCache: Map<string, string> = new Map();
  /** Cached list of all known project_ids (primed lazily / by warmup) to avoid repeated full scans. */
  private knownProjectIds: string[] | null = null;
  /** Epoch-ms when {@link knownProjectIds} was last populated; used for TTL expiry. */
  private knownProjectIdsAt = 0;
  /**
   * Max age of the {@link knownProjectIds} cache before it is transparently refreshed.
   * Long-running servers (e.g. the MCP container) would otherwise never see branches/projects
   * indexed by a SEPARATE process after startup, falsely reporting them as "not indexed".
   */
  private static readonly KNOWN_PROJECT_IDS_TTL_MS = 30_000;

  constructor(private config: Neo4jConfig, projectConfig?: ProjectConfig) {
    this.projectConfig = projectConfig || {
      isolation_strategy: 'shared_db',
      cross_project_analysis: true,
      max_projects_shared_db: 100
    };
  }

  async connect(): Promise<void> {
    try {
      this.driver = neo4j.driver(
        this.config.uri,
        neo4j.auth.basic(this.config.user, this.config.password),
        {
          // Keep a warm pool so requests don't pay TCP/auth setup repeatedly.
          maxConnectionPoolSize: 50,
          // Fail fast instead of blocking forever when the DB is unreachable.
          connectionAcquisitionTimeout: 60_000, // ms
          connectionTimeout: 20_000, // ms
          // Azure Container Apps' L4 ingress silently drops idle TCP connections
          // after ~4 min. A 1h lifetime kept stale sockets in the pool, so the
          // server logged "Response write failure" / "network aborts detected"
          // when it tried to reply on a connection the load balancer had already
          // torn down. Keep connections well under that idle window and probe any
          // idle-for-a-while connection before reusing it.
          maxConnectionLifetime: 3 * 60 * 1000, // 3 min (< ACA idle timeout)
          // Ping pooled connections idle longer than this before handing them out,
          // so dead/half-open sockets are detected & replaced instead of failing.
          connectionLivenessCheckTimeout: 30_000, // ms
        }
      );
      
      // Verify connectivity
      await this.driver.verifyConnectivity();
      console.log('Connected to Neo4J database');
    } catch (error) {
      console.error('Failed to connect to Neo4J:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      console.log('Disconnected from Neo4J database');
    }
  }

  getSession(): Session {
    if (!this.driver) {
      throw new Error('Neo4J driver not connected. Call connect() first.');
    }
    return this.driver.session();
  }

  async runQuery(query: string, parameters: Record<string, any> = {}): Promise<Result> {
    const session = this.getSession();
    try {
      return await session.run(query, parameters);
    } finally {
      await session.close();
    }
  }

  async runTransaction<T>(
    work: (tx: any) => Promise<T>
  ): Promise<T> {
    const session = this.getSession();
    try {
      return await session.executeWrite(work);
    } finally {
      await session.close();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.runQuery('RETURN 1 as health');
      return result.records.length > 0;
    } catch (error) {
      console.error('Health check failed:', error);
      return false;
    }
  }

  /**
   * Normalizes a branch name so it can be safely embedded in a project_id.
   * Slashes (e.g. "feature/CR-1234") are mapped to underscores because "/" already
   * appears in base project ids (e.g. "owner/repo").
   */
  static normalizeBranch(branch: string | undefined | null): string {
    const b = (branch || '').trim();
    if (!b) return DEFAULT_BRANCH;
    return b.replace(/\//g, '_');
  }

  /** Branch used when no branch is provided by the caller (env-configurable). */
  static getDefaultBranch(): string {
    return Neo4jClient.normalizeBranch(process.env.CODERAG_DEFAULT_BRANCH || DEFAULT_BRANCH);
  }

  /**
   * Ordered list of fallback branches tried when the requested branch is not indexed.
   * Configurable via CODERAG_BRANCH_FALLBACKS (comma-separated). Defaults to develop,main.
   */
  static getBranchFallbacks(): string[] {
    const raw = process.env.CODERAG_BRANCH_FALLBACKS;
    const list = raw
      ? raw.split(',').map(b => Neo4jClient.normalizeBranch(b)).filter(Boolean)
      : ['develop', DEFAULT_BRANCH];
    // Ensure the default branch is always a last-resort fallback.
    if (!list.includes(DEFAULT_BRANCH)) list.push(DEFAULT_BRANCH);
    return list;
  }

  /**
   * Composes a full project_id from a base id and a branch.
   * The default branch produces no suffix (backward compatible).
   */
  static composeProjectId(base: string, branch?: string): string {
    const normalized = Neo4jClient.normalizeBranch(branch);
    if (normalized === DEFAULT_BRANCH) return base;
    return `${base}${BRANCH_SEPARATOR}${normalized}`;
  }

  /** Splits a full project_id into its base id and branch (default branch when no suffix). */
  static parseProjectId(projectId: string): { base: string; branch: string } {
    const idx = projectId.lastIndexOf(BRANCH_SEPARATOR);
    if (idx === -1) {
      return { base: projectId, branch: DEFAULT_BRANCH };
    }
    return {
      base: projectId.slice(0, idx),
      branch: projectId.slice(idx + BRANCH_SEPARATOR.length) || DEFAULT_BRANCH
    };
  }

  /**
   * Resolves a user-provided project identifier (and optional branch) to the actual
   * project_id stored in the database, honoring a branch fallback chain.
   *
   * Branch precedence: explicit `branch` arg → CODERAG_DEFAULT_BRANCH → "main".
   * If the requested branch is not indexed for the resolved base project, the
   * configured fallback branches are tried in order and `fallbackUsed` is set.
   */
  async resolveProjectAndBranch(userInput: string, branch?: string): Promise<ResolvedProject> {
    // Allow callers to pass a fully composed id like "owner-repo@develop".
    let inputBase = userInput;
    let inlineBranch: string | undefined;
    if (userInput && userInput.includes(BRANCH_SEPARATOR)) {
      const parsed = Neo4jClient.parseProjectId(userInput);
      inputBase = parsed.base;
      inlineBranch = parsed.branch;
    }

    const requestedBranch = Neo4jClient.normalizeBranch(
      branch || inlineBranch || Neo4jClient.getDefaultBranch()
    );

    // First attempt with the (possibly cached) project-id list.
    const usedCache =
      this.knownProjectIds !== null &&
      Date.now() - this.knownProjectIdsAt < Neo4jClient.KNOWN_PROJECT_IDS_TTL_MS;
    let result = await this.computeBranchResolution(inputBase, requestedBranch, false);

    // Self-heal against a stale cache: a long-running server may have indexed a new
    // branch/project in ANOTHER process after this cache was primed. If the requested
    // branch looks missing AND we relied on a cached list, force a single refresh and
    // recompute before reporting it as "not indexed". When the first attempt already
    // hit the DB (cache cold/expired), a retry would be redundant, so we skip it.
    if (usedCache && (!result.available || result.fallbackUsed)) {
      result = await this.computeBranchResolution(inputBase, requestedBranch, true);
    }

    return result;
  }

  /**
   * Computes branch resolution against the current (optionally force-refreshed) set of
   * known project ids. Extracted from {@link resolveProjectAndBranch} so the resolver can
   * retry with a fresh project-id list when a branch appears to be missing.
   */
  private async computeBranchResolution(
    inputBase: string,
    requestedBranch: string,
    forceRefresh: boolean
  ): Promise<ResolvedProject> {
    // Build a map of base project id -> indexed branches.
    const allProjectIds = await this.getKnownProjectIds(forceRefresh);
    const baseToBranches = new Map<string, Set<string>>();
    for (const pid of allProjectIds) {
      const { base, branch: b } = Neo4jClient.parseProjectId(pid);
      if (!baseToBranches.has(base)) baseToBranches.set(base, new Set());
      baseToBranches.get(base)!.add(b);
    }
    const bases = Array.from(baseToBranches.keys());

    // Resolve the base project from the (branch-stripped) user input.
    const resolvedBase = this.resolveBase(inputBase, bases);
    const availableBranches = Array.from(baseToBranches.get(resolvedBase) || []).sort();

    // Try the requested branch first, then the fallback chain.
    const candidates = [requestedBranch, ...Neo4jClient.getBranchFallbacks()];
    let resolvedBranch = requestedBranch;
    let available = false;
    for (const cand of candidates) {
      if (availableBranches.includes(cand)) {
        resolvedBranch = cand;
        available = true;
        break;
      }
    }

    const projectId = Neo4jClient.composeProjectId(resolvedBase, resolvedBranch);
    return {
      projectId,
      base: resolvedBase,
      requestedBranch,
      resolvedBranch,
      fallbackUsed: available && resolvedBranch !== requestedBranch,
      available,
      availableBranches
    };
  }

  /**
   * Matches a (branch-stripped) user input against the set of known base project ids.
   * Uses exact, suffix and case-insensitive contains matching. Returns the input
   * unchanged when no match is found (results will likely be empty).
   */
  private resolveBase(inputBase: string, bases: string[]): string {
    if (!inputBase) return inputBase;

    // Exact base match.
    if (bases.includes(inputBase)) return inputBase;

    // Suffix match (e.g. "icm-as" matches "intershop-com/Products-icm-as").
    const suffixMatch = bases.find(b =>
      b.endsWith(inputBase) || b.endsWith('/' + inputBase) || b.endsWith('-' + inputBase)
    );
    if (suffixMatch) return suffixMatch;

    // Case-insensitive contains match.
    const lowerInput = inputBase.toLowerCase();
    const containsMatch = bases.find(b => b.toLowerCase().includes(lowerInput));
    if (containsMatch) return containsMatch;

    return inputBase;
  }

  /**
   * Resolves a user-provided project identifier to the actual project_id stored in
   * the database. Branch-aware: pass an optional branch to select a specific branch
   * variant (with fallback). Backward compatible — without a branch and with the
   * default branch "main", the behavior is identical to the pre-branch resolver.
   * Results are cached for performance.
   */
  async resolveProjectId(userInput: string, branch?: string): Promise<string> {
    if (!userInput) return userInput;

    const cacheKey = `${userInput}::${branch || ''}`;
    if (this.projectIdCache.has(cacheKey)) {
      return this.projectIdCache.get(cacheKey)!;
    }

    const resolved = await this.resolveProjectAndBranch(userInput, branch);
    // Only cache confident resolutions. Caching a fallback (requested branch missing)
    // would pin the wrong project_id forever, even after that branch gets indexed later.
    if (resolved.available && !resolved.fallbackUsed) {
      this.projectIdCache.set(cacheKey, resolved.projectId);
    }
    return resolved.projectId;
  }

  /**
   * Returns the list of all known project IDs, cached for the lifetime of the process.
   * Prefers the small {@link ProjectContext} node set (cheap, indexed) and only falls
   * back to a DISTINCT scan over all CodeNodes when no ProjectContext nodes exist.
   * This avoids an expensive full graph scan on every cache miss, which on large
   * databases with a cold page cache could exceed the MCP request timeout.
   */
  async getKnownProjectIds(forceRefresh = false): Promise<string[]> {
    const fresh =
      this.knownProjectIds !== null &&
      Date.now() - this.knownProjectIdsAt < Neo4jClient.KNOWN_PROJECT_IDS_TTL_MS;
    if (fresh && !forceRefresh) {
      return this.knownProjectIds!;
    }

    // Cheap path: read from the small ProjectContext node set.
    const contextResult = await this.runQuery(
      'MATCH (p:ProjectContext) RETURN p.project_id as pid'
    );
    let ids = contextResult.records
      .map(r => r.get('pid') as string)
      .filter(pid => !!pid);

    // Fallback only when no ProjectContext nodes are present (legacy data).
    if (ids.length === 0) {
      const scanResult = await this.runQuery(
        'MATCH (n:CodeNode) RETURN DISTINCT n.project_id as pid'
      );
      ids = scanResult.records
        .map(r => r.get('pid') as string)
        .filter(pid => !!pid);
    }

    this.knownProjectIds = ids;
    this.knownProjectIdsAt = Date.now();
    return ids;
  }

  /**
   * Primes connection pool, page cache and the project-id cache so that the first
   * real user request does not pay the cold-start cost (which can otherwise exceed
   * the MCP request timeout right after a database restart).
   */
  async warmup(): Promise<void> {
    try {
      await this.getKnownProjectIds(true);
      // Touch the CodeNode index so the page cache is warm for typical lookups.
      await this.runQuery('MATCH (n:CodeNode) RETURN count(n) as c');
    } catch (error) {
      console.error('Warmup query failed (non-fatal):', error);
    }
  }

  async initializeDatabase(): Promise<void> {
    const session = this.getSession();
    try {
      // Create project-aware constraints and indexes for better performance
      const constraints = [
        // Project-aware core constraints
        'CREATE CONSTRAINT IF NOT EXISTS FOR (n:CodeNode) REQUIRE (n.project_id, n.id) IS UNIQUE',
        'CREATE CONSTRAINT IF NOT EXISTS FOR (e:CodeEdge) REQUIRE (e.project_id, e.id) IS UNIQUE',
        
        // Project context constraints
        'CREATE CONSTRAINT IF NOT EXISTS FOR (p:ProjectContext) REQUIRE p.project_id IS UNIQUE',
        
        // Project-aware indexes for performance
        'CREATE INDEX IF NOT EXISTS FOR (n:CodeNode) ON (n.project_id)',
        'CREATE INDEX IF NOT EXISTS FOR (n:CodeNode) ON (n.project_id, n.type)',
        'CREATE INDEX IF NOT EXISTS FOR (n:CodeNode) ON (n.project_id, n.name)',
        'CREATE INDEX IF NOT EXISTS FOR (n:CodeNode) ON (n.project_id, n.qualified_name)',
        'CREATE INDEX IF NOT EXISTS FOR (e:CodeEdge) ON (e.project_id)',
        'CREATE INDEX IF NOT EXISTS FOR (e:CodeEdge) ON (e.project_id, e.type)',
        
        // Traditional indexes for backward compatibility and cross-project queries
        'CREATE INDEX IF NOT EXISTS FOR (n:CodeNode) ON (n.type)',
        'CREATE INDEX IF NOT EXISTS FOR (n:CodeNode) ON (n.name)',
        'CREATE INDEX IF NOT EXISTS FOR (n:CodeNode) ON (n.qualified_name)',
        'CREATE INDEX IF NOT EXISTS FOR (e:CodeEdge) ON (e.type)'
      ];

      for (const constraint of constraints) {
        await session.run(constraint);
      }

      // Full-text index used by NodeManager.searchNodes for fast (sub-second) name /
      // qualified_name / description lookups. The range indexes above do NOT accelerate
      // substring (CONTAINS) matching, so on large projects (e.g. icm-as) the previous
      // CONTAINS scan over every CodeNode — including large description fields —
      // exceeded the MCP request timeout. A full-text index turns this into an indexed
      // lookup. Created separately because the syntax differs from range indexes and a
      // failure here must not abort the (already applied) core schema.
      try {
        await session.run(
          `CREATE FULLTEXT INDEX codeNodeSearch IF NOT EXISTS
           FOR (n:CodeNode) ON EACH [n.name, n.qualified_name, n.description]`
        );
      } catch (error) {
        console.error('Full-text index creation failed (search will fall back to CONTAINS):', error);
      }

      console.log('Database initialized with project-aware constraints and indexes');
    } finally {
      await session.close();
    }
  }

  // Project management methods
  async createProject(project: ProjectContext): Promise<ProjectContext> {
    const { base, branch } = Neo4jClient.parseProjectId(project.project_id);
    const query = `
      CREATE (p:ProjectContext {
        project_id: $project_id,
        base_project_id: $base_project_id,
        branch: $branch,
        name: $name,
        description: $description,
        created_at: datetime(),
        updated_at: datetime()
      })
      RETURN p
    `;

    const params = {
      project_id: project.project_id,
      base_project_id: project.base_project_id || base,
      branch: project.branch || branch,
      name: project.name || project.project_id,
      description: project.description || null
    };

    const result = await this.runQuery(query, params);
    if (result.records.length === 0) {
      throw new Error('Failed to create project');
    }

    const record = result.records[0].get('p');
    return {
      project_id: record.properties.project_id,
      base_project_id: record.properties.base_project_id,
      branch: record.properties.branch,
      name: record.properties.name,
      description: record.properties.description,
      created_at: record.properties.created_at.toStandardDate(),
      updated_at: record.properties.updated_at.toStandardDate()
    };
  }

  async getProject(projectId: string): Promise<ProjectContext | null> {
    const query = `
      MATCH (p:ProjectContext {project_id: $project_id})
      RETURN p
    `;

    const result = await this.runQuery(query, { project_id: projectId });
    if (result.records.length === 0) {
      return null;
    }

    const record = result.records[0].get('p');
    const parsed = Neo4jClient.parseProjectId(record.properties.project_id);
    return {
      project_id: record.properties.project_id,
      base_project_id: record.properties.base_project_id ?? parsed.base,
      branch: record.properties.branch ?? parsed.branch,
      name: record.properties.name,
      description: record.properties.description,
      created_at: record.properties.created_at?.toStandardDate(),
      updated_at: record.properties.updated_at?.toStandardDate()
    };
  }

  async listProjects(): Promise<ProjectContext[]> {
    const query = `
      MATCH (p:ProjectContext)
      RETURN p
      ORDER BY p.created_at DESC
    `;

    const result = await this.runQuery(query);
    return result.records.map(record => {
      const p = record.get('p');
      const parsed = Neo4jClient.parseProjectId(p.properties.project_id);
      return {
        project_id: p.properties.project_id,
        base_project_id: p.properties.base_project_id ?? parsed.base,
        branch: p.properties.branch ?? parsed.branch,
        name: p.properties.name,
        description: p.properties.description,
        created_at: p.properties.created_at?.toStandardDate(),
        updated_at: p.properties.updated_at?.toStandardDate()
      };
    });
  }

  async deleteProject(projectId: string): Promise<boolean> {
    const query = `
      MATCH (p:ProjectContext {project_id: $project_id})
      OPTIONAL MATCH (n:CodeNode {project_id: $project_id})
      OPTIONAL MATCH (e:CodeEdge {project_id: $project_id})
      DELETE p, n, e
      RETURN count(p) as deleted_projects
    `;

    const result = await this.runQuery(query, { project_id: projectId });
    return result.records[0]?.get('deleted_projects') > 0;
  }

  /**
   * Atomically rebrands an existing project_id to a new one (blue-green swap).
   *
   * All CodeNode/CodeEdge nodes are re-pointed to {@link newId} in batches (cheap
   * SET, no data movement), and the ProjectContext is moved with its derived
   * `base_project_id`/`branch` fields refreshed from {@link newId}.
   *
   * The caller is responsible for ensuring the target project_id is empty
   * (e.g. via {@link clearGraph}) before swapping, so the (project_id, id)
   * uniqueness constraint cannot be violated. Any stale target ProjectContext
   * is removed up-front to satisfy the unique project_id constraint.
   */
  async renameProject(oldId: string, newId: string): Promise<void> {
    if (!oldId || !newId || oldId === newId) return;

    const BATCH_SIZE = 5000;
    const { base, branch } = Neo4jClient.parseProjectId(newId);

    // Remove any stale ProjectContext for the target so the unique
    // project_id constraint holds when we move the temp context over.
    await this.runQuery(
      'MATCH (p:ProjectContext {project_id: $newId}) DELETE p',
      { newId }
    );

    // Rebrand nodes: move them to the new id AND swap their per-project label.
    //
    // Every node carries TWO labels (see NodeManager.addNode/addNodesBatch):
    //   • the generic :CodeNode label, and
    //   • a per-project label `Project_<sanitizedProjectId>_<NodeType>`.
    // The previous implementation only updated the `project_id` PROPERTY and left
    // the per-project LABEL untouched, so after an atomic --reindex swap the nodes
    // kept a stale label like `Project___coderag_reindex__<ts>_develop_Class`.
    // That leaked the throwaway reindex project id into the graph forever.
    //
    // Labels cannot be parameterized in Cypher, so we swap them per node type using
    // the same label-building logic that created them. The label parts are derived
    // from a sanitized project id (alphanumerics/underscores only), so they are safe
    // to interpolate; we still backtick-quote them defensively.
    const rebrandNodesForType = async (nodeType: string): Promise<void> => {
      const oldLabel = this.getProjectLabel(oldId, nodeType);
      const newLabel = this.getProjectLabel(newId, nodeType);
      let updated = 0;
      do {
        const res = await this.runQuery(
          `MATCH (n:\`${oldLabel}\`)
           WHERE n.project_id = $oldId
           WITH n LIMIT ${BATCH_SIZE}
           REMOVE n:\`${oldLabel}\`
           SET n:\`${newLabel}\`, n.project_id = $newId
           RETURN count(n) as updated`,
          { oldId, newId }
        );
        updated = res.records[0]?.get('updated')?.toNumber?.() || res.records[0]?.get('updated') || 0;
        if (updated > 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } while (updated > 0);
    };

    const rebrandNodes = async (): Promise<void> => {
      // Swap the per-project label for every known node type.
      for (const nodeType of NODE_TYPES) {
        await rebrandNodesForType(nodeType);
      }

      // Safety net: re-point any remaining nodes (e.g. untyped/legacy nodes that
      // never got a per-project label) by project_id property alone.
      let updated = 0;
      do {
        const res = await this.runQuery(
          `MATCH (n:CodeNode {project_id: $oldId})
           WITH n LIMIT ${BATCH_SIZE}
           SET n.project_id = $newId
           RETURN count(n) as updated`,
          { oldId, newId }
        );
        updated = res.records[0]?.get('updated')?.toNumber?.() || res.records[0]?.get('updated') || 0;
        if (updated > 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } while (updated > 0);
    };

    // Rebrand relationships: in Neo4j, relationships (CALLS, IMPLEMENTS,
    // EXTENDS, …) are NOT nodes and carry no label, so they must be matched
    // with a relationship pattern by their project_id property. The previous
    // implementation used a node pattern `(n:CodeEdge {...})` which never
    // matched anything, leaving edges with the temporary reindex project_id.
    // That broke every query that filters relationships by project_id
    // (statistics, find_implementations, inheritance hierarchy, …).
    const rebrandEdges = async (): Promise<void> => {
      let updated = 0;
      do {
        const res = await this.runQuery(
          `MATCH ()-[r {project_id: $oldId}]->()
           WITH r LIMIT ${BATCH_SIZE}
           SET r.project_id = $newId
           RETURN count(r) as updated`,
          { oldId, newId }
        );
        updated = res.records[0]?.get('updated')?.toNumber?.() || res.records[0]?.get('updated') || 0;
        if (updated > 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } while (updated > 0);
    };

    await rebrandNodes();
    await rebrandEdges();

    // Move the ProjectContext itself and refresh its derived fields.
    await this.runQuery(
      `MATCH (p:ProjectContext {project_id: $oldId})
       SET p.project_id = $newId,
           p.base_project_id = $base,
           p.branch = $branch,
           p.updated_at = datetime()`,
      { oldId, newId, base, branch }
    );

    // Project-id related caches are now stale.
    this.projectIdCache.clear();
    this.knownProjectIds = null;
  }

  // Utility methods
  getProjectLabel(projectId: string, nodeType: string): string {
    // Sanitize project ID for use in Neo4j labels
    // Neo4j labels can only contain alphanumeric characters and underscores
    const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9_]/g, '_');
    return `Project_${sanitizedProjectId}_${nodeType.charAt(0).toUpperCase() + nodeType.slice(1)}`;
  }

  generateProjectScopedId(projectId: string, entityId: string): string {
    return `${projectId}:${entityId}`;
  }

  parseProjectScopedId(scopedId: string): { projectId: string; entityId: string } {
    const [projectId, ...entityParts] = scopedId.split(':');
    return {
      projectId,
      entityId: entityParts.join(':')
    };
  }
}