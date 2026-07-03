import { Neo4jClient } from '../graph/neo4j-client.js';

export interface CKMetrics {
  classId: string;
  className: string;
  wmc: number;        // Weighted Methods per Class
  dit: number;        // Depth of Inheritance Tree
  noc: number;        // Number of Children
  cbo: number;        // Coupling Between Objects
  rfc: number;        // Response for Class
  lcom: number;       // Lack of Cohesion in Methods (basic version)
}

export interface PackageMetrics {
  packageName: string;
  ca: number;         // Afferent Coupling
  ce: number;         // Efferent Coupling
  instability: number; // I = Ce / (Ce + Ca)
  abstractness: number; // A = abstract classes / total classes
  distance: number;    // D = |A + I - 1|
}

export interface ArchitecturalIssue {
  type: 'circular_dependency' | 'layer_violation' | 'god_class' | 'high_coupling';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  entities: string[];
  metrics?: Record<string, number>;
}

export class MetricsManager {
  constructor(private client: Neo4jClient) {}

  async calculateCKMetrics(classId: string, projectId?: string): Promise<CKMetrics> {
    const className = await this.getClassName(classId, projectId);
    
    const [wmc, dit, noc, cbo, rfc, lcom] = await Promise.all([
      this.calculateWMC(classId, projectId),
      this.calculateDIT(classId, projectId),
      this.calculateNOC(classId, projectId),
      this.calculateCBO(classId, projectId),
      this.calculateRFC(classId, projectId),
      this.calculateLCOM(classId, projectId)
    ]);

    return {
      classId,
      className,
      wmc,
      dit,
      noc,
      cbo,
      rfc,
      lcom
    };
  }

  async calculatePackageMetrics(packageName: string, projectId?: string): Promise<PackageMetrics> {
    const [ca, ce, abstractness] = await Promise.all([
      this.calculateAfferentCoupling(packageName, projectId),
      this.calculateEfferentCoupling(packageName, projectId),
      this.calculateAbstractness(packageName, projectId)
    ]);

    const instability = (ca + ce) === 0 ? 0 : ce / (ca + ce);
    const distance = Math.abs(abstractness + instability - 1);

    return {
      packageName,
      ca,
      ce,
      instability,
      abstractness,
      distance
    };
  }

  async findArchitecturalIssues(projectId?: string): Promise<ArchitecturalIssue[]> {
    const issues: ArchitecturalIssue[] = [];

    // Find circular dependencies
    const circularDeps = await this.findCircularDependencies(projectId);
    issues.push(...circularDeps);

    // Find god classes
    const godClasses = await this.findGodClasses(projectId);
    issues.push(...godClasses);

    // Find highly coupled classes
    const highCoupling = await this.findHighlyCoupledClasses(projectId);
    issues.push(...highCoupling);

    return issues;
  }

  async calculateProjectSummary(projectId?: string): Promise<{
    totalClasses: number;
    totalMethods: number;
    totalPackages: number;
    averageMetrics: {
      avgCBO: number;
      avgRFC: number;
      avgDIT: number;
    };
    issueCount: number;
  }> {
    const [
      totalClasses,
      totalMethods,
      totalPackages,
      avgMetrics,
      issues
    ] = await Promise.all([
      this.getTotalClasses(projectId),
      this.getTotalMethods(projectId),
      this.getTotalPackages(projectId),
      this.getAverageMetrics(projectId),
      this.findArchitecturalIssues(projectId)
    ]);

    return {
      totalClasses,
      totalMethods,
      totalPackages,
      averageMetrics: avgMetrics,
      issueCount: issues.length
    };
  }

  // CK Metrics Implementation
  private async calculateWMC(classId: string, projectId?: string): Promise<number> {
    const anchor = projectId ? '{id: $classId, project_id: $projectId}' : '{id: $classId}';
    const query = `
      MATCH (class:CodeNode ${anchor})-[:CONTAINS]->(method:CodeNode {type: 'method'})
      RETURN count(method) as wmc
    `;
    const result = await this.client.runQuery(query, this.ckParams(classId, projectId));
    return result.records[0]?.get('wmc').toNumber() || 0;
  }

  private async calculateDIT(classId: string, projectId?: string): Promise<number> {
    const anchor = projectId ? '{id: $classId, project_id: $projectId}' : '{id: $classId}';
    const query = `
      MATCH path = (class:CodeNode ${anchor})-[:EXTENDS*]->(ancestor:CodeNode)
      RETURN max(length(path)) as dit
    `;
    const result = await this.client.runQuery(query, this.ckParams(classId, projectId));
    return result.records[0]?.get('dit')?.toNumber() || 0;
  }

  private async calculateNOC(classId: string, projectId?: string): Promise<number> {
    const anchor = projectId ? '{id: $classId, project_id: $projectId}' : '{id: $classId}';
    const query = `
      MATCH (class:CodeNode ${anchor})<-[:EXTENDS]-(child:CodeNode)
      RETURN count(child) as noc
    `;
    const result = await this.client.runQuery(query, this.ckParams(classId, projectId));
    return result.records[0]?.get('noc').toNumber() || 0;
  }

  private async calculateCBO(classId: string, projectId?: string): Promise<number> {
    // CBO counts the number of other classes this class is coupled to
    // This includes: inheritance, interface implementation, field types, method parameters, etc.
    const anchor = projectId ? '{id: $classId, project_id: $projectId}' : '{id: $classId}';
    const query = `
      MATCH (class:CodeNode ${anchor})
      OPTIONAL MATCH (class)-[:EXTENDS|IMPLEMENTS|REFERENCES]->(other:CodeNode)
      WHERE other.type IN ['class', 'interface'] AND other.id <> $classId
      WITH class, collect(DISTINCT other) as outgoing
      OPTIONAL MATCH (class)<-[:EXTENDS|IMPLEMENTS|REFERENCES]-(incoming:CodeNode)
      WHERE incoming.type IN ['class', 'interface'] AND incoming.id <> $classId
      WITH outgoing, collect(DISTINCT incoming) as incoming
      RETURN size(outgoing) + size(incoming) as cbo
    `;
    const result = await this.client.runQuery(query, this.ckParams(classId, projectId));
    return result.records[0]?.get('cbo').toNumber() || 0;
  }

  private async calculateRFC(classId: string, projectId?: string): Promise<number> {
    const anchor = projectId ? '{id: $classId, project_id: $projectId}' : '{id: $classId}';
    const query = `
      MATCH (class:CodeNode ${anchor})-[:CONTAINS]->(method:CodeNode {type: 'method'})
      OPTIONAL MATCH (method)-[:CALLS]->(calledMethod:CodeNode {type: 'method'})
      RETURN count(DISTINCT method) + count(DISTINCT calledMethod) as rfc
    `;
    const result = await this.client.runQuery(query, this.ckParams(classId, projectId));
    return result.records[0]?.get('rfc').toNumber() || 0;
  }

  private async calculateLCOM(classId: string, projectId?: string): Promise<number> {
    // Simplified LCOM calculation - basic version
    // More sophisticated version would require field usage analysis
    const anchor = projectId ? '{id: $classId, project_id: $projectId}' : '{id: $classId}';
    const query = `
      MATCH (class:CodeNode ${anchor})-[:CONTAINS]->(method:CodeNode {type: 'method'})
      MATCH (class)-[:CONTAINS]->(field:CodeNode {type: 'field'})
      RETURN count(DISTINCT method) as methods, count(DISTINCT field) as fields
    `;
    const result = await this.client.runQuery(query, this.ckParams(classId, projectId));
    const record = result.records[0];
    const methods = record?.get('methods').toNumber() || 0;
    const fields = record?.get('fields').toNumber() || 0;
    
    // Basic LCOM approximation
    return methods > 0 && fields > 0 ? Math.max(0, methods - fields) : 0;
  }

  // Package Metrics Implementation
  private async calculateAfferentCoupling(packageName: string, projectId?: string): Promise<number> {
    const projectFilter = projectId
      ? 'AND internal.project_id = $projectId AND external.project_id = $projectId'
      : '';
    const query = `
      MATCH (external:CodeNode)-[:CALLS|REFERENCES|EXTENDS|IMPLEMENTS]->(internal:CodeNode)
      WHERE internal.qualified_name STARTS WITH $packagePrefix
      AND NOT external.qualified_name STARTS WITH $packagePrefix
      ${projectFilter}
      RETURN count(DISTINCT external) as ca
    `;
    const params: Record<string, any> = { packagePrefix: packageName + '.' };
    if (projectId) params.projectId = projectId;
    const result = await this.client.runQuery(query, params);
    return result.records[0]?.get('ca').toNumber() || 0;
  }

  private async calculateEfferentCoupling(packageName: string, projectId?: string): Promise<number> {
    const projectFilter = projectId
      ? 'AND internal.project_id = $projectId AND external.project_id = $projectId'
      : '';
    const query = `
      MATCH (internal:CodeNode)-[:CALLS|REFERENCES|EXTENDS|IMPLEMENTS]->(external:CodeNode)
      WHERE internal.qualified_name STARTS WITH $packagePrefix
      AND NOT external.qualified_name STARTS WITH $packagePrefix
      ${projectFilter}
      RETURN count(DISTINCT external) as ce
    `;
    const params: Record<string, any> = { packagePrefix: packageName + '.' };
    if (projectId) params.projectId = projectId;
    const result = await this.client.runQuery(query, params);
    return result.records[0]?.get('ce').toNumber() || 0;
  }

  private async calculateAbstractness(packageName: string, projectId?: string): Promise<number> {
    const projectFilter = projectId ? 'AND class.project_id = $projectId' : '';
    // Martin's Abstractness A = (abstract classes + interfaces) / total types.
    // The MATCH must include interfaces and enums, not just type='class' — otherwise
    // packages composed mainly of interfaces report A=0 (the interface CASE branch
    // could never fire under a type='class'-only filter). An interface is abstract by
    // definition; a node is also abstract if it carries the 'abstract' modifier or
    // has is_abstract=true. Enums are counted as concrete types in the denominator.
    const query = `
      MATCH (class:CodeNode)
      WHERE class.qualified_name STARTS WITH $packagePrefix
      AND class.type IN ['class', 'interface', 'enum']
      ${projectFilter}
      RETURN 
        count(CASE WHEN class.type = 'interface'
                     OR class.is_abstract = true
                     OR 'abstract' IN class.modifiers
                   THEN 1 END) as abstractClasses,
        count(class) as totalClasses
    `;
    const params: Record<string, any> = { packagePrefix: packageName + '.' };
    if (projectId) params.projectId = projectId;
    const result = await this.client.runQuery(query, params);
    const record = result.records[0];
    const abstract = record?.get('abstractClasses').toNumber() || 0;
    const total = record?.get('totalClasses').toNumber() || 0;
    
    return total > 0 ? abstract / total : 0;
  }

  // Architectural Analysis
  private async findCircularDependencies(projectId?: string): Promise<ArchitecturalIssue[]> {
    // Detect circular dependencies between classes, excluding bidirectional ORM
    // parent-child relationships (e.g., ParentPO -> ChildPO -> ParentPO via owner reference).
    // Exclusion criteria for 2-hop cycles:
    //   1. Both classes end with "PO" and share the same package (ORM entity ownership), OR
    //   2. One class name contains the other (nested/attribute value pattern)
    const anchor = projectId ? "{type: 'class', project_id: $projectId}" : "{type: 'class'}";
    const query = `
      MATCH path = (c1:CodeNode ${anchor})-[:REFERENCES*2..5]->(c2:CodeNode {type: 'class'})
      WHERE c1 = c2
      WITH c1, nodes(path) as cycleNodes, length(path) as cycleLength
      // Check if all nodes in cycle are PO classes in the same package (ORM ownership pattern)
      WITH c1, cycleNodes, cycleLength,
        reduce(pkg = replace(c1.qualified_name, '.' + c1.name, ''), n IN cycleNodes[1..] |
          CASE WHEN pkg IS NOT NULL
            AND replace(n.qualified_name, '.' + n.name, '') = replace(c1.qualified_name, '.' + c1.name, '')
            AND n.name ENDS WITH 'PO'
          THEN pkg ELSE null END
        ) as sameOrmPackage
      WITH c1, cycleNodes, cycleLength, sameOrmPackage,
        CASE
          WHEN c1.name ENDS WITH 'PO' AND sameOrmPackage IS NOT NULL THEN true
          WHEN cycleLength = 2 AND
            replace(c1.qualified_name, '.' + c1.name, '') =
              replace(cycleNodes[1].qualified_name, '.' + cycleNodes[1].name, '')
            AND (cycleNodes[1].name CONTAINS c1.name OR c1.name CONTAINS cycleNodes[1].name)
          THEN true
          ELSE false
        END as isBidirectionalOrm
      WHERE NOT isBidirectionalOrm
      RETURN DISTINCT c1.name as className
    `;
    const result = await this.client.runQuery(query, projectId ? { projectId } : {});
    
    return result.records.map(record => ({
      type: 'circular_dependency' as const,
      severity: 'high' as const,
      description: `Circular dependency detected involving class: ${record.get('className')}`,
      entities: [record.get('className')]
    }));
  }

  private async findGodClasses(projectId?: string): Promise<ArchitecturalIssue[]> {
    const anchor = projectId ? "{type: 'class', project_id: $projectId}" : "{type: 'class'}";
    const query = `
      MATCH (class:CodeNode ${anchor})-[:CONTAINS]->(method:CodeNode {type: 'method'})
      WITH class, count(method) as methodCount
      WHERE methodCount > 20
      OPTIONAL MATCH (class)-[:CALLS|REFERENCES]-(other:CodeNode {type: 'class'})
      WITH class, methodCount, count(DISTINCT other) as coupling
      WHERE coupling > 10
      RETURN class.id as classId, class.name as className, methodCount, coupling
    `;
    const result = await this.client.runQuery(query, projectId ? { projectId } : {});
    
    return result.records.map(record => ({
      type: 'god_class' as const,
      severity: 'high' as const,
      description: `God class detected: ${record.get('className')} (${record.get('methodCount')} methods, ${record.get('coupling')} couplings)`,
      entities: [record.get('classId')],
      metrics: {
        methodCount: record.get('methodCount').toNumber(),
        coupling: record.get('coupling').toNumber()
      }
    }));
  }

  private async findHighlyCoupledClasses(projectId?: string): Promise<ArchitecturalIssue[]> {
    const anchor = projectId ? "{type: 'class', project_id: $projectId}" : "{type: 'class'}";
    const query = `
      MATCH (class:CodeNode ${anchor})-[:CALLS|REFERENCES]-(other:CodeNode {type: 'class'})
      WITH class, count(DISTINCT other) as coupling
      WHERE coupling > 15
      RETURN class.id as classId, class.name as className, coupling
      ORDER BY coupling DESC
    `;
    const result = await this.client.runQuery(query, projectId ? { projectId } : {});
    
    return result.records.map(record => ({
      type: 'high_coupling' as const,
      severity: record.get('coupling').toNumber() > 25 ? 'critical' as const : 'high' as const,
      description: `Highly coupled class: ${record.get('className')} (${record.get('coupling')} couplings)`,
      entities: [record.get('classId')],
      metrics: {
        coupling: record.get('coupling').toNumber()
      }
    }));
  }

  // Helper methods
  private ckParams(classId: string, projectId?: string): Record<string, any> {
    const params: Record<string, any> = { classId };
    if (projectId) params.projectId = projectId;
    return params;
  }

  private async getClassName(classId: string, projectId?: string): Promise<string> {
    const anchor = projectId ? '{id: $classId, project_id: $projectId}' : '{id: $classId}';
    const query = `MATCH (class:CodeNode ${anchor}) RETURN class.name as name`;
    const result = await this.client.runQuery(query, this.ckParams(classId, projectId));
    return result.records[0]?.get('name') || 'Unknown';
  }

  private async getTotalClasses(projectId?: string): Promise<number> {
    const filter = projectId ? ' WHERE class.project_id = $projectId' : '';
    const query = `MATCH (class:CodeNode {type: "class"})${filter} RETURN count(class) as total`;
    const result = await this.client.runQuery(query, projectId ? { projectId } : {});
    return result.records[0]?.get('total').toNumber() || 0;
  }

  private async getTotalMethods(projectId?: string): Promise<number> {
    const filter = projectId ? ' WHERE method.project_id = $projectId' : '';
    const query = `MATCH (method:CodeNode {type: "method"})${filter} RETURN count(method) as total`;
    const result = await this.client.runQuery(query, projectId ? { projectId } : {});
    return result.records[0]?.get('total').toNumber() || 0;
  }

  private async getTotalPackages(projectId?: string): Promise<number> {
    const filter = projectId ? ' WHERE pkg.project_id = $projectId' : '';
    const query = `MATCH (pkg:CodeNode {type: "package"})${filter} RETURN count(pkg) as total`;
    const result = await this.client.runQuery(query, projectId ? { projectId } : {});
    return result.records[0]?.get('total').toNumber() || 0;
  }

  async listPackages(projectId?: string, depth: number = 3): Promise<string[]> {
    const projectFilter = projectId ? 'AND n.project_id = $projectId' : '';
    const query = `
      MATCH (n:CodeNode)
      WHERE n.qualified_name CONTAINS '.'
        ${projectFilter}
      WITH split(n.qualified_name, '.') as parts
      WHERE size(parts) > $depth
      WITH reduce(pkg = '', i IN range(0, $depth - 1) |
        pkg + CASE WHEN i > 0 THEN '.' ELSE '' END + parts[i]) as package
      RETURN DISTINCT package
      ORDER BY package
    `;
    const params: Record<string, any> = { depth };
    if (projectId) params.projectId = projectId;
    const result = await this.client.runQuery(query, params);
    return result.records.map(r => r.get('package'));
  }

  private async getAverageMetrics(projectId?: string): Promise<{ avgCBO: number; avgRFC: number; avgDIT: number }> {
    const anchor = projectId ? "{type: 'class', project_id: $projectId}" : "{type: 'class'}";
    const query = `
      MATCH (class:CodeNode ${anchor})
      OPTIONAL MATCH (class)-[:CALLS|REFERENCES]-(other:CodeNode {type: 'class'})
      WITH class, count(DISTINCT other) as cbo
      OPTIONAL MATCH (class)-[:CONTAINS]->(method:CodeNode {type: 'method'})
      OPTIONAL MATCH (method)-[:CALLS]->(calledMethod:CodeNode {type: 'method'})
      WITH class, cbo, count(DISTINCT method) + count(DISTINCT calledMethod) as rfc
      OPTIONAL MATCH path = (class)-[:EXTENDS*]->(ancestor:CodeNode)
      WITH class, cbo, rfc, max(length(path)) as dit
      RETURN avg(cbo) as avgCBO, avg(rfc) as avgRFC, avg(dit) as avgDIT
    `;
    const result = await this.client.runQuery(query, projectId ? { projectId } : {});
    const record = result.records[0];
    
    return {
      avgCBO: record?.get('avgCBO') || 0,
      avgRFC: record?.get('avgRFC') || 0,
      avgDIT: record?.get('avgDIT') || 0
    };
  }
}