import * as path from 'path';
import { BaseLanguageParser } from './base/BaseLanguageParser.js';
import { ParsedEntity, ParsedRelationship, ParseError } from '../types.js';

interface PipelineNode {
  nodeId: string;
  type: string;
  name?: string;
  strict?: boolean;
  callMode?: string;
  parameters?: Array<{ name: string; type: string }>;
  returnValues?: Array<{ name: string; type: string }>;
  pipeletRef?: string;
  successors?: string[];
  parameterBindings?: Array<{ name: string; objectPath: string }>;
  returnValueBindings?: Array<{ name: string; objectPath: string }>;
}

interface Pipeline {
  name: string;
  type: string;
  overrideMode: string;
  nodes: PipelineNode[];
}

/**
 * Parser for Intershop Pipeline XML files (.pipeline)
 * 
 * Intershop Pipelines are workflow definitions used in Intershop Commerce Management.
 * They define business logic flows with:
 * - StartNodes: Entry points (mapped to 'function' type)
 * - EndNodes: Exit points
 * - PipeletNodes: Java component calls
 * - PipelineNodeNodes: References to other pipelets/pipelines
 * - JoinNodes: Flow control
 * 
 * This parser extracts:
 * - Pipeline as module
 * - StartNodes as functions (with parameters)
 * - EndNodes with return values
 * - Pipelet/Pipeline references as relationships
 */
export class PipelineParser extends BaseLanguageParser {
  
  canParse(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.pipeline';
  }

  async parseFile(filePath: string, content: string, projectId: string): Promise<{
    entities: ParsedEntity[];
    relationships: ParsedRelationship[];
    errors: ParseError[];
  }> {
    this.setCurrentProject(projectId);

    const entities: ParsedEntity[] = [];
    const relationships: ParsedRelationship[] = [];
    const errors: ParseError[] = [];

    try {
      const pipeline = this.parsePipelineXml(content, filePath);
      
      if (!pipeline) {
        this.addError(errors, {
          file_path: filePath,
          message: 'Could not parse pipeline XML',
          severity: 'error'
        });
        return { entities, relationships, errors };
      }

      // Extract cartridge/module name from path
      const cartridgeName = this.extractCartridgeName(filePath);
      const pipelineQualifiedName = cartridgeName ? `${cartridgeName}.${pipeline.name}` : pipeline.name;
      
      // Create pipeline entity as module
      const pipelineEntity: Omit<ParsedEntity, 'project_id'> = {
        id: pipelineQualifiedName,
        type: 'module',
        name: pipeline.name,
        qualified_name: pipelineQualifiedName,
        source_file: filePath,
        description: `Intershop Pipeline: ${pipeline.name} (${pipeline.type})`,
        attributes: {
          pipeline_type: pipeline.type,
          override_mode: pipeline.overrideMode,
          cartridge: cartridgeName
        }
      };
      this.addEntity(entities, pipelineEntity);

      // Process nodes
      for (const node of pipeline.nodes) {
        this.processNode(node, pipeline, pipelineQualifiedName, filePath, entities, relationships, errors);
      }

    } catch (error) {
      this.addError(errors, {
        file_path: filePath,
        message: `Failed to parse pipeline: ${error instanceof Error ? error.message : 'Unknown error'}`,
        severity: 'error'
      });
    }

    return { entities, relationships, errors };
  }

  private parsePipelineXml(content: string, filePath: string): Pipeline | null {
    // Extract pipeline attributes
    const pipelineMatch = content.match(/<pipeline:Pipeline[^>]*name="([^"]+)"[^>]*>/);
    if (!pipelineMatch) return null;

    const name = pipelineMatch[1];
    const typeMatch = content.match(/type="([^"]+)"/);
    const overrideModeMatch = content.match(/overrideMode="([^"]+)"/);

    const pipeline: Pipeline = {
      name,
      type: typeMatch ? typeMatch[1] : 'unknown',
      overrideMode: overrideModeMatch ? overrideModeMatch[1] : 'Inherit',
      nodes: []
    };

    // Parse all nodes
    const nodePattern = /<nodes\s+xsi:type="pipeline:(\w+)"([^>]*)>([\s\S]*?)<\/nodes>/g;
    let match;
    
    while ((match = nodePattern.exec(content)) !== null) {
      const nodeType = match[1];
      const attributes = match[2];
      const nodeContent = match[3];

      const node = this.parseNode(nodeType, attributes, nodeContent);
      if (node) {
        pipeline.nodes.push(node);
      }
    }

    return pipeline;
  }

  private parseNode(nodeType: string, attributes: string, content: string): PipelineNode | null {
    const nodeIdMatch = attributes.match(/nodeID="([^"]+)"/);
    if (!nodeIdMatch) return null;

    const node: PipelineNode = {
      nodeId: nodeIdMatch[1],
      type: nodeType
    };

    // Parse common attributes
    const nameMatch = attributes.match(/\sname="([^"]+)"/);
    if (nameMatch) node.name = nameMatch[1];

    const strictMatch = attributes.match(/strict="([^"]+)"/);
    if (strictMatch) node.strict = strictMatch[1] === 'true';

    const callModeMatch = attributes.match(/callMode="([^"]+)"/);
    if (callModeMatch) node.callMode = callModeMatch[1];

    // Parse parameters (for StartNode)
    const parameters: Array<{ name: string; type: string }> = [];
    const paramPattern = /<parameters\s+name="([^"]+)"\s+type="([^"]+)"/g;
    let paramMatch;
    while ((paramMatch = paramPattern.exec(content)) !== null) {
      parameters.push({ name: paramMatch[1], type: paramMatch[2] });
    }
    if (parameters.length > 0) node.parameters = parameters;

    // Parse return values (for EndNode)
    const returnValues: Array<{ name: string; type: string }> = [];
    const returnPattern = /<returnValues\s+name="([^"]+)"\s+type="([^"]+)"/g;
    let returnMatch;
    while ((returnMatch = returnPattern.exec(content)) !== null) {
      returnValues.push({ name: returnMatch[1], type: returnMatch[2] });
    }
    if (returnValues.length > 0) node.returnValues = returnValues;

    // Parse pipelet reference (for PipeletNode and PipelineNodeNode)
    const pipeletMatch = content.match(/<pipelet\s+href="([^"]+)"/);
    if (pipeletMatch) node.pipeletRef = pipeletMatch[1];

    // Parse successors
    const successors: string[] = [];
    const successorPattern = /<nodeSuccessors[^>]*next="([^"]+)"/g;
    let successorMatch;
    while ((successorMatch = successorPattern.exec(content)) !== null) {
      successors.push(successorMatch[1]);
    }
    if (successors.length > 0) node.successors = successors;

    // Parse parameter bindings
    const paramBindings: Array<{ name: string; objectPath: string }> = [];
    const bindingPattern = /<parameterBindings\s+name="([^"]+)"\s+objectPath="([^"]+)"/g;
    let bindingMatch;
    while ((bindingMatch = bindingPattern.exec(content)) !== null) {
      paramBindings.push({ name: bindingMatch[1], objectPath: bindingMatch[2] });
    }
    if (paramBindings.length > 0) node.parameterBindings = paramBindings;

    return node;
  }

  private processNode(
    node: PipelineNode,
    pipeline: Pipeline,
    pipelineQualifiedName: string,
    filePath: string,
    entities: ParsedEntity[],
    relationships: ParsedRelationship[],
    errors: ParseError[]
  ): void {
    switch (node.type) {
      case 'StartNode':
        this.processStartNode(node, pipelineQualifiedName, filePath, entities, relationships);
        break;
      case 'EndNode':
        this.processEndNode(node, pipelineQualifiedName, filePath, entities, relationships);
        break;
      case 'PipeletNode':
      case 'PipelineNodeNode':
        this.processPipeletNode(node, pipelineQualifiedName, filePath, relationships);
        break;
      // JoinNode, DecisionNode etc. are flow control nodes - not creating entities for them
    }
  }

  private processStartNode(
    node: PipelineNode,
    pipelineQualifiedName: string,
    filePath: string,
    entities: ParsedEntity[],
    relationships: ParsedRelationship[]
  ): void {
    if (!node.name) return;

    const startNodeId = `${pipelineQualifiedName}.${node.name}`;
    
    const entity: Omit<ParsedEntity, 'project_id'> = {
      id: startNodeId,
      type: 'function',
      name: node.name,
      qualified_name: startNodeId,
      source_file: filePath,
      description: `Pipeline StartNode: ${node.name}${node.callMode ? ` (${node.callMode})` : ''}`,
      modifiers: node.callMode ? [node.callMode.toLowerCase()] : [],
      attributes: {
        parameters: node.parameters?.map(p => ({
          name: p.name,
          type: p.type,
          description: `Parameter of type ${p.type}`
        })) || [],
        is_strict: node.strict,
        call_mode: node.callMode,
        node_type: 'StartNode'
      }
    };
    this.addEntity(entities, entity);

    // Create contains relationship from pipeline to start node
    const containsRelationship: Omit<ParsedRelationship, 'project_id'> = {
      id: `contains:${pipelineQualifiedName}:${startNodeId}`,
      type: 'contains',
      source: pipelineQualifiedName,
      target: startNodeId,
      source_file: filePath
    };
    this.addRelationship(relationships, containsRelationship);
  }

  private processEndNode(
    node: PipelineNode,
    pipelineQualifiedName: string,
    filePath: string,
    entities: ParsedEntity[],
    relationships: ParsedRelationship[]
  ): void {
    // EndNodes are part of the pipeline flow but typically don't need separate entities
    // Their return values are useful for understanding what the pipeline returns
    // We could add them as attributes to the StartNode or Pipeline if needed
  }

  private processPipeletNode(
    node: PipelineNode,
    pipelineQualifiedName: string,
    filePath: string,
    relationships: ParsedRelationship[]
  ): void {
    if (!node.pipeletRef) return;

    // Parse the pipelet reference: enfinity:/cartridge/pipelets/ClassName.pipelinenode or .xml
    const pipeletTarget = this.parsePipeletReference(node.pipeletRef);
    if (!pipeletTarget) return;

    // Create a "calls" relationship from the pipeline to the pipelet
    const callRelationship: Omit<ParsedRelationship, 'project_id'> = {
      id: `calls:${pipelineQualifiedName}:${pipeletTarget}:${node.nodeId}`,
      type: 'calls',
      source: pipelineQualifiedName,
      target: pipeletTarget,
      source_file: filePath,
      attributes: {
        node_id: node.nodeId,
        node_type: node.type,
        parameter_bindings: node.parameterBindings
      }
    };
    this.addRelationship(relationships, callRelationship);
  }

  private parsePipeletReference(ref: string): string | null {
    // Format: enfinity:/cartridge/pipelets/com.package.ClassName.pipelinenode
    // or: enfinity:/cartridge/pipelets/ClassName.xml
    
    const match = ref.match(/enfinity:\/([^/]+)\/pipelets\/(.+)\.(pipelinenode|xml)$/);
    if (!match) return null;

    const cartridge = match[1];
    const className = match[2];
    
    // If it's a fully qualified class name, use it directly
    if (className.includes('.')) {
      return className;
    }
    
    // Otherwise, it might be a simple pipelet name
    return `${cartridge}.${className}`;
  }

  private extractCartridgeName(filePath: string): string | null {
    // Try to extract cartridge name from path
    // Typical path: .../cartridge_name/src/main/resources/.../pipelines/Name.pipeline
    // or: .../cartridge_name/pipelines/Name.pipeline
    
    const normalizedPath = filePath.replace(/\\/g, '/');
    
    // Look for common Intershop project structure patterns
    const patterns = [
      /\/([^/]+)\/src\/main\/resources\/.*\/pipelines\//,
      /\/([^/]+)\/staticfiles\/cartridge\/pipelines\//,
      /\/([^/]+)\/pipelines\//
    ];
    
    for (const pattern of patterns) {
      const match = normalizedPath.match(pattern);
      if (match) {
        return match[1];
      }
    }

    // Fallback: try to find a name that looks like a cartridge (e.g., bc_order_approval)
    const pathParts = normalizedPath.split('/');
    for (const part of pathParts) {
      if (part.match(/^(bc_|ac_|sld_|app_|is_|core_|pf_)/)) {
        return part;
      }
    }

    return null;
  }
}
