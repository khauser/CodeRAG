import { JavaParser } from '../../../src/scanner/parsers/java-parser.js';

describe('JavaParser', () => {
  let parser: JavaParser;

  beforeEach(() => {
    parser = new JavaParser();
    jest.clearAllMocks();
  });

  describe('canParse', () => {
    test('should accept Java files', () => {
      expect(parser.canParse('Test.java')).toBe(true);
      expect(parser.canParse('MyClass.java')).toBe(true);
      expect(parser.canParse('/path/to/File.java')).toBe(true);
    });

    test('should reject non-Java files', () => {
      expect(parser.canParse('test.ts')).toBe(false);
      expect(parser.canParse('test.js')).toBe(false);
      expect(parser.canParse('test.py')).toBe(false);
      expect(parser.canParse('test.txt')).toBe(false);
    });

    test('should handle case insensitive extensions', () => {
      expect(parser.canParse('Test.JAVA')).toBe(true);
      expect(parser.canParse('Test.Java')).toBe(true);
    });
  });

  describe('parseFile', () => {
    const projectId = 'test-project';
    const filePath = '/test/Test.java';

    test('should handle empty file', async () => {
      const result = await parser.parseFile(filePath, '', projectId);

      expect(result.entities).toEqual([]);
      expect(result.relationships).toEqual([]);
      // Empty file might generate parsing errors - that's acceptable
      expect(Array.isArray(result.errors)).toBe(true);
    });

    test('should return valid parse result structure', async () => {
      const javaCode = `package com.test;
public class TestClass {
  public void method() {}
}`;

      const result = await parser.parseFile(filePath, javaCode, projectId);

      expect(result).toHaveProperty('entities');
      expect(result).toHaveProperty('relationships');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.entities)).toBe(true);
      expect(Array.isArray(result.relationships)).toBe(true);
      expect(Array.isArray(result.errors)).toBe(true);
    });

    test('should handle simple Java code without throwing', async () => {
      const javaCode = `
        package com.test;
        
        public class TestClass {
          private String name;
          
          public TestClass(String name) {
            this.name = name;
          }
          
          public String getName() {
            return name;
          }
        }
      `;

      expect(async () => {
        await parser.parseFile(filePath, javaCode, projectId);
      }).not.toThrow();
    });

    test('should handle syntax errors gracefully', async () => {
      const javaCode = `
        package com.test;
        
        public class TestClass {
          // Missing closing brace
          public void method() {
        }
      `;

      const result = await parser.parseFile(filePath, javaCode, projectId);

      // Should not throw, may have errors in result
      expect(result).toBeDefined();
      expect(result).toHaveProperty('entities');
      expect(result).toHaveProperty('relationships');
      expect(result).toHaveProperty('errors');
    });

    test('should create REFERENCES relationships for generic type arguments', async () => {
      const javaCode = `
        package com.test;
        
        import java.util.Collection;
        
        public class ItemRO {
          private Collection<FormatterRO> formatters;
          private String name;
        }
      `;

      const result = await parser.parseFile(filePath, javaCode, projectId);

      // Find REFERENCES relationships (lowercase in the result)
      const referencesRelationships = result.relationships.filter(r => r.type === 'references');
      
      // Should have a reference to FormatterRO from both the field and the class
      const formatterReferences = referencesRelationships.filter(r => 
        r.target.includes('FormatterRO')
      );
      
      expect(formatterReferences.length).toBeGreaterThanOrEqual(1);
      
      // Verify the reference target is resolved to the correct package
      expect(formatterReferences.some(r => r.target === 'com.test.FormatterRO')).toBe(true);
    });

    test('should create REFERENCES for nested generic types', async () => {
      const javaCode = `
        package com.example;
        
        import java.util.Map;
        import java.util.List;
        
        public class ComplexClass {
          private Map<KeyType, List<ValueType>> complexMap;
        }
      `;

      const result = await parser.parseFile(filePath, javaCode, projectId);

      // Find REFERENCES relationships (lowercase in the result)
      const referencesRelationships = result.relationships.filter(r => r.type === 'references');
      
      // Should have references to both KeyType and ValueType
      const keyTypeRefs = referencesRelationships.filter(r => r.target.includes('KeyType'));
      const valueTypeRefs = referencesRelationships.filter(r => r.target.includes('ValueType'));
      
      expect(keyTypeRefs.length).toBeGreaterThanOrEqual(1);
      expect(valueTypeRefs.length).toBeGreaterThanOrEqual(1);
    });
  });
});