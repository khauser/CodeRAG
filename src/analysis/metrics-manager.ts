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

  async calculateCKMetrics(classId: string): Promise<CKMetrics> {
    const className = await this.getClassName(classId);
    
    const [wmc, dit, noc, cbo, rfc, lcom] = await Promise.all([
      this.calculateWMC(classId),
      this.calculateDIT(classId),
      this.calculateNOC(classId),
      this.calculateCBO(classId),
      this.calculateRFC(classId),
      this.calculateLCOM(classId)
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

  async calculatePackageMetrics(packageName: string): Promise<PackageMetrics> {
    const [ca, ce, abstractness] = await Promise.all([
      this.calculateAfferentCoupling(packageName),
      this.calculateEfferentCoupling(packageName),
      this.calculateAbstractness(packageName)
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

  async findArchitecturalIssues(): Promise<ArchitecturalIssue[]> {
    const issues: ArchitecturalIssue[] = [];

    // Find circular dependencies
    const circularDeps = await this.findCircularDependencies();
    issues.push(...circularDeps);

    // Find god classes
    const godClasses = await this.findGodClasses();
    issues.push(...godClasses);

    // Find highly coupled classes
    const highCoupling = await this.findHighlyCoupledClasses();
    issues.push(...highCoupling);

    return issues;
  }

  async calculateProjectSummary(): Promise<{
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
      this.getTotalClasses(),
      this.getTotalMethods(),
      this.getTotalPackages(),
      this.getAverageMetrics(),
      this.findArchitecturalIssues()
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
  private async calculateWMC(classId: string): Promise<number> {
    const query = `
      MATCH (class:CodeNode {id: $classId})-[:CONTAINS]->(method:CodeNode {type: 'method'})
      RETURN count(method) as wmc
    `;
    const result = await this.client.runQuery(query, { classId });
    return result.records[0]?.get('wmc').toNumber() || 0;
  }

  private async calculateDIT(classId: string): Promise<number> {
    const query = `
      MATCH path = (class:CodeNode {id: $classId})-[:EXTENDS*]->(ancestor:CodeNode)
      RETURN max(length(path)) as dit
    `;
    const result = await this.client.runQuery(query, { classId });
    return result.records[0]?.get('dit')?.toNumber() || 0;
  }

  private async calculateNOC(classId: string): Promise<number> {
    const query = `
      MATCH (class:CodeNode {id: $classId})<-[:EXTENDS]-(child:CodeNode)
      RETURN count(child) as noc
    `;
    const result = await this.client.runQuery(query, { classId });
    return result.records[0]?.get('noc').toNumber() || 0;
  }

  private async calculateCBO(classId: string): Promise<number> {
    // CBO counts the number of other classes this class is coupled to
    // This includes: inheritance, interface implementation, field types, method parameters, etc.
    const query = `
      MATCH (class:CodeNode {id: $classId})
      OPTIONAL MATCH (class)-[:EXTENDS|IMPLEMENTS|REFERENCES]->(other:CodeNode)
      WHERE other.type IN ['class', 'interface'] AND other.id <> $classId
      WITH class, collect(DISTINCT other) as outgoing
      OPTIONAL MATCH (class)<-[:EXTENDS|IMPLEMENTS|REFERENCES]-(incoming:CodeNode)
      WHERE incoming.type IN ['class', 'interface'] AND incoming.id <> $classId
      RETURN size(outgoing) + size(collect(DISTINCT incoming)) as cbo
    `;
    const result = await this.client.runQuery(query, { classId });
    return result.records[0]?.get('cbo').toNumber() || 0;
  }

  private async calculateRFC(classId: string): Promise<number> {
    const query = `
      MATCH (class:CodeNode {id: $classId})-[:CONTAINS]->(method:CodeNode {type: 'method'})
      OPTIONAL MATCH (method)-[:CALLS]->(calledMethod:CodeNode {type: 'method'})
      RETURN count(DISTINCT method) + count(DISTINCT calledMethod) as rfc
    `;
    const result = await this.client.runQuery(query, { classId });
    return result.records[0]?.get('rfc').toNumber() || 0;
  }

  private async calculateLCOM(classId: string): Promise<number> {
    // Simplified LCOM calculation - basic version
    // More sophisticated version would require field usage analysis
    const query = `
      MATCH (class:CodeNode {id: $classId})-[:CONTAINS]->(method:CodeNode {type: 'method'})
      MATCH (class)-[:CONTAINS]->(field:CodeNode {type: 'field'})
      RETURN count(DISTINCT method) as methods, count(DISTINCT field) as fields
    `;
    const result = await this.client.runQuery(query, { classId });
    const record = result.records[0];
    const methods = record?.get('methods').toNumber() || 0;
    const fields = record?.get('fields').toNumber() || 0;
    
    // Basic LCOM approximation
    return methods > 0 && fields > 0 ? Math.max(0, methods - fields) : 0;
  }

  // Package Metrics Implementation
  private async calculateAfferentCoupling(packageName: string): Promise<number> {
    const query = `
      MATCH (external:CodeNode)-[:CALLS|REFERENCES]->(internal:CodeNode)
      WHERE internal.qualified_name STARTS WITH $packagePrefix
      AND NOT external.qualified_name STARTS WITH $packagePrefix
      RETURN count(DISTINCT external) as ca
    `;
    const result = await this.client.runQuery(query, { packagePrefix: packageName + '.' });
    return result.records[0]?.get('ca').toNumber() || 0;
  }

  private async calculateEfferentCoupling(packageName: string): Promise<number> {
    const query = `
      MATCH (internal:CodeNode)-[:CALLS|REFERENCES]->(external:CodeNode)
      WHERE internal.qualified_name STARTS WITH $packagePrefix
      AND NOT external.qualified_name STARTS WITH $packagePrefix
      RETURN count(DISTINCT external) as ce
    `;
    const result = await this.client.runQuery(query, { packagePrefix: packageName + '.' });
    return result.records[0]?.get('ce').toNumber() || 0;
  }

  private async calculateAbstractness(packageName: string): Promise<number> {
    const query = `
      MATCH (class:CodeNode {type: 'class'})
      WHERE class.qualified_name STARTS WITH $packagePrefix
      RETURN 
        count(CASE WHEN 'abstract' IN class.modifiers OR class.type = 'interface' THEN 1 END) as abstractClasses,
        count(class) as totalClasses
    `;
    const result = await this.client.runQuery(query, { packagePrefix: packageName + '.' });
    const record = result.records[0];
    const abstract = record?.get('abstractClasses').toNumber() || 0;
    const total = record?.get('totalClasses').toNumber() || 0;
    
    return total > 0 ? abstract / total : 0;
  }

  // Architectural Analysis
  private async findCircularDependencies(): Promise<ArchitecturalIssue[]> {
    // Use REFERENCES relationship to detect circular dependencies between classes
    const query = `
      MATCH (c1:CodeNode {type: 'class'})-[:REFERENCES*2..5]->(c2:CodeNode {type: 'class'})
      WHERE c1 = c2
      RETURN DISTINCT c1.name as className
    `;
    const result = await this.client.runQuery(query);
    
    return result.records.map(record => ({
      type: 'circular_dependency' as const,
      severity: 'high' as const,
      description: `Circular dependency detected involving class: ${record.get('className')}`,
      entities: [record.get('className')]
    }));
  }

  private async findGodClasses(): Promise<ArchitecturalIssue[]> {
    const query = `
      MATCH (class:CodeNode {type: 'class'})-[:CONTAINS]->(method:CodeNode {type: 'method'})
      WITH class, count(method) as methodCount
      WHERE methodCount > 20
      OPTIONAL MATCH (class)-[:CALLS|REFERENCES]-(other:CodeNode {type: 'class'})
      WITH class, methodCount, count(DISTINCT other) as coupling
      WHERE coupling > 10
      RETURN class.id as classId, class.name as className, methodCount, coupling
    `;
    const result = await this.client.runQuery(query);
    
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

  private async findHighlyCoupledClasses(): Promise<ArchitecturalIssue[]> {
    const query = `
      MATCH (class:CodeNode {type: 'class'})-[:CALLS|REFERENCES]-(other:CodeNode {type: 'class'})
      WITH class, count(DISTINCT other) as coupling
      WHERE coupling > 15
      RETURN class.id as classId, class.name as className, coupling
      ORDER BY coupling DESC
    `;
    const result = await this.client.runQuery(query);
    
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
  private async getClassName(classId: string): Promise<string> {
    const query = 'MATCH (class:CodeNode {id: $classId}) RETURN class.name as name';
    const result = await this.client.runQuery(query, { classId });
    return result.records[0]?.get('name') || 'Unknown';
  }

  private async getTotalClasses(): Promise<number> {
    const query = 'MATCH (class:CodeNode {type: "class"}) RETURN count(class) as total';
    const result = await this.client.runQuery(query);
    return result.records[0]?.get('total').toNumber() || 0;
  }

  private async getTotalMethods(): Promise<number> {
    const query = 'MATCH (method:CodeNode {type: "method"}) RETURN count(method) as total';
    const result = await this.client.runQuery(query);
    return result.records[0]?.get('total').toNumber() || 0;
  }

  private async getTotalPackages(): Promise<number> {
    const query = 'MATCH (pkg:CodeNode {type: "package"}) RETURN count(pkg) as total';
    const result = await this.client.runQuery(query);
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

  private async getAverageMetrics(): Promise<{ avgCBO: number; avgRFC: number; avgDIT: number }> {
    const query = `
      MATCH (class:CodeNode {type: 'class'})
      OPTIONAL MATCH (class)-[:CALLS|REFERENCES]-(other:CodeNode {type: 'class'})
      WITH class, count(DISTINCT other) as cbo
      OPTIONAL MATCH (class)-[:CONTAINS]->(method:CodeNode {type: 'method'})
      OPTIONAL MATCH (method)-[:CALLS]->(calledMethod:CodeNode {type: 'method'})
      WITH class, cbo, count(DISTINCT method) + count(DISTINCT calledMethod) as rfc
      OPTIONAL MATCH path = (class)-[:EXTENDS*]->(ancestor:CodeNode)
      WITH class, cbo, rfc, max(length(path)) as dit
      RETURN avg(cbo) as avgCBO, avg(rfc) as avgRFC, avg(dit) as avgDIT
    `;
    const result = await this.client.runQuery(query);
    const record = result.records[0];
    
    return {
      avgCBO: record?.get('avgCBO') || 0,
      avgRFC: record?.get('avgRFC') || 0,
      avgDIT: record?.get('avgDIT') || 0
    };
  }
}