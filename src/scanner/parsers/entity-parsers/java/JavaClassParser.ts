import { ParsedEntity, ParsedRelationship } from '../../../types.js';
import { AnnotationInfo } from '../../../../types.js';
import { EntityFactory } from '../../base/EntityFactory.js';
import { RelationshipBuilder } from '../../base/RelationshipBuilder.js';
import { JavaContentExtractor } from '../../extractors/java/JavaContentExtractor.js';
import { JavaDocExtractor } from '../../extractors/java/JavaDocExtractor.js';
import { JavaAnnotationExtractor } from '../../extractors/java/JavaAnnotationExtractor.js';

export class JavaClassParser {
  private contentExtractor = new JavaContentExtractor();
  private docExtractor = new JavaDocExtractor();
  private annotationExtractor = new JavaAnnotationExtractor();

  parseClasses(
    content: string, 
    filePath: string, 
    packageName: string,
    entities: ParsedEntity[], 
    relationships: ParsedRelationship[],
    addEntity: (entity: Omit<ParsedEntity, 'project_id'>) => void,
    addRelationship: (rel: Omit<ParsedRelationship, 'project_id'>) => void
  ): void {
    const extractionResult = this.contentExtractor.extractContent(content, filePath);
    
    for (const parsedClass of extractionResult.classes) {
      const classId = `${packageName}.${parsedClass.name}`;
      const qualifiedName = `${packageName}.${parsedClass.name}`;
      
      // Extract documentation
      const documentation = parsedClass.startLine 
        ? this.docExtractor.extractDocumentation(content, this.getPositionFromLine(content, parsedClass.startLine))
        : undefined;

      // Extract annotations using the shared annotation extractor
      const annotations = this.annotationExtractor.extractAnnotationsForLine(content, parsedClass.startLine || 1);

      // Create class entity (without annotations as attributes - they become nodes)
      const classEntity = EntityFactory.createClass(
        classId,
        parsedClass.name,
        qualifiedName,
        filePath,
        parsedClass.startLine,
        parsedClass.endLine,
        parsedClass.modifiers,
        documentation,
        [] // No annotations as attributes - they are now nodes
      );

      addEntity(classEntity);

      // Create annotation nodes and ANNOTATED_WITH relationships
      this.createAnnotationNodesAndRelationships(
        classId, annotations, filePath, packageName, addEntity, addRelationship
      );

      // Create package relationships (bidirectional for better graph traversal)
      const packageId = packageName;
      addRelationship(RelationshipBuilder.createBelongsTo(classId, packageId, filePath));
      addRelationship(RelationshipBuilder.createContains(packageId, classId, filePath));

      // Handle inheritance
      if (parsedClass.extends && parsedClass.extends.length > 0) {
        for (const parentClass of parsedClass.extends) {
          const parentId = this.resolveType(parentClass.trim(), packageName, extractionResult.imports);
          // Skip relationships to standard library types
          if (!this.isStandardLibraryType(parentId)) {
            addRelationship(RelationshipBuilder.createExtends(classId, parentId, filePath));
          }
        }
      }

      // Handle interfaces
      if (parsedClass.implements && parsedClass.implements.length > 0) {
        for (const interfaceName of parsedClass.implements) {
          const interfaceId = this.resolveType(interfaceName.trim(), packageName, extractionResult.imports);
          // Skip relationships to standard library types
          if (!this.isStandardLibraryType(interfaceId)) {
            addRelationship(RelationshipBuilder.createImplements(classId, interfaceId, filePath));
          }
        }
      }

      // Create class-level type references from methods and fields
      this.createClassTypeReferences(
        classId, 
        packageName, 
        extractionResult, 
        parsedClass,
        addRelationship, 
        filePath
      );
    }
  }

  /**
   * Creates REFERENCES relationships from a class to all types it uses in:
   * - Method return types
   * - Method parameter types
   * - Field types
   * 
   * This provides better class-level coupling information for metrics like CBO.
   */
  private createClassTypeReferences(
    classId: string,
    packageName: string,
    extractionResult: ReturnType<JavaContentExtractor['extractContent']>,
    parsedClass: { startLine?: number; endLine?: number },
    addRelationship: (rel: Omit<ParsedRelationship, 'project_id'>) => void,
    filePath: string
  ): void {
    const referencedTypes = new Set<string>();

    // Collect types from method return types and parameters
    for (const method of extractionResult.functions) {
      // Only process methods that belong to this class (by line number range)
      // If startLine === endLine, we don't have proper class bounds, so we can't filter by line number
      if (parsedClass.startLine && parsedClass.endLine && method.startLine &&
          parsedClass.startLine !== parsedClass.endLine) {
        if (method.startLine < parsedClass.startLine || method.startLine > parsedClass.endLine) {
          continue;
        }
      }

      // Add return type
      if (method.returnType) {
        const types = this.extractTypesFromTypeString(method.returnType);
        types.forEach(t => referencedTypes.add(t));
      }

      // Add parameter types
      if (method.parameters) {
        for (const param of method.parameters) {
          if (param.type) {
            const types = this.extractTypesFromTypeString(param.type);
            types.forEach(t => referencedTypes.add(t));
          }
        }
      }

      // Create class-level type references from methods and fields
      this.createClassTypeReferences(
        classId, 
        packageName, 
        extractionResult, 
        parsedClass,
        addRelationship, 
        filePath
      );
    }
  }

  /**
   * Creates Annotation nodes and ANNOTATED_WITH relationships for a class.
   * Each annotation on the class becomes a separate node in the graph.
   */
  private createAnnotationNodesAndRelationships(
    classId: string,
    annotations: AnnotationInfo[],
    filePath: string,
    packageName: string,
    addEntity: (entity: Omit<ParsedEntity, 'project_id'>) => void,
    addRelationship: (rel: Omit<ParsedRelationship, 'project_id'>) => void
  ): void {
    for (const annotation of annotations) {
      // Create unique annotation node ID based on class and annotation name
      const annotationId = `${classId}@${annotation.name}`;
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

      // Create ANNOTATED_WITH relationship from class to annotation
      addRelationship(RelationshipBuilder.createAnnotatedWith(
        classId, 
        annotationId, 
        filePath, 
        { source_line: annotation.source_line }
      ));
    }
  }

  /**
   * Creates REFERENCES relationships from a class to all types it uses in:
   * - Method return types
   * - Method parameter types
   * - Field types
   * 
   * This provides better class-level coupling information for metrics like CBO.
   */
  private createClassTypeReferences(
    classId: string,
    packageName: string,
    extractionResult: ReturnType<JavaContentExtractor['extractContent']>,
    parsedClass: { startLine?: number; endLine?: number },
    addRelationship: (rel: Omit<ParsedRelationship, 'project_id'>) => void,
    filePath: string
  ): void {
    const referencedTypes = new Set<string>();

    // Collect types from method return types and parameters
    for (const method of extractionResult.functions) {
      // Only process methods that belong to this class (by line number range)
      // If startLine === endLine, we don't have proper class bounds, so we can't filter by line number
      if (parsedClass.startLine && parsedClass.endLine && method.startLine &&
          parsedClass.startLine !== parsedClass.endLine) {
        if (method.startLine < parsedClass.startLine || method.startLine > parsedClass.endLine) {
          continue;
        }
      }

      // Add return type
      if (method.returnType) {
        const types = this.extractTypesFromTypeString(method.returnType);
        types.forEach(t => referencedTypes.add(t));
      }

      // Add parameter types
      if (method.parameters) {
        for (const param of method.parameters) {
          if (param.type) {
            const types = this.extractTypesFromTypeString(param.type);
            types.forEach(t => referencedTypes.add(t));
          }
        }
      }
    }

    // Collect types from field types
    for (const field of extractionResult.fields) {
      // Only process fields that belong to this class
      // If startLine === endLine, we don't have proper class bounds, so we can't filter by line number
      if (parsedClass.startLine && parsedClass.endLine && field.startLine && 
          parsedClass.startLine !== parsedClass.endLine) {
        if (field.startLine < parsedClass.startLine || field.startLine > parsedClass.endLine) {
          continue;
        }
      }

      if (field.type) {
        const types = this.extractTypesFromTypeString(field.type);
        types.forEach(t => referencedTypes.add(t));
      }
    }

    // Create REFERENCES relationships for each unique type
    for (const typeName of referencedTypes) {
      const resolvedType = this.resolveType(typeName, packageName, extractionResult.imports);
      
      // Skip standard library types and self-references
      if (!this.isStandardLibraryType(resolvedType) && resolvedType !== classId) {
        addRelationship(RelationshipBuilder.createReferences(classId, resolvedType, filePath));
      }
    }

    // Collect types from field types
    for (const field of extractionResult.fields) {
      // Only process fields that belong to this class
      // If startLine === endLine, we don't have proper class bounds, so we can't filter by line number
      if (parsedClass.startLine && parsedClass.endLine && field.startLine && 
          parsedClass.startLine !== parsedClass.endLine) {
        if (field.startLine < parsedClass.startLine || field.startLine > parsedClass.endLine) {
          continue;
        }
      }

      if (field.type) {
        const types = this.extractTypesFromTypeString(field.type);
        types.forEach(t => referencedTypes.add(t));
      }
    }

    // Create REFERENCES relationships for each unique type
    for (const typeName of referencedTypes) {
      const resolvedType = this.resolveType(typeName, packageName, extractionResult.imports);
      
      // Skip standard library types and self-references
      if (!this.isStandardLibraryType(resolvedType) && resolvedType !== classId) {
        addRelationship(RelationshipBuilder.createReferences(classId, resolvedType, filePath));
      }
    }
  }

  /**
   * Extracts all type names from a type string, handling generics.
   * E.g., "Map<String, List<PunchoutItemRO>>" returns ["Map", "String", "List", "PunchoutItemRO"]
   */
  private extractTypesFromTypeString(typeString: string): string[] {
    const types: string[] = [];
    
    // Remove array brackets
    const cleaned = typeString.replace(/\[\]/g, '');
    
    // Split by generic delimiters and commas
    const parts = cleaned.split(/[<>,\s]+/);
    
    for (const part of parts) {
      const trimmed = part.trim();
      // Only include valid class names (starting with uppercase)
      if (trimmed && /^[A-Z][A-Za-z0-9_$]*$/.test(trimmed)) {
        types.push(trimmed);
      }
    }
    
    return types;
  }

  /**
   * Extracts all type names from a type string, handling generics.
   * E.g., "Map<String, List<PunchoutItemRO>>" returns ["Map", "String", "List", "PunchoutItemRO"]
   */
  private extractTypesFromTypeString(typeString: string): string[] {
    const types: string[] = [];
    
    // Remove array brackets
    const cleaned = typeString.replace(/\[\]/g, '');
    
    // Split by generic delimiters and commas
    const parts = cleaned.split(/[<>,\s]+/);
    
    for (const part of parts) {
      const trimmed = part.trim();
      // Only include valid class names (starting with uppercase)
      if (trimmed && /^[A-Z][A-Za-z0-9_$]*$/.test(trimmed)) {
        types.push(trimmed);
      }
    }
    
    return types;
  }

  private resolveType(typeName: string, packageName: string, imports: any[]): string {
    // Remove generic type parameters
    const baseType = typeName.split('<')[0].trim();
    
    // Check if it's a fully qualified name
    if (baseType.includes('.')) {
      return baseType;
    }
    
    // Check imports for the type
    for (const imp of imports) {
      if (imp.items?.includes(baseType) || imp.module.endsWith(`.${baseType}`)) {
        return imp.module.includes('.') ? imp.module : `${packageName}.${baseType}`;
      }
    }
    
    // Default to same package
    return `${packageName}.${baseType}`;
  }

  private isStandardLibraryType(typeName: string): boolean {
    // Standard Java library packages
    const javaStandardPackages = [
      'java.lang.',
      'java.util.',
      'java.io.',
      'java.math.',
      'java.time.',
      'java.net.',
      'java.nio.',
      'java.sql.',
      'java.text.',
      'java.security.',
      'java.util.concurrent.',
      'java.util.function.',
      'java.util.stream.',
      'java.util.regex.',
      'javax.',
      'jakarta.',
      'org.w3c.',
      'org.xml.',
      'sun.',
      'com.sun.'
    ];
    
    for (const pkg of javaStandardPackages) {
      if (typeName.startsWith(pkg)) {
        return true;
      }
    }
    
    // Common standard library types (unqualified names that might be resolved)
    const baseTypeName = typeName.split('.').pop() || typeName;
    const commonStdTypes = [
      'Serializable', 'Cloneable', 'Comparable', 'Iterable', 'AutoCloseable',
      'Runnable', 'Callable', 'Future', 'Closeable', 'Flushable',
      'Exception', 'RuntimeException', 'Error', 'Throwable',
      'Object', 'Class', 'String', 'Number', 'Enum'
    ];
    
    return commonStdTypes.includes(baseTypeName);
  }

  private getPositionFromLine(content: string, lineNumber: number): number {
    const lines = content.split('\n');
    let position = 0;
    
    for (let i = 0; i < Math.min(lineNumber - 1, lines.length); i++) {
      position += lines[i].length + 1; // +1 for newline
    }
    
    return position;
  }
}