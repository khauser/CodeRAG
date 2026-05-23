import OpenAI, { AzureOpenAI } from 'openai';
import { SemanticSearchConfig, SemanticEmbedding } from '../types.js';
import { getSemanticSearchConfig } from '../config.js';

/**
 * Optional context information for enriching class/interface/enum embeddings.
 * This data is typically gathered from graph edges and child nodes.
 */
export interface NodeContext {
  /** Superclass name (from EXTENDS edge) */
  superclass?: string;
  /** Implemented interface names (from IMPLEMENTS edges) */
  implemented_interfaces?: string[];
  /** Public method names (from CONTAINS edges to method children) */
  public_methods?: string[];
  /** Important private method names */
  important_private_methods?: string[];
  /** Injected dependency type names (from field annotations like @Inject) */
  injected_dependencies?: string[];
  /** Repository type names used by this class */
  repositories_used?: string[];
  /** Event types published by this class */
  events_published?: string[];
  /** Module/cartridge name this class belongs to */
  module?: string;
  /** Architectural role description (e.g., "REST resource", "Handler implementation", "Business object") */
  architectural_role?: string;
  /** Main responsibilities summary */
  responsibilities?: string;
  /** Related domain concepts */
  domain_concepts?: string[];
}

export interface EmbeddingProvider {
  generateEmbedding(text: string): Promise<number[]>;
  generateEmbeddings(texts: string[]): Promise<number[][]>;
  getDimensions(): number;
  getModel(): string;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private config: SemanticSearchConfig;

  constructor(config: SemanticSearchConfig) {
    if (!config.api_key) {
      throw new Error('OpenAI API key is required for OpenAI embedding provider');
    }
    
    this.config = config;
    
    // Detect Azure OpenAI by URL pattern
    const isAzure = config.base_url && config.base_url.includes('.openai.azure.com');
    
    if (isAzure) {
      // Use AzureOpenAI client for Azure endpoints.
      // In openai SDK v5+, baseURL and endpoint are mutually exclusive.
      // Since the SDK reads OPENAI_BASE_URL from env as default for baseURL,
      // we must use baseURL (not endpoint) to avoid the conflict.
      const azureEndpoint = this.extractAzureEndpoint(config.base_url!);
      this.client = new AzureOpenAI({
        apiKey: config.api_key,
        baseURL: `${azureEndpoint}/openai`,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-06-01',
        deployment: config.model,
      });
    } else {
      // Standard OpenAI or compatible API
      const clientConfig: any = {
        apiKey: config.api_key,
      };
      
      if (config.base_url) {
        clientConfig.baseURL = config.base_url;
      }
      
      this.client = new OpenAI(clientConfig);
    }
  }

  /**
   * Extracts the Azure endpoint base URL (e.g. https://myresource.openai.azure.com)
   * from a full base_url that may include path segments.
   */
  private extractAzureEndpoint(baseUrl: string): string {
    try {
      const url = new URL(baseUrl);
      return `${url.protocol}//${url.host}`;
    } catch {
      return baseUrl;
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Truncate text if it exceeds max tokens
      const truncatedText = this.truncateText(text, this.config.max_tokens);
      
      const response = await this.client.embeddings.create({
        model: this.config.model,
        input: truncatedText,
      });

      return response.data[0].embedding;
    } catch (error) {
      throw new Error(`Failed to generate embedding: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      // Process in batches to avoid API limits
      const results: number[][] = [];
      const batchSize = Math.min(this.config.batch_size, texts.length);
      
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const truncatedBatch = batch.map(text => this.truncateText(text, this.config.max_tokens));
        
        const response = await this.client.embeddings.create({
          model: this.config.model,
          input: truncatedBatch,
        });

        const batchEmbeddings = response.data.map(item => item.embedding);
        results.push(...batchEmbeddings);
      }

      return results;
    } catch (error) {
      throw new Error(`Failed to generate batch embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  getDimensions(): number {
    return this.config.dimensions;
  }

  getModel(): string {
    return this.config.model;
  }

  private truncateText(text: string, maxTokens: number): string {
    // Simple token estimation: ~4 characters per token
    const estimatedTokens = text.length / 4;
    if (estimatedTokens <= maxTokens) {
      return text;
    }
    
    const maxChars = maxTokens * 4;
    return text.substring(0, maxChars) + '...';
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private config: SemanticSearchConfig;
  private baseUrl: string;
  private parallelRequests: number;

  constructor(config: SemanticSearchConfig) {
    this.config = config;
    this.baseUrl = config.base_url || 'http://localhost:11434';
    this.parallelRequests = config.parallel_requests || 10;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new Error('Empty text provided for embedding generation');
    }

    // Replace null bytes, control characters, and non-BMP Unicode (surrogate pairs) that may cause Ollama issues
    const sanitizedText = text
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
      .replace(/[\uD800-\uDFFF]/g, '')
      .replace(/[\uFFFD\uFFFE\uFFFF]/g, '');
    const truncatedText = this.truncateText(sanitizedText, this.config.max_tokens);
    const maxRetries = 5;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.config.model,
            prompt: truncatedText,
          }),
        });

        if (!response.ok) {
          let errorBody = '';
          try { errorBody = await response.text(); } catch { /* ignore */ }
          const statusText = `${response.status} ${response.statusText}`;
          // Don't retry on deterministic errors like context length exceeded
          const isRetryable = response.status >= 500 && !errorBody.includes('context length');
          if (isRetryable && attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 2000;
            console.warn(`Ollama API error (${statusText}): ${errorBody.substring(0, 200)}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw new Error(`Ollama API error: ${statusText} - ${errorBody.substring(0, 500)}`);
        }

        const data = await response.json();
        return data.embedding;
      } catch (error) {
        if (attempt < maxRetries && error instanceof Error && !error.message.startsWith('Ollama API error:')) {
          const delay = Math.pow(2, attempt) * 2000;
          console.warn(`Ollama request failed, retrying in ${delay}ms (attempt ${attempt}/${maxRetries}): ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`Failed to generate Ollama embedding: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    throw new Error('Failed to generate Ollama embedding: max retries exceeded');
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    try {
      const results: number[][] = new Array(texts.length);
      
      // Process in parallel batches with controlled concurrency
      // This allows multiple GPU inference requests to queue up
      for (let i = 0; i < texts.length; i += this.parallelRequests) {
        const batch = texts.slice(i, i + this.parallelRequests);
        const batchPromises = batch.map((text, idx) => 
          this.generateEmbedding(text)
            .then(embedding => ({ index: i + idx, embedding }))
            .catch(error => {
              console.warn(`Failed to generate embedding for text at index ${i + idx} (length=${text?.length}, first 200 chars: ${JSON.stringify(text?.substring(0, 200))}):`, error);
              return { index: i + idx, embedding: null as number[] | null };
            })
        );
        
        const batchResults = await Promise.all(batchPromises);
        for (const result of batchResults) {
          if (result.embedding) {
            results[result.index] = result.embedding;
          }
        }
      }

      // Filter out any null results and return
      return results.filter(Boolean);
    } catch (error) {
      throw new Error(`Failed to generate Ollama batch embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  getDimensions(): number {
    return this.config.dimensions;
  }

  getModel(): string {
    return this.config.model;
  }

  private truncateText(text: string, maxTokens: number): string {
    // Simple token estimation: ~4 characters per token
    const estimatedTokens = text.length / 4;
    if (estimatedTokens <= maxTokens) {
      return text;
    }
    
    const maxChars = maxTokens * 4;
    return text.substring(0, maxChars) + '...';
  }
}


export class EmbeddingService {
  private provider: EmbeddingProvider | null = null;
  private config: SemanticSearchConfig;

  constructor(config?: SemanticSearchConfig) {
    this.config = config || getSemanticSearchConfig();
    this.initializeProvider();
  }

  private initializeProvider(): void {
    if (this.config.provider === 'disabled') {
      this.provider = null;
      return;
    }

    try {
      switch (this.config.provider) {
        case 'openai':
          this.provider = new OpenAIEmbeddingProvider(this.config);
          break;
        case 'ollama':
          this.provider = new OllamaEmbeddingProvider(this.config);
          break;
        default:
          throw new Error(`Unknown embedding provider: ${this.config.provider}`);
      }
    } catch (error) {
      console.warn(`Failed to initialize embedding provider: ${error instanceof Error ? error.message : 'Unknown error'}`);
      this.provider = null;
    }
  }

  isEnabled(): boolean {
    return this.provider !== null;
  }

  async generateEmbedding(text: string): Promise<SemanticEmbedding | null> {
    if (!this.provider) {
      return null;
    }

    try {
      const vector = await this.provider.generateEmbedding(text);
      return {
        vector,
        model: this.provider.getModel(),
        version: '1.0',
        created_at: new Date()
      };
    } catch (error) {
      console.error(`Failed to generate embedding: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  async generateEmbeddings(texts: string[]): Promise<(SemanticEmbedding | null)[]> {
    if (!this.provider) {
      return texts.map(() => null);
    }

    try {
      const vectors = await this.provider.generateEmbeddings(texts);
      return vectors.map(vector => ({
        vector,
        model: this.provider!.getModel(),
        version: '1.0',
        created_at: new Date()
      }));
    } catch (error) {
      console.error(`Failed to generate batch embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return texts.map(() => null);
    }
  }

  /**
   * Extracts semantic content from a code node for embedding generation.
   * For METHOD nodes, produces a structured representation including symbol type,
   * class context, body summary, called methods, used fields, and domain terms.
   * For other node types, produces a simpler representation.
   *
   * @param node the code node to extract semantic content from
   * @returns a structured text string suitable for embedding
   */
  extractSemanticContent(node: any, context?: NodeContext): string {
    if (node.type === 'method' || node.type === 'function') {
      return this.extractMethodSemanticContent(node);
    } else if (node.type === 'class' || node.type === 'interface' || node.type === 'enum') {
      return this.extractClassSummaryContent(node, context);
    }
    return this.extractDefaultSemanticContent(node);
  }

  /**
   * Extracts structured semantic content for METHOD and FUNCTION nodes.
   * Produces a rich, structured text block optimized for embedding quality.
   *
   * @param node the method/function code node
   * @returns structured semantic text for embedding
   */
  private extractMethodSemanticContent(node: any): string {
    const lines: string[] = [];

    lines.push(`Symbol type: ${node.type?.toUpperCase() || 'METHOD'}`);
    lines.push(`Method: ${node.name || 'unknown'}`);

    if (node.qualified_name) {
      lines.push(`Qualified name: ${node.qualified_name}`);
    }

    // Extract class and package from qualified name
    if (node.qualified_name) {
      const className = this.extractClassName(node.qualified_name);
      const packageName = this.extractPackageName(node.qualified_name);
      if (className) lines.push(`Class: ${className}`);
      if (packageName) lines.push(`Package: ${packageName}`);
    }

    // Description / JavaDoc
    if (node.description) {
      lines.push('');
      lines.push(`Description:\n${node.description}`);
    }

    // Annotations
    if (node.attributes?.annotations && node.attributes.annotations.length > 0) {
      const annotations = node.attributes.annotations
        .map((a: any) => a.name)
        .join(', ');
      lines.push('');
      lines.push(`Annotations:\n${annotations}`);
    }

    // Modifiers
    if (node.modifiers && node.modifiers.length > 0) {
      lines.push('');
      lines.push(`Modifiers:\n${node.modifiers.join(', ')}`);
    }

    // Parameters
    if (node.attributes?.parameters && node.attributes.parameters.length > 0) {
      const paramLines = node.attributes.parameters
        .map((p: any) => `${p.name}: ${p.type}${p.description ? ` - ${p.description}` : ''}`)
        .join('\n');
      lines.push('');
      lines.push(`Parameters:\n${paramLines}`);
    }

    // Return type
    if (node.attributes?.return_type) {
      lines.push('');
      lines.push(`Returns:\n${node.attributes.return_type}`);
    }

    // Thrown exceptions
    if (node.attributes?.thrown_exceptions && node.attributes.thrown_exceptions.length > 0) {
      lines.push('');
      lines.push(`Throws:\n${node.attributes.thrown_exceptions.join(', ')}`);
    }

    // Body summary / behavior
    if (node.attributes?.body_summary) {
      lines.push('');
      lines.push(`Behavior:\n${node.attributes.body_summary}`);
    } else if (node.attributes?.body_text) {
      lines.push('');
      lines.push(`Behavior:\n${this.summarizeBody(node.attributes.body_text)}`);
    }

    // Called methods
    if (node.attributes?.called_symbol_names && node.attributes.called_symbol_names.length > 0) {
      lines.push('');
      lines.push(`Calls:\n${node.attributes.called_symbol_names.join(', ')}`);
    }

    // Used fields
    if (node.attributes?.used_field_names && node.attributes.used_field_names.length > 0) {
      lines.push('');
      lines.push(`Fields used:\n${node.attributes.used_field_names.join(', ')}`);
    }

    // Domain terms
    if (node.attributes?.domain_terms && node.attributes.domain_terms.length > 0) {
      lines.push('');
      lines.push(`Domain terms:\n${node.attributes.domain_terms.join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Extracts a structured summary document for class, interface, and enum nodes.
   * Produces a rich, context-aware embedding text that includes symbol metadata,
   * inheritance, dependencies, responsibilities, and architectural role.
   *
   * The optional {@link NodeContext} parameter supplies relationship data typically
   * resolved from graph edges (EXTENDS, IMPLEMENTS, CONTAINS) and child nodes.
   *
   * @param node the class/interface/enum code node
   * @param context optional enrichment context gathered from the code graph
   * @returns structured summary text optimized for embedding
   */
  private extractClassSummaryContent(node: any, context?: NodeContext): string {
    const lines: string[] = [];

    // --- Identity ---
    lines.push(`Symbol type: ${node.type?.toUpperCase() || 'CLASS'}`);
    lines.push(`Name: ${node.name || 'unknown'}`);

    if (node.qualified_name) {
      lines.push(`Qualified name: ${node.qualified_name}`);
    }

    // Package (derived from qualified name for class-level nodes: last segment is the class itself)
    if (node.qualified_name) {
      const packageName = this.extractClassPackageName(node.qualified_name);
      if (packageName) {
        lines.push(`Package: ${packageName}`);
      }
    }

    // Module / cartridge
    if (context?.module) {
      lines.push(`Module: ${context.module}`);
    }

    // --- JavaDoc / Description ---
    if (node.description) {
      lines.push('');
      lines.push(`JavaDoc:\n${node.description}`);
    }

    // --- Annotations ---
    if (node.attributes?.annotations && node.attributes.annotations.length > 0) {
      const annotations = node.attributes.annotations
        .map((a: any) => a.name)
        .join(', ');
      lines.push('');
      lines.push(`Annotations:\n${annotations}`);
    }

    // --- Modifiers ---
    if (node.modifiers && node.modifiers.length > 0) {
      lines.push('');
      lines.push(`Modifiers:\n${node.modifiers.join(', ')}`);
    }

    // --- Inheritance & Interfaces ---
    if (context?.superclass) {
      lines.push('');
      lines.push(`Extends: ${context.superclass}`);
    }
    if (context?.implemented_interfaces && context.implemented_interfaces.length > 0) {
      lines.push(`Implements: ${context.implemented_interfaces.join(', ')}`);
    }

    // --- Methods ---
    if (context?.public_methods && context.public_methods.length > 0) {
      lines.push('');
      lines.push(`Important methods:\n${context.public_methods.join(', ')}`);
    }
    if (context?.important_private_methods && context.important_private_methods.length > 0) {
      lines.push(`Important private methods:\n${context.important_private_methods.join(', ')}`);
    }

    // --- Dependencies ---
    if (context?.injected_dependencies && context.injected_dependencies.length > 0) {
      lines.push('');
      lines.push(`Injected dependencies:\n${context.injected_dependencies.join(', ')}`);
    }
    if (context?.repositories_used && context.repositories_used.length > 0) {
      lines.push(`Repositories used:\n${context.repositories_used.join(', ')}`);
    }

    // --- Events ---
    if (context?.events_published && context.events_published.length > 0) {
      lines.push('');
      lines.push(`Events published:\n${context.events_published.join(', ')}`);
    }

    // --- Architectural role & Responsibilities ---
    if (context?.architectural_role) {
      lines.push('');
      lines.push(`Architectural role:\n${context.architectural_role}`);
    }
    if (context?.responsibilities) {
      lines.push('');
      lines.push(`Responsibilities:\n${context.responsibilities}`);
    }

    // --- Domain concepts ---
    if (context?.domain_concepts && context.domain_concepts.length > 0) {
      lines.push('');
      lines.push(`Related domain concepts:\n${context.domain_concepts.join(', ')}`);
    }

    return lines.join('\n');
  }

  /**
   * Extracts the package name from a class-level qualified name.
   * For class nodes the last segment is the class name itself,
   * so the package is everything before it.
   *
   * Example: "com.example.order.OrderService" → "com.example.order"
   *
   * @param qualifiedName the fully qualified class name
   * @returns the package name, or null if not determinable
   */
  private extractClassPackageName(qualifiedName: string): string | null {
    const parts = qualifiedName.split('.');
    return parts.length >= 2 ? parts.slice(0, parts.length - 1).join('.') : null;
  }

  /**
   * Extracts semantic content for non-method node types (class, interface, enum, etc.).
   *
   * @param node the code node
   * @returns semantic text for embedding
   */
  private extractDefaultSemanticContent(node: any): string {
    const parts: string[] = [];

    if (node.name) parts.push(node.name);
    if (node.qualified_name && node.qualified_name !== node.name) {
      parts.push(node.qualified_name);
    }

    if (node.description) parts.push(node.description);

    if (node.attributes?.parameters) {
      const paramInfo = node.attributes.parameters
        .map((p: any) => `${p.name}: ${p.type}${p.description ? ` - ${p.description}` : ''}`)
        .join(', ');
      if (paramInfo) parts.push(`Parameters: ${paramInfo}`);
    }

    if (node.attributes?.return_type) {
      parts.push(`Returns: ${node.attributes.return_type}`);
    }

    if (node.attributes?.annotations) {
      const annotations = node.attributes.annotations
        .map((a: any) => a.name)
        .join(', ');
      if (annotations) parts.push(`Annotations: ${annotations}`);
    }

    if (node.modifiers && node.modifiers.length > 0) {
      parts.push(`Modifiers: ${node.modifiers.join(', ')}`);
    }

    return parts.join(' | ');
  }

  /**
   * Extracts the class name from a qualified name (e.g., "com.example.OrderService.createOrder" → "OrderService").
   *
   * @param qualifiedName the fully qualified method name
   * @returns the enclosing class name, or null if not determinable
   */
  private extractClassName(qualifiedName: string): string | null {
    const parts = qualifiedName.split('.');
    // For a method, the class is the second-to-last segment
    return parts.length >= 2 ? parts[parts.length - 2] : null;
  }

  /**
   * Extracts the package name from a qualified name (e.g., "com.example.OrderService.createOrder" → "com.example").
   *
   * @param qualifiedName the fully qualified method name
   * @returns the package name, or null if not determinable
   */
  private extractPackageName(qualifiedName: string): string | null {
    const parts = qualifiedName.split('.');
    // Package is everything before class.method (last two segments)
    return parts.length >= 3 ? parts.slice(0, parts.length - 2).join('.') : null;
  }

  /**
   * Produces a short summary from a method body text.
   * For short bodies (≤10 lines), returns the body as-is.
   * For longer bodies, extracts key identifiers and call patterns.
   *
   * @param bodyText the raw method body text
   * @returns a concise summary suitable for embedding
   */
  private summarizeBody(bodyText: string): string {
    const MAX_SHORT_BODY_LINES = 10;
    const MAX_SUMMARY_LENGTH = 500;
    const lines = bodyText.split('\n').filter(l => l.trim().length > 0);

    if (lines.length <= MAX_SHORT_BODY_LINES) {
      return bodyText.substring(0, MAX_SUMMARY_LENGTH);
    }

    // For longer bodies, extract meaningful identifiers and method calls
    const callPattern = /(\w+)\s*\(/g;
    const calls = new Set<string>();
    let match;
    while ((match = callPattern.exec(bodyText)) !== null) {
      const name = match[1];
      // Filter out common keywords
      if (!['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'throw'].includes(name)) {
        calls.add(name);
      }
    }

    const summary = [
      `Body (${lines.length} lines):`,
      lines.slice(0, 3).join('\n'),
      '...',
      lines.slice(-2).join('\n'),
    ];

    if (calls.size > 0) {
      summary.push(`Key calls: ${Array.from(calls).slice(0, 15).join(', ')}`);
    }

    return summary.join('\n').substring(0, MAX_SUMMARY_LENGTH);
  }
}