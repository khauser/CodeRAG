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
    name: 'chained getter with cross-file return type: head emitted, tail dropped (no guessed type)',
    methodSuffix: '.Svc.run',
    source: `package com.acme;
public class Svc {
  public void run(ApplicationBO application) {
    String d = application.getSite().getDomainName();
  }
}`,
    // getSite()'s receiver is the typed param, so the head call is emitted.
    expectPresentEndsWith: ['.ApplicationBO.getSite'],
    // getSite()'s return type is declared in another file (unavailable here), so
    // the tail call must NOT be emitted with a type invented from the getter name
    // (e.g. `com.acme.Site.getDomainName`).
    expectAbsentEndsWith: ['.Site.getDomainName', '.getDomainName'],
  },
  {
    name: 'static getter chain: head emitted, tail dropped (no lexical CurrentAppContext type)',
    methodSuffix: '.Svc.run',
    source: `package com.acme;
import com.acme.app.AppContextUtil;
public class Svc {
  public void run() {
    Object v = AppContextUtil.getCurrentAppContext().getVariable("CURRENT");
  }
}`,
    expectPresentEndsWith: ['.AppContextUtil.getCurrentAppContext'],
    // getCurrentAppContext()'s return type is cross-file, so getVariable must not
    // be emitted against a type synthesized from the getter name.
    expectAbsentEndsWith: ['.CurrentAppContext.getVariable', '.getVariable'],
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
  const parser = new JavaParser();
  let failures = 0;

  for (const c of cases) {
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
