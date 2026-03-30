import { MetricsManager } from '../../analysis/metrics-manager.js';
import { createPaginatedResponse } from '../../utils/token-limiter.js';

// Metrics Analysis Tool Parameters
export interface CalculateCKMetricsParams {
  classId: string;
}

export interface CalculatePackageMetricsParams {
  packageName: string;
}

export interface GetProjectSummaryParams {
  project?: string;
}

// Quality Assessment Helpers
export function assessCKMetrics(result: any): string {
  const issues: string[] = [];
  
  if (result.wmc > 15) issues.push("High WMC: Consider breaking down this class");
  if (result.dit > 4) issues.push("Deep inheritance: Consider composition over inheritance");
  if (result.noc > 7) issues.push("Many children: Consider interface segregation");
  if (result.cbo > 10) issues.push("High coupling: Reduce dependencies");
  if (result.rfc > 30) issues.push("High RFC: Class is doing too much");
  if (result.lcom > 0.7) issues.push("Low cohesion: Methods don't work together well");
  
  if (issues.length === 0) {
    return "✅ Class metrics appear healthy";
  }
  
  return "⚠️ Issues detected:\n" + issues.map(issue => `• ${issue}`).join('\n');
}

export function assessPackageMetrics(result: any): string {
  const issues: string[] = [];
  
  if (result.instability > 0.7 && result.abstractness < 0.3) {
    issues.push("Zone of Pain: Stable and concrete - hard to extend");
  }
  if (result.instability < 0.3 && result.abstractness > 0.7) {
    issues.push("Zone of Uselessness: Abstract and stable but not used");
  }
  if (result.distance > 0.7) {
    issues.push("Poorly balanced abstraction vs instability");
  }
  if (result.ce === 0 && result.ca === 0) {
    issues.push("Isolated package - no dependencies");
  }
  
  if (issues.length === 0) {
    return "✅ Package design appears well-balanced";
  }
  
  return "⚠️ Issues detected:\n" + issues.map(issue => `• ${issue}`).join('\n');
}

export function calculateQualityScore(summary: any): string {
  let score = 100;
  
  // Penalize high averages
  if (summary.averageMetrics.avgCBO > 10) score -= 20;
  if (summary.averageMetrics.avgRFC > 30) score -= 15;
  if (summary.averageMetrics.avgDIT > 4) score -= 10;
  
  // Penalize issues
  score -= summary.issueCount * 5;
  
  score = Math.max(0, score);
  
  if (score >= 90) return `${score}/100 (Excellent)`;
  if (score >= 75) return `${score}/100 (Good)`;
  if (score >= 60) return `${score}/100 (Fair)`;
  if (score >= 40) return `${score}/100 (Poor)`;
  return `${score}/100 (Critical)`;
}

// Metrics Analysis Functions
export async function calculateCKMetrics(
  metricsManager: MetricsManager,
  params: CalculateCKMetricsParams,
  detailLevel: 'detailed' | 'simple' = 'simple'
) {
  const result = await metricsManager.calculateCKMetrics(params.classId);
  
  if (detailLevel === 'detailed') {
    return {
      content: [{ 
        type: 'text', 
        text: `CK Metrics for ${result.className}:

• Weighted Methods per Class (WMC): ${result.wmc}
• Depth of Inheritance Tree (DIT): ${result.dit}
• Number of Children (NOC): ${result.noc}
• Coupling Between Objects (CBO): ${result.cbo}
• Response for Class (RFC): ${result.rfc}
• Lack of Cohesion in Methods (LCOM): ${result.lcom}

Quality Assessment:
${assessCKMetrics(result)}

Raw Data:
${JSON.stringify(result, null, 2)}`
      }]
    };
  } else {
    return {
      content: [{ 
        type: 'text', 
        text: `CK Metrics for ${result.className}:
• WMC: ${result.wmc}, DIT: ${result.dit}, NOC: ${result.noc}
• CBO: ${result.cbo}, RFC: ${result.rfc}, LCOM: ${result.lcom}

${JSON.stringify(result, null, 2)}`
      }]
    };
  }
}

export async function calculatePackageMetrics(
  metricsManager: MetricsManager,
  params: CalculatePackageMetricsParams,
  detailLevel: 'detailed' | 'simple' = 'simple'
) {
  const result = await metricsManager.calculatePackageMetrics(params.packageName);
  
  if (detailLevel === 'detailed') {
    return {
      content: [{ 
        type: 'text', 
        text: `Package Metrics for ${result.packageName}:

• Afferent Coupling (Ca): ${result.ca}
• Efferent Coupling (Ce): ${result.ce}
• Instability (I): ${result.instability.toFixed(3)}
• Abstractness (A): ${result.abstractness.toFixed(3)}
• Distance from Main Sequence (D): ${result.distance.toFixed(3)}

Quality Assessment:
${assessPackageMetrics(result)}

Raw Data:
${JSON.stringify(result, null, 2)}`
      }]
    };
  } else {
    return {
      content: [{ 
        type: 'text', 
        text: `Package Metrics for ${result.packageName}:
• Ca: ${result.ca}, Ce: ${result.ce}, I: ${result.instability.toFixed(3)}
• A: ${result.abstractness.toFixed(3)}, D: ${result.distance.toFixed(3)}

${JSON.stringify(result, null, 2)}`
      }]
    };
  }
}

export async function findArchitecturalIssues(
  metricsManager: MetricsManager,
  params: { limit?: number; offset?: number } = {}
) {
  const result = await metricsManager.findArchitecturalIssues();
  const paginated = createPaginatedResponse(result, params.offset || 0, params.limit);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(paginated, null, 2) }]
  };
}

export async function getProjectSummary(
  metricsManager: MetricsManager,
  params: GetProjectSummaryParams,
  detailLevel: 'detailed' | 'simple' = 'simple'
) {
  const result = await metricsManager.calculateProjectSummary();
  
  if (detailLevel === 'detailed') {
    return {
      content: [{ 
        type: 'text', 
        text: `📊 PROJECT SUMMARY

🏗️ STRUCTURE
  Classes: ${result.totalClasses}
  Methods: ${result.totalMethods}
  Packages: ${result.totalPackages}

📈 QUALITY SCORE: ${calculateQualityScore(result)}

📊 AVERAGE METRICS
  CBO (Coupling): ${result.averageMetrics.avgCBO.toFixed(2)}
  RFC (Response): ${result.averageMetrics.avgRFC.toFixed(2)}
  DIT (Inheritance): ${result.averageMetrics.avgDIT.toFixed(2)}
  LCOM (Cohesion): ${(result.averageMetrics as any).avgLCOM?.toFixed(2) || 'N/A'}

⚠️ ISSUES DETECTED: ${result.issueCount}

🎯 RECOMMENDATIONS
${result.issueCount > 0 ? 
  '• Review architectural issues using find_architectural_issues\n• Focus on reducing coupling and improving cohesion\n• Consider refactoring large classes and deep hierarchies' :
  '• Code structure appears healthy\n• Continue monitoring as codebase grows\n• Consider adding more comprehensive tests'
}

Raw Data:
${JSON.stringify(result, null, 2)}`
      }]
    };
  } else {
    return {
      content: [{ 
        type: 'text', 
        text: `Project Summary: ${result.totalClasses} classes, ${result.totalMethods} methods, ${result.issueCount} issues

${JSON.stringify(result, null, 2)}`
      }]
    };
  }
}