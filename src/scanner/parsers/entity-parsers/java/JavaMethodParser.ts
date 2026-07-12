import { ParsedEntity, ParsedRelationship } from '../../../types.js';
import { AnnotationInfo } from '../../../../types.js';
import { EntityFactory } from '../../base/EntityFactory.js';
import { RelationshipBuilder } from '../../base/RelationshipBuilder.js';
import { JavaContentExtractor } from '../../extractors/java/JavaContentExtractor.js';
import { JavaDocExtractor } from '../../extractors/java/JavaDocExtractor.js';
import { JavaAnnotationExtractor } from '../../extractors/java/JavaAnnotationExtractor.js';
import { JavaAstCallExtractor } from './JavaAstCallExtractor.js';

export class JavaMethodParser {
  private contentExtractor = new JavaContentExtractor();
  private docExtractor = new JavaDocExtractor();
  private annotationExtractor = new JavaAnnotationExtractor();
  private astCallExtractor = new JavaAstCallExtractor();

  parseMethods(
    content: string, 
    filePath: string, 
    packageName: string,
    entities: ParsedEntity[], 
    relationships: ParsedRelationship[],
    addEntity: (entity: Omit<ParsedEntity, 'project_id'>) => void,
    addRelationship: (rel: Omit<ParsedRelationship, 'project_id'>) => void
  ): Promise<void> {
    return this.parseMethodsAsync(content, filePath, packageName, entities, relationships, addEntity, addRelationship);
  }

  private async parseMethodsAsync(
    content: string, 
    filePath: string, 
    packageName: string,
    entities: ParsedEntity[], 
    relationships: ParsedRelationship[],
    addEntity: (entity: Omit<ParsedEntity, 'project_id'>) => void,
    addRelationship: (rel: Omit<ParsedRelationship, 'project_id'>) => void
  ): Promise<void> {
    const extractionResult = this.contentExtractor.extractContent(content, filePath);
    
    // Prefer AST-based CALLS extraction (handles method chaining, static calls,
    // and .class-mediated factory idioms). Falls back to regex when parsing fails.
    const astCallsEmitted = await this.astCallExtractor.extractFileCalls(
      content,
      filePath,
      packageName,
      (name: string) => this.resolveClassName(name, packageName, extractionResult.imports),
      addRelationship
    );
    
    for (const parsedMethod of extractionResult.functions) {
      // Determine the containing class
      const containingClass = this.findContainingClass(content, parsedMethod.startLine || 1, entities);
      if (!containingClass) continue; // Skip if not in a class
      
      const methodId = `${containingClass.qualified_name}.${parsedMethod.name}`;
      const qualifiedName = `${containingClass.qualified_name}.${parsedMethod.name}`;
      
      // Extract documentation
      const documentation = parsedMethod.startLine 
        ? this.docExtractor.extractDocumentation(content, this.getPositionFromLine(content, parsedMethod.startLine))
        : undefined;

      // Extract annotations using the shared annotation extractor
      const annotations = this.annotationExtractor.extractAnnotationsForLine(content, parsedMethod.startLine || 1);

      // Create method entity (without annotations as attributes - they become nodes)
      const methodEntity = EntityFactory.createMethod(
        methodId,
        parsedMethod.name,
        qualifiedName,
        filePath,
        parsedMethod.startLine,
        parsedMethod.endLine,
        parsedMethod.modifiers,
        documentation,
        [] // No annotations as attributes - they are now nodes
      );

      addEntity(methodEntity);

      // Create annotation nodes and ANNOTATED_WITH relationships for method
      this.createAnnotationNodesAndRelationships(
        methodId, annotations, filePath, containingClass.qualified_name, addEntity, addRelationship
      );

      // Create containment relationship
      addRelationship(RelationshipBuilder.createContains(containingClass.id, methodId, filePath));

      // Create throws relationships for declared exceptions
      if (parsedMethod.throws && parsedMethod.throws.length > 0) {
        const containingPackage = containingClass.qualified_name.substring(0, containingClass.qualified_name.lastIndexOf('.'));
        for (const exceptionName of parsedMethod.throws) {
          const resolvedExc = this.resolveClassName(exceptionName, containingPackage, extractionResult.imports);
          if (resolvedExc && !this.isStandardLibraryType(resolvedExc)) {
            addRelationship(RelationshipBuilder.createThrows(methodId, resolvedExc, filePath));
          }
        }
      }

      // Parse method calls and create call relationships
      // Pass the containing class qualified name for proper internal method resolution.
      // When the AST extractor already emitted CALLS edges, only regex-based
      // REFERENCES are still needed here.
      this.parseMethodCalls(content, parsedMethod, methodId, containingClass.qualified_name, extractionResult.imports, addRelationship, filePath, entities, astCallsEmitted);
    }
  }

  private findContainingClass(content: string, methodLine: number, entities: ParsedEntity[]): ParsedEntity | null {
    // Find the class or interface that contains this method based on line numbers
    let bestMatch: ParsedEntity | null = null;
    let bestRange = Infinity;

    for (const entity of entities) {
      if ((entity.type === 'class' || entity.type === 'interface') && 
          entity.start_line && 
          entity.end_line &&
          methodLine >= entity.start_line && 
          methodLine <= entity.end_line) {
        // Prefer the narrowest enclosing entity (handles nested classes)
        const range = entity.end_line - entity.start_line;
        if (range < bestRange) {
          bestRange = range;
          bestMatch = entity;
        }
      }
    }
    return bestMatch;
  }

  private parseMethodCalls(
    content: string, 
    method: any, 
    methodId: string, 
    containingClassName: string,
    imports: any[],
    addRelationship: (rel: Omit<ParsedRelationship, 'project_id'>) => void,
    filePath: string,
    entities: ParsedEntity[],
    astCallsEmitted: boolean = false
  ): void {
    if (!method.startLine || !method.endLine) return;
    
    let methodBody = this.extractMethodBody(content, method.startLine, method.endLine);
    
    // Defect 1: strip comments and string/char literals so their contents are
    // never mis-tokenized as type names or method calls.
    methodBody = this.stripCommentsAndLiterals(methodBody);
    
    // Remove annotations from the method body to avoid matching them as method calls
    methodBody = methodBody.replace(/@[A-Za-z_][A-Za-z0-9_]*(\s*\([^)]*\))?/g, '');
    
    // Defect 3: drop the method signature (everything up to and including the
    // opening brace) so the declaration itself (e.g. `execute(...)`) is not
    // counted as a self-call.
    const braceIndex = methodBody.indexOf('{');
    if (braceIndex !== -1) {
      methodBody = methodBody.slice(braceIndex + 1);
    }
    
    const containingPackage = containingClassName.substring(0, containingClassName.lastIndexOf('.'));
    
    // Collect method names in the containing class for internal call resolution
    const classMethodNames = new Set<string>();
    for (const entity of entities) {
      if (entity.type === 'method' && entity.qualified_name.startsWith(containingClassName + '.')) {
        classMethodNames.add(entity.name);
      }
    }
    
    // Build a map of field/variable/parameter names to their resolved types.
    const fieldTypeMap = this.buildFieldTypeMap(content, containingClassName, imports);
    
    // De-duplicate emitted CALLS edges.
    const emittedCalls = new Set<string>();
    const addCall = (targetId: string): void => {
      if (targetId && !emittedCalls.has(targetId)) {
        emittedCalls.add(targetId);
        addRelationship(RelationshipBuilder.createCalls(methodId, targetId, filePath));
      }
    };
    
    let match: RegExpExecArray | null;
    
    // CALLS extraction (blocks 1-3) only runs as a fallback when the AST-based
    // extractor could not process the file. REFERENCES (block 4) always runs.
    if (!astCallsEmitted) {
      // 1. Internal (receiver-less) method calls: foo(...)
      const simpleMethodCallPattern = /(?<![.\w$])([a-z][A-Za-z0-9_]*)\s*\(/g;
      while ((match = simpleMethodCallPattern.exec(methodBody)) !== null) {
        const calledMethodName = match[1];
        
        if (this.isBuiltInMethod(calledMethodName)) continue;
        if (this.isCommonAnnotation(calledMethodName)) continue;
        
        // Only resolve internal method calls
        if (classMethodNames.has(calledMethodName)) {
          addCall(`${containingClassName}.${calledMethodName}`);
        }
      }
      
      // 2. Instance method calls on a typed receiver: receiver.method(...)
      // A leading boundary (?<![.\w$]) prevents matching camelCase fragments
      // (Defect 1) and ensures the receiver is a whole identifier.
      const instanceCallPattern = /(?<![.\w$])([a-z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\s*\(/g;
      while ((match = instanceCallPattern.exec(methodBody)) !== null) {
        const receiver = match[1];
        const calledMethod = match[2];
        
        if (receiver === 'this' || receiver === 'super') continue;
        if (this.isBuiltInMethod(calledMethod)) continue;
        
        // Resolve the receiver type from declarations. Emit real invocations,
        // including java.* targets (Defect 2 wants java.lang.String.isEmpty).
        const resolvedType = fieldTypeMap.get(receiver);
        if (resolvedType) {
          addCall(`${resolvedType}.${calledMethod}`);
        }
      }
      
      // 3. Static method calls via a type name: TypeName.method(...) (Defect 4)
      const staticCallPattern = /(?<![.\w$])([A-Z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\s*\(/g;
      while ((match = staticCallPattern.exec(methodBody)) !== null) {
        const typeName = match[1];
        const calledMethod = match[2];
        
        if (this.isCommonAnnotation(typeName)) continue;
        if (this.isBuiltInMethod(calledMethod)) continue;
        
        const resolvedType = this.resolveClassName(typeName, containingPackage, imports);
        if (resolvedType) {
          addCall(`${resolvedType}.${calledMethod}`);
        }
      }
    }

    // 4. Find class usages -> REFERENCES edges.
    // The (?<![A-Za-z0-9_$]) boundary prevents matching capitalised fragments
    // inside camelCase identifiers (Defect 1: ClassID / To).
    const classUsagePatterns = [
      /new\s+([A-Z][A-Za-z0-9_]*)\s*[<(]/g,                                        // new ClassName( or new ClassName<
      /(?<![A-Za-z0-9_$])([A-Z][A-Za-z0-9_]*)\.(?![A-Z])[a-z][A-Za-z0-9_]*\s*\(/g,  // ClassName.method(
      /(?<![A-Za-z0-9_$])([A-Z][A-Za-z0-9_]*)\.class\b/g,                           // ClassName.class
      /\(\s*([A-Z][A-Za-z0-9_]*)\s*\)/g,                                           // (ClassName) cast
    ];
    
    const referencedClasses = new Set<string>();
    
    for (const pattern of classUsagePatterns) {
      pattern.lastIndex = 0;
      while ((match = pattern.exec(methodBody)) !== null) {
        const className = match[1];
        
        // Skip common Java types and annotations
        if (this.isBuiltInMethod(className)) continue;
        if (this.isCommonAnnotation(className)) continue;
        if (this.isStandardJavaClass(className)) continue;
        
        referencedClasses.add(className);
      }
    }
    
    // Resolve and create relationships for referenced classes
    for (const className of referencedClasses) {
      const resolvedClass = this.resolveClassName(className, containingPackage, imports);
      if (resolvedClass && !this.isStandardLibraryType(resolvedClass)) {
        // Create a REFERENCES relationship from the method to the class
        addRelationship(RelationshipBuilder.createReferences(methodId, resolvedClass, filePath));
      }
    }
  }

  private resolveClassName(className: string, packageName: string, imports: any[]): string | null {
    // Strip generics and whitespace: List<Foo> -> List
    const base = className.split('<')[0].trim();
    if (!base) return null;
    
    // Already fully qualified
    if (base.includes('.')) return base;
    
    // 1. Explicit single-type imports
    for (const imp of imports) {
      if (imp.items?.includes('*')) continue; // wildcards handled below
      if (imp.items?.includes(base) || imp.module.endsWith(`.${base}`)) {
        return imp.module.endsWith(`.${base}`) ? imp.module : `${imp.module}.${base}`;
      }
    }
    
    // 2. Implicit java.lang.* resolution (Defect 2: String -> java.lang.String)
    if (this.isJavaLangType(base)) {
      return `java.lang.${base}`;
    }
    
    // 3. On-demand (wildcard) imports - only safe when unambiguous
    const wildcards = imports.filter(imp => imp.items?.includes('*'));
    if (wildcards.length === 1) {
      return `${wildcards[0].module}.${base}`;
    }
    
    // 4. Same-package fallback - only for things that look like a type name
    if (/^[A-Z]/.test(base)) {
      return `${packageName}.${base}`;
    }
    
    // 5. Unresolved - do NOT invent a current-package target (Defects 2 & 3)
    return null;
  }

  private isJavaLangType(name: string): boolean {
    const javaLang = new Set([
      'String', 'Object', 'Class', 'Integer', 'Long', 'Double', 'Float',
      'Boolean', 'Byte', 'Short', 'Character', 'Number', 'Void',
      'Math', 'System', 'Thread', 'Runnable', 'CharSequence', 'Iterable',
      'Comparable', 'Cloneable', 'StringBuilder', 'StringBuffer',
      'Exception', 'RuntimeException', 'Error', 'Throwable',
      'IllegalArgumentException', 'IllegalStateException', 'NullPointerException',
      'IndexOutOfBoundsException', 'ClassCastException', 'UnsupportedOperationException'
    ]);
    return javaLang.has(name);
  }

  private isStandardJavaClass(className: string): boolean {
    const standardClasses = [
      'String', 'Object', 'Class', 'Integer', 'Long', 'Double', 'Float', 
      'Boolean', 'Byte', 'Short', 'Character', 'Number', 'Void',
      'List', 'Set', 'Map', 'Collection', 'ArrayList', 'HashMap', 'HashSet',
      'Optional', 'Stream', 'Arrays', 'Collections', 'Objects', 'Math',
      'System', 'Runtime', 'Thread', 'Runnable', 'Exception', 'Error',
      'StringBuilder', 'StringBuffer', 'Throwable'
    ];
    return standardClasses.includes(className);
  }

  /**
   * Builds a map of field/variable names to their fully qualified types.
   * This enables cross-class CALLS edge resolution for instance method calls.
   */
  private buildFieldTypeMap(content: string, containingClassName: string, imports: any[]): Map<string, string> {
    const fieldTypeMap = new Map<string, string>();
    const containingPackage = containingClassName.substring(0, containingClassName.lastIndexOf('.'));
    
    // Match field declarations: [modifiers] Type fieldName [= ...];
    // Handles generics like Map<String, List<Foo>> by using a non-greedy approach on the type
    const fieldPattern = /(?:(?:private|protected|public|static|final|volatile|transient)\s+)*([A-Z][A-Za-z0-9_]*(?:<[^;]*?>)?)\s+([a-z][A-Za-z0-9_]*)\s*[;=]/g;
    let match;
    
    while ((match = fieldPattern.exec(content)) !== null) {
      const rawType = match[1].replace(/<.*>/, ''); // Strip generics for resolution
      const fieldName = match[2];
      
      // Resolve the type through imports
      const resolvedType = this.resolveClassName(rawType, containingPackage, imports);
      if (resolvedType) {
        fieldTypeMap.set(fieldName, resolvedType);
      }
    }
    
    // Also match local variable declarations in a simpler way:
    // Type varName = expr;  or  final Type varName = expr;
    const localVarPattern = /(?:final\s+)?([A-Z][A-Za-z0-9_]*(?:<[^;]*?>)?)\s+([a-z][A-Za-z0-9_]*)\s*=/g;
    while ((match = localVarPattern.exec(content)) !== null) {
      const rawType = match[1].replace(/<.*>/, '');
      const varName = match[2];
      
      if (!fieldTypeMap.has(varName)) {
        const resolvedType = this.resolveClassName(rawType, containingPackage, imports);
        if (resolvedType) {
          fieldTypeMap.set(varName, resolvedType);
        }
      }
    }
    
    // Match method parameters: (Type paramName, Type paramName, ...)
    // This captures parameters from method signatures so calls like param.method() can be resolved
    const methodParamPattern = /\(\s*(?:(?:final\s+)?(?:@\w+(?:\([^)]*\))?\s+)*([A-Z][A-Za-z0-9_]*(?:<[^>]*>)?)\s+([a-z][A-Za-z0-9_]*)\s*[,)])/g;
    while ((match = methodParamPattern.exec(content)) !== null) {
      const rawType = match[1].replace(/<.*>/, '');
      const paramName = match[2];
      
      if (!fieldTypeMap.has(paramName)) {
        const resolvedType = this.resolveClassName(rawType, containingPackage, imports);
        if (resolvedType) {
          fieldTypeMap.set(paramName, resolvedType);
        }
      }
    }

    // Match all method parameters more broadly: handles multi-param signatures
    // Pattern: Type name appearing in parameter lists
    const allParamsPattern = /(?:final\s+)?(?:@\w+(?:\([^)]*\))?\s+)*([A-Z][A-Za-z0-9_]*(?:<[^>]*>)?)\s+([a-z][A-Za-z0-9_]*)\s*(?=[,)])/g;
    while ((match = allParamsPattern.exec(content)) !== null) {
      const rawType = match[1].replace(/<.*>/, '');
      const paramName = match[2];
      
      if (!fieldTypeMap.has(paramName)) {
        const resolvedType = this.resolveClassName(rawType, containingPackage, imports);
        if (resolvedType) {
          fieldTypeMap.set(paramName, resolvedType);
        }
      }
    }
    
    return fieldTypeMap;
  }

  private isStandardLibraryType(typeName: string): boolean {
    const standardPackages = [
      'java.', 'javax.', 'jakarta.', 'sun.', 'com.sun.', 
      'org.w3c.', 'org.xml.'
    ];
    return standardPackages.some(pkg => typeName.startsWith(pkg));
  }

  private extractMethodBody(content: string, startLine: number, endLine: number): string {
    const lines = content.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
  }

  /**
   * Removes comments and string/char literals from a code fragment so that their
   * contents are never mis-tokenized as type names or method calls (Defect 1).
   */
  private stripCommentsAndLiterals(code: string): string {
    return code
      // Block comments
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // Line comments
      .replace(/\/\/[^\n]*/g, ' ')
      // String literals
      .replace(/"([^"\\]|\\.)*"/g, '""')
      // Char literals
      .replace(/'([^'\\]|\\.)*'/g, "''");
  }

  private isBuiltInMethod(methodName: string): boolean {
    const builtInMethods = [
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
      'try', 'catch', 'finally', 'throw', 'throws', 'return', 'new',
      'this', 'super', 'class', 'interface', 'enum', 'extends', 'implements',
      'public', 'private', 'protected', 'static', 'final', 'abstract',
      'println', 'print', 'toString', 'equals', 'hashCode', 'getClass'
    ];
    
    return builtInMethods.includes(methodName);
  }

  private isCommonAnnotation(name: string): boolean {
    // Common Java/Framework annotations that might be incorrectly picked up
    const commonAnnotations = [
      // JAXB annotations
      'XmlRootElement', 'XmlElement', 'XmlAttribute', 'XmlAccessorType', 
      'XmlType', 'XmlTransient', 'XmlElementWrapper', 'XmlSchema',
      // Jackson annotations
      'JsonProperty', 'JsonIgnore', 'JsonInclude', 'JsonFormat', 
      'JsonSerialize', 'JsonDeserialize', 'JsonCreator', 'JsonValue',
      // JPA/Hibernate annotations
      'Entity', 'Table', 'Column', 'Id', 'GeneratedValue', 'ManyToOne',
      'OneToMany', 'ManyToMany', 'OneToOne', 'JoinColumn', 'Transient',
      // Spring annotations
      'Autowired', 'Component', 'Service', 'Repository', 'Controller',
      'RestController', 'RequestMapping', 'GetMapping', 'PostMapping',
      'PutMapping', 'DeleteMapping', 'PathVariable', 'RequestBody',
      'RequestParam', 'Bean', 'Configuration', 'Value', 'Inject',
      // Lombok annotations
      'Data', 'Getter', 'Setter', 'Builder', 'NoArgsConstructor',
      'AllArgsConstructor', 'RequiredArgsConstructor', 'ToString', 'EqualsAndHashCode',
      // Validation annotations
      'NotNull', 'NotEmpty', 'NotBlank', 'Size', 'Min', 'Max', 'Valid',
      'Pattern', 'Email', 'Past', 'Future',
      // Other common annotations
      'Override', 'Deprecated', 'SuppressWarnings', 'FunctionalInterface',
      'SafeVarargs', 'Nullable', 'NonNull', 'Nonnull', 'Test', 'Before', 
      'After', 'BeforeEach', 'AfterEach', 'Mock', 'InjectMocks', 'Spy'
    ];
    
    return commonAnnotations.includes(name);
  }

  private extractAnnotations(content: string, startLine: number): any[] {
    const annotations: any[] = [];
    const lines = content.split('\n');
    
    // Look backwards from the method declaration for annotations
    for (let i = startLine - 2; i >= 0 && i >= startLine - 10; i--) {
      const line = lines[i]?.trim() || '';
      
      // Stop if we hit a non-annotation line (but skip blank lines)
      if (!line.startsWith('@') && line.length > 0 && !line.startsWith('//') && !line.startsWith('*')) {
        break;
      }
      
      // Extract annotation
      const annotationMatch = line.match(/@(\w+)(?:\((.*)\))?/);
      if (annotationMatch) {
        annotations.push({
          name: annotationMatch[1],
          parameters: annotationMatch[2] || null,
          source_line: i + 1
        });
      }
    }
    
    return annotations;
  }

  private getPositionFromLine(content: string, lineNumber: number): number {
    const lines = content.split('\n');
    let position = 0;
    
    for (let i = 0; i < Math.min(lineNumber - 1, lines.length); i++) {
      position += lines[i].length + 1; // +1 for newline
    }
    
    return position;
  }

  /**
   * Creates Annotation nodes and ANNOTATED_WITH relationships for a method.
   * Each annotation on the method becomes a separate node in the graph.
   */
  private createAnnotationNodesAndRelationships(
    methodId: string,
    annotations: AnnotationInfo[],
    filePath: string,
    packageName: string,
    addEntity: (entity: Omit<ParsedEntity, 'project_id'>) => void,
    addRelationship: (rel: Omit<ParsedRelationship, 'project_id'>) => void
  ): void {
    for (const annotation of annotations) {
      // Create unique annotation node ID based on method and annotation name
      const annotationId = `${methodId}@${annotation.name}`;
      const qualifiedName = `${packageName}.${annotation.name}`;

      // Create annotation node
      const annotationEntity = EntityFactory.createAnnotation(
        annotationId,
        annotation.name,
        qualifiedName,
        filePath,
        annotation.source_line,
        annotation.framework,
        annotation.category,
        annotation.parameters
      );

      addEntity(annotationEntity);

      // Create ANNOTATED_WITH relationship from method to annotation
      addRelationship(RelationshipBuilder.createAnnotatedWith(
        methodId, 
        annotationId, 
        filePath, 
        { source_line: annotation.source_line }
      ));
    }
  }
}