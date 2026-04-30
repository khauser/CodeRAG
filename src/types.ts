export interface AnnotationInfo {
  name: string;                    // e.g., "@Override", "@Component", "@pytest.fixture"
  type: 'annotation' | 'decorator' | 'pragma';
  parameters?: Array<{
    name?: string;                 // Named parameter (e.g., "value" in @RequestMapping(value="/api"))
    value: string;                 // Parameter value
    type?: string;                 // Parameter type if determinable
  }>;
  source_line?: number;           // Line number where annotation appears
  framework?: string;             // e.g., "Spring", "JUnit", "Flask", "Angular"
  category?: string;              // e.g., "testing", "injection", "validation", "lifecycle"
}

export interface CodeNode {
  id: string;
  project_id: string;
  type: 'class' | 'interface' | 'enum' | 'exception' | 'function' | 'method' | 'field' | 'package' | 'module' | 'annotation';
  name: string;
  qualified_name: string;
  description?: string;
  source_file?: string;
  start_line?: number;
  end_line?: number;
  modifiers?: string[];
  is_abstract?: boolean;
  attributes?: {
    parameters?: Array<{
      name: string;
      type: string;
      description?: string;
    }>;
    return_type?: string;
    annotations?: AnnotationInfo[];
    framework?: string;            // For annotation nodes: the framework (Spring, JUnit, etc.)
    category?: string;             // For annotation nodes: the category (testing, injection, etc.)
    // Method-specific properties
    body_text?: string;            // Raw method body text
    body_summary?: string;         // Short summary of method behavior (LLM-generated or extracted)
    called_symbol_names?: string[];// Names of methods/functions called within this method
    used_field_names?: string[];   // Field names accessed within this method
    thrown_exceptions?: string[];  // Exception types thrown by this method
    domain_terms?: string[];       // Domain-relevant terms extracted from the method
    cyclomatic_complexity?: number;// Cyclomatic complexity metric
    line_count?: number;           // Number of lines in the method body
    is_generated?: boolean;        // Whether the method is auto-generated (e.g., lombok, IDE)
    is_test?: boolean;             // Whether this is a test method
    [key: string]: any;
  };
}

export interface CodeEdge {
  id: string;
  project_id: string;
  type: 'calls' | 'implements' | 'extends' | 'contains' | 'references' | 'throws' | 'belongs_to' | 'annotated_with';
  source: string;
  target: string;
  attributes?: {
    [key: string]: any;
  };
}

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

export interface ProjectConfig {
  isolation_strategy: 'shared_db' | 'separate_db';
  default_project?: string;
  cross_project_analysis: boolean;
  max_projects_shared_db: number;
}

export interface ProjectContext {
  project_id: string;
  name?: string;
  description?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface QueryResult {
  nodes?: CodeNode[];
  edges?: CodeEdge[];
  records?: any[];
}

// Semantic Search Types
export interface SemanticEmbedding {
  vector: number[];
  model: string;
  version: string;
  created_at: Date;
}

export interface SemanticSearchConfig {
  provider: 'openai' | 'ollama' | 'disabled';
  model: string;
  api_key?: string;
  base_url?: string;
  dimensions: number;
  max_tokens: number;
  batch_size: number;
  similarity_threshold: number;
  /** Number of parallel requests for local providers (Ollama/LM Studio). Default: 10 */
  parallel_requests?: number;
  /** Entity types to embed. Default: ['class', 'interface', 'method', 'function', 'enum'] */
  embed_entity_types?: Array<'class' | 'interface' | 'method' | 'function' | 'enum' | 'field'>;
}

export interface SemanticSearchResult {
  node: CodeNode;
  similarity_score: number;
  matched_content: string;
}

export interface SemanticSearchParams {
  query: string;
  project_id?: string;
  node_types?: CodeNode['type'][];
  limit?: number;
  similarity_threshold?: number;
}