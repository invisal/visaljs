// Semantic analysis: scopes and bindings, strictness, and the
// early errors of the supported subset. Produces the facts lowering needs:
// which binding each identifier refers to, which bindings are captured by
// inner functions or reassigned, and which references need a TDZ check.
//
// Two passes. Pass A builds scopes and declares everything (hoisting).
// Pass B resolves references and checks control flow, in source order.
import type * as A from "../frontend/ast.ts";
import { boundNames } from "../frontend/ast.ts";
import { CompileError } from "../frontend/errors.ts";

/** "self": a named function expression's own name, visible only inside it (read-only).
 *  "this": a function's `this`, as a binding when an arrow function inside reads it.
 *  "arguments": a function's arguments object, when its code (or an arrow's) mentions it.
 *  "class": a class declaration (let-like); its inner name, in the class scope, is a const. */
export type BindingKind = "var" | "let" | "const" | "function" | "param" | "catch" | "self" | "this" | "arguments" | "class";

export interface Binding {
  name: string;
  kind: BindingKind;
  scope: Scope;
  /** The declaring identifier (the first one, for var and param). */
  node: A.Identifier;
  /** Written after its initialization: an assignment, an update, a second `var x = …`. */
  reassigned: boolean;
  /** Referenced from a function other than the one declaring it: it lives in an environment. */
  captured: boolean;
  /** A sloppy-mode function declaration in a block also gets a var in the function (Annex B.3.3). */
  annexBVar: Binding | null;
}

export type ScopeKind = "script" | "function" | "block" | "catch" | "self" | "class";

export interface Scope {
  kind: ScopeKind;
  node: A.Node;
  parent: Scope | null;
  func: FunctionInfo;
  bindings: Map<string, Binding>;
}

export interface FunctionInfo {
  node: A.FunctionNode;
  strict: boolean;
  /** Mentions `this`, itself or through arrow functions (the direct entry then takes it). */
  usesThis: boolean;
  /** `this` as a binding: when arrow functions inside read it (captured), and in a derived
   *  class constructor, where it starts in TDZ until super() binds it. */
  thisBinding: Binding | null;
  /** Mentions `super.x` (needs its home object) or `new.target`, itself or through arrows. */
  usesSuper: boolean;
  usesNewTarget: boolean;
  /** Its function object and new.target as captured bindings: arrows inside use super or new.target. */
  calleeBinding: Binding | null;
  newTargetBinding: Binding | null;
  /** The binding holding its arguments object (§10.2.11 step 22): a synthetic one, or a
   *  `var arguments`. null: the function doesn't need one. */
  argumentsBinding: Binding | null;
  /** An arrow function: `this` (and `arguments`) belong to the enclosing non-arrow function. */
  arrow: boolean;
  /** function*: the body runs as a resumable state machine. */
  generator: boolean;
  /** async: the same state machine, resumed by the promises it awaits. A module's
   *  top level counts as async: `await` is allowed there. */
  async: boolean;
  /** Contains an await or a for await of its own (a module's body: top-level await). */
  awaits: boolean;
  /** Plain parameter names only (§15.1.3): no defaults, no rest. Otherwise parameters are
   *  initialized left to right and can be read before (TDZ). */
  simpleParams: boolean;
  parent: FunctionInfo | null;
  /** The var scope: parameters, vars, top-level functions, top-level lexical declarations. */
  scope: Scope;
  inner: FunctionInfo[];
}

export interface Reference {
  id: A.Identifier;
  /** null: not declared anywhere, a global lookup at runtime. */
  binding: Binding | null;
  func: FunctionInfo;
  write: boolean;
  /** Might run before the binding is initialized: lowering emits a TDZ check. */
  tdz: boolean;
}

export interface SemanticInfo {
  program: FunctionInfo;
  functions: Map<A.FunctionNode, FunctionInfo>;
  /** Scopes of Program, FunctionDeclaration, BlockStatement, ForStatement, SwitchStatement, CatchClause. */
  scopes: Map<A.Node, Scope>;
  /** The implicit block around a function declaration used as an `if` branch (Annex B.3.4). */
  branchBlocks: Map<A.FunctionDeclaration, Scope>;
  /** Every identifier that is an expression or an assignment target. */
  references: Map<A.Identifier, Reference>;
  /** Every declaring identifier. */
  declarations: Map<A.Identifier, Binding>;
  /** A variable's initializer, `var x = …` (with a plain name); with `reassigned` false, the
   *  only value it ever holds once initialized. */
  initializers: Map<Binding, A.Expression>;
}

const STRICT_RESERVED = new Set(["implements", "interface", "let", "package", "private", "protected", "public", "static", "yield"]);
const LEXICAL: ReadonlySet<BindingKind> = new Set(["let", "const", "class"]);

/** The function whose `this` and `arguments` code in `fn` sees: `fn`, or through arrows. */
export function thisOwner(fn: FunctionInfo): FunctionInfo {
  let f = fn;
  while (f.arrow && f.parent) f = f.parent;
  return f;
}

function syntaxError(message: string, node: { loc: A.Loc }): never {
  throw new CompileError("SyntaxError", message, node.loc);
}

export function analyze(program: A.Program): SemanticInfo {
  return new Analyzer().run(program);
}

class Analyzer {
  private readonly info: Omit<SemanticInfo, "program"> = {
    functions: new Map(),
    scopes: new Map(),
    references: new Map(),
    declarations: new Map(),
    branchBlocks: new Map(),
    initializers: new Map(),
  };
  /** var declarations collected in pass A, declared once every lexical name is known.
   *  `annexB`: the block function this var twins (Annex B.3.3). */
  private pendingVars: { id: A.Identifier; scope: Scope; annexB?: Binding }[] = [];

  run(program: A.Program): SemanticInfo {
    this.module = program.module;
    const exported = new Set<string>();
    for (const { name, loc } of program.exportedNames) {
      if (exported.has(name)) throw new CompileError("SyntaxError", `Duplicate export of '${name}'`, loc);
      exported.add(name);
    }
    const top = this.newFunction(program, program.strict, null, null);
    this.hoistBody(program.body, top.scope);
    this.declarePendingVars();
    new Resolver(this.info, (f, scope) => this.hoistFunctionExpression(f, scope)).body(program.body, top.scope);
    return { program: top, ...this.info };
  }

  // ---- Pass A: scopes and declarations ----------------------------------

  /** `declaredIn`: the scope the function declaration appears in (its closure's outer scope). */
  private newFunction(node: A.FunctionNode, strict: boolean, parent: FunctionInfo | null, declaredIn: Scope | null): FunctionInfo {
    const arrow = node.type === "FunctionExpression" && node.arrow;
    const generator = node.type !== "Program" && node.generator === true;
    const isAsync = node.type === "Program" ? node.module : node.async === true;
    const simpleParams = node.type === "Program" || (!node.rest && node.defaults.every((d) => d === null) && node.params.every((p) => p.type === "Identifier"));
    const fn = {
      node, strict, usesThis: false, thisBinding: null, usesSuper: false, usesNewTarget: false,
      calleeBinding: null, newTargetBinding: null,
      argumentsBinding: null, arrow, generator, async: isAsync, awaits: false, simpleParams, parent, inner: [],
    } as unknown as FunctionInfo;
    fn.scope = { kind: parent ? "function" : "script", node, parent: declaredIn, func: fn, bindings: new Map() };
    if (node.type === "FunctionExpression" && node.classCtor?.derived) {
      /* `this` is uninitialized until super() (§10.2.1.3): a binding, not the incoming value */
      fn.thisBinding = {
        name: "this", kind: "this", scope: fn.scope, node: { type: "Identifier", loc: node.loc, name: "this" },
        reassigned: true, captured: false, annexBVar: null,
      };
      fn.scope.bindings.set("%this", fn.thisBinding);
    }
    parent?.inner.push(fn);
    this.info.functions.set(node, fn);
    this.info.scopes.set(node, fn.scope);
    return fn;
  }

  private newScope(kind: ScopeKind, node: A.Node, parent: Scope): Scope {
    const scope: Scope = { kind, node, parent, func: parent.func, bindings: new Map() };
    this.info.scopes.set(node, scope);
    return scope;
  }

  /** Module code: `await` is reserved (§13.1.1). */
  private module = false;

  private checkBindingName(id: A.Identifier, strict: boolean, kind: BindingKind) {
    if (LEXICAL.has(kind) && id.name === "let") syntaxError("let is disallowed as a lexically bound name", id);
    if (this.module && id.name === "await") syntaxError("'await' is a reserved word in a module", id);
    if (!strict) return;
    if (id.name === "eval" || id.name === "arguments") syntaxError(`'${id.name}' can't be a binding name in strict mode`, id);
    if (STRICT_RESERVED.has(id.name)) syntaxError(`'${id.name}' is a reserved word in strict mode`, id);
  }

  private bind(scope: Scope, id: A.Identifier, kind: BindingKind): Binding {
    const b: Binding = { name: id.name, kind, scope, node: id, reassigned: false, captured: false, annexBVar: null };
    scope.bindings.set(id.name, b);
    this.info.declarations.set(id, b);
    return b;
  }

  /** let, const, block-level functions, catch parameters. */
  private declareLexical(scope: Scope, id: A.Identifier, kind: BindingKind): Binding {
    this.checkBindingName(id, scope.func.strict, kind);
    const existing = scope.bindings.get(id.name);
    if (existing) {
      /* sloppy mode tolerates duplicate function declarations in a block (Annex B.3.2.4) */
      const sloppyFunctions = kind === "function" && existing.kind === "function" && !scope.func.strict && scope.kind === "block";
      if (!sloppyFunctions) syntaxError(`Identifier '${id.name}' has already been declared`, id);
      this.info.declarations.set(id, existing);
      existing.reassigned = true;
      return existing;
    }
    return this.bind(scope, id, kind);
  }

  /** Declarations of a function body or the script: its var scope. */
  private hoistBody(body: A.Statement[], scope: Scope) {
    for (const s of body) {
      if (s.type === "FunctionDeclaration") this.declareFunctionInVarScope(s, scope);
      else this.hoistStatement(s, scope);
    }
  }

  /** Top-level function declarations are var-like: they merge with vars and each other. */
  private declareFunctionInVarScope(f: A.FunctionDeclaration, scope: Scope) {
    this.checkBindingName(f.id, scope.func.strict || f.strict, "function");
    const existing = scope.bindings.get(f.id.name);
    if (existing && LEXICAL.has(existing.kind)) syntaxError(`Identifier '${f.id.name}' has already been declared`, f.id);
    if (existing) {
      existing.kind = existing.kind === "param" ? "param" : "function";
      existing.reassigned = true;  // several declarations or a var: not a single known function
      this.info.declarations.set(f.id, existing);
    } else {
      this.bind(scope, f.id, "function");
    }
    this.hoistFunction(f, scope);
  }

  private hoistFunction(f: A.FunctionDeclaration | A.FunctionExpression, declaredIn: Scope) {
    const parent = declaredIn.func;
    /* class code is strict; a CommonJS module's wrapper is sloppy, as Node runs CommonJS, though
     * the bundle around it is a module */
    const strict = (parent.strict && !f.commonJS) || f.strict || (f.type === "FunctionExpression" && f.inClass);
    const fn = this.newFunction(f, strict, parent, declaredIn);
    if (f.id) this.checkBindingName(f.id, strict, "function");  // a strict function's own directive covers its name
    if (f.type === "FunctionExpression" && f.id) {
      /* the expression's own name: a scope between the function and where it appears */
      const self: Scope = { kind: "self", node: f, parent: declaredIn, func: fn, bindings: new Map() };
      this.bind(self, f.id, "self");
      fn.scope.parent = self;
    }
    /* §15.1.3: defaults or a rest parameter make the list not simple; arrows and methods
     * never allow duplicates either */
    const simple = !f.rest && f.defaults.every((d) => d === null) && f.params.every((p) => p.type === "Identifier");
    if (!simple && f.strict) syntaxError("Illegal 'use strict' directive in function with non-simple parameter list", f.body);
    const noDuplicates = strict || !simple || (f.type === "FunctionExpression" && f.method);
    const seen = new Set<string>();
    for (const p of (f.rest ? [...f.params, f.rest] : f.params).flatMap(boundNames)) {
      this.checkBindingName(p, strict, "param");
      if (seen.has(p.name)) {
        if (noDuplicates) syntaxError(`Duplicate parameter name not allowed in this context`, p);
        this.info.declarations.set(p, fn.scope.bindings.get(p.name)!);
        continue;
      }
      seen.add(p.name);
      this.bind(fn.scope, p, "param");
    }
    this.hoistBody(f.body.body, fn.scope);
  }

  /** `forHead`: a for-in/of declaration, which has no initializer. */
  private hoistVarDeclaration(d: A.VariableDeclaration, scope: Scope, forHead = false) {
    for (const decl of d.declarations) {
      if (decl.id.type !== "Identifier" && !decl.init && !forHead) syntaxError("Missing initializer in destructuring declaration", decl);
      for (const id of boundNames(decl.id)) {
        if (d.kind === "var") {
          this.checkBindingName(id, scope.func.strict, "var");
          this.pendingVars.push({ id, scope });
        } else {
          if (d.kind === "const" && !decl.init && !forHead) syntaxError("Missing initializer in const declaration", decl);
          this.declareLexical(scope, id, d.kind);
        }
      }
    }
  }

  /** A statement in single-statement position (if/loop/label body): no declarations. */
  private checkSingleStatement(s: A.Statement, scope: Scope, context: "if" | "loop" | "label") {
    if (s.type === "VariableDeclaration" && s.kind !== "var") syntaxError("Lexical declaration cannot appear in a single-statement context", s);
    if (s.type === "ClassDeclaration") syntaxError("Lexical declaration cannot appear in a single-statement context", s);
    if (s.type === "FunctionDeclaration") {
      /* Annex B.3.4: `if (x) function f(){}` in sloppy mode; B.3.2: labelled functions in sloppy
       * mode. Plain functions only: never generators. */
      if (context === "loop" || scope.func.strict || s.generator || s.async) syntaxError("In this context, function declarations are only allowed in a block", s);
    }
    if (context === "label") {
      let body: A.Statement = s;
      while (body.type === "LabeledStatement") body = body.body;
      if (body.type === "FunctionDeclaration" && (body.generator || body.async))
        syntaxError(`${body.async ? "Async functions" : "Generators"} can only be declared at the top level or inside a block`, body);
    }
    if (context === "loop") {
      let body: A.Statement = s;
      while (body.type === "LabeledStatement") body = body.body;
      if (body.type === "FunctionDeclaration") syntaxError("A labelled function can't be the body of a loop", body);
    }
  }

  private hoistBranch(s: A.Statement, scope: Scope, context: "if" | "loop" | "label") {
    this.checkSingleStatement(s, scope, context);
    if (s.type === "FunctionDeclaration") {
      /* treated as if it were the only statement of a block */
      const block: Scope = { kind: "block", node: s, parent: scope, func: scope.func, bindings: new Map() };
      this.info.branchBlocks.set(s, block);
      this.declareBlockFunction(s, block);
      return;
    }
    this.hoistStatement(s, scope);
  }

  private declareBlockFunction(f: A.FunctionDeclaration, block: Scope) {
    const b = this.declareLexical(block, f.id, "function");
    this.hoistFunction(f, block);
    if (!block.func.strict && !f.generator && !f.async) {
      /* Annex B.3.3 (plain functions): also a var in the function, unless that would be an early error */
      const param = block.func.scope.bindings.get(f.id.name)?.kind === "param";
      if (!param && !this.lexicalConflict(f.id.name, block.parent)) this.pendingVars.push({ id: f.id, scope: block.parent!, annexB: b });
    }
  }

  private hoistStatement(s: A.Statement, scope: Scope): void {
    switch (s.type) {
      case "VariableDeclaration":
        return this.hoistVarDeclaration(s, scope);
      case "FunctionDeclaration":
        return this.declareBlockFunction(s, scope);
      case "ClassDeclaration":
        this.declareLexical(scope, s.id, "class");
        return;
      case "BlockStatement": {
        const block = this.newScope("block", s, scope);
        for (const inner of s.body) this.hoistStatement(inner, block);
        return;
      }
      case "IfStatement":
        this.hoistBranch(s.consequent, scope, "if");
        if (s.alternate) this.hoistBranch(s.alternate, scope, "if");
        return;
      case "WhileStatement":
      case "DoWhileStatement":
        return this.hoistBranch(s.body, scope, "loop");
      case "ForStatement": {
        const head = this.newScope("block", s, scope);
        if (s.init?.type === "VariableDeclaration") this.hoistVarDeclaration(s.init, head);
        return this.hoistBranch(s.body, head, "loop");
      }
      case "ForInStatement":
      case "ForOfStatement": {
        const head = this.newScope("block", s, scope);
        if (s.left.type === "VariableDeclaration") this.hoistVarDeclaration(s.left, head, true);
        return this.hoistBranch(s.body, head, "loop");
      }
      case "LabeledStatement":
        return this.hoistBranch(s.body, scope, "label");
      case "SwitchStatement": {
        const block = this.newScope("block", s, scope);
        for (const c of s.cases) for (const inner of c.consequent) this.hoistStatement(inner, block);
        return;
      }
      case "TryStatement": {
        this.hoistStatement(s.block, scope);
        if (s.handler) {
          const catchScope = this.newScope("catch", s.handler, scope);
          if (s.handler.param) for (const id of boundNames(s.handler.param)) this.declareLexical(catchScope, id, "catch");
          const body = this.newScope("block", s.handler.body, catchScope);
          for (const inner of s.handler.body.body) this.hoistStatement(inner, body);
          /* the catch parameter can't be redeclared lexically in the catch block */
          for (const name of body.bindings.keys())
            if (catchScope.bindings.has(name)) syntaxError(`Identifier '${name}' has already been declared`, body.bindings.get(name)!.node);
        }
        if (s.finalizer) this.hoistStatement(s.finalizer, scope);
        return;
      }
      default:
        return;
    }
  }

  /** A lexical binding of `name` between `scope` and its var scope (inclusive).
   *  A simple catch parameter doesn't conflict with var (Annex B.3.5, universal in practice). */
  private lexicalConflict(name: string, scope: Scope | null): Binding | null {
    for (let s = scope; s; s = s.kind === "function" || s.kind === "script" ? null : s.parent) {
      const b = s.bindings.get(name);
      if (b && (LEXICAL.has(b.kind) || (b.kind === "function" && s.kind === "block"))) return b;
    }
    return null;
  }

  /** A function expression, met while resolving: hoisted then (pass A for its body). */
  private hoistFunctionExpression(f: A.FunctionExpression, scope: Scope) {
    this.hoistFunction(f, scope);
    this.declarePendingVars();
  }

  private declarePendingVars() {
    const pending = this.pendingVars;
    this.pendingVars = [];
    for (const { id, scope, annexB } of pending) {
      if (this.lexicalConflict(id.name, scope)) {
        if (annexB) continue;  // checked at hoisting; a later lexical name just cancels the twin
        syntaxError(`Identifier '${id.name}' has already been declared`, id);
      }
      const varScope = scope.func.scope;
      let b = varScope.bindings.get(id.name);
      if (!b) {
        b = { name: id.name, kind: "var", scope: varScope, node: id, reassigned: false, captured: false, annexBVar: null };
        varScope.bindings.set(id.name, b);
      }
      if (annexB) {
        annexB.annexBVar = b;
        b.reassigned = true;  // assigned when the block function's declaration is evaluated
      } else if (!this.info.declarations.has(id)) {
        this.info.declarations.set(id, b);
      }
    }
  }
}

// ---- Pass B: references and control flow ---------------------------------

interface Labels {
  names: Map<string, { iteration: boolean }>;
  breakable: number;  // enclosing loops and switches
  loops: number;
}

class Resolver {
  /** The function whose parameter list is being analyzed (`yield` is an early error there). */
  private inParams: FunctionInfo | null = null;

  private readonly initialized = new Set<Binding>();
  /** For each switch scope: the case each lexical binding is declared in. */
  private readonly caseOf = new Map<Binding, A.SwitchCase>();
  private currentCase: A.SwitchCase | null = null;
  private labels: Labels = { names: new Map(), breakable: 0, loops: 0 };
  private readonly info: Omit<SemanticInfo, "program">;
  private readonly hoist: (f: A.FunctionExpression, scope: Scope) => void;

  constructor(info: Omit<SemanticInfo, "program">, hoist: (f: A.FunctionExpression, scope: Scope) => void) {
    this.info = info;
    this.hoist = hoist;
  }

  body(statements: A.Statement[], scope: Scope) {
    for (const s of statements) this.statement(s, scope);
  }

  private resolve(name: string, scope: Scope): Binding | null {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const b = s.bindings.get(name);
      if (b) return b;
    }
    return null;
  }

  private reference(id: A.Identifier, scope: Scope, write: boolean) {
    const func = scope.func;
    if (func.strict && STRICT_RESERVED.has(id.name)) syntaxError(`'${id.name}' is a reserved word in strict mode`, id);
    if (write && func.strict && (id.name === "eval" || id.name === "arguments"))
      syntaxError(`Unexpected eval or arguments in strict mode`, id);
    const binding = id.name === "arguments" ? this.resolveArguments(scope) : this.resolve(id.name, scope);
    if (!binding && id.name.startsWith("#")) syntaxError(`Private field '${id.name}' must be declared in an enclosing class`, id);
    let tdz = false;
    if (binding) {
      if (binding.scope.func !== func) binding.captured = true;
      if (write) binding.reassigned = true;
      if (LEXICAL.has(binding.kind)) {
        const declCase = this.caseOf.get(binding);
        tdz = binding.scope.func !== func || !this.initialized.has(binding) || (declCase !== undefined && declCase !== this.currentCase);
      } else if (binding.kind === "param" && !binding.scope.func.simpleParams) {
        tdz = binding.scope.func !== func || !this.initialized.has(binding);
      }
    }
    this.info.references.set(id, { id, binding, func, write, tdz });
  }

  /** `arguments` (§10.2.11): a declaration of that name up to the owning function (an
   *  arrow's is its enclosing function's) wins, except `var arguments`, which is the
   *  arguments object itself. Otherwise the owning function gets an arguments binding. */
  private resolveArguments(scope: Scope): Binding | null {
    const owner = thisOwner(scope.func);
    if (owner.node.type === "Program") return this.resolve("arguments", scope);  // a global lookup
    if (owner.node.type === "FunctionExpression" && owner.node.fieldInit)
      syntaxError("'arguments' is not allowed in class field initializer or static initialization block", owner.node);
    let found: Binding | null = null;
    for (let s: Scope | null = scope; s; s = s.parent) {
      found = s.bindings.get("arguments") ?? null;
      if (found || s === owner.scope) break;
    }
    if (found && !(found.kind === "var" && found.scope === owner.scope)) return found;
    if (!owner.argumentsBinding) {
      owner.argumentsBinding = found ?? {
        name: "arguments", kind: "arguments", scope: owner.scope, node: { type: "Identifier", loc: owner.node.loc, name: "arguments" },
        reassigned: false, captured: false, annexBVar: null,
      };
      if (!found) owner.scope.bindings.set("arguments", owner.argumentsBinding);
      /* mapped (sloppy, simple parameters): its indices alias the parameters, which live in the environment */
      if (!owner.strict && owner.simpleParams)
        for (const b of owner.scope.bindings.values()) if (b.kind === "param") b.captured = true;
    }
    return owner.argumentsBinding;
  }

  private declarator(d: A.VariableDeclarator, kind: A.VariableDeclaration["kind"], scope: Scope) {
    if (d.init) this.expression(d.init, scope);
    this.pattern(d.id, scope, (id) => this.initializeDeclared(id, kind, d.init !== null || d.id.type !== "Identifier"));
    if (d.init && d.id.type === "Identifier") this.info.initializers.set(this.info.declarations.get(d.id)!, d.init);
  }

  /** A declared name gets its value (`written`: not just a `var x;`). */
  private initializeDeclared(id: A.Identifier, kind: A.VariableDeclaration["kind"] | "param" | "catch", written: boolean) {
    const b = this.info.declarations.get(id)!;
    if (kind === "var") {
      if (written && this.initialized.has(b)) b.reassigned = true;  // `var x = 1; var x = 2;`
      if (written || !this.initialized.has(b)) this.initialized.add(b);
      if (b.kind === "function" && written) b.reassigned = true;
    } else {
      this.initialized.add(b);
      if (this.currentCase && b.scope.node.type === "SwitchStatement") this.caseOf.set(b, this.currentCase);
    }
  }

  /** A destructuring pattern (or a plain name): its computed keys and defaults in order, and
   *  its leaves, which are either declarations being initialized (`bind`) or, in an
   *  assignment pattern (`bind` null), assignment targets. */
  private pattern(p: A.PatternTarget, scope: Scope, bind: ((id: A.Identifier) => void) | null) {
    const leaf = (target: A.PatternTarget, init: A.Expression | null) => {
      /* a member target's object and key are evaluated before the value (§13.15.5.6) */
      const member = !bind && (target.type === "MemberExpression" || target.type === "SuperMember");
      if (member) this.target(target, scope);
      if (init) this.expression(init, scope);
      if (!member) this.pattern(target, scope, bind);
    };
    switch (p.type) {
      case "Identifier":
        if (bind) bind(p);
        else this.reference(p, scope, true);
        return;
      case "ObjectPattern":
        for (const q of p.properties) {
          if (q.computed) this.expression(q.key, scope);
          leaf(q.target, q.init);
        }
        if (p.rest) leaf(p.rest, null);
        return;
      case "ArrayPattern":
        for (const e of p.elements) if (e) leaf(e.target, e.init);
        if (p.rest) leaf(p.rest, null);
        return;
      default:
        this.target(p, scope);
    }
  }

  private function(f: A.FunctionDeclaration | A.FunctionExpression) {
    const fn = this.info.functions.get(f)!;
    if (f.type === "FunctionExpression" && f.id) this.initialized.add(this.info.declarations.get(f.id)!);
    if (f.type === "FunctionExpression" && f.initRef) {
      /* the constructor runs the class's instance initializer on `this` */
      this.reference(f.initRef, fn.scope, false);
      if (!f.classCtor?.derived) fn.usesThis = true;
    }
    const saved = { labels: this.labels, currentCase: this.currentCase };
    this.labels = { names: new Map(), breakable: 0, loops: 0 };  // labels don't cross functions
    this.currentCase = null;
    /* parameters initialize left to right: a default sees the ones before it */
    const initParam = (id: A.Identifier) => this.initialized.add(fn.scope.bindings.get(id.name)!);
    const outerParams = this.inParams;
    this.inParams = fn;
    f.params.forEach((p, i) => {
      const d = f.defaults[i];
      if (d) this.expression(d, fn.scope);
      this.pattern(p, fn.scope, initParam);
    });
    if (f.rest) this.pattern(f.rest, fn.scope, initParam);
    this.inParams = outerParams;
    this.body(f.body.body, fn.scope);
    this.labels = saved.labels;
    this.currentCase = saved.currentCase;
  }

  private loopBody(body: A.Statement, scope: Scope) {
    this.labels.breakable++;
    this.labels.loops++;
    this.statement(body, scope);
    this.labels.breakable--;
    this.labels.loops--;
  }

  private statement(s: A.Statement, scope: Scope): void {
    switch (s.type) {
      case "ExportLocals":
        /* §16.2.1.1: an exported name must be declared at the module's top level */
        for (const id of s.locals)
          if (!scope.bindings.has(id.name)) syntaxError(`Export '${id.name}' is not defined in module`, id);
        return;
      case "VariableDeclaration":
        for (const d of s.declarations) this.declarator(d, s.kind, scope);
        return;
      case "FunctionDeclaration":
        this.initialized.add(this.info.declarations.get(s.id)!);  // hoisted: initialized on entry
        return this.function(s);
      case "ClassDeclaration": {
        this.classNode(s, scope);
        const b = this.info.declarations.get(s.id)!;
        this.initialized.add(b);
        if (this.currentCase && b.scope.node.type === "SwitchStatement") this.caseOf.set(b, this.currentCase);
        return;
      }
      case "ExpressionStatement":
        return this.expression(s.expression, scope);
      case "BlockStatement": {
        const block = this.info.scopes.get(s)!;
        this.hoistedFunctionsInitialized(block);
        return this.body(s.body, block);
      }
      case "EmptyStatement":
        return;
      case "IfStatement":
        this.expression(s.test, scope);
        this.statement(s.consequent, scope);
        if (s.alternate) this.statement(s.alternate, scope);
        return;
      case "WhileStatement":
        this.expression(s.test, scope);
        return this.loopBody(s.body, scope);
      case "DoWhileStatement":
        this.loopBody(s.body, scope);
        return this.expression(s.test, scope);
      case "ForStatement": {
        const head = this.info.scopes.get(s)!;
        if (s.init?.type === "VariableDeclaration") this.statement(s.init, head);
        else if (s.init) this.expression(s.init, head);
        if (s.test) this.expression(s.test, head);
        if (s.update) this.expression(s.update, head);
        return this.loopBody(s.body, head);
      }
      case "ForInStatement":
      case "ForOfStatement": {
        if (s.type === "ForOfStatement" && s.await) {
          if (!scope.func.async) syntaxError("for await is only valid in async functions and the top level bodies of modules", s);
          scope.func.awaits = true;
        }
        const head = this.info.scopes.get(s)!;
        this.expression(s.right, head);  // let/const names are in TDZ here
        if (s.left.type === "VariableDeclaration") {
          const kind = s.left.kind;
          this.pattern(s.left.declarations[0]!.id, head, (id) => {
            const b = this.info.declarations.get(id)!;
            if (kind === "var") b.reassigned = true;  // written each iteration
            this.initialized.add(b);
          });
        } else {
          this.pattern(s.left, head, null);
        }
        return this.loopBody(s.body, head);
      }
      case "BreakStatement":
        if (s.label) {
          if (!this.labels.names.has(s.label.name)) syntaxError(`Undefined label '${s.label.name}'`, s.label);
        } else if (!this.labels.breakable) {
          syntaxError("Illegal break statement", s);
        }
        return;
      case "ContinueStatement":
        if (s.label) {
          const l = this.labels.names.get(s.label.name);
          if (!l) syntaxError(`Undefined label '${s.label.name}'`, s.label);
          if (!l.iteration) syntaxError(`Illegal continue statement: '${s.label.name}' does not denote an iteration statement`, s.label);
        } else if (!this.labels.loops) {
          syntaxError("Illegal continue statement: no surrounding iteration statement", s);
        }
        return;
      case "ReturnStatement":
        if (scope.func.node.type === "Program" || (scope.func.node.type === "FunctionExpression" && scope.func.node.fieldInit))
          syntaxError("Illegal return statement", s);
        if (s.argument) this.expression(s.argument, scope);
        return;
      case "ThrowStatement":
        return this.expression(s.argument, scope);
      case "TryStatement":
        this.statement(s.block, scope);
        if (s.handler) {
          const catchScope = this.info.scopes.get(s.handler)!;
          if (s.handler.param) this.pattern(s.handler.param, catchScope, (id) => this.initialized.add(catchScope.bindings.get(id.name)!));
          this.statement(s.handler.body, catchScope);
        }
        if (s.finalizer) this.statement(s.finalizer, scope);
        return;
      case "SwitchStatement": {
        this.expression(s.discriminant, scope);
        const block = this.info.scopes.get(s)!;
        this.hoistedFunctionsInitialized(block);
        this.labels.breakable++;
        const savedCase = this.currentCase;
        for (const c of s.cases) {
          this.currentCase = c;
          if (c.test) this.expression(c.test, block);
          this.body(c.consequent, block);
        }
        this.currentCase = savedCase;
        this.labels.breakable--;
        return;
      }
      case "Unsupported":
        return;
      case "LabeledStatement": {
        const name = s.label.name;
        if (this.labels.names.has(name)) syntaxError(`Label '${name}' has already been declared`, s.label);
        let body: A.Statement = s.body;
        while (body.type === "LabeledStatement") body = body.body;
        const iteration = body.type === "WhileStatement" || body.type === "DoWhileStatement" || body.type === "ForStatement" || body.type === "ForInStatement" || body.type === "ForOfStatement";
        this.labels.names.set(name, { iteration });
        this.statement(s.body, scope);
        this.labels.names.delete(name);
        return;
      }
    }
  }

  /** Block-level function declarations are initialized when the block is entered. */
  private hoistedFunctionsInitialized(block: Scope) {
    for (const b of block.bindings.values()) if (b.kind === "function") this.initialized.add(b);
  }

  private member(e: A.MemberExpression, scope: Scope) {
    this.expression(e.object, scope);
    if (e.computed || e.private) this.expression(e.property, scope);  // a private name is a binding of its class
  }

  /** An update target: read, then written. */
  private target(t: A.Target, scope: Scope) {
    if (t.type === "MemberExpression") this.member(t, scope);
    else if (t.type === "SuperMember") this.superMember(t, scope);
    else this.reference(t, scope, true);
  }

  /** `super.x`: in methods, accessors and class constructors (and arrows inside them). */
  private superMember(e: A.SuperMember, scope: Scope) {
    const owner = thisOwner(scope.func);
    if (owner.node.type !== "FunctionExpression" || !owner.node.method)
      syntaxError("'super' keyword unexpected here", e);
    owner.usesSuper = true;
    this.fromArrow(scope, "callee");
    this.useThis(scope);  // the receiver
    if (e.computed) this.expression(e.property, scope);
  }

  /** `this` read here: its owner (through arrows) takes it, as a captured binding if needed. */
  private useThis(scope: Scope) {
    thisOwner(scope.func).usesThis = true;
    this.fromArrow(scope, "this");
  }

  /** Code in an arrow using its enclosing function's `this`, function object (for super)
   *  or new.target: the owner keeps it in a captured binding the arrow reads. */
  private fromArrow(scope: Scope, what: "this" | "callee" | "newTarget") {
    const owner = thisOwner(scope.func);
    if (owner === scope.func || owner.node.type === "Program") return;
    const field = what === "this" ? "thisBinding" : what === "callee" ? "calleeBinding" : "newTargetBinding";
    let b = owner[field];
    if (!b) {
      b = { name: what, kind: "this", scope: owner.scope, node: { type: "Identifier", loc: owner.node.loc, name: what }, reassigned: false, captured: true, annexBVar: null };
      owner[field] = b;
      owner.scope.bindings.set(`%${what}`, b);  // no identifier can name it
    }
    b.captured = true;
  }

  /** A class (§15.7.14): a scope holding its own name (a const, in TDZ until the class
   *  exists), in which the heritage, constructor and members are resolved. */
  private classNode(c: A.ClassDeclaration | A.ClassExpression, scope: Scope) {
    const classScope: Scope = { kind: "class", node: c, parent: scope, func: scope.func, bindings: new Map() };
    this.info.scopes.set(c, classScope);
    let inner: Binding | null = null;
    if (c.id) {
      if (c.id.name === "eval" || c.id.name === "arguments" || STRICT_RESERVED.has(c.id.name) || c.id.name === "let")
        syntaxError(`'${c.id.name}' can't be a class name (class code is strict)`, c.id);
      inner = { name: c.id.name, kind: "const", scope: classScope, node: c.id, reassigned: false, captured: false, annexBVar: null };
      classScope.bindings.set(c.id.name, inner);
    }
    /* private names (#x) and hidden bindings (%init, %fk0, %pm0): set before any code can read them */
    for (const name of [...c.privateNames, ...c.hidden]) {
      const b: Binding = { name, kind: "const", scope: classScope, node: { type: "Identifier", loc: c.loc, name }, reassigned: false, captured: false, annexBVar: null };
      classScope.bindings.set(name, b);
      this.initialized.add(b);
    }
    if (c.superClass) this.expression(c.superClass, classScope);
    this.hoist(c.ctor, classScope);
    this.function(c.ctor);
    for (const m of c.members) {
      if (m.computed) this.expression(m.key, classScope);
      if (!m.value) continue;
      this.hoist(m.value, classScope);
      this.function(m.value);
    }
    for (const init of [c.instanceInit, c.staticInit]) {
      if (!init) continue;
      this.hoist(init, classScope);
      this.function(init);
    }
    if (inner) this.initialized.add(inner);
  }

  private expression(e: A.Expression, scope: Scope): void {
    switch (e.type) {
      case "Literal":
      case "RegExpLiteral":
      case "BigIntLiteral":
        return;
      case "Identifier":
        return this.reference(e, scope, false);
      case "UnaryExpression":
        if (e.operator === "delete" && e.argument.type === "Identifier" && scope.func.strict)
          syntaxError("Delete of an unqualified identifier in strict mode.", e.argument);
        if (e.operator === "delete" && e.argument.type === "MemberExpression" && e.argument.private)
          syntaxError("Private fields can not be deleted", e.argument);
        return this.expression(e.argument, scope);
      case "UpdateExpression":
        return this.target(e.argument, scope);
      case "BinaryExpression":
      case "LogicalExpression":
        this.expression(e.left, scope);
        return this.expression(e.right, scope);
      case "AssignmentExpression":
        if (e.target.type === "ObjectPattern" || e.target.type === "ArrayPattern") {
          this.expression(e.value, scope);  // the value first, then the pattern's targets
          return this.pattern(e.target, scope, null);
        }
        if (e.target.type !== "Identifier") {
          this.target(e.target, scope);  // object and key are evaluated before the value
          return this.expression(e.value, scope);
        }
        this.expression(e.value, scope);
        return this.reference(e.target, scope, true);
      case "ConditionalExpression":
        this.expression(e.test, scope);
        this.expression(e.consequent, scope);
        return this.expression(e.alternate, scope);
      case "CallExpression":
      case "NewExpression":
        this.expression(e.callee, scope);
        for (const a of e.arguments) this.expression(a.type === "SpreadElement" ? a.argument : a, scope);
        return;
      case "MemberExpression":
        return this.member(e, scope);
      case "ChainExpression":
        return this.expression(e.expression, scope);
      case "ObjectExpression": {
        let proto: A.Property | null = null;
        for (const p of e.properties) {
          if (p.type === "SpreadElement") {
            this.expression(p.argument, scope);
            continue;
          }
          if (p.isProto) {
            if (proto) syntaxError("Duplicate __proto__ fields are not allowed in object literals", p);
            proto = p;
          }
          if (p.computed) this.expression(p.key, scope);
          this.expression(p.value, scope);
        }
        return;
      }
      case "ArrayExpression":
        for (const x of e.elements) if (x) this.expression(x.type === "SpreadElement" ? x.argument : x, scope);
        return;
      case "HostFunction":
      case "ImportMeta":
      case "TemplateObject":
        return;
      case "TemplateLiteral":
        for (const x of e.expressions) this.expression(x, scope);
        return;
      case "ImportCall":
        this.expression(e.source, scope);
        if (e.options) this.expression(e.options, scope);
        return;
      case "ThisExpression":
        /* an arrow's `this` is its enclosing function's: a captured binding there */
        return this.useThis(scope);
      case "FunctionExpression":
        this.hoist(e, scope);
        return this.function(e);
      case "AwaitExpression":
        if (!scope.func.async) syntaxError("await is only valid in async functions and the top level bodies of modules", e);
        if (this.inParams === scope.func) syntaxError("Illegal await-expression in formal parameters of async function", e);
        scope.func.awaits = true;
        this.expression(e.argument, scope);
        return;
      case "YieldExpression":
        if (this.inParams === scope.func) syntaxError("Yield expression not allowed in formal parameter", e);
        if (e.argument) this.expression(e.argument, scope);
        return;
      case "ClassExpression":
        return this.classNode(e, scope);
      case "SuperCall": {
        const owner = thisOwner(scope.func);
        if (owner.node.type !== "FunctionExpression" || !owner.node.classCtor?.derived)
          syntaxError("'super' keyword unexpected here", e);
        owner.usesSuper = true;  // the constructor's own [[Prototype]]: the parent class
        owner.usesNewTarget = true;
        this.fromArrow(scope, "callee");
        this.fromArrow(scope, "newTarget");
        this.useThis(scope);
        /* from an arrow, the class's field initializer is reached through its own reference */
        const init = (owner.node as A.FunctionExpression).initRef;
        if (init && owner !== scope.func) {
          e.initRef = { type: "Identifier", loc: e.loc, name: init.name };
          this.reference(e.initRef, scope, false);
        }
        for (const a of e.arguments) this.expression(a.type === "SpreadElement" ? a.argument : a, scope);
        return;
      }
      case "SuperMember":
        return this.superMember(e, scope);
      case "DefineField":
        this.useThis(scope);
        if (e.computed || e.private) this.expression(e.key, scope);
        if (e.value) this.expression(e.value, scope);
        return;
      case "AddPrivateMethod":
        this.useThis(scope);
        this.expression(e.name, scope);
        return this.expression(e.fn, scope);
      case "NewTarget": {
        const owner = thisOwner(scope.func);
        if (owner.node.type === "Program") syntaxError("new.target expression is not allowed here", e);
        owner.usesNewTarget = true;
        this.fromArrow(scope, "newTarget");
        return;
      }
      case "SequenceExpression":
        for (const x of e.expressions) this.expression(x, scope);
        return;
      case "Unsupported":
        return;
    }
  }
}
