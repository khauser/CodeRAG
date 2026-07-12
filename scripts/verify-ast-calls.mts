/*
 * Standalone verification for the AST-based Java CALLS extraction.
 *
 * The `java-parser` dependency is pure ESM and cannot be loaded under the
 * project's (CJS) Jest runtime, so these cases - which require the real AST
 * (method chaining, static calls, `.class` factory idioms, forward-referenced
 * internal calls) - are verified here against real Node/ESM instead.
 *
 * Run with:  npm run verify:ast
 * Exits non-zero if any expectation fails.
 */
import { JavaParser } from '../src/scanner/parsers/java-parser.js';

interface Case {
  name: string;
  source: string;
  methodSuffix: string;
  /**
   * Additional files whose method signatures are collected into the project-wide
   * return-type index BEFORE the main source is parsed. This mirrors the scanner's
   * signature pre-pass and enables cross-cartridge chained-call resolution
   * (Defect 4d): a().b() where a()'s return type is declared in another file.
   */
  signatureFiles?: { path: string; source: string }[];
  expectPresent?: string[];      // exact targets that must be present
  expectPresentEndsWith?: string[]; // targets that must be present (suffix match)
  expectAbsentEndsWith?: string[];  // targets that must NOT be present (suffix match)
}

const cases: Case[] = [
  {
    name: '.class factory idiom resolves the chained call target',
    methodSuffix: '.Svc.run',
    source: `package com.acme;
import com.acme.naming.NamingMgr;
import com.acme.tax.TaxMgr;
public class Svc {
  public void run() {
    TaxMgr mgr = NamingMgr.get(TaxMgr.class);
    Object rates = NamingMgr.get(TaxMgr.class).lookupTaxRates(1, 2);
  }
}`,
    expectPresent: [
      'com.acme.naming.NamingMgr.get',
      'com.acme.tax.TaxMgr.lookupTaxRates',
    ],
  },
  {
    name: 'getExtension(X.class).method() resolves through the .class literal',
    methodSuffix: '.Svc.run',
    source: `package com.acme;
import com.acme.ext.PersistentObjectBOExtension;
public class Svc {
  public void run(AddressBO shipTo) {
    Object po = shipTo.getExtension(PersistentObjectBOExtension.class).getPersistentObject();
  }
}`,
    expectPresent: ['com.acme.ext.PersistentObjectBOExtension.getPersistentObject'],
  },
  {
    name: 'unqualified java.util type resolves to its real package',
    methodSuffix: '.Svc.run',
    source: `package com.acme;
import java.util.List;
public class Svc {
  public void run(List items) {
    items.add("x");
  }
}`,
    expectPresent: ['java.util.List.add'],
  },
  {
    name: 'internal forward-referenced call resolves to the containing class',
    methodSuffix: '.Svc.run',
    source: `package com.acme;
public class Svc {
  public void run() {
    helper();
  }
  private void helper() {}
}`,
    expectPresent: ['com.acme.Svc.helper'],
  },
  {
    name: 'chained getter with cross-file return type, NO signature pre-pass: head emitted, tail dropped (no guessed type)',
    methodSuffix: '.Svc.run',
    source: `package com.acme;
public class Svc {
  public void run(ApplicationBO application) {
    String d = application.getSite().getDomainName();
  }
}`,
    // getSite()'s receiver is the typed param, so the head call is emitted.
    expectPresentEndsWith: ['.ApplicationBO.getSite'],
    // getSite()'s return type is declared in another file that was NOT scanned for
    // signatures here, so the tail call must NOT be emitted with a type invented
    // from the getter name (e.g. `com.acme.Site.getDomainName`).
    expectAbsentEndsWith: ['.Site.getDomainName', '.getDomainName'],
  },
  {
    name: 'static getter chain, NO signature pre-pass: head emitted, tail dropped (no lexical CurrentAppContext type)',
    methodSuffix: '.Svc.run',
    source: `package com.acme;
import com.acme.app.AppContextUtil;
public class Svc {
  public void run() {
    Object v = AppContextUtil.getCurrentAppContext().getVariable("CURRENT");
  }
}`,
    expectPresentEndsWith: ['.AppContextUtil.getCurrentAppContext'],
    // getCurrentAppContext()'s return type is cross-file and unscanned, so
    // getVariable must not be emitted against a type synthesized from the getter.
    expectAbsentEndsWith: ['.CurrentAppContext.getVariable', '.getVariable'],
  },
  {
    // Defect 4d: with a signature pre-pass over the (other-cartridge) declaring
    // files, the intermediate method's declared return type is known, so the tail
    // call resolves to the real cross-cartridge type. Mirrors the reference
    // GetProductTaxRate.execute example.
    name: 'Defect 4d: cross-cartridge chained tail resolves via signature pre-pass',
    methodSuffix: '.GetProductTaxRate.execute',
    signatureFiles: [
      {
        path: '/platform/core/AppContextUtil.java',
        source: `package com.intershop.beehive.core.capi.app;
public class AppContextUtil {
  public static AppContext getCurrentAppContext() { return null; }
}`,
      },
      {
        // Bodyless interface signature in another cartridge; return type Domain is
        // imported from a third package (method's own import scope is used).
        path: '/platform/bc_application/ApplicationBO.java',
        source: `package com.intershop.component.application.capi;
import com.intershop.beehive.core.capi.domain.Domain;
public interface ApplicationBO {
  Domain getSite();
}`,
      },
    ],
    source: `package com.intershop.component.b2b.pipelet.taxation;
import com.intershop.beehive.core.capi.app.AppContextUtil;
import com.intershop.component.application.capi.ApplicationBO;
public class GetProductTaxRate extends Pipelet {
  public int execute(PipelineDictionary dict) throws PipeletExecutionException {
    Object ctxVar = AppContextUtil.getCurrentAppContext().getVariable(ApplicationBO.CURRENT);
    ApplicationBO application = dict.getRequired("ApplicationBO");
    String domainName = application.getSite().getDomainName();
    return PIPELET_NEXT;
  }
}`,
    expectPresent: [
      // AC1 + AC2: tail calls resolve to the real cross-cartridge return types.
      'com.intershop.beehive.core.capi.app.AppContext.getVariable',
      'com.intershop.beehive.core.capi.domain.Domain.getDomainName',
      // AC4: intermediate calls remain.
      'com.intershop.beehive.core.capi.app.AppContextUtil.getCurrentAppContext',
      'com.intershop.component.application.capi.ApplicationBO.getSite',
    ],
    // AC3: no lexical getter-name guesses placed in the caller's package.
    expectAbsentEndsWith: [
      'taxation.CurrentAppContext.getVariable',
      'taxation.Site.getDomainName',
    ],
  },
  {
    // Defect 4d generic form: x.a().b() where a()'s return type is an interface in
    // cartridge B (itself importing its return type from cartridge C).
    name: 'Defect 4d: generic multi-cartridge chain x.a().b() resolves b() into cartridge B',
    methodSuffix: '.Caller.run',
    signatureFiles: [
      {
        path: '/b/Beta.java',
        source: `package com.example.b;
import com.example.c.Gamma;
public interface Beta { Gamma a(); }`,
      },
      {
        path: '/c/Gamma.java',
        source: `package com.example.c;
public interface Gamma { void b(); }`,
      },
    ],
    source: `package com.example.a;
import com.example.b.Beta;
public class Caller {
  public void run(Beta x) {
    x.a().b();
  }
}`,
    expectPresent: ['com.example.b.Beta.a', 'com.example.c.Gamma.b'],
  },
  {
    name: 'internal getter with in-file return type imported from another package: tail uses declared type package',
    methodSuffix: '.Svc.run',
    source: `package com.acme;
import com.other.Thing;
public class Svc {
  Thing make() { return null; }
  public void run() {
    make().use();
  }
}`,
    // make()'s declared return type resolves via the import to com.other.Thing,
    // so the tail call target uses that package - never the current package.
    expectPresent: ['com.acme.Svc.make', 'com.other.Thing.use'],
    expectAbsentEndsWith: ['com.acme.Thing.use'],
  },
  {
    name: 'deep 4-level chain a().b().c().d() with in-file return types',
    methodSuffix: '.Svc.run',
    source: `package com.acme;
public class Svc {
  public void run(Root root) {
    root.a().b().c().d();
  }
}
class Root { A a() { return null; } }
class A { B b() { return null; } }
class B { C c() { return null; } }
class C { void d() {} }`,
    expectPresent: [
      'com.acme.Root.a',
      'com.acme.A.b',
      'com.acme.B.c',
      'com.acme.C.d',
    ],
  },
];

async function main(): Promise<void> {
  let failures = 0;

  for (const c of cases) {
    // Use a fresh parser per case so the project-wide return-type index only
    // contains the signatures explicitly declared for this case.
    const parser = new JavaParser();
    for (const sig of c.signatureFiles ?? []) {
      await parser.collectSignatures(sig.path, sig.source, 'verify');
    }
    const result = await parser.parseFile('/verify/Svc.java', c.source, 'verify');
    const targets = result.relationships
      .filter(r => r.type === 'calls' && r.source.endsWith(c.methodSuffix))
      .map(r => r.target);

    const problems: string[] = [];
    for (const t of c.expectPresent ?? []) {
      if (!targets.includes(t)) problems.push(`missing exact target: ${t}`);
    }
    for (const t of c.expectPresentEndsWith ?? []) {
      if (!targets.some(x => x.endsWith(t))) problems.push(`missing target ending with: ${t}`);
    }
    for (const t of c.expectAbsentEndsWith ?? []) {
      if (targets.some(x => x.endsWith(t))) problems.push(`unexpected target ending with: ${t}`);
    }

    if (problems.length === 0) {
      console.log(`  PASS  ${c.name}`);
    } else {
      failures++;
      console.error(`  FAIL  ${c.name}`);
      for (const p of problems) console.error(`          - ${p}`);
      console.error(`          actual targets: ${JSON.stringify(targets)}`);
    }
  }

  console.log(`\n${cases.length - failures}/${cases.length} AST call-extraction cases passed.`);
  if (failures > 0) process.exit(1);
}

main().catch(err => {
  console.error('verify:ast crashed:', err);
  process.exit(1);
});
