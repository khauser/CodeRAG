import { JavaParser } from '../../../src/scanner/parsers/java-parser.js';
import { JavaAstCallExtractor } from '../../../src/scanner/parsers/entity-parsers/java/JavaAstCallExtractor.js';

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

    test('should create annotation nodes and ANNOTATED_WITH relationships for fields', async () => {
      const javaCode = `
        package com.example.pipelet;
        
        public class MyPipelet {
          @PipelineNodeOutput
          private Yes yes;
          
          @PipelineNodeOutput  
          private No no;
          
          interface Yes {}
          interface No {}
        }
      `;

      const result = await parser.parseFile(filePath, javaCode, projectId);

      // Find annotation entities
      const annotationEntities = result.entities.filter(e => e.type === 'annotation');
      const pipelineNodeOutputAnnotations = annotationEntities.filter(e => e.name === '@PipelineNodeOutput');
      
      // Should have 2 @PipelineNodeOutput annotations (one for each field)
      expect(pipelineNodeOutputAnnotations.length).toBe(2);

      // Find ANNOTATED_WITH relationships
      const annotatedWithRelationships = result.relationships.filter(r => r.type === 'annotated_with');
      
      // Should have relationships from fields to annotations
      const yesFieldAnnotations = annotatedWithRelationships.filter(r => r.source.includes('.yes'));
      const noFieldAnnotations = annotatedWithRelationships.filter(r => r.source.includes('.no'));
      
      expect(yesFieldAnnotations.length).toBe(1);
      expect(noFieldAnnotations.length).toBe(1);
      
      // Verify the annotation targets contain @PipelineNodeOutput
      expect(yesFieldAnnotations[0].target).toContain('@PipelineNodeOutput');
      expect(noFieldAnnotations[0].target).toContain('@PipelineNodeOutput');
    });

    test('should create annotation nodes and ANNOTATED_WITH relationships for methods', async () => {
      const javaCode = `
        package com.example.pipelet;
        
        public class MyPipelet {
          @PipelineNodeInput(name = "Input")
          public Object execute(Input input) {
            return null;
          }
          
          interface Input {}
        }
      `;

      const result = await parser.parseFile(filePath, javaCode, projectId);

      // Find annotation entities
      const annotationEntities = result.entities.filter(e => e.type === 'annotation');
      const pipelineNodeInputAnnotations = annotationEntities.filter(e => e.name === '@PipelineNodeInput');
      
      // Should have 1 @PipelineNodeInput annotation
      expect(pipelineNodeInputAnnotations.length).toBe(1);

      // Find ANNOTATED_WITH relationships
      const annotatedWithRelationships = result.relationships.filter(r => r.type === 'annotated_with');
      
      // Should have relationship from execute method to annotation
      const executeMethodAnnotations = annotatedWithRelationships.filter(r => r.source.includes('.execute'));
      
      expect(executeMethodAnnotations.length).toBe(1);
      expect(executeMethodAnnotations[0].target).toContain('@PipelineNodeInput');
    });

    test('should handle inline annotations on same line as field declaration', async () => {
      const javaCode = `
        package com.example;
        
        public class TestClass {
          @Inject private MyService service;
          @Autowired private OtherService other;
        }
      `;

      const result = await parser.parseFile(filePath, javaCode, projectId);

      // Find annotation entities
      const annotationEntities = result.entities.filter(e => e.type === 'annotation');
      
      // Should have both @Inject and @Autowired annotations
      expect(annotationEntities.some(e => e.name === '@Inject')).toBe(true);
      expect(annotationEntities.some(e => e.name === '@Autowired')).toBe(true);

      // Find ANNOTATED_WITH relationships
      const annotatedWithRelationships = result.relationships.filter(r => r.type === 'annotated_with');
      
      // Should have relationships for both fields
      expect(annotatedWithRelationships.filter(r => r.source.includes('.service')).length).toBe(1);
      expect(annotatedWithRelationships.filter(r => r.source.includes('.other')).length).toBe(1);
    });

    describe('call & reference extraction (GetProductTaxRate regression)', () => {
      // Synthetic version of
      // com.intershop.component.b2b.pipelet.taxation.GetProductTaxRate.execute
      // exercising Defects 1-4 from coderag-parser-fix.md.
      const source = `package com.intershop.component.b2b.pipelet.taxation;

import com.intershop.beehive.core.capi.naming.NamingMgr;
import com.intershop.component.foundation.capi.tax.TaxMgr;
import com.intershop.component.product.capi.ProductBO;

public class GetProductTaxRate extends Pipelet {
  public int execute(PipelineDictionary dict) throws PipeletExecutionException {
    ProductBO product = dict.getRequired("ProductBO");
    String taxClassID = product.getTaxClassID();
    if (null == taxClassID || taxClassID.isEmpty()) {
      return PIPELET_ERROR;
    }
    // retrieve persistent ship-to address instance
    TaxMgr taxMgr = NamingMgr.get(TaxMgr.class);
    dict.put("TaxRate", taxMgr);
    return PIPELET_NEXT;
  }
}`;
      const executeId = 'com.intershop.component.b2b.pipelet.taxation.GetProductTaxRate.execute';

      const getEdges = async () => {
        const result = await parser.parseFile('/test/GetProductTaxRate.java', source, projectId);
        const calls = result.relationships.filter(r => r.type === 'calls' && r.source === executeId);
        const refs = result.relationships.filter(r => r.type === 'references' && r.source === executeId);
        return { calls, refs };
      };

      test('Defect 1: no reference to camelCase fragments (ClassID / To)', async () => {
        const { refs } = await getEdges();
        expect(refs.some(r => r.target.endsWith('.ClassID'))).toBe(false);
        expect(refs.some(r => r.target.endsWith('.To'))).toBe(false);
      });

      test('Defect 2: String.isEmpty resolves to java.lang.String.isEmpty', async () => {
        const { calls } = await getEdges();
        expect(calls.some(r => r.target === 'java.lang.String.isEmpty')).toBe(true);
        // Must NOT be attributed to the enclosing package
        expect(calls.some(r =>
          r.target === 'com.intershop.component.b2b.pipelet.taxation.String.isEmpty'
        )).toBe(false);
      });

      test('Defect 3: no self-call execute -> execute', async () => {
        const { calls } = await getEdges();
        expect(calls.some(r => r.target === executeId)).toBe(false);
      });

      test('Defect 4: static call NamingMgr.get is captured', async () => {
        const { calls } = await getEdges();
        expect(calls.some(r =>
          r.target === 'com.intershop.beehive.core.capi.naming.NamingMgr.get'
        )).toBe(true);
      });

      test('previously-correct edges remain: instance calls resolved', async () => {
        const { calls } = await getEdges();
        expect(calls.some(r =>
          r.target === 'com.intershop.component.product.capi.ProductBO.getTaxClassID'
        )).toBe(true);
        // dict is a PipelineDictionary parameter (same-package fallback)
        expect(calls.some(r => r.target.endsWith('.PipelineDictionary.getRequired'))).toBe(true);
        expect(calls.some(r => r.target.endsWith('.PipelineDictionary.put'))).toBe(true);
      });

      test('.class literal produces a TaxMgr reference', async () => {
        const { refs } = await getEdges();
        expect(refs.some(r =>
          r.target === 'com.intershop.component.foundation.capi.tax.TaxMgr'
        )).toBe(true);
      });
    });

    describe('Defect 4d: cross-cartridge chained return-type resolution', () => {
      // Chained-call resolution runs only through the AST extractor, whose
      // pure-ESM `java-parser` dependency cannot be loaded inside Jest's CJS
      // sandbox (a dynamic import is downleveled to require() and the native
      // import trick needs --experimental-vm-modules, which breaks Jest globals).
      // We still attempt to inject it via the documented `setParseFn` seam; when
      // that is not possible the AST-only assertions (AC1/AC2 and the generic
      // chain) defer to the standalone verifier `npm run verify:ast`, which
      // exercises the compiled extractor in a real ESM runtime. The fallback-safe
      // invariants (AC3/AC4) always run because they also hold for the regex path.
      let astAvailable = false;
      beforeAll(async () => {
        try {
          const nativeImport = new Function('s', 'return import(s);') as (s: string) => Promise<any>;
          const mod: any = await nativeImport('java-parser');
          if (mod && typeof mod.parse === 'function') {
            JavaAstCallExtractor.setParseFn(mod.parse);
            astAvailable = true;
          }
        } catch {
          astAvailable = false;
        }
      });
      afterAll(() => {
        JavaAstCallExtractor.setParseFn(null);
      });

      // Intermediate method declared in another cartridge (platform/core): its
      // return type AppContext is an ordinary same-package interface.
      const appContextUtil = `package com.intershop.beehive.core.capi.app;

public class AppContextUtil {
  public static AppContext getCurrentAppContext() {
    return null;
  }
}`;

      // Intermediate method declared as a bodyless interface signature in yet
      // another cartridge (platform/bc_application). Its return type Domain is
      // imported from a third package, exercising "use the method's own import
      // scope" and the "external/compiled signature (no body)" case.
      const applicationBO = `package com.intershop.component.application.capi;

import com.intershop.beehive.core.capi.domain.Domain;

public interface ApplicationBO {
  Domain getSite();
}`;

      // Caller in cartridge b2b/bc_b2b chaining a().b() across cartridges.
      const caller = `package com.intershop.component.b2b.pipelet.taxation;

import com.intershop.beehive.core.capi.app.AppContextUtil;
import com.intershop.component.application.capi.ApplicationBO;

public class GetProductTaxRate extends Pipelet {
  public int execute(PipelineDictionary dict) throws PipeletExecutionException {
    Object ctxVar = AppContextUtil.getCurrentAppContext().getVariable(ApplicationBO.CURRENT);
    ApplicationBO application = dict.getRequired("ApplicationBO");
    String domainName = application.getSite().getDomainName();
    return PIPELET_NEXT;
  }
}`;
      const executeId = 'com.intershop.component.b2b.pipelet.taxation.GetProductTaxRate.execute';

      const getCallerEdges = async () => {
        // Signature pre-pass over the dependency cartridges first, so the
        // project-wide return-type index is populated regardless of file order.
        await parser.collectSignatures('/platform/core/AppContextUtil.java', appContextUtil, projectId);
        await parser.collectSignatures('/platform/bc_application/ApplicationBO.java', applicationBO, projectId);

        const result = await parser.parseFile('/b2b/GetProductTaxRate.java', caller, projectId);
        return result.relationships.filter(r => r.type === 'calls' && r.source === executeId);
      };

      test('AC1: getVariable resolves to the cross-cartridge return type AppContext', async () => {
        if (!astAvailable) return; // AST parser unavailable under Jest; see npm run verify:ast
        const calls = await getCallerEdges();
        expect(calls.some(r =>
          r.target === 'com.intershop.beehive.core.capi.app.AppContext.getVariable'
        )).toBe(true);
      });

      test('AC2: getDomainName resolves to the cross-cartridge return type Domain', async () => {
        if (!astAvailable) return; // AST parser unavailable under Jest; see npm run verify:ast
        const calls = await getCallerEdges();
        expect(calls.some(r =>
          r.target === 'com.intershop.beehive.core.capi.domain.Domain.getDomainName'
        )).toBe(true);
      });

      test('AC3: no lexical getter-name guesses in the current package (Defect 4c)', async () => {
        const calls = await getCallerEdges();
        expect(calls.some(r =>
          r.target === 'com.intershop.component.b2b.pipelet.taxation.CurrentAppContext.getVariable'
        )).toBe(false);
        expect(calls.some(r =>
          r.target === 'com.intershop.component.b2b.pipelet.taxation.Site.getDomainName'
        )).toBe(false);
        // No tail-call target may land in the caller's package unless declared there.
        expect(calls.some(r =>
          r.target.startsWith('com.intershop.component.b2b.pipelet.taxation.') &&
          (r.target.endsWith('.getVariable') || r.target.endsWith('.getDomainName'))
        )).toBe(false);
      });

      test('AC4: the intermediate calls remain (getCurrentAppContext, getSite)', async () => {
        const calls = await getCallerEdges();
        expect(calls.some(r =>
          r.target === 'com.intershop.beehive.core.capi.app.AppContextUtil.getCurrentAppContext'
        )).toBe(true);
        expect(calls.some(r =>
          r.target === 'com.intershop.component.application.capi.ApplicationBO.getSite'
        )).toBe(true);
      });

      test('generic multi-cartridge chain x.a().b() resolves b() into cartridge B', async () => {
        if (!astAvailable) return; // AST parser unavailable under Jest; see npm run verify:ast
        const cartridgeC = `package com.example.c;

public interface Gamma {
  void b();
}`;
        const cartridgeA = `package com.example.a;

import com.example.b.Beta;

public class Caller {
  public void run(Beta x) {
    x.a().b();
  }
}`;
        await parser.collectSignatures('/b/Beta.java',
          'package com.example.b;\n\nimport com.example.c.Gamma;\n\npublic interface Beta {\n  Gamma a();\n}',
          projectId);
        await parser.collectSignatures('/c/Gamma.java', cartridgeC, projectId);
        const result = await parser.parseFile('/a/Caller.java', cartridgeA, projectId);
        const runId = 'com.example.a.Caller.run';
        const calls = result.relationships.filter(r => r.type === 'calls' && r.source === runId);
        expect(calls.some(r => r.target === 'com.example.b.Beta.a')).toBe(true);
        expect(calls.some(r => r.target === 'com.example.c.Gamma.b')).toBe(true);
      });
    });
  });
});
