import { ParsedEntity, ParsedRelationship } from '../../../types.js';
import { AnnotationInfo } from '../../../../types.js';
import { EntityFactory } from '../../base/EntityFactory.js';
import { RelationshipBuilder } from '../../base/RelationshipBuilder.js';
import { JavaContentExtractor } from '../../extractors/java/JavaContentExtractor.js';
import { JavaDocExtractor } from '../../extractors/java/JavaDocExtractor.js';
import { JavaAnnotationExtractor } from '../../extractors/java/JavaAnnotationExtractor.js';

export class JavaFieldParser {
  private contentExtractor = new JavaContentExtractor();
  private docExtractor = new JavaDocExtractor();
  private annotationExtractor = new JavaAnnotationExtractor();

  parseFields(
    content: string, 
    filePath: string, 
    packageName: string,
    entities: ParsedEntity[], 
    relationships: ParsedRelationship[],
    addEntity: (entity: Omit<ParsedEntity, 'project_id'>) => void,
    addRelationship: (rel: Omit<ParsedRelationship, 'project_id'>) => void
  ): void {
    const extractionResult = this.contentExtractor.extractContent(content, filePath);
    
    for (const parsedField of extractionResult.fields) {
      // Determine the containing class
      const containingClass = this.findContainingClass(content, parsedField.startLine || 1, entities);
      if (!containingClass) continue; // Skip if not in a class
      
      const fieldId = `${containingClass.qualified_name}.${parsedField.name}`;
      const qualifiedName = `${containingClass.qualified_name}.${parsedField.name}`;
      
      // Extract documentation
      const documentation = parsedField.startLine 
        ? this.docExtractor.extractDocumentation(content, this.getPositionFromLine(content, parsedField.startLine))
        : undefined;

      // Extract annotations using the shared annotation extractor
      const annotations = this.annotationExtractor.extractAnnotationsForLine(content, parsedField.startLine || 1);

      // Create field entity
      const fieldEntity = EntityFactory.createField(
        fieldId,
        parsedField.name,
        qualifiedName,
        filePath,
        parsedField.startLine,
        parsedField.endLine,
        parsedField.modifiers,
        documentation,
        annotations
      );

      addEntity(fieldEntity);

      // Create annotation nodes and ANNOTATED_WITH relationships for field
      this.createAnnotationNodesAndRelationships(
        fieldId, annotations, filePath, containingClass.qualified_name, addEntity, addRelationship
      );

      // Create containment relationship
      addRelationship(RelationshipBuilder.createContains(containingClass.id, fieldId, filePath));

      // Create type references for all types in the field declaration (including generic type arguments)
      if (parsedField.type) {
        const allTypes = this.extractAllTypesFromGeneric(parsedField.type);
        for (const typeName of allTypes) {
          const referencedType = this.resolveType(typeName, packageName, extractionResult.imports);
          // Create reference if it's not a primitive/standard library type
          if (!this.isBuiltInType(referencedType)) {
            addRelationship(RelationshipBuilder.createReferences(fieldId, referencedType, filePath));
            // Also link the containing class to the field type for higher-level graph views.
            addRelationship(RelationshipBuilder.createReferences(containingClass.id, referencedType, filePath));
          }
        }
      }
    }
  }

  private findContainingClass(content: string, fieldLine: number, entities: ParsedEntity[]): ParsedEntity | null {
    // Find the class that contains this field based on line numbers
    for (const entity of entities) {
      if (entity.type === 'class' && 
          entity.start_line && 
          entity.end_line) {
        // If startLine === endLine, we don't have proper class bounds,
        // so assume field belongs to this class if it's after the class declaration
        if (entity.start_line === entity.end_line) {
          if (fieldLine >= entity.start_line) {
            return entity;
          }
        } else if (fieldLine >= entity.start_line && fieldLine <= entity.end_line) {
          return entity;
        }
      }
    }
    return null;
  }

  /**
   * Extracts all type names from a generic type declaration.
   * For example, "Collection<PunchoutAvailableFormatterRO>" returns ["Collection", "PunchoutAvailableFormatterRO"]
   * And "Map<String, List<MyClass>>" returns ["Map", "String", "List", "MyClass"]
   */
  private extractAllTypesFromGeneric(typeName: string): string[] {
    const types: string[] = [];
    
    // Remove array brackets first
    const cleanType = typeName.replace(/\[\]/g, '');
    
    // Use regex to extract all type names (word characters that could be type names)
    // This handles nested generics like Map<String, List<MyClass>>
    const typePattern = /([A-Z][A-Za-z0-9_]*)/g;
    let match;
    
    while ((match = typePattern.exec(cleanType)) !== null) {
      const foundType = match[1];
      // Avoid duplicates
      if (!types.includes(foundType)) {
        types.push(foundType);
      }
    }
    
    return types;
  }

  private resolveType(typeName: string, packageName: string, imports: any[]): string {
    // Remove generic type parameters and array brackets
    const baseType = typeName.replace(/[<>\[\]]/g, '').split(/[<,\s]/)[0].trim();
    
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

  private isBuiltInType(typeName: string): boolean {
    // Primitive and wrapper types
    const primitiveTypes = [
      'int', 'long', 'short', 'byte', 'float', 'double', 'boolean', 'char',
      'Integer', 'Long', 'Short', 'Byte', 'Float', 'Double', 'Boolean', 'Character',
      'String', 'Object', 'void', 'Void', 'Class', 'Number'
    ];
    
    // Check for primitive/wrapper types
    const baseTypeName = typeName.split('.').pop() || typeName;
    if (primitiveTypes.includes(baseTypeName)) {
      return true;
    }
    
    // Standard Java library packages - skip references to these
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
      'java.concurrent.',
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
    
    // Check if type is from a standard Java package
    for (const pkg of javaStandardPackages) {
      if (typeName.startsWith(pkg)) {
        return true;
      }
    }
    
    // Common collection types (unqualified)
    const commonCollections = [
      'List', 'Set', 'Map', 'Collection', 'Queue', 'Deque', 
      'ArrayList', 'LinkedList', 'HashMap', 'HashSet', 'TreeMap', 'TreeSet',
      'LinkedHashMap', 'LinkedHashSet', 'ConcurrentHashMap', 'ConcurrentMap',
      'Optional', 'Stream', 'Iterator', 'Iterable', 'Comparable', 'Comparator',
      'Supplier', 'Consumer', 'Function', 'Predicate', 'BiFunction', 'BiConsumer',
      'BigDecimal', 'BigInteger', 'Date', 'Calendar', 'LocalDate', 'LocalDateTime',
      'LocalTime', 'Instant', 'Duration', 'Period', 'ZonedDateTime', 'OffsetDateTime',
      'UUID', 'URI', 'URL', 'File', 'Path', 'Pattern', 'Matcher',
      'StringBuilder', 'StringBuffer', 'CharSequence', 'Appendable',
      'Exception', 'RuntimeException', 'Error', 'Throwable'
    ];
    
    if (commonCollections.includes(baseTypeName)) {
      return true;
    }
    
    return false;
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
   * Creates annotation nodes and ANNOTATED_WITH relationships for a field.
   * Each annotation on the field becomes a separate node in the graph.
   */
  private createAnnotationNodesAndRelationships(
    fieldId: string,
    annotations: AnnotationInfo[],
    filePath: string,
    packageName: string,
    addEntity: (entity: Omit<ParsedEntity, 'project_id'>) => void,
    addRelationship: (rel: Omit<ParsedRelationship, 'project_id'>) => void
  ): void {
    for (const annotation of annotations) {
      // Create unique annotation node ID based on field and annotation name
      const annotationId = `${fieldId}@${annotation.name}`;
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

      // Create ANNOTATED_WITH relationship from field to annotation
      addRelationship(RelationshipBuilder.createAnnotatedWith(
        fieldId, 
        annotationId, 
        filePath, 
        { source_line: annotation.source_line }
      ));
    }
  }
}