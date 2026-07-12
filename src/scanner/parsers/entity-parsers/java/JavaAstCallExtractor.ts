import { ParsedRelationship } from '../../../types.js';
import { RelationshipBuilder } from '../../base/RelationshipBuilder.js';

// The java-parser CST is dynamically shaped; we treat nodes as `any` and use
// small helpers to navigate them safely.
type CstNode = any;

type ParseFn = (code: string) => CstNode;

/**
 * Resolves a simple (or already-qualified) type name to a fully-qualified name,
 * or returns null when it cannot be resolved safely.
 */
export type TypeResolver = (name: string) => string | null;

/**
 * Looks up the declared return type (fully-qualified) of a method identified by
 * its fully-qualified name (`${classQN}.${methodName}`), or returns null when it
 * is unknown. This is the seam that lets chained-call resolution reach return
 * types declared in other cartridges/files (Defect 4d).
 */
export type ReturnTypeLookup = (methodQN: string) => string | null;

interface ChainItem {
  name: string;
  call: boolean;
  classLiteral: boolean;
  args?: CstNode; // methodInvocationSuffix node, when call === true
}

interface ClassScope {
  classQN: string;
  fields: Map<string, string>;      // fieldName -> resolvedType
  methodNames: Set<string>;         // simple method names declared on this class
}

/**
 * AST-based extractor for CALLS edges on Java methods.
 *
 * Unlike the regex fallback, this walks the real Concrete Syntax Tree produced by
 * `java-parser`, which lets it reconstruct full method-invocation chains
 * (`a().b().c()`), resolve static calls (`Type.method(...)`), and follow
 * `.class`-mediated idioms such as `NamingMgr.get(TaxMgr.class).lookupTaxRates(...)`.
 *
 * Cross-file return types are resolved through a project-wide return-type index
 * (`globalReturnTypes`) that is populated in a scan pre-pass and while parsing
 * every file. For a chained call `a().b()` whose intermediate method `a()` is
 * declared in a different cartridge, the receiver type of `b()` is taken from
 * that method's declared return type recorded in the index (Defect 4d). When the
 * return type genuinely cannot be determined (e.g. a compiled dependency that was
 * never scanned), the tail call is dropped rather than guessed — the extractor
 * never synthesizes a receiver type from the invoked method's (getter) name.
 */
export class JavaAstCallExtractor {
  // ICM/JEE idioms where the concrete return type is passed as a `.class` literal
  // argument, e.g. NamingMgr.get(TaxMgr.class) -> TaxMgr,
  // bo.getExtension(FooExtension.class) -> FooExtension.
  private static readonly CLASS_LITERAL_FACTORY_METHODS = new Set([
    'get', 'getExtension', 'getInstance', 'getService', 'lookup', 'adaptTo', 'create'
  ]);

  // `java-parser` is a pure-ESM package. We load it lazily via a runtime dynamic
  // import that is hidden inside `new Function` so the TypeScript/Jest transform
  // does not rewrite it into a `require` (which cannot load ESM) nor promote the
  // importing module (and its transitive importers) to ESM. This works in the
  // real Node/ESM runtime.
  //
  // Under Jest the sandboxed VM does not provide a dynamic-import callback, so the
  // native import fails there; tests inject the parser explicitly via setParseFn.
  private static readonly dynamicImport: (specifier: string) => Promise<any> =
    new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<any>;

  private static injectedParseFn: ParseFn | null = null;

  /** Test seam: inject a concrete `parse` implementation (e.g. from java-parser). */
  static setParseFn(fn: ParseFn | null): void {
    JavaAstCallExtractor.injectedParseFn = fn;
  }

  private parseFnPromise: Promise<ParseFn | null> | null = null;

  private loadParser(): Promise<ParseFn | null> {
    if (JavaAstCallExtractor.injectedParseFn) {
      return Promise.resolve(JavaAstCallExtractor.injectedParseFn);
    }
    if (!this.parseFnPromise) {
      this.parseFnPromise = JavaAstCallExtractor.dynamicImport('java-parser')
        .then(mod => (mod && typeof mod.parse === 'function' ? mod.parse as ParseFn : null))
        .catch(() => null);
    }
    return this.parseFnPromise;
  }

  /**
   * Extracts CALLS edges for every method in the given file.
   *
   * @returns true when the file was parsed and processed via the AST, false when
   *          parsing failed and the caller should fall back to the regex extractor.
   */
  async extractFileCalls(
    content: string,
    filePath: string,
    packageName: string,
    resolveType: TypeResolver,
    addRelationship: (rel: Omit<ParsedRelationship, 'project_id'>) => void,
    globalReturnTypes?: Map<string, string>
  ): Promise<boolean> {
    const parse = await this.loadParser();
    if (!parse) return false;

    let cst: CstNode;
    try {
      cst = parse(content);
    } catch {
      // Broken/partial source - let the caller use the regex fallback.
      return false;
    }

    try {
      const pkg = this.extractPackageName(cst) || packageName;

      // Pass A: collect class scopes (fields + method names) and return types.
      const classScopes = new Map<string, ClassScope>();
      const returnTypeMap = new Map<string, string>(); // `${classQN}.${method}` -> type
      this.collectClassInfo(cst, pkg, [], resolveType, classScopes, returnTypeMap);

      // Share this file's declared return types with the project-wide index so
      // other files' chained calls can resolve receiver types across cartridges.
      if (globalReturnTypes) {
        for (const [k, v] of returnTypeMap) globalReturnTypes.set(k, v);
      }

      // Return-type lookup: prefer the current file's model, then fall back to
      // the project-wide index (methods declared in other cartridges/files).
      const lookupReturnType: ReturnTypeLookup = (methodQN: string) =>
        returnTypeMap.get(methodQN) ?? globalReturnTypes?.get(methodQN) ?? null;

      // Pass B: process each method body and emit CALLS edges.
      const emitted = new Set<string>();
      const emit = (source: string, target: string): void => {
        const key = `${source}=>${target}`;
        if (emitted.has(key)) return;
        emitted.add(key);
        addRelationship(RelationshipBuilder.createCalls(source, target, filePath));
      };

      this.processMethods(cst, pkg, [], resolveType, classScopes, lookupReturnType, emit);
      return true;
    } catch {
      // Any unexpected CST shape -> fall back to regex extraction.
      return false;
    }
  }

  /**
   * Signature-only pre-pass: parses the file and records every declared method's
   * fully-qualified return type into the shared project-wide index, without
   * emitting any edges. Running this over all Java files before CALLS extraction
   * makes cross-cartridge chained-call resolution independent of file order.
   *
   * @returns true when the file was parsed, false when parsing failed.
   */
  async collectReturnTypes(
    content: string,
    packageName: string,
    resolveType: TypeResolver,
    globalReturnTypes: Map<string, string>
  ): Promise<boolean> {
    const parse = await this.loadParser();
    if (!parse) return false;

    let cst: CstNode;
    try {
      cst = parse(content);
    } catch {
      return false;
    }

    try {
      const pkg = this.extractPackageName(cst) || packageName;
      const classScopes = new Map<string, ClassScope>();
      this.collectClassInfo(cst, pkg, [], resolveType, classScopes, globalReturnTypes);
      return true;
    } catch {
      return false;
    }
  }

  // ---- Pass A: class/method metadata -------------------------------------

  private collectClassInfo(
    node: CstNode,
    pkg: string,
    stack: string[],
    resolveType: TypeResolver,
    classScopes: Map<string, ClassScope>,
    returnTypeMap: Map<string, string>
  ): void {
    if (!node || !node.children) return;

    let nextStack = stack;
    const typeName = this.typeDeclName(node);
    if (typeName) {
      nextStack = [...stack, typeName];
      const classQN = [pkg, ...nextStack].join('.');
      const scope: ClassScope = {
        classQN,
        fields: this.collectFields(node, resolveType),
        methodNames: new Set<string>()
      };
      classScopes.set(classQN, scope);

      // Method names + return types for this class (direct members only).
      // Interface methods (bodyless signatures, e.g. `Domain getSite();`) are
      // included so their return types feed cross-cartridge chain resolution.
      const methodDecls = [
        ...this.findDirectDescendants(node, 'methodDeclaration'),
        ...this.findDirectDescendants(node, 'interfaceMethodDeclaration')
      ];
      for (const method of methodDecls) {
        const name = this.methodName(method);
        if (!name) continue;
        scope.methodNames.add(name);
        const rt = this.methodReturnType(method, resolveType);
        if (rt) returnTypeMap.set(`${classQN}.${name}`, rt);
      }
    }

    for (const key of Object.keys(node.children)) {
      for (const child of node.children[key]) {
        if (child && child.children) {
          this.collectClassInfo(child, pkg, nextStack, resolveType, classScopes, returnTypeMap);
        }
      }
    }
  }

  // ---- Pass B: process method bodies -------------------------------------

  private processMethods(
    node: CstNode,
    pkg: string,
    stack: string[],
    resolveType: TypeResolver,
    classScopes: Map<string, ClassScope>,
    lookupReturnType: ReturnTypeLookup,
    emit: (source: string, target: string) => void
  ): void {
    if (!node || !node.children) return;

    let nextStack = stack;
    const typeName = this.typeDeclName(node);
    if (typeName) {
      nextStack = [...stack, typeName];
      const classQN = [pkg, ...nextStack].join('.');
      const scope = classScopes.get(classQN);

      if (scope) {
        for (const method of this.directMethods(node)) {
          this.processMethod(method, scope, resolveType, lookupReturnType, emit);
        }
      }
    }

    for (const key of Object.keys(node.children)) {
      for (const child of node.children[key]) {
        if (child && child.children) {
          this.processMethods(child, pkg, nextStack, resolveType, classScopes, lookupReturnType, emit);
        }
      }
    }
  }

  private processMethod(
    method: CstNode,
    scope: ClassScope,
    resolveType: TypeResolver,
    lookupReturnType: ReturnTypeLookup,
    emit: (source: string, target: string) => void
  ): void {
    const name = this.methodName(method) || this.constructorName(method);
    if (!name) return;
    const methodId = `${scope.classQN}.${name}`;

    // Local scope: class fields, then method params + local vars (override).
    const vars = new Map<string, string>(scope.fields);
    this.collectParams(method, resolveType).forEach((v, k) => vars.set(k, v));
    this.collectLocalVars(method, resolveType).forEach((v, k) => vars.set(k, v));

    const body = this.child(method, 'methodBody') || this.child(method, 'constructorBody');
    if (!body) return;

    for (const primary of this.findDescendants(body, 'primary')) {
      this.resolveChain(primary, methodId, scope, vars, resolveType, lookupReturnType, emit);
    }
  }

  // ---- Chain reconstruction & resolution ---------------------------------

  private resolveChain(
    primary: CstNode,
    methodId: string,
    scope: ClassScope,
    vars: Map<string, string>,
    resolveType: TypeResolver,
    lookupReturnType: ReturnTypeLookup,
    emit: (source: string, target: string) => void
  ): void {
    const items = this.buildChainItems(primary);
    const firstCallIdx = items.findIndex(it => it.call);
    if (firstCallIdx === -1) return; // no invocation in this primary

    const recvIds = items.slice(0, firstCallIdx).map(i => i.name);
    const isInternal = recvIds.length === 0;
    let currentType: string | null = this.resolveReceiverRoot(recvIds, scope, vars, resolveType);

    for (let i = firstCallIdx; i < items.length; i++) {
      const it = items[i];
      if (!it.call) {
        // Field/member access: return type unknown across files.
        currentType = null;
        continue;
      }

      if (i === firstCallIdx && isInternal) {
        // Receiver-less call: this.method() / method().
        if (scope.methodNames.has(it.name)) {
          emit(methodId, `${scope.classQN}.${it.name}`);
        }
        // Receiver type of the next call is the invoked method's declared return
        // type. It is looked up in the project-wide index, so a method declared
        // in another cartridge still resolves the tail call (Defect 4d). When it
        // is genuinely unknown, leave it unresolved and drop the tail call rather
        // than guessing a type name.
        currentType = lookupReturnType(`${scope.classQN}.${it.name}`);
        continue;
      }

      if (currentType) {
        emit(methodId, `${currentType}.${it.name}`);
      }
      currentType = this.nextTypeAfterCall(currentType, it, lookupReturnType, resolveType);
    }
  }

  /**
   * Linearizes a `primary` node into an ordered list of identifiers, marking the
   * ones that are invoked (methodInvocationSuffix) or used as a `.class` literal.
   */
  private buildChainItems(primary: CstNode): ChainItem[] {
    const items: ChainItem[] = [];

    const prefix = this.child(primary, 'primaryPrefix');
    if (prefix) {
      const fqn = this.child(prefix, 'fqnOrRefType');
      if (fqn) {
        for (const id of this.fqnIdentifiers(fqn)) {
          items.push({ name: id, call: false, classLiteral: false });
        }
      }
    }

    for (const suffix of this.orderedChildren(primary, 'primarySuffix')) {
      const invocation = this.child(suffix, 'methodInvocationSuffix');
      if (invocation) {
        if (items.length > 0) {
          items[items.length - 1].call = true;
          items[items.length - 1].args = invocation;
        }
        continue;
      }
      if (this.child(suffix, 'classLiteralSuffix')) {
        if (items.length > 0) items[items.length - 1].classLiteral = true;
        continue;
      }
      // Dot Identifier member navigation.
      const id = this.firstIdentifier(suffix);
      if (id) items.push({ name: id, call: false, classLiteral: false });
    }

    return items;
  }

  private resolveReceiverRoot(
    recvIds: string[],
    scope: ClassScope,
    vars: Map<string, string>,
    resolveType: TypeResolver
  ): string | null {
    if (recvIds.length === 0) return scope.classQN; // implicit this
    if (recvIds.length === 1) {
      const v = recvIds[0];
      if (vars.has(v)) return vars.get(v)!;
      if (/^[A-Z]/.test(v)) return resolveType(v); // static call on a type name
      return null;
    }
    // Multiple segments: either a field chain (unresolvable) or a qualified type.
    if (vars.has(recvIds[0])) return null;
    return resolveType(recvIds.join('.'));
  }

  private nextTypeAfterCall(
    currentType: string | null,
    it: ChainItem,
    lookupReturnType: ReturnTypeLookup,
    resolveType: TypeResolver
  ): string | null {
    // `.class`-mediated factory idiom: get(Foo.class) -> Foo.
    if (it.args && JavaAstCallExtractor.CLASS_LITERAL_FACTORY_METHODS.has(it.name)) {
      const literalType = this.findClassLiteralArg(it.args);
      if (literalType) {
        return resolveType(literalType);
      }
    }
    if (currentType) {
      // The receiver type of the next call in the chain is the declared return
      // type of the invoked method. It is looked up in the project-wide index,
      // so methods declared in another cartridge (or as a bodyless interface
      // signature) still resolve the tail call (Defect 4d).
      const declared = lookupReturnType(`${currentType}.${it.name}`);
      if (declared) return declared;
      // Genuinely unknown (e.g. an unscanned compiled dependency): do NOT
      // synthesize a type from the method/getter name. Leave it unresolved so
      // the tail call is dropped rather than emitted with a wrong receiver type.
      return null;
    }
    return null;
  }

  /** Finds the first `Type.class` argument and returns its simple type name. */
  private findClassLiteralArg(invocation: CstNode): string | null {
    for (const primary of this.findDescendants(invocation, 'primary')) {
      const hasClassLiteral = this.orderedChildren(primary, 'primarySuffix')
        .some(s => this.child(s, 'classLiteralSuffix'));
      if (hasClassLiteral) {
        const prefix = this.child(primary, 'primaryPrefix');
        const fqn = prefix && this.child(prefix, 'fqnOrRefType');
        if (fqn) {
          const ids = this.fqnIdentifiers(fqn);
          if (ids.length > 0) return ids[ids.length - 1];
        }
      }
    }
    return null;
  }

  // ---- Symbol collection -------------------------------------------------

  private collectFields(classNode: CstNode, resolveType: TypeResolver): Map<string, string> {
    const map = new Map<string, string>();
    for (const field of this.findDirectDescendants(classNode, 'fieldDeclaration')) {
      const type = this.simpleTypeName(this.child(field, 'unannType'));
      if (!type) continue;
      const resolved = resolveType(type);
      if (!resolved) continue;
      for (const id of this.variableDeclaratorIds(field)) {
        map.set(id, resolved);
      }
    }
    return map;
  }

  private collectParams(method: CstNode, resolveType: TypeResolver): Map<string, string> {
    const map = new Map<string, string>();
    for (const param of this.findDescendants(method, 'formalParameter')) {
      // In the CST a formalParameter wraps a variableParaRegularParameter that in
      // turn holds unannType + variableDeclaratorId, so unannType is not a direct
      // child - resolve it via a scoped search.
      const type = this.simpleTypeName(this.findFirst(param, 'unannType'));
      const id = this.firstVariableDeclaratorId(param);
      if (!type || !id) continue;
      const resolved = resolveType(type);
      if (resolved) map.set(id, resolved);
    }
    return map;
  }

  private collectLocalVars(method: CstNode, resolveType: TypeResolver): Map<string, string> {
    const map = new Map<string, string>();
    for (const decl of this.findDescendants(method, 'localVariableDeclaration')) {
      const type = this.simpleTypeName(this.child(decl, 'localVariableType'));
      if (!type) continue;
      const resolved = resolveType(type);
      if (!resolved) continue;
      for (const id of this.variableDeclaratorIds(decl)) {
        map.set(id, resolved);
      }
    }
    return map;
  }

  // ---- CST navigation helpers --------------------------------------------

  private child(node: CstNode, name: string): CstNode | undefined {
    return node?.children?.[name]?.[0];
  }

  private orderedChildren(node: CstNode, name: string): CstNode[] {
    const arr = node?.children?.[name];
    if (!arr) return [];
    return [...arr].sort((a, b) => this.startOffset(a) - this.startOffset(b));
  }

  private startOffset(node: CstNode): number {
    return node?.location?.startOffset ?? node?.startOffset ?? 0;
  }

  private extractPackageName(cst: CstNode): string | null {
    const pkgDecl = this.findFirst(cst, 'packageDeclaration');
    if (!pkgDecl) return null;
    const ids = this.tokenImages(pkgDecl, 'Identifier');
    return ids.length ? ids.join('.') : null;
  }

  private typeDeclName(node: CstNode): string | null {
    if (!node?.name) return null;
    if (node.name === 'normalClassDeclaration' ||
        node.name === 'normalInterfaceDeclaration' ||
        node.name === 'enumDeclaration' ||
        node.name === 'recordDeclaration') {
      // typeIdentifier is a direct child (the type name), before any extends/implements.
      const ti = this.child(node, 'typeIdentifier') || this.findFirst(node, 'typeIdentifier');
      return ti ? this.firstIdentifier(ti) : null;
    }
    return null;
  }

  private methodName(method: CstNode): string | null {
    if (method?.name !== 'methodDeclaration' && method?.name !== 'interfaceMethodDeclaration') return null;
    const declarator = this.findFirst(method, 'methodDeclarator');
    return declarator ? this.firstIdentifier(declarator) : null;
  }

  private constructorName(method: CstNode): string | null {
    if (method?.name !== 'constructorDeclaration') return null;
    const declarator = this.findFirst(method, 'constructorDeclarator');
    const ti = declarator && this.findFirst(declarator, 'typeIdentifier');
    return ti ? this.firstIdentifier(ti) : null;
  }

  private methodReturnType(method: CstNode, resolveType: TypeResolver): string | null {
    const header = this.child(method, 'methodHeader');
    const result = header && this.child(header, 'result');
    if (!result) return null;
    const type = this.simpleTypeName(result);
    return type ? resolveType(type) : null;
  }

  /** Direct method/constructor declarations of a type body (not nested types). */
  private directMethods(classNode: CstNode): CstNode[] {
    return [
      ...this.findDirectDescendants(classNode, 'methodDeclaration'),
      ...this.findDirectDescendants(classNode, 'interfaceMethodDeclaration'),
      ...this.findDirectDescendants(classNode, 'constructorDeclaration')
    ];
  }

  private fqnIdentifiers(fqn: CstNode): string[] {
    const ids: string[] = [];
    const commons = this.findDescendants(fqn, 'fqnOrRefTypePartCommon');
    commons.sort((a, b) => this.startOffset(a) - this.startOffset(b));
    for (const common of commons) {
      const id = this.firstIdentifier(common);
      if (id) ids.push(id);
    }
    return ids;
  }

  private variableDeclaratorIds(node: CstNode): string[] {
    return this.findDescendants(node, 'variableDeclaratorId')
      .map(v => this.firstIdentifier(v))
      .filter((s): s is string => !!s);
  }

  private firstVariableDeclaratorId(node: CstNode): string | null {
    const v = this.findFirst(node, 'variableDeclaratorId');
    return v ? this.firstIdentifier(v) : null;
  }

  /** Simple (outermost) type name of an unann/result type node, or null for primitives/void. */
  private simpleTypeName(typeNode: CstNode | undefined): string | null {
    if (!typeNode) return null;
    // `typeIdentifier` is used in some type positions; unann* types instead expose
    // the type name as a plain Identifier token. Prefer typeIdentifier, then fall
    // back to the first Identifier in the (type-only) node. Returns null for
    // primitive/void types, which carry no Identifier.
    const ti = this.findFirst(typeNode, 'typeIdentifier');
    if (ti) {
      const name = this.firstIdentifier(ti);
      if (name) return name;
    }
    return this.firstIdentifier(typeNode);
  }

  private firstIdentifier(node: CstNode): string | null {
    const imgs = this.tokenImages(node, 'Identifier');
    return imgs.length ? imgs[0] : null;
  }

  /** DFS: collect all token images of a given tokenType name, in offset order. */
  private tokenImages(node: CstNode, tokenName: string): string[] {
    const out: { image: string; offset: number }[] = [];
    const walk = (n: CstNode): void => {
      if (!n) return;
      if (n.image !== undefined) {
        if (n.tokenType?.name === tokenName) out.push({ image: n.image, offset: n.startOffset ?? 0 });
        return;
      }
      if (n.children) {
        for (const key of Object.keys(n.children)) {
          for (const c of n.children[key]) walk(c);
        }
      }
    };
    walk(node);
    out.sort((a, b) => a.offset - b.offset);
    return out.map(o => o.image);
  }

  private findFirst(node: CstNode, name: string): CstNode | null {
    if (!node?.children) return null;
    if (node.name === name) return node;
    for (const key of Object.keys(node.children)) {
      for (const c of node.children[key]) {
        if (c?.children || c?.name) {
          const found = this.findFirst(c, name);
          if (found) return found;
        }
      }
    }
    return null;
  }

  private findDescendants(node: CstNode, name: string): CstNode[] {
    const acc: CstNode[] = [];
    const walk = (n: CstNode): void => {
      if (!n?.children) return;
      if (n.name === name) acc.push(n);
      for (const key of Object.keys(n.children)) {
        for (const c of n.children[key]) {
          if (c?.children) walk(c);
        }
      }
    };
    walk(node);
    return acc;
  }

  /**
   * Like findDescendants, but does not descend into nested type declarations, so
   * members of nested/local classes are not attributed to the enclosing class.
   */
  private findDirectDescendants(node: CstNode, name: string): CstNode[] {
    const prune = new Set([
      'normalClassDeclaration', 'normalInterfaceDeclaration',
      'enumDeclaration', 'recordDeclaration'
    ]);
    const acc: CstNode[] = [];
    const walk = (n: CstNode, isRoot: boolean): void => {
      if (!n?.children) return;
      if (!isRoot && prune.has(n.name)) return; // stop at nested type declarations
      if (n.name === name) acc.push(n);
      for (const key of Object.keys(n.children)) {
        for (const c of n.children[key]) {
          if (c?.children) walk(c, false);
        }
      }
    };
    walk(node, true);
    return acc;
  }
}