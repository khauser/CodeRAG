import { BaseHandler } from '../../src/mcp/base-handler.js';
import { Neo4jClient } from '../../src/graph/neo4j-client.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

// Mock all dependencies
jest.mock('../../src/graph/neo4j-client.js');
jest.mock('@modelcontextprotocol/sdk/server/index.js');

// Create a concrete implementation for testing
class TestHandler extends BaseHandler {
  async start(): Promise<void> {
    // Test implementation
  }
  
  // Expose getToolSchemas for testing
  public getToolSchemasPublic() {
    return (this as any).getToolSchemas();
  }
}

/**
 * Simple keyword-based tool selection simulation.
 * This mimics how an LLM might select tools based on description matching.
 */
function selectToolForQuery(query: string, tools: any[]): { tool: string; score: number }[] {
  const queryLower = query.toLowerCase();
  const scores: { tool: string; score: number }[] = [];

  for (const tool of tools) {
    let score = 0;
    const desc = (tool.description || '').toLowerCase();
    const name = tool.name.toLowerCase();

    // Keywords that indicate class/method name lookup
    const nameSearchKeywords = [
      'class', 'klasse', 'method', 'methode', 'interface', 
      'what is', 'was ist', 'tell me about', 'sagen', 'finde',
      'look up', 'lookup', 'information about', 'explain'
    ];

    // Keywords that indicate semantic/functional search
    const semanticKeywords = [
      'how to', 'wie', 'functionality', 'funktionalität',
      'validate', 'validieren', 'authentication', 'handle',
      'process', 'convert', 'generate', 'calculate'
    ];

    // Check if query contains a specific class/entity name pattern (CamelCase)
    const hasCamelCaseName = /[A-Z][a-z]+[A-Z]/.test(query);
    const hasQuotedName = /"[^"]+"|'[^']+'/.test(query);

    // Score based on keyword matches in description
    for (const keyword of nameSearchKeywords) {
      if (queryLower.includes(keyword) && desc.includes(keyword)) {
        score += 10;
      }
      if (queryLower.includes(keyword) && desc.includes('name')) {
        score += 5;
      }
    }

    for (const keyword of semanticKeywords) {
      if (queryLower.includes(keyword) && desc.includes('natural language')) {
        score += 10;
      }
      if (queryLower.includes(keyword) && desc.includes('functionality')) {
        score += 10;
      }
    }

    // Specific tool bonuses
    if (name === 'lookup_class' || name === 'search_nodes') {
      // Bonus for class name lookups
      if (hasCamelCaseName) score += 20;
      if (hasQuotedName) score += 15;
      if (queryLower.includes('class') || queryLower.includes('klasse')) score += 15;
      if (queryLower.includes('tell me about') || queryLower.includes('sagen')) score += 10;
      
      // Check if description mentions the exact use case
      if (desc.includes('tell me about class') || desc.includes('was kannst du mir')) {
        score += 25;
      }
    }

    if (name === 'semantic_search') {
      // Bonus for functional queries
      if (queryLower.includes('function') && queryLower.includes('that')) score += 15;
      if (queryLower.includes('code that') || queryLower.includes('code for')) score += 15;
      
      // Penalty for class name lookups - semantic search should NOT be used
      if (hasCamelCaseName) score -= 10;
      if (queryLower.includes('class') && hasCamelCaseName) score -= 20;
      
      // Check if description explicitly says NOT to use for name search
      if (desc.includes('for searching by class/method name, use search_nodes')) {
        if (hasCamelCaseName || queryLower.includes('class')) {
          score -= 30;
        }
      }
    }

    scores.push({ tool: tool.name, score });
  }

  return scores.sort((a, b) => b.score - a.score);
}

describe('Tool Selection for User Queries', () => {
  let handler: TestHandler;
  let mockClient: jest.Mocked<Neo4jClient>;
  let mockServer: jest.Mocked<Server>;
  let toolSchemas: any[];

  beforeAll(() => {
    mockServer = {
      setRequestHandler: jest.fn(),
      connect: jest.fn(),
      close: jest.fn()
    } as any;

    (Server as jest.MockedClass<typeof Server>).mockImplementation(() => mockServer);

    mockClient = {
      runQuery: jest.fn(),
      getProjectLabel: jest.fn().mockReturnValue('Project_test_Class')
    } as any;

    handler = new TestHandler(mockClient, 'test-server', '1.0.0', 'detailed');
    toolSchemas = handler.getToolSchemasPublic();
  });

  describe('Tool Descriptions', () => {
    test('lookup_class should be marked as PRIMARY TOOL for class lookups', () => {
      const tool = toolSchemas.find((t: any) => t.name === 'lookup_class');
      expect(tool).toBeDefined();
      expect(tool.description.toLowerCase()).toContain('primary tool');
      expect(tool.description.toLowerCase()).toContain('class');
      // Should include German phrase
      expect(tool.description.toLowerCase()).toContain('was kannst du mir');
      // Should explicitly say NOT semantic_search
      expect(tool.description.toLowerCase()).toContain('not semantic_search');
    });

    test('search_nodes should have description mentioning class/method search', () => {
      const tool = toolSchemas.find((t: any) => t.name === 'search_nodes');
      expect(tool).toBeDefined();
      expect(tool.description.toLowerCase()).toContain('class');
      expect(tool.description.toLowerCase()).toContain('method');
      expect(tool.description.toLowerCase()).toContain('by name');
    });

    test('semantic_search should explicitly say DO NOT use for class names', () => {
      const tool = toolSchemas.find((t: any) => t.name === 'semantic_search');
      expect(tool).toBeDefined();
      expect(tool.description.toLowerCase()).toContain('do not use');
      expect(tool.description.toLowerCase()).toContain('lookup_class');
      // Should have ONLY keyword to restrict usage
      expect(tool.description).toMatch(/ONLY/i);
    });
  });

  describe('Class Name Lookup Queries', () => {
    const classLookupQueries = [
      'Was kannst Du mir zur Klasse IsApprovalNeeded sagen?',
      'Tell me about class UserService',
      'What is the class PaymentProcessor?',
      'Explain class OrderManager',
      'Find class CustomerRepository',
      'Finde Klasse AuthenticationService'
    ];

    test.each(classLookupQueries)(
      'query "%s" should prefer lookup_class or search_nodes over semantic_search',
      (query) => {
        const scores = selectToolForQuery(query, toolSchemas);
        
        const lookupClassScore = scores.find(s => s.tool === 'lookup_class')?.score || 0;
        const searchNodesScore = scores.find(s => s.tool === 'search_nodes')?.score || 0;
        const semanticSearchScore = scores.find(s => s.tool === 'semantic_search')?.score || 0;

        const bestNameSearchScore = Math.max(lookupClassScore, searchNodesScore);
        
        expect(bestNameSearchScore).toBeGreaterThan(semanticSearchScore);
        
        // Log for debugging
        console.log(`Query: "${query}"`);
        console.log(`  lookup_class: ${lookupClassScore}, search_nodes: ${searchNodesScore}, semantic_search: ${semanticSearchScore}`);
      }
    );
  });

  describe('Semantic/Functional Queries', () => {
    const semanticQueries = [
      'Find functions that validate email addresses',
      'Code for user authentication',
      'Functions that process payments'
    ];

    test.each(semanticQueries)(
      'query "%s" should prefer semantic_search over lookup_class',
      (query) => {
        const scores = selectToolForQuery(query, toolSchemas);
        
        const lookupClassScore = scores.find(s => s.tool === 'lookup_class')?.score || 0;
        const semanticSearchScore = scores.find(s => s.tool === 'semantic_search')?.score || 0;

        // For functional queries, semantic_search should be preferred
        expect(semanticSearchScore).toBeGreaterThanOrEqual(lookupClassScore);
        
        console.log(`Query: "${query}"`);
        console.log(`  lookup_class: ${lookupClassScore}, semantic_search: ${semanticSearchScore}`);
      }
    );
  });

  describe('Tool Schema Validation', () => {
    test('lookup_class should have required class_name parameter', () => {
      const tool = toolSchemas.find((t: any) => t.name === 'lookup_class');
      expect(tool).toBeDefined();
      expect(tool.inputSchema.properties.class_name).toBeDefined();
      expect(tool.inputSchema.required).toContain('class_name');
    });

    test('search_nodes should have required search_term parameter', () => {
      const tool = toolSchemas.find((t: any) => t.name === 'search_nodes');
      expect(tool).toBeDefined();
      expect(tool.inputSchema.properties.search_term).toBeDefined();
      expect(tool.inputSchema.required).toContain('search_term');
    });

    test('semantic_search should have required query parameter', () => {
      const tool = toolSchemas.find((t: any) => t.name === 'semantic_search');
      expect(tool).toBeDefined();
      expect(tool.inputSchema.properties.query).toBeDefined();
      expect(tool.inputSchema.required).toContain('query');
    });
  });
});
