import { Neo4jClient } from '../../graph/neo4j-client.js';

export interface ListProjectsParams {
  include_stats?: boolean;
  sort_by?: 'name' | 'created_at' | 'updated_at' | 'entity_count';
  limit?: number;
}

/**
 * Groups project snapshots by their base project id and lists the indexed branches
 * per base. Helps the AI discover which branches actually exist before querying.
 */
function groupByBase(projects: any[]) {
  const map = new Map<string, { base_project_id: string; name?: string; branches: string[] }>();
  for (const p of projects) {
    const parsed = Neo4jClient.parseProjectId(p.project_id);
    const base = p.base_project_id || parsed.base;
    const branch = p.branch || parsed.branch;
    if (!map.has(base)) {
      map.set(base, { base_project_id: base, name: p.name, branches: [] });
    }
    const entry = map.get(base)!;
    if (!entry.branches.includes(branch)) entry.branches.push(branch);
  }
  return Array.from(map.values()).map(e => ({
    ...e,
    branches: e.branches.sort()
  }));
}

export async function listProjects(
  neo4jClient: Neo4jClient,
  params: ListProjectsParams = {}
) {
  const { include_stats = false, sort_by = 'name', limit = 100 } = params;
  
  try {
    // Get basic project information
    const projects = await neo4jClient.listProjects();
    
    if (!include_stats) {
      // Simple list without statistics
      const sortedProjects = sortProjects(projects, sort_by);
      return {
        projects: sortedProjects.slice(0, limit),
        bases: groupByBase(projects),
        total_count: projects.length
      };
    }

    // Enhanced list with statistics.
    //
    // Instead of issuing one expensive stats query per project (an N+1 pattern
    // that easily exceeds the MCP request timeout on large graphs), fetch the
    // stats for every project in two graph-wide aggregation queries and join
    // them with the project list in memory.
    const statsByProject = await getAllProjectStats(neo4jClient);
    const emptyStats = {
      entity_count: 0,
      relationship_count: 0,
      entity_types: [] as string[],
      relationship_types: [] as string[]
    };
    const projectsWithStats = projects.map((project) => ({
      ...project,
      stats: statsByProject.get(project.project_id) ?? { ...emptyStats }
    }));

    const sortedProjects = sortProjectsWithStats(projectsWithStats, sort_by);
    
    return {
      projects: sortedProjects.slice(0, limit),
      bases: groupByBase(projects),
      total_count: projects.length,
      summary: {
        total_projects: projects.length,
        total_entities: projectsWithStats.reduce((sum, p) => sum + p.stats.entity_count, 0),
        total_relationships: projectsWithStats.reduce((sum, p) => sum + p.stats.relationship_count, 0)
      }
    };
  } catch (error) {
    throw new Error(`Failed to list projects: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface ProjectStats {
  entity_count: number;
  relationship_count: number;
  entity_types: string[];
  relationship_types: string[];
}

/**
 * Fetches statistics for every project in two graph-wide aggregation queries
 * (one for entities, one for relationships) instead of one query per project.
 *
 * This avoids the N+1 round-trip pattern that caused `list_projects` with
 * `include_stats: true` to time out on large graphs. Relationships are matched
 * in a single direction so each edge is counted exactly once (the previous
 * undirected match traversed every relationship twice).
 */
async function getAllProjectStats(
  neo4jClient: Neo4jClient
): Promise<Map<string, ProjectStats>> {
  const toNumber = (value: any): number =>
    typeof value?.toNumber === 'function' ? value.toNumber() : Number(value ?? 0);

  const stats = new Map<string, ProjectStats>();
  const ensure = (projectId: string): ProjectStats => {
    let entry = stats.get(projectId);
    if (!entry) {
      entry = {
        entity_count: 0,
        relationship_count: 0,
        entity_types: [],
        relationship_types: []
      };
      stats.set(projectId, entry);
    }
    return entry;
  };

  // Entity counts and types per project.
  const entityResult = await neo4jClient.runQuery(`
    MATCH (n:CodeNode)
    WHERE n.project_id IS NOT NULL
    RETURN
      n.project_id AS project_id,
      count(n) AS entity_count,
      collect(DISTINCT n.type) AS entity_types
  `);

  for (const record of entityResult.records) {
    const entry = ensure(record.get('project_id'));
    entry.entity_count = toNumber(record.get('entity_count'));
    entry.entity_types = (record.get('entity_types') as string[]).filter(
      (type) => type !== null
    );
  }

  // Relationship counts and types per project (directed, counted once).
  const relationshipResult = await neo4jClient.runQuery(`
    MATCH (:CodeNode)-[r]->(:CodeNode)
    WHERE r.project_id IS NOT NULL
    RETURN
      r.project_id AS project_id,
      count(r) AS relationship_count,
      collect(DISTINCT type(r)) AS relationship_types
  `);

  for (const record of relationshipResult.records) {
    const entry = ensure(record.get('project_id'));
    entry.relationship_count = toNumber(record.get('relationship_count'));
    entry.relationship_types = (record.get('relationship_types') as string[]).filter(
      (type) => type !== null
    );
  }

  return stats;
}

function sortProjects(projects: any[], sortBy: string) {
  return [...projects].sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return (a.name || a.project_id).localeCompare(b.name || b.project_id);
      case 'created_at':
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      case 'updated_at':
        return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
      default:
        return (a.name || a.project_id).localeCompare(b.name || b.project_id);
    }
  });
}

function sortProjectsWithStats(projects: any[], sortBy: string) {
  return [...projects].sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return (a.name || a.project_id).localeCompare(b.name || b.project_id);
      case 'created_at':
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      case 'updated_at':
        return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
      case 'entity_count':
        return b.stats.entity_count - a.stats.entity_count;
      default:
        return (a.name || a.project_id).localeCompare(b.name || b.project_id);
    }
  });
}

export const listProjectsTool = {
  name: 'list_projects',
  description: 'List all projects in the CodeRAG graph database with optional statistics',
  inputSchema: {
    type: 'object',
    properties: {
      include_stats: {
        type: 'boolean',
        description: 'Include detailed statistics for each project (entity counts, types, etc.)',
        default: false
      },
      sort_by: {
        type: 'string',
        enum: ['name', 'created_at', 'updated_at', 'entity_count'],
        description: 'Sort projects by the specified field',
        default: 'name'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of projects to return',
        default: 100,
        minimum: 1,
        maximum: 1000
      }
    },
    required: []
  }
};