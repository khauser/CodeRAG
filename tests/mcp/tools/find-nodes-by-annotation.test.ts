import { Neo4jClient } from '../../../src/graph/neo4j-client.js';
import { findNodesByAnnotation } from '../../../src/mcp/tools/find-nodes-by-annotation.js';

// Mock the Neo4jClient
jest.mock('../../../src/graph/neo4j-client.js');

describe('Find Nodes By Annotation Tool', () => {
  let mockNeo4jClient: jest.Mocked<Neo4jClient>;

  beforeEach(() => {
    mockNeo4jClient = {
      runQuery: jest.fn()
    } as any;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findNodesByAnnotation', () => {
    test('should find nodes by annotation name only', async () => {
      const mockResult = {
        records: [
          {
            get: jest.fn((field) => {
              if (field === 'n') {
                return {
                  properties: {
                    id: 'test-class',
                    type: 'class',
                    name: 'TestClass',
                    qualified_name: 'com.example.TestClass',
                    source_file: 'TestClass.java'
                  }
                };
              }
              if (field === 'matched_annotation') {
                return {
                  name: '@Component',
                  framework: 'Spring',
                  category: 'injection',
                  parameters: { value: 'testService' }
                };
              }
              return null;
            })
          },
          {
            get: jest.fn((field) => {
              if (field === 'n') {
                return {
                  properties: {
                    id: 'another-class',
                    type: 'class',
                    name: 'AnotherClass',
                    qualified_name: 'com.example.AnotherClass',
                    source_file: 'AnotherClass.java'
                  }
                };
              }
              if (field === 'matched_annotation') {
                return {
                  name: '@Component',
                  framework: 'Spring',
                  category: 'injection'
                };
              }
              return null;
            })
          }
        ]
      };

      mockNeo4jClient.runQuery.mockResolvedValue(mockResult);

      const params = {
        annotation_name: '@Component'
      };

      const result = await findNodesByAnnotation(mockNeo4jClient, params);

      expect(mockNeo4jClient.runQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE (a.name = $withAt OR a.name = $withoutAt)'),
        { withAt: '@Component', withoutAt: 'Component' }
      );
      expect(result.nodes).toHaveLength(2);
      expect(result.nodes[0].name).toBe('TestClass');
      expect(result.nodes[0].matched_annotation.name).toBe('@Component');
      expect(result.nodes[0].matched_annotation.framework).toBe('Spring');
      expect(result.nodes[1].name).toBe('AnotherClass');
      expect(result.total_count).toBe(2);
    });

    test('should find nodes by annotation with framework filter', async () => {
      const mockResult = {
        records: [
          {
            get: jest.fn((field) => {
              if (field === 'n') {
                return {
                  properties: {
                    id: 'spring-component',
                    type: 'class',
                    name: 'SpringComponent',
                    qualified_name: 'com.example.SpringComponent'
                  }
                };
              }
              if (field === 'matched_annotation') {
                return {
                  name: '@Component',
                  framework: 'Spring',
                  category: 'injection'
                };
              }
              return null;
            })
          }
        ]
      };

      mockNeo4jClient.runQuery.mockResolvedValue(mockResult);

      const params = {
        annotation_name: '@Component',
        framework: 'Spring'
      };

      const result = await findNodesByAnnotation(mockNeo4jClient, params);

      expect(mockNeo4jClient.runQuery).toHaveBeenCalledWith(
        expect.stringContaining('AND a.attributes_json CONTAINS $framework'),
        { withAt: '@Component', withoutAt: 'Component', framework: 'Spring' }
      );
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].matched_annotation.framework).toBe('Spring');
    });

    test('should find nodes by annotation with category filter', async () => {
      const mockResult = {
        records: [
          {
            get: jest.fn((field) => {
              if (field === 'n') {
                return {
                  properties: {
                    id: 'test-method',
                    type: 'method',
                    name: 'testMethod',
                    qualified_name: 'com.example.TestClass.testMethod'
                  }
                };
              }
              if (field === 'matched_annotation') {
                return {
                  name: '@Test',
                  framework: 'JUnit',
                  category: 'testing'
                };
              }
              return null;
            })
          }
        ]
      };

      mockNeo4jClient.runQuery.mockResolvedValue(mockResult);

      const params = {
        annotation_name: '@Test',
        category: 'testing'
      };

      const result = await findNodesByAnnotation(mockNeo4jClient, params);

      expect(mockNeo4jClient.runQuery).toHaveBeenCalledWith(
        expect.stringContaining('AND a.attributes_json CONTAINS $category'),
        { withAt: '@Test', withoutAt: 'Test', category: 'testing' }
      );
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].matched_annotation.category).toBe('testing');
    });

    test('should find nodes by annotation with node type filter', async () => {
      const mockResult = {
        records: [
          {
            get: jest.fn((field) => {
              if (field === 'n') {
                return {
                  properties: {
                    id: 'test-class',
                    type: 'class',
                    name: 'TestClass',
                    qualified_name: 'com.example.TestClass'
                  }
                };
              }
              if (field === 'matched_annotation') {
                return {
                  name: '@Entity',
                  framework: 'JPA',
                  category: 'persistence'
                };
              }
              return null;
            })
          }
        ]
      };

      mockNeo4jClient.runQuery.mockResolvedValue(mockResult);

      const params = {
        annotation_name: '@Entity',
        node_type: 'class' as const
      };

      const result = await findNodesByAnnotation(mockNeo4jClient, params);

      expect(mockNeo4jClient.runQuery).toHaveBeenCalledWith(
        expect.stringContaining('AND n.type = $node_type'),
        { withAt: '@Entity', withoutAt: 'Entity', node_type: 'class' }
      );
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].type).toBe('class');
    });

    test('should find nodes with all filters applied', async () => {
      const mockResult = {
        records: [
          {
            get: jest.fn((field) => {
              if (field === 'n') {
                return {
                  properties: {
                    id: 'rest-controller',
                    type: 'class',
                    name: 'UserController',
                    qualified_name: 'com.example.controller.UserController'
                  }
                };
              }
              if (field === 'matched_annotation') {
                return {
                  name: '@RestController',
                  framework: 'Spring',
                  category: 'web',
                  parameters: { value: '/api/users' }
                };
              }
              return null;
            })
          }
        ]
      };

      mockNeo4jClient.runQuery.mockResolvedValue(mockResult);

      const params = {
        annotation_name: '@RestController',
        framework: 'Spring',
        category: 'web',
        node_type: 'class' as const
      };

      const result = await findNodesByAnnotation(mockNeo4jClient, params);

      expect(mockNeo4jClient.runQuery).toHaveBeenCalledWith(
        expect.stringContaining('AND a.attributes_json CONTAINS $framework'),
        {
          withAt: '@RestController',
          withoutAt: 'RestController',
          framework: 'Spring',
          category: 'web',
          node_type: 'class'
        }
      );
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].name).toBe('UserController');
      expect(result.nodes[0].matched_annotation.name).toBe('@RestController');
      expect(result.nodes[0].matched_annotation.framework).toBe('Spring');
      expect(result.nodes[0].matched_annotation.category).toBe('web');
    });

    test('should handle empty results', async () => {
      const mockResult = { records: [] };

      mockNeo4jClient.runQuery.mockResolvedValue(mockResult);

      const params = {
        annotation_name: '@NonExistentAnnotation'
      };

      const result = await findNodesByAnnotation(mockNeo4jClient, params);

      expect(result.nodes).toHaveLength(0);
      expect(result.total_count).toBe(0);
    });

    test('should handle null records', async () => {
      const mockResult = { records: null };

      mockNeo4jClient.runQuery.mockResolvedValue(mockResult);

      const params = {
        annotation_name: '@TestAnnotation'
      };

      const result = await findNodesByAnnotation(mockNeo4jClient, params);

      expect(result.nodes).toHaveLength(0);
      expect(result.total_count).toBe(0);
    });

    test('should handle annotations with special characters', async () => {
      const mockResult = {
        records: [
          {
            get: jest.fn((field) => {
              if (field === 'n') {
                return {
                  properties: {
                    id: 'python-method',
                    type: 'method',
                    name: 'static_method',
                    qualified_name: 'example.MyClass.static_method'
                  }
                };
              }
              if (field === 'matched_annotation') {
                return {
                  name: 'staticmethod',
                  framework: 'Python',
                  category: 'builtin'
                };
              }
              return null;
            })
          }
        ]
      };

      mockNeo4jClient.runQuery.mockResolvedValue(mockResult);

      const params = {
        annotation_name: 'staticmethod'
      };

      const result = await findNodesByAnnotation(mockNeo4jClient, params);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].matched_annotation.name).toBe('staticmethod');
    });

    test('should propagate database errors', async () => {
      mockNeo4jClient.runQuery.mockRejectedValue(new Error('Database connection failed'));

      const params = {
        annotation_name: '@Component'
      };

      await expect(findNodesByAnnotation(mockNeo4jClient, params)).rejects.toThrow('Database connection failed');
    });

    test('should handle nodes with complex annotation parameters', async () => {
      const mockResult = {
        records: [
          {
            get: jest.fn((field) => {
              if (field === 'n') {
                return {
                  properties: {
                    id: 'endpoint-method',
                    type: 'method',
                    name: 'getUserById',
                    qualified_name: 'com.example.UserController.getUserById'
                  }
                };
              }
              if (field === 'matched_annotation') {
                return {
                  name: '@GetMapping',
                  framework: 'Spring',
                  category: 'web',
                  parameters: {
                    value: '/users/{id}',
                    produces: 'application/json',
                    headers: ['Accept=application/json']
                  }
                };
              }
              return null;
            })
          }
        ]
      };

      mockNeo4jClient.runQuery.mockResolvedValue(mockResult);

      const params = {
        annotation_name: '@GetMapping'
      };

      const result = await findNodesByAnnotation(mockNeo4jClient, params);

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].matched_annotation.parameters.value).toBe('/users/{id}');
      expect(result.nodes[0].matched_annotation.parameters.produces).toBe('application/json');
    });
  });

  // Regression tests for the confirmed embedding leak (§4 of the hardening spec):
  // embeddings must never be returned, regardless of whether `node_type` is set.
  describe('embedding leak (§4)', () => {
    const leakyProperties = {
      id: 'n1',
      project_id: 'proj',
      type: 'class',
      name: 'FooResource',
      qualified_name: 'com.example.FooResource',
      modifiers: ['public'],
      is_abstract: false,
      attributes_json: '{}',
      // These must NEVER be returned:
      semantic_embedding: new Array(3072).fill(0.0123),
      embedding_model: 'text-embedding-3-large',
      embedding_version: '1.0',
      embedding_created_at: '2026-01-01T00:00:00Z'
    };

    const makeLeakyResult = () => ({
      records: [
        {
          get: jest.fn((field: string) => {
            if (field === 'n') return { properties: { ...leakyProperties } };
            if (field === 'matched_annotation') return { properties: { name: '@Path', type: 'annotation' } };
            return null;
          })
        }
      ]
    });

    test('does not leak embeddings WITHOUT node_type', async () => {
      mockNeo4jClient.runQuery.mockResolvedValue(makeLeakyResult());
      const result = await findNodesByAnnotation(mockNeo4jClient, { annotation_name: 'Path' });
      const json = JSON.stringify(result);
      expect(json).not.toContain('semantic_embedding');
      expect(json).not.toContain('embedding_model');
      expect(json).not.toContain('embedding_version');
      expect(json).not.toContain('embedding_created_at');
      expect(result.nodes[0].id).toBe('n1');
      expect(result.nodes[0].name).toBe('FooResource');
    });

    test('does not leak embeddings WITH node_type', async () => {
      mockNeo4jClient.runQuery.mockResolvedValue(makeLeakyResult());
      const result = await findNodesByAnnotation(mockNeo4jClient, {
        annotation_name: 'Path',
        node_type: 'class'
      });
      const json = JSON.stringify(result);
      expect(json).not.toContain('semantic_embedding');
      expect(json).not.toContain('embedding_model');
    });
  });
});