import { ParsedEntity, ParsedRelationship } from '../../../types.js';
import { EntityFactory } from '../../base/EntityFactory.js';
import { RelationshipBuilder } from '../../base/RelationshipBuilder.js';
import { JavaContentExtractor } from '../../extractors/java/JavaContentExtractor.js';
import { JavaDocExtractor } from '../../extractors/java/JavaDocExtractor.js';
import { JavaFrameworkDetector } from '../../framework-detection/java/JavaFrameworkDetector.js';
import { JavaAnnotationExtractor } from '../../extractors/java/JavaAnnotationExtractor.js';

export class JavaClassParser {
  private contentExtractor = new JavaContentExtractor();
  private docExtractor = new JavaDocExtractor();
  private frameworkDetector = new JavaFrameworkDetector();
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

      // Extract annotations using modular extractor
      const annotationResult = this.annotationExtractor.extractAnnotations(content, this.getPositionFromLine(content, parsedClass.startLine || 1));
      const annotations = annotationResult.annotations;

      // Create class entity
      const classEntity = EntityFactory.createClass(
        classId,
        parsedClass.name,
        qualifiedName,
        filePath,
        parsedClass.startLine,
        parsedClass.endLine,
        parsedClass.modifiers,
        documentation,
        annotations
      );

      addEntity(classEntity);

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

  private extractAnnotations(content: string, startLine: number): any[] {
    const annotations: any[] = [];
    const lines = content.split('\n');
    
    // Look backwards from the class declaration for annotations
    for (let i = startLine - 2; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line.startsWith('//') || line.startsWith('/*')) continue;
      
      const annotationMatch = line.match(/@([A-Za-z_][A-Za-z0-9_]*)/);
      if (annotationMatch) {
        const annotationName = annotationMatch[1];
        const framework = this.frameworkDetector.detectFramework(annotationName) || 'Unknown';
        const category = this.frameworkDetector.categorizeAnnotation(annotationName) || 'unknown';
        
        annotations.unshift({
          name: annotationName,
          framework,
          category
        });
      } else if (line && !line.startsWith('@')) {
        break; // Stop at non-annotation content
      }
    }
    
    return annotations;
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