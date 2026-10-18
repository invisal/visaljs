// Lowering: our AST + semantic facts → IR, with explicit
// evaluation order and control flow.
//
// Top-level bindings live in global slots, function locals are SSA values,
// captured variables live in scope environments. Calls to top-level
// functions are direct; every other callee (builtins, methods, values) goes
// through the generic entry. try/catch/finally uses completion states:
// a break, continue or return that crosses a finally records an exit
// code, runs the finally, and the finally's dispatch continues the jump outward.
import type * as A from "../frontend/ast.ts";
import { boundNames } from "../frontend/ast.ts";
import { CompileError } from "../frontend/errors.ts";
import { FunctionBuilder, type VarKey } from "@visaljs/ir";
import { propKey, type Block, type FunctionIR, type GlobalSlot, type Instr, type IntKind, type ModuleIR, type Op, type PropKey } from "@visaljs/ir";
import { thisOwner, type Binding, type FunctionInfo, type Scope, type SemanticInfo } from "../sema/analyze.ts";

/** Host functions a script can call by name (the test host's). */
const HOST_FUNCTIONS = new Set(["print"]);

/** Global names with fixed values: non-writable properties of the global object. */
const CONSTANT_GLOBALS: Record<string, number | undefined> = { undefined, NaN, Infinity };

const BINARY: Record<A.BinaryOperator, Op> = {
  "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod", "**": "exp",
  "<<": "shl", ">>": "sar", ">>>": "shr", "&": "bitand", "|": "bitor", "^": "bitxor",
  "==": "eq", "!=": "ne", "===": "strict_eq", "!==": "strict_ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge",
  in: "in", instanceof: "instanceof",
};

/** A callee as V8 names it in "x is not a function": the source shape, not the value. */
function calleeText(e: A.Expression): string {
  switch (e.type) {
    case "Identifier": return e.name;
    case "ThisExpression": return "this";
    case "CallExpression": return `${calleeText(e.callee)}(...)`;
    case "ChainExpression": return calleeText(e.expression);
    case "MemberExpression": {
      const obj = calleeText(e.object) + (e.optional ? "?." : "");
      if (!e.computed) return `${obj}${e.optional ? "" : "."}${(e.property as A.Identifier).name}`;
      const p = e.property;
      if (p.type === "Literal") return `${obj}[${typeof p.value === "string" ? JSON.stringify(p.value) : String(p.value)}]`;
      return `${obj}[${p.type === "Identifier" ? p.name : "..."}]`;
    }
    default: return "(intermediate value)";
  }
}

/** A member expression whose object (and computed key) are evaluated: what a
 *  get, set, call or delete then uses. `key` is a constant when known statically. */
interface MemberRef {
  obj: Instr;
  key: PropKey | Instr;
  /** `obj.#x`: `key` is the private name. */
  private?: boolean;
  /** `super.x`: the function whose home object's prototype holds the property; `obj` is `this`. */
  superCallee?: Instr;
}

function isConst(key: PropKey | Instr): key is PropKey {
  return !("op" in key);
}

function hasSpread(items: readonly (A.Argument | null)[]): boolean {
  return items.some((x) => x?.type === "SpreadElement");
}

function notSupported(detail: string, node: { loc: A.Loc }): never {
  throw new CompileError("NotSupported", detail, node.loc);
}

/** What every function's lowering shares: global slots, environments, function ids and names. */
interface ModuleContext {
  info: SemanticInfo;
  slots: Map<Binding, number>;
  /** Scopes with captured bindings: each gets an environment, a slot per captured binding. */
  envs: Map<Scope, Map<Binding, number>>;
  /** Unique names (C identifiers derive from them). */
  ids: Map<A.FunctionNode, string>;
  /** Names inferred from where an anonymous function appears (`var f = function () {}`). */
  inferredNames: Map<A.FunctionExpression, string>;
  printAssigned: boolean;
  globals: GlobalSlot[];
  /** Each original file's import.meta object, cached in a hidden module slot. */
  importMetaSlots: Map<string, number>;
  declaredFunctions: Map<Binding, FunctionInfo>;
  classesById: Map<A.Identifier, A.ClassDeclaration | A.ClassExpression>;
  /** The functions that read their own name's binding (a named function expression's). */
  readsOwnName: Set<FunctionInfo>;
  /** "use static" code: integer arithmetic and conversions where its declarations say so. */
  static: boolean;
}

/** Static code's integer operators: an `i64` (+ - * & | ^ << >> >>>; / and % by a constant other
 *  than 0), or int_div and int_mod. */
const INT_OPERATORS = new Set<A.BinaryOperator>(["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>", ">>>"]);

/** A function's `name` from its binding: a module's anonymous default export is "default"
 *  (§16.2.3.7), though its hidden binding is `*default*`. */
function functionName(binding: string): string {
  return binding === "*default*" ? "default" : binding;
}

/** The name an identifier gives a function (§8.4 NamedEvaluation): the source's, even where the
 *  bundler renamed the binding (`sum$1` is still `sum`). */
function nameOf(id: A.Identifier): string {
  return id.original ?? id.name;
}

export function lower(program: A.Program, info: SemanticInfo): ModuleIR {
  const globals: GlobalSlot[] = [];
  const slots = new Map<Binding, number>();
  /* top-level let/const/class: the global lexical scope, in slots; var and functions are
   * properties of the global object (classic scripts). A module's are all its own. */
  for (const b of info.program.scope.bindings.values()) {
    if ((b.kind === "var" || b.kind === "function") && !program.module) continue;
    slots.set(b, globals.length);
    globals.push({ name: b.name, slot: globals.length });
  }
  /* readable ids: a class's constructor and methods take its name and their keys */
  const classNames = new Map<A.FunctionNode, string>();
  for (const [node] of info.scopes) {
    if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") continue;
    const cls = node.id?.name ?? "class";
    classNames.set(node.ctor, cls);
    for (const m of node.members) {
      if (!m.value) continue;
      const key = m.computed ? "computed" : m.key.type === "Identifier" ? m.key.name.replace("#", "private_") : String((m.key as A.Literal).value);
      classNames.set(m.value, `${cls}_${m.kind === "method" ? "" : `${m.kind}_`}${key}`);
    }
    if (node.instanceInit) classNames.set(node.instanceInit, `${cls}_fields`);
    if (node.staticInit) classNames.set(node.staticInit, `${cls}_static`);
  }
  const ids = new Map<A.FunctionNode, string>();
  const used = new Set<string>(["main"]);
  for (const node of info.functions.keys()) {
    if (node.type === "Program") continue;
    const base = node.id?.name ?? classNames.get(node) ?? "anonymous";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    ids.set(node, id);
  }
  const envs = new Map<Scope, Map<Binding, number>>();
  for (const scope of new Set([...info.scopes.values(), ...info.declarations.values()].map((x) => ("scope" in x ? x.scope : x)))) {
    if (scope === info.program.scope) continue;  // top-level bindings are global slots
    const captured = [...scope.bindings.values()].filter((b) => b.captured);
    if (captured.length) envs.set(scope, new Map(captured.map((b, i) => [b, i])));
  }
  /* built once, not searched per call site: a large bundle has millions of references */
  const declaredFunctions = new Map<Binding, FunctionInfo>();
  const ownNames = new Map<Binding, FunctionInfo>();
  for (const fn of info.functions.values()) {
    const node = fn.node;
    if (node.type === "FunctionDeclaration") {
      const binding = info.declarations.get(node.id)!;
      if (!declaredFunctions.has(binding)) declaredFunctions.set(binding, fn);
    } else if (node.type === "FunctionExpression" && node.id) ownNames.set(info.declarations.get(node.id)!, fn);
  }
  const classesById = new Map<A.Identifier, A.ClassDeclaration | A.ClassExpression>();
  for (const sc of info.scopes.values()) {
    const cls = sc.node as A.ClassDeclaration | A.ClassExpression;
    if (sc.kind === "class" && cls.id && !classesById.has(cls.id)) classesById.set(cls.id, cls);
  }
  /* the test host's print is called directly, unless the script replaces it */
  let printAssigned = false;
  const readsOwnName = new Set<FunctionInfo>();
  for (const r of info.references.values()) {
    if (r.id.name === "print" && r.write && !r.binding) printAssigned = true;
    if (r.binding && ownNames.get(r.binding) === r.func) readsOwnName.add(r.func);
  }
  const m: ModuleContext = {
    info, slots, envs, ids, inferredNames: new Map(), printAssigned, globals, importMetaSlots: new Map(),
    declaredFunctions, classesById, readsOwnName, static: program.static === true,
  };
  const main = new FunctionLowering(m, info.program).run();
  const functions: FunctionIR[] = [];
  const nodes: A.FunctionNode[] = [];
  for (const fn of info.functions.values()) {
    if (fn === info.program) continue;
    functions.push(new FunctionLowering(m, fn).run());
    nodes.push(fn.node);
  }
  /* names inferred while lowering the code that creates the functions */
  functions.forEach((f, i) => {
    const node = nodes[i]!;
    if (node.type === "FunctionExpression" && !node.id) f.meta!.jsName = m.inferredNames.get(node) ?? "";
  });
  if (m.static) for (const fn of [main, ...functions]) fn.dialect = "static";
  return { main, functions, globals, source: program.source };
}

/** The nearest scope enclosing `scope` (itself included) that has an environment. */
function envScopeFrom(m: ModuleContext, scope: Scope | null): Scope | null {
  for (let s = scope; s; s = s.parent) if (m.envs.has(s)) return s;
  return null;
}

/** The environment a function closes over: the nearest one outside its own scope
 *  (a named expression's own-name scope counts: it's created with the closure). */
function outerEnvScope(m: ModuleContext, fn: FunctionInfo): Scope | null {
  return envScopeFrom(m, fn.scope.parent);
}

/** Whether a function body has a try…finally (outside nested functions). */
function containsFinally(body: A.Statement[]): boolean {
  const walk = (s: A.Statement | null): boolean => {
    if (!s) return false;
    switch (s.type) {
      case "TryStatement": return s.finalizer !== null || walk(s.block) || walk(s.handler?.body ?? null);
      case "BlockStatement": return s.body.some(walk);
      case "IfStatement": return walk(s.consequent) || walk(s.alternate);
      case "WhileStatement": case "DoWhileStatement": case "ForStatement": case "ForInStatement": case "ForOfStatement": case "LabeledStatement": return walk(s.body);
      case "SwitchStatement": return s.cases.some((c) => c.consequent.some(walk));
      default: return false;
    }
  };
  return body.some(walk);
}

// ---- Control frames ----------------------------------------------------------

interface BreakFrame {
  kind: "break";
  labels: string[];
  /** Target of an unlabelled break (loops and switch); labelled blocks only take `break L`. */
  plainBreak: boolean;
  breakTarget: Block;
  continueTarget: Block | null;  // loops only
}

/** A for…of loop's iterator: jumps out of the loop close it (IteratorClose), except a
 *  `continue` of the loop itself (`loopFrame`, its break frame just outside). */
interface IteratorFrame {
  kind: "iterator";
  rec: Instr;
  loopFrame: number;
  /** for await: closing awaits the iterator's return() (AsyncIteratorClose) */
  async: boolean;
}

interface FinallyFrame {
  kind: "finally";
  entry: Block;
  completion: VarKey;
  /** Jumps that cross this finally: continued after it runs. Codes 0 and 1 are normal and throw. */
  exits: { code: number; key: string; perform: () => void }[];
}

type Frame = BreakFrame | FinallyFrame | IteratorFrame;

const NORMAL = 0;
const THROW = 1;

class FunctionLowering {
  private readonly b: FunctionBuilder;
  private readonly frames: Frame[] = [];
  /** Where a pending return value and a caught-and-rethrown exception wait while a finally runs. */
  private readonly retval: VarKey = { name: "ret" };
  private readonly pendingException: VarKey = { name: "exc" };
  private readonly m: ModuleContext;
  private readonly info: SemanticInfo;
  private readonly fn: FunctionInfo;
  private readonly slots: Map<Binding, number>;
  /** The function's `this`, coerced for sloppy functions (computed once, in the entry block). */
  private thisValue: Instr | null = null;
  /** The environment this function closes over (its hidden `env` parameter), if any. */
  private envParam: Instr | null = null;
  private readonly outerEnv: Scope | null;
  /** The scopes entered so far, innermost last: where the current environment comes from. */
  private readonly scopeStack: Scope[] = [];
  /** The optional chain being lowered: where a nullish `?.` goes (made on first use). */
  private chainShort: { block: Block | null } | null = null;

  constructor(m: ModuleContext, fn: FunctionInfo) {
    this.m = m;
    this.info = m.info;
    this.fn = fn;
    this.slots = m.slots;
    this.scopeStack.push(fn.scope);
    const node = fn.node;
    this.outerEnv = node.type === "Program" ? null : outerEnvScope(m, fn);
    if (node.type === "Program") {
      this.b = new FunctionBuilder("main", [], fn.strict, node.loc);
      return;
    }
    const self = node.type === "FunctionExpression" && node.id ? this.info.declarations.get(node.id)! : null;
    const readsSelf = self !== null && m.readsOwnName.has(fn);
    const takesArguments = fn.argumentsBinding !== null;
    const mappedArguments = takesArguments && !fn.strict && fn.simpleParams;  // its `callee` is the function
    const classCtor = node.type === "FunctionExpression" ? node.classCtor : null;
    /* hidden leading parameters, in this order, only when the function needs them */
    const hidden = {
      env: this.outerEnv !== null,
      callee: readsSelf || mappedArguments || fn.usesSuper || fn.generator,  // super: its home object, or its parent class; a generator: its prototype
      this: fn.usesThis,
      newTarget: fn.usesNewTarget,
      arguments: takesArguments,
    };
    const names = (Object.keys(hidden) as (keyof typeof hidden)[]).filter((k) => hidden[k]);
    const params = [
      ...names,
      ...node.params.map((p, i) => (p.type === "Identifier" ? p.name : `arg${i}`)),  // a pattern's argument has no name
      ...(node.rest ? [node.rest.type === "Identifier" ? node.rest.name : "rest"] : []),  // the rest array: built by the caller (or the generic entry)
    ];
    this.b = new FunctionBuilder(m.ids.get(node)!, params, fn.strict, node.loc);
    for (const [i, n] of names.entries()) this.hidden[n] = this.b.fn.params[i]!;
    const firstDefault = node.defaults.findIndex((d) => d !== null);
    this.b.fn.meta = {
      jsName: functionName(node.id ? nameOf(node.id) : ""),
      length: firstDefault >= 0 ? firstDefault : node.params.length,  // parameters before the first default or rest
      constructor: (node.type === "FunctionDeclaration" || !node.method || classCtor !== null) && !fn.generator && !fn.async,
      generator: fn.generator,
      async: fn.async,
      classCtor: classCtor ? (classCtor.derived ? "derived" : "base") : null,
      arrow: fn.arrow,
      hasRest: node.rest !== null,
      takesEnv: hidden.env,
      takesCallee: hidden.callee,
      takesThis: hidden.this,
      takesNewTarget: hidden.newTarget,
      source: node.source,
      takesArguments,
    };
    this.envParam = this.hidden.env ?? null;
  }

  /** The hidden parameters that this function takes, by name. */
  private readonly hidden: Partial<Record<"env" | "callee" | "this" | "newTarget" | "arguments", Instr>> = {};

  private get hiddenParams(): number {
    return Object.keys(this.hidden).length;
  }

  /** A derived class constructor: `this` is a binding, uninitialized until super(). */
  private get derivedCtor(): boolean {
    return this.b.fn.meta?.classCtor === "derived";
  }

  run(): FunctionIR {
    const b = this.b;
    const node = this.fn.node;
    if (containsFinally(node.type === "Program" ? node.body : node.body.body)) {
      /* read after a finally on paths that didn't set them */
      b.writeVariable(this.retval, b.const(undefined));
      b.writeVariable(this.pendingException, b.const(undefined));
    }
    if (node.type === "Program") {
      /* a module with top-level await: its body is an async function's */
      if (node.module && this.fn.awaits) {
        b.emit("async_start", []);
        this.startBody();
      }
      /* Slots of top-level bindings: let/const uninitialized (TDZ); a module's vars undefined */
      for (const [binding, slot] of this.slots)
        b.emit("store_global", [binding.kind === "var" ? b.const(undefined) : b.emit("empty", [])], { index: slot });
      /* §16.1.7: the functions, then the vars, as global object properties (a script's) */
      this.hoistFunctions(node.body);
      if (!node.module)
        for (const binding of this.fn.scope.bindings.values())
          if (binding.kind === "var") b.emit("declare_global", [], { key: propKey(binding.name), index: 0 });
      this.statements(node.body);
    } else {
      const hidden = this.hiddenParams;
      if (this.fn.async && !this.fn.generator) {
        /* everything runs in the state machine: even a throwing default rejects the promise (§27.7.5.2) */
        b.emit("async_start", []);
        this.startBody();
      }
      if (this.hidden.this) {
        const raw = this.hidden.this;
        this.thisValue = this.fn.strict ? raw : b.emit("sloppy_this", [raw], { name: "this" });
      }
      this.createEnv(this.fn.scope);
      if (this.derivedCtor) {
        /* uninitialized until super(); captured, the environment already starts EMPTY */
        if (!this.fn.thisBinding!.captured) this.write(this.fn.thisBinding!, b.emit("empty", [], { name: "this" }));
      } else if (this.fn.thisBinding) {
        this.write(this.fn.thisBinding, this.thisValue!);  // arrows inside read it
      }
      /* arrows inside use super or new.target: they read these through the environment */
      if (this.fn.calleeBinding) this.write(this.fn.calleeBinding, this.hidden.callee!);
      if (this.fn.newTargetBinding) this.write(this.fn.newTargetBinding, this.hidden.newTarget!);
      /* a base class constructor initializes the instance's fields before its body (§10.2.2 step 6) */
      if (!this.derivedCtor && node.type === "FunctionExpression" && node.initRef) this.runInitializer(this.thisValue!);
      /* the body's declarations first: parameter defaults may already refer to them */
      for (const binding of this.fn.scope.bindings.values()) {
        if (binding.kind === "var" || binding.kind === "function") this.write(binding, b.const(undefined));  // functions: set by hoisting
        if ((binding.kind === "let" || binding.kind === "const" || binding.kind === "class") && !binding.captured)
          this.write(binding, b.emit("empty", [], { name: binding.name }));  // captured ones: the environment starts EMPTY
      }
      if (this.fn.argumentsBinding) this.write(this.fn.argumentsBinding, this.argumentsObject(node, this.hidden.arguments!));
      if (this.fn.simpleParams) {
        node.params.forEach((p, i) => this.write(this.binding(p as A.Identifier), b.fn.params[hidden + i]!));
      } else {
        /* left to right: a default sees the parameters before it, the later ones are in TDZ */
        const names = (node.rest ? [...node.params, node.rest] : node.params).flatMap(boundNames);
        for (const id of names) if (!this.binding(id).captured) this.write(this.binding(id), b.emit("empty", [], { name: id.name }));
        node.params.forEach((p, i) => {
          const arg = b.fn.params[hidden + i]!;
          const d = node.defaults[i];
          this.destructure(p, d ? this.defaulted(arg, d, p.type === "Identifier" ? nameOf(p) : "") : arg, true);
        });
        if (node.rest) this.destructure(node.rest, b.fn.params[hidden + node.params.length]!, true);
      }
      this.hoistFunctions(node.body.body);
      if (this.fn.generator) {
        /* the prologue ran at call time; the body runs on the first next() (§27.5.3.1) */
        b.emit("gen_start", [this.hidden.callee!]);
        this.startBody();
      }
      this.statements(node.body.body);
    }
    /* falling off the end: undefined, or a derived constructor's (initialized) this */
    if (!b.dead) b.terminate({ kind: "return", value: this.derivedCtor ? this.readThis() : b.const(undefined) });
    return b.finish();
  }

  /** The arguments object (§10.2.11), made before the parameters are initialized: a
   *  default can read it. Mapped: each index aliases its parameter's environment slot. */
  private argumentsObject(node: A.FunctionDeclaration | A.FunctionExpression, args: Instr): Instr {
    const b = this.b;
    const undef = b.const(undefined);
    if (this.fn.strict || !this.fn.simpleParams) return b.emit("make_arguments", [args, undef, undef], { name: "arguments" });
    const slots = this.m.envs.get(this.fn.scope);
    /* duplicate names: only the last one maps */
    const params = node.params as A.Identifier[];  // simple parameters: names only
    const table = params.map((p, i) => (params.slice(i + 1).some((q) => q.name === p.name) ? -1 : slots!.get(this.binding(p))!));
    const env = slots ? b.readVariable(this.envKey(this.fn.scope)) : undef;
    return b.emit("make_arguments", [args, this.hidden.callee!, env], { table, name: "arguments" });
  }

  // ---- Generators -----------------------------------------------------------------------------

  /** After gen_start or async_start: the resume function's first block. */
  private startBody() {
    const b = this.b;
    const start = b.newBlock();
    b.jump(start);
    b.seal(start);
    b.setBlock(start);
  }

  /** `await v`: a pause point resumed by a microtask once v settles; a rejection is an
   *  exception here (§27.7.5.3 Await). */
  private awaitExpr(e: A.AwaitExpression): Instr {
    const b = this.b;
    const value = this.expression(e.argument);
    b.loc = e.loc;
    return b.emit("await", [value]);
  }

  /** `yield v`: a pause point. next(x) resumes with x as its value, throw(e) as an exception
   *  here, return(x) as `return x` here (finally blocks and for…of iterators then run). */
  private yieldExpr(e: A.YieldExpression): Instr {
    const b = this.b;
    let value = e.argument ? this.expression(e.argument) : b.const(undefined);
    b.loc = e.loc;
    if (this.asyncGenerator) value = b.emit("await", [value]);  // §27.6.3.8 Yield: Await first
    const sent = b.emit("yield", [value]);
    /* an async generator resumed by return(v) awaits v, then returns it (AsyncGeneratorUnwrapYieldResumption) */
    this.returnIfResumedByReturn(b.emit("resume_is_return", []), () => (this.asyncGenerator ? b.emit("await", [sent]) : sent));
    return sent;
  }

  private returnIfResumedByReturn(isReturn: Instr, value: () => Instr) {
    const b = this.b;
    const ret = b.newBlock(), cont = b.newBlock();
    b.terminate({ kind: "branch", cond: isReturn, then: ret, else: cont });
    b.seal(ret);
    b.seal(cont);
    b.setBlock(ret);
    b.writeVariable(this.retval, value());
    this.transfer({ kind: "return" }, this.frames.length);
    b.setBlock(cont);
  }

  private get asyncGenerator(): boolean {
    return this.fn.async && this.fn.generator;
  }

  /** `yield* iterable` (§15.5.5): a loop of delegation steps, each forwarding the resume
   *  (next, throw or return) to the inner iterator; its results pass through unwrapped. */
  private yieldStar(e: A.YieldExpression): Instr {
    if (this.asyncGenerator) return this.asyncYieldStar(e);
    const b = this.b;
    const rec = b.emit("ys_start", [this.expression(e.argument!)]);
    b.loc = e.loc;
    const received: VarKey = { name: "received" }, mode: VarKey = { name: "mode" };
    b.writeVariable(received, b.const(undefined));
    b.writeVariable(mode, b.const(0));
    const loop = b.newBlock(), pause = b.newBlock(), finished = b.newBlock(), done = b.newBlock(), ret = b.newBlock();
    b.jump(loop);
    b.setBlock(loop);  // sealed after the back edge
    const out = b.emit("ys_step", [rec, b.readVariable(received), b.readVariable(mode)]);
    const status = b.emit("ys_status", [rec]);
    b.terminate({ kind: "branch", cond: b.emit("strict_eq", [status, b.const(0)]), then: pause, else: finished });
    b.seal(pause);
    b.seal(finished);
    b.setBlock(pause);
    b.writeVariable(received, b.emit("yield_raw", [out]));
    b.writeVariable(mode, b.emit("resume_mode", []));
    b.jump(loop);
    b.seal(loop);
    b.setBlock(finished);
    b.terminate({ kind: "branch", cond: b.emit("strict_eq", [status, b.const(1)]), then: done, else: ret });
    b.seal(done);
    b.seal(ret);
    b.setBlock(ret);  // the inner iterator finished a return(): so does this generator
    b.writeVariable(this.retval, out);
    this.transfer({ kind: "return" }, this.frames.length);
    b.setBlock(done);
    return out;
  }

  /** `yield* iterable` in an async generator (§15.5.5, async): each step's result is
   *  awaited. ays_step starts a step and gives the value to await; ays_settled finishes it
   *  (status 3: await what it gives, then settle again). A return() resumption awaits its
   *  value first, and a rejection there goes to the inner iterator's throw(). */
  private asyncYieldStar(e: A.YieldExpression): Instr {
    const b = this.b;
    const rec = b.emit("async_iter_start", [this.expression(e.argument!)]);
    b.loc = e.loc;
    const outer = b.current.handler;
    const received: VarKey = { name: "received" }, mode: VarKey = { name: "mode" }, pending: VarKey = { name: "pending" };
    b.writeVariable(received, b.const(undefined));
    b.writeVariable(mode, b.const(0));
    const loop = b.newBlock(), settle = b.newBlock();
    const pause = b.newBlock(), other = b.newBlock(), again = b.newBlock(), finished = b.newBlock(), done = b.newBlock(), ret = b.newBlock();
    const plain = b.newBlock(), caught = b.newBlock(outer);
    const awaitReturn = b.newBlock(caught);
    b.jump(loop);
    b.setBlock(loop);  // sealed after the back edges
    b.writeVariable(pending, b.emit("ays_step", [rec, b.readVariable(received), b.readVariable(mode)]));
    b.jump(settle);
    b.setBlock(settle);  // sealed after its back edge
    const out = b.emit("ays_settled", [rec, b.emit("await", [b.readVariable(pending)])]);
    const status = b.emit("ays_status", [rec]);
    const branch = (code: number, then: Block, otherwise: Block) => {
      b.terminate({ kind: "branch", cond: b.emit("strict_eq", [status, b.const(code)]), then, else: otherwise });
      b.seal(then);
      b.seal(otherwise);
    };
    branch(0, pause, other);
    /* yield the inner value as it is (no extra await); how it was resumed is what goes in */
    b.setBlock(pause);
    const sent = b.emit("yield_raw", [out]);
    const resumedBy = b.emit("resume_mode", []);
    b.terminate({ kind: "branch", cond: b.emit("strict_eq", [resumedBy, b.const(2)]), then: awaitReturn, else: plain });
    b.seal(plain);
    b.seal(awaitReturn);
    b.setBlock(plain);
    b.writeVariable(received, sent);
    b.writeVariable(mode, resumedBy);
    b.jump(loop);
    b.setBlock(awaitReturn);  // return(v): v awaited; a rejection becomes a throw() to the inner iterator
    b.writeVariable(received, b.emit("await", [sent]));
    b.writeVariable(mode, b.const(2));
    b.jump(loop);
    b.seal(caught);
    b.setBlock(caught);
    b.writeVariable(received, b.emit("take_exception", []));
    b.writeVariable(mode, b.const(1));
    b.jump(loop);
    b.seal(loop);
    b.setBlock(other);
    branch(3, again, finished);
    b.setBlock(again);
    b.writeVariable(pending, out);
    b.jump(settle);
    b.seal(settle);
    b.setBlock(finished);
    branch(1, done, ret);
    b.setBlock(ret);  // the inner iterator finished a return(): so does this generator
    b.writeVariable(this.retval, out);
    this.transfer({ kind: "return" }, this.frames.length);
    b.setBlock(done);
    return out;
  }

  /** AsyncIteratorClose after a normal completion (a jump out of a for await): return() is
   *  called and its result awaited, then checked to be an object. */
  private asyncIterClose(rec: Instr) {
    const b = this.b;
    const result = b.emit("async_iter_return", [rec]);
    const has = b.newBlock(), after = b.newBlock();
    b.terminate({ kind: "branch", cond: b.emit("not_empty", [result]), then: has, else: after });
    b.seal(has);
    b.setBlock(has);
    b.emit("async_iter_check", [b.emit("await", [result])]);
    b.jump(after);
    b.seal(after);
    b.setBlock(after);
  }

  // ---- Destructuring (§8.6.2 BindingInitialization, §13.15.5 destructuring assignment) ----

  /** Puts `value` into a pattern (or a plain target). `declare`: the leaves are declarations
   *  being initialized; otherwise they are assignment targets. */
  private destructure(p: A.PatternTarget, value: Instr, declare: boolean): void {
    if (p.type === "ObjectPattern") return this.objectPattern(p, value, declare);
    if (p.type === "ArrayPattern") return this.arrayPattern(p, value, declare);
    if (declare && p.type === "Identifier") return this.write(this.binding(p), value);
    this.writeTarget(this.targetRef(p, false), value);
  }

  /** One element: an assignment's plain target is evaluated first, then the value, its default
   *  when undefined (naming an anonymous function after an identifier), then the nested pattern. */
  private patternElement(target: A.PatternTarget, init: A.Expression | null, value: () => Instr, declare: boolean) {
    const nested = target.type === "ObjectPattern" || target.type === "ArrayPattern";
    const ref = !declare && !nested ? this.targetRef(target as A.Target, false) : null;
    let v = value();
    if (init) v = this.defaulted(v, init, target.type === "Identifier" ? nameOf(target) : "");
    if (ref) this.writeTarget(ref, v);
    else this.destructure(target, v, declare);
  }

  /** `{ a, [k]: b = 1, ...rest }`: null and undefined throw; each key is read in order; the
   *  rest copies the other own enumerable properties. */
  private objectPattern(p: A.ObjectPattern, value: Instr, declare: boolean) {
    const b = this.b;
    b.loc = p.loc;
    const obj = b.emit("require_coercible", [value]);
    const keys: Instr[] = [];  // for the rest: the keys already taken
    for (const q of p.properties) {
      b.loc = q.loc;
      let key: PropKey | Instr;
      if (q.computed) key = b.emit("to_property_key", [this.expression(q.key)]);
      else key = propKey(q.key.type === "Identifier" ? q.key.name : ((q.key as A.Literal).value as string | number));
      if (p.rest) keys.push(isConst(key) ? b.const("index" in key ? key.index : key.name) : key);
      this.patternElement(q.target, q.init, () => this.getMember({ obj, key }), declare);
    }
    if (p.rest) this.patternElement(p.rest, null, () => b.emit("object_rest", [obj, b.emit("new_array", keys)]), declare);
  }

  /** `[a, , b = 1, ...rest]`: through the iterator protocol. An exception while the pattern
   *  is filled closes the iterator (unless the iterator itself failed, which marks it done),
   *  and so does finishing before it is exhausted. */
  private arrayPattern(p: A.ArrayPattern, value: Instr, declare: boolean) {
    const b = this.b;
    b.loc = p.loc;
    const rec = b.emit("iter_start", [value]);
    const outer = b.current.handler;
    const landing = b.newBlock(outer), inner = b.newBlock(landing), after = b.newBlock(outer);
    b.jump(inner);
    b.seal(inner);
    b.setBlock(inner);
    for (const e of p.elements) {
      if (!e) b.emit("iter_value", [rec]);  // a hole skips a value
      else this.patternElement(e.target, e.init, () => b.emit("iter_value", [rec]), declare);
    }
    if (p.rest) this.patternElement(p.rest, null, () => b.emit("iter_rest", [rec]), declare);
    b.emit("iter_close", [rec]);  // nothing when exhausted
    b.jump(after);
    b.seal(landing);
    b.setBlock(landing);
    if (!b.dead) {
      const exception = b.emit("take_exception", []);
      b.emit("iter_close_throw", [rec]);
      b.terminate({ kind: "throw", value: exception });
    }
    b.seal(after);
    b.setBlock(after);
  }

  private defaulted(arg: Instr, init: A.Expression, name: string): Instr {
    const b = this.b;
    const result: VarKey = { name };
    b.writeVariable(result, arg);
    b.loc = init.loc;
    const missing = b.emit("strict_eq", [arg, b.const(undefined)]);
    const evaluate = b.newBlock(), join = b.newBlock();
    b.terminate({ kind: "branch", cond: missing, then: evaluate, else: join });
    b.seal(evaluate);
    b.setBlock(evaluate);
    b.writeVariable(result, this.named(init, name));
    b.jump(join);
    b.seal(join);
    b.setBlock(join);
    return b.readVariable(result);
  }

  /** Function declarations of a body: their objects exist before its first statement
   *  (hoisting), in source order, so the last of duplicates wins. */
  private hoistFunctions(body: A.Statement[]) {
    for (const s of body) {
      if (s.type !== "FunctionDeclaration") continue;
      this.b.loc = s.loc;
      const binding = this.binding(s.id);
      const fn = this.makeFunction(s, s.id.name);
      if (this.isGlobalVar(binding)) this.b.emit("declare_global", [fn], { key: propKey(binding.name), index: 1 });
      else this.write(binding, fn);
    }
  }

  /** A function object, closing over the current environment if the function needs one. */
  private makeFunction(node: A.FunctionDeclaration | A.FunctionExpression, name?: string): Instr {
    const b = this.b;
    const target = this.m.ids.get(node)!;
    const fn = this.info.functions.get(node)!;
    const outer = outerEnvScope(this.m, fn);
    if (!outer) return b.emit("make_function", [], { target, ...(name ? { name } : {}) });
    if (node.type === "FunctionExpression" && node.id && outer === fn.scope.parent) {
      /* a named expression whose own name is captured: an environment holding the function */
      const env = b.emit("env_new", [this.currentEnv()], { index: 1 });
      const f = b.emit("make_function", [env], { target });
      b.emit("env_store", [env, f], { index: 0, slot: 0 });
      return f;
    }
    return b.emit("make_function", [this.currentEnv()], { target, ...(name ? { name } : {}) });
  }

  /** A function object for a function expression or method, named from its context. */
  private functionValue(e: A.FunctionExpression, inferredName?: string): Instr {
    if (!e.id && inferredName !== undefined) this.m.inferredNames.set(e, functionName(inferredName));
    this.b.loc = e.loc;
    return this.makeFunction(e);
  }

  /** An expression that may be an anonymous function taking its name from the context (§8.4 NamedEvaluation). */
  private named(e: A.Expression, name: string): Instr {
    if (e.type === "FunctionExpression") return this.functionValue(e, name);
    if (e.type === "ClassExpression" && !e.id) return this.classValue(e, name);
    return this.expression(e);
  }

  // ---- Bindings ------------------------------------------------------------

  private binding(id: A.Identifier): Binding {
    return this.info.declarations.get(id)!;
  }

  // ---- Environments --------------------------------------------------------

  /** The key under which a scope's environment is an SSA variable of this function. */
  private readonly envKeys = new Map<Scope, VarKey>();

  private envKey(scope: Scope): VarKey {
    let k = this.envKeys.get(scope);
    if (!k) this.envKeys.set(scope, (k = { name: "env" }));
    return k;
  }

  /** The innermost environment at this point: a scope's of this function, else the one it closes over. */
  private currentEnv(): Instr {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const s = this.scopeStack[i]!;
      if (this.m.envs.has(s) && this.envKeys.has(s)) return this.b.readVariable(this.envKey(s));
    }
    return this.envParam ?? this.b.const(undefined);
  }

  /** On entry to a scope with captured bindings: its environment, linked to the current one. */
  private createEnv(scope: Scope) {
    const slots = this.m.envs.get(scope);
    if (!slots) return;
    const env = this.b.emit("env_new", [this.currentEnv()], { index: slots.size, name: "env" });
    this.b.writeVariable(this.envKey(scope), env);
  }

  /** Where a captured binding lives from here: an environment value and the parents to climb. */
  private envAccess(binding: Binding): { env: Instr; depth: number; slot: number } {
    const scope = binding.scope;
    const slot = this.m.envs.get(scope)!.get(binding)!;
    if (this.envKeys.has(scope) && scope.func === this.fn && scope.kind !== "self")
      return { env: this.b.readVariable(this.envKey(scope)), depth: 0, slot };
    /* outside this function: climb from the environment it closes over */
    let depth = 0;
    for (let s = this.outerEnv; s !== scope; s = envScopeFrom(this.m, s!.parent)) {
      if (!s) throw new Error(`binding '${binding.name}' is not in an enclosing environment`);
      depth++;
    }
    return { env: this.envParam!, depth, slot };
  }

  /** A script's top-level var or function: a property of the global object. */
  private isGlobalVar(binding: Binding): boolean {
    return binding.scope === this.info.program.scope && (binding.kind === "var" || binding.kind === "function") &&
      !(this.info.program.node as A.Program).module;
  }

  private isLocal(binding: Binding): boolean {
    if (this.slots.has(binding) || this.isGlobalVar(binding)) return false;
    if (binding.captured) return false;
    if (binding.scope.func !== this.fn) throw new Error(`'${binding.name}' is another function's and not captured`);
    return true;
  }

  private write(binding: Binding, value: Instr) {
    if (this.m.static && binding.node.int && value.op !== "empty") value = this.toInt(value, binding.node.int);
    if (this.isGlobalVar(binding)) {
      this.b.emit("set_prop", [this.b.emit("global_this", []), value], { key: propKey(binding.name) });
      return;
    }
    if (this.isLocal(binding)) {
      if (!value.name && value.op !== "param") value.name = binding.name;
      this.b.writeVariable(binding, value);
    } else if (binding.captured && !this.slots.has(binding)) {
      const { env, depth, slot } = this.envAccess(binding);
      this.b.emit("env_store", [env, value], { index: depth, slot });
    } else {
      this.b.emit("store_global", [value], { index: this.slots.get(binding)! });
    }
  }

  private read(ref: { binding: Binding | null; tdz: boolean }, id: A.Identifier, forTypeof = false): Instr {
    const b = this.b;
    const binding = ref.binding;
    if (!binding) {
      if (id.name in CONSTANT_GLOBALS) return b.const(CONSTANT_GLOBALS[id.name]);
      return b.emit(forTypeof ? "global_typeof_name" : "global_name", [], { target: id.name });
    }
    if (binding.kind === "self" && binding.scope.func === this.fn) {
      /* a named function expression's own name, inside it: the callee */
      return this.hidden.callee!;
    }
    let v: Instr;
    if (this.isGlobalVar(binding)) return b.emit("get_prop", [b.emit("global_this", [])], { key: propKey(binding.name), name: binding.name });
    if (this.isLocal(binding)) v = b.readVariable(binding);
    else if (binding.captured && !this.slots.has(binding)) {
      const { env, depth, slot } = this.envAccess(binding);
      v = b.emit("env_load", [env], { index: depth, slot, name: binding.name });
    } else v = b.emit("load_global", [], { index: this.slots.get(binding)!, name: binding.name });
    return ref.tdz ? b.emit("check_tdz", [v], { name: binding.name }) : v;
  }

  /** Static code: whether `e` is an integer, as C's types say: an int binding, an integer
   *  literal, a call of a function declared to return one, or integer arithmetic of those. A
   *  `number` is a double, whatever values it holds. */
  private isInt(e: A.Expression): boolean {
    if (!this.m.static) return false;
    const declared = (id: A.Identifier) => this.info.references.get(id)?.binding?.node;
    switch (e.type) {
      case "Literal": return typeof e.value === "number" && Number.isInteger(e.value) && !e.float;
      case "Identifier": return declared(e)?.int !== undefined;
      case "UnaryExpression": return (e.operator === "-" || e.operator === "~") && this.isInt(e.argument);
      case "UpdateExpression": return this.isInt(e.argument as A.Expression);
      case "BinaryExpression": return INT_OPERATORS.has(e.operator) && this.isInt(e.left) && this.isInt(e.right);
      case "AssignmentExpression": return e.target.type === "Identifier" && this.isInt(e.target);
      case "ConditionalExpression": return this.isInt(e.consequent) && this.isInt(e.alternate);
      case "CallExpression": return e.callee.type === "Identifier" && declared(e.callee)?.returnsInt !== undefined;
      default: return false;
    }
  }

  /** Static code's integer arithmetic, C's: / and % by a constant other than 0 can't throw. */
  private int64(operator: A.BinaryOperator, left: Instr, right: Instr): Instr {
    const division = operator === "/" || operator === "%";
    if (division && !(right.op === "const" && right.lit!.value !== 0)) return this.b.emit(operator === "/" ? "int_div" : "int_mod", [left, right]);
    return this.b.emit("i64", [left, right], { target: operator });
  }

  /** Static code: `value` converted to an integer, as C converts what is stored in one. */
  private toInt(value: Instr, kind: IntKind): Instr {
    const op = kind === "i32" ? "to_i32" : "to_i64";
    if (value.op === op || (kind === "i64" && (value.op === "i64" || value.op === "int_div" || value.op === "int_mod"))) return value;
    return this.b.emit(op, [value]);
  }

  /** Assigns to an identifier (not a declaration's initialization). */
  private assign(id: A.Identifier, value: Instr) {
    const ref = this.info.references.get(id)!;
    const binding = ref.binding;
    if (!binding) {
      /* no declaration: a property of the global object (strict code: only an existing one) */
      this.b.emit("set_global_name", [value], { key: propKey(id.name) });
      return;
    }
    if (ref.tdz) this.read(ref, id);  // a write before initialization is a ReferenceError too
    if (binding.kind === "self") {
      /* immutable: ignored in sloppy code, a TypeError in strict code */
      if (this.fn.strict) this.b.emit("call_runtime", [], { target: "throw_const_assign" });
      return;
    }
    if (binding.kind === "const") {
      this.b.emit("call_runtime", [], { target: "throw_const_assign" });
      return;
    }
    this.write(binding, value);
  }

  // ---- Statements ------------------------------------------------------------

  private statements(list: A.Statement[]) {
    for (const s of list) {
      if (this.b.dead) return;  // after return/break/throw: unreachable, nothing to emit
      this.statement(s);
    }
  }

  /** Entering a block scope: its environment, if it has captured bindings; let/const start
   *  uninitialized on each entry (TDZ). Every enterScope is matched by an exitScope. */
  private enterScope(scope: Scope | undefined, body: A.Statement[] = []) {
    if (!scope) return;
    this.scopeStack.push(scope);
    this.createEnv(scope);
    for (const binding of scope.bindings.values()) {
      if ((binding.kind === "let" || binding.kind === "const" || binding.kind === "class") && !binding.captured)
        this.write(binding, this.b.emit("empty", [], { name: binding.name }));
    }
    /* the block's function declarations exist from its start (B.3.3: in sloppy code too) */
    this.hoistFunctions(body);
  }

  private exitScope(scope: Scope | undefined) {
    if (!scope) return;
    if (this.scopeStack.pop() !== scope) throw new Error("unbalanced scopes");
  }

  /** `for (let …)`: each iteration gets its own copy of the head's environment (§14.7.4.4). */
  private copyIterationEnv(scope: Scope | undefined) {
    if (!scope || !this.m.envs.has(scope)) return;
    const key = this.envKey(scope);
    this.b.writeVariable(key, this.b.emit("env_copy", [this.b.readVariable(key)], { name: "env" }));
  }

  private statement(s: A.Statement): void {
    const b = this.b;
    b.loc = s.loc;
    switch (s.type) {
      case "ExportLocals":
        return;  // the module is the whole program: nothing imports its exports
      case "VariableDeclaration":
        for (const d of s.declarations) {
          b.loc = d.loc;
          if (d.id.type !== "Identifier") this.destructure(d.id, this.expression(d.init!), true);
          else if (d.init) this.write(this.binding(d.id), this.named(d.init, nameOf(d.id)));
          else if (s.kind !== "var") this.write(this.binding(d.id), b.const(undefined));
        }
        return;
      case "FunctionDeclaration": {
        /* hoisted: its object was created on entry to its block. `if (x) function f() {}` and a
         * labelled function are blocks of their own (B.3.4) */
        const branch = this.info.branchBlocks.get(s);
        if (branch) this.enterScope(branch, [s]);
        /* Annex B.3.3: in sloppy code, evaluating the declaration also sets the function's var */
        const binding = this.binding(s.id);
        if (binding.annexBVar) this.write(binding.annexBVar, this.loadBinding(binding));
        if (branch) this.exitScope(branch);
        return;
      }
      case "ClassDeclaration":
        this.write(this.binding(s.id), this.classValue(s));
        return;
      case "ExpressionStatement":
        this.expression(s.expression);
        return;
      case "BlockStatement": {
        const scope = this.info.scopes.get(s);
        this.enterScope(scope, s.body);
        this.statements(s.body);
        this.exitScope(scope);
        return;
      }
      case "EmptyStatement":
        return;
      case "IfStatement":
        return this.ifStatement(s);
      case "WhileStatement":
      case "DoWhileStatement":
      case "ForStatement":
        return this.loop(s, []);
      case "ForInStatement":
        return this.forIn(s, []);
      case "ForOfStatement":
        return this.forOf(s, []);
      case "LabeledStatement":
        return this.labeled(s, []);
      case "BreakStatement":
        return this.breakOrContinue("break", s.label?.name ?? null);
      case "ContinueStatement":
        return this.breakOrContinue("continue", s.label?.name ?? null);
      case "ReturnStatement": {
        let value = s.argument ? this.expression(s.argument) : b.const(undefined);
        if (s.argument && this.asyncGenerator) value = b.emit("await", [value]);  // §15.5.5: return awaits in async generators
        const returnsInt = this.fn.node.type === "Program" ? undefined : this.fn.node.returnsInt;
        if (this.m.static && returnsInt) value = this.toInt(value, returnsInt);
        /* a derived constructor returns an object, or its (initialized) this (§10.2.2 steps 10–12) */
        if (this.derivedCtor)
          value = s.argument ? b.emit("derived_return", [value, this.loadBinding(this.fn.thisBinding!)]) : this.readThis();
        b.writeVariable(this.retval, value);
        return this.transfer({ kind: "return" }, this.frames.length);
      }
      case "ThrowStatement":
        b.terminate({ kind: "throw", value: this.expression(s.argument) });
        return;
      case "TryStatement":
        return this.tryStatement(s);
      case "SwitchStatement":
        return this.switchStatement(s, []);
      case "Unsupported":
        return notSupported(s.detail, s);
    }
  }

  private ifStatement(s: A.IfStatement) {
    const b = this.b;
    const cond = this.expression(s.test);
    const then = b.newBlock(), otherwise = b.newBlock(), join = b.newBlock();
    b.terminate({ kind: "branch", cond, then, else: s.alternate ? otherwise : join });
    b.seal(then);
    b.seal(otherwise);
    b.setBlock(then);
    this.statement(s.consequent);
    if (!b.dead) b.jump(join);
    if (s.alternate) {
      b.setBlock(otherwise);
      this.statement(s.alternate);
      if (!b.dead) b.jump(join);
    }
    b.seal(join);
    b.setBlock(join);
  }

  private labeled(s: A.LabeledStatement, labels: string[]): void {
    const all = [...labels, s.label.name];
    const body = s.body;
    if (body.type === "LabeledStatement") return this.labeled(body, all);
    if (body.type === "WhileStatement" || body.type === "DoWhileStatement" || body.type === "ForStatement") return this.loop(body, all);
    if (body.type === "ForInStatement") return this.forIn(body, all);
    if (body.type === "ForOfStatement") return this.forOf(body, all);
    if (body.type === "SwitchStatement") return this.switchStatement(body, all);
    /* a labelled block or statement: only `break L` targets its end */
    const after = this.b.newBlock();
    this.frames.push({ kind: "break", labels: all, plainBreak: false, breakTarget: after, continueTarget: null });
    this.statement(body);
    this.frames.pop();
    if (!this.b.dead) this.b.jump(after);
    this.b.seal(after);
    this.b.setBlock(after);
  }

  private loop(s: A.WhileStatement | A.DoWhileStatement | A.ForStatement, labels: string[]) {
    const b = this.b;
    const exit = b.newBlock();

    if (s.type === "DoWhileStatement") {
      /* body first; the test at the bottom is the continue target */
      const body = b.newBlock(), test = b.newBlock();
      b.jump(body);
      b.setBlock(body);  // sealed after the back edge
      this.loopBody(s.body, labels, exit, test);
      b.seal(test);
      b.setBlock(test);
      if (!b.dead) b.terminate({ kind: "branch", cond: this.expression(s.test), then: body, else: exit });
      b.seal(body);
    } else {
      if (s.type === "ForStatement") {
        this.enterScope(this.info.scopes.get(s));
        if (s.init?.type === "VariableDeclaration") this.statement(s.init);
        else if (s.init) this.expression(s.init);
        this.copyIterationEnv(this.info.scopes.get(s));
      }
      const header = b.newBlock(), body = b.newBlock();  // header: sealed after the back edges
      const update = s.type === "ForStatement" ? b.newBlock() : header;  // the continue target
      b.jump(header);
      b.setBlock(header);
      if (s.test) b.terminate({ kind: "branch", cond: this.expression(s.test), then: body, else: exit });
      else b.jump(body);
      b.seal(body);
      b.setBlock(body);
      this.loopBody(s.body, labels, exit, update);
      if (update !== header) {
        b.seal(update);
        b.setBlock(update);
        if (!b.dead) {
          if (s.type === "ForStatement") this.copyIterationEnv(this.info.scopes.get(s));
          if (s.type === "ForStatement" && s.update) this.expression(s.update);
          b.jump(header);
        }
      }
      b.seal(header);
      if (s.type === "ForStatement") this.exitScope(this.info.scopes.get(s));
    }
    b.seal(exit);
    b.setBlock(exit);
  }

  /** for…in (§14.7.5): the runtime walks the keys (for_in_next: the next key, or undefined
   *  when done). let/const get a fresh environment each iteration, like `for (let …)`. */
  private forIn(s: A.ForInStatement, labels: string[]) {
    const b = this.b;
    const head = this.info.scopes.get(s);
    this.enterScope(head);  // let/const in TDZ while the object is evaluated
    const iter = b.emit("for_in_start", [this.expression(s.right)]);
    const header = b.newBlock(), body = b.newBlock(), exit = b.newBlock();
    b.jump(header);
    b.setBlock(header);  // sealed after the back edges
    const key = b.emit("for_in_next", [iter]);
    b.terminate({ kind: "branch", cond: b.emit("strict_ne", [key, b.const(undefined)]), then: body, else: exit });
    b.seal(body);
    b.setBlock(body);
    this.copyIterationEnv(head);
    b.loc = s.left.loc;
    /* a member target is evaluated each iteration */
    if (s.left.type === "VariableDeclaration") this.destructure(s.left.declarations[0]!.id, key, true);
    else this.destructure(s.left, key, false);
    this.loopBody(s.body, labels, exit, header);
    b.seal(header);
    this.exitScope(head);
    b.seal(exit);
    b.setBlock(exit);
  }

  /** for…of (§14.7.5): the runtime steps the iterator (iter_next: the next value, or EMPTY
   *  when done). Leaving the loop early closes the iterator: a jump out through transfer(),
   *  an exception in the body through a landing block that closes and rethrows. An
   *  exception from the iterator itself (next()) doesn't close it. */
  private forOf(s: A.ForOfStatement, labels: string[]) {
    if (s.await) return this.forAwaitOf(s, labels);
    const b = this.b;
    const head = this.info.scopes.get(s);
    this.enterScope(head);  // let/const in TDZ while the iterable is evaluated
    const rec = b.emit("iter_start", [this.expression(s.right)]);
    const outer = b.current.handler;
    const header = b.newBlock(outer), exit = b.newBlock(outer), landing = b.newBlock(outer);
    const body = b.newBlock(landing);
    b.jump(header);
    b.setBlock(header);  // sealed after the back edges
    const value = b.emit("iter_next", [rec]);
    b.terminate({ kind: "branch", cond: b.emit("not_empty", [value]), then: body, else: exit });
    b.seal(body);
    b.setBlock(body);
    this.frames.push({ kind: "break", labels, plainBreak: true, breakTarget: exit, continueTarget: header });
    this.frames.push({ kind: "iterator", rec, loopFrame: this.frames.length - 1, async: false });
    this.copyIterationEnv(head);
    b.loc = s.left.loc;
    if (s.left.type === "VariableDeclaration") this.destructure(s.left.declarations[0]!.id, value, true);
    else this.destructure(s.left, value, false);
    this.statement(s.body);
    this.frames.pop();
    this.frames.pop();
    if (!b.dead) b.jump(header);
    b.seal(header);
    /* an exception in the body (or the binding): close the iterator, then rethrow */
    b.seal(landing);
    b.setBlock(landing);
    if (!b.dead) {
      const exception = b.emit("take_exception", []);
      b.emit("iter_close_throw", [rec]);
      b.terminate({ kind: "throw", value: exception });
    }
    this.exitScope(head);
    b.seal(exit);
    b.setBlock(exit);
  }

  /** for await (§14.7.5, async): each next() result is awaited. Leaving early awaits the
   *  iterator's return(); after an exception, errors while closing are ignored. */
  private forAwaitOf(s: A.ForOfStatement, labels: string[]) {
    const b = this.b;
    const head = this.info.scopes.get(s);
    this.enterScope(head);
    const rec = b.emit("async_iter_start", [this.expression(s.right)]);
    const outer = b.current.handler;
    const header = b.newBlock(outer), exit = b.newBlock(outer), landing = b.newBlock(outer);
    const body = b.newBlock(landing);
    b.jump(header);
    b.setBlock(header);  // sealed after the back edges
    const result = b.emit("await", [b.emit("async_iter_next", [rec])]);
    const value = b.emit("async_iter_value", [rec, result]);
    b.terminate({ kind: "branch", cond: b.emit("not_empty", [value]), then: body, else: exit });
    b.seal(body);
    b.setBlock(body);
    this.frames.push({ kind: "break", labels, plainBreak: true, breakTarget: exit, continueTarget: header });
    this.frames.push({ kind: "iterator", rec, loopFrame: this.frames.length - 1, async: true });
    this.copyIterationEnv(head);
    b.loc = s.left.loc;
    if (s.left.type === "VariableDeclaration") this.destructure(s.left.declarations[0]!.id, value, true);
    else this.destructure(s.left, value, false);
    this.statement(s.body);
    this.frames.pop();
    this.frames.pop();
    if (!b.dead) b.jump(header);
    b.seal(header);
    /* an exception in the body: close (awaiting return(), ignoring its errors), then rethrow */
    b.seal(landing);
    b.setBlock(landing);
    if (!b.dead) {
      const exception = b.emit("take_exception", []);
      const ignore = b.newBlock(outer), rethrow = b.newBlock(outer);
      const closing = b.newBlock(ignore), wait = b.newBlock(ignore);
      b.jump(closing);
      b.seal(closing);
      b.setBlock(closing);
      const closed = b.emit("async_iter_return", [rec]);
      b.terminate({ kind: "branch", cond: b.emit("not_empty", [closed]), then: wait, else: rethrow });
      b.seal(wait);
      b.setBlock(wait);
      b.emit("await", [closed]);
      b.jump(rethrow);
      b.seal(ignore);
      b.setBlock(ignore);
      b.emit("take_exception", []);
      b.jump(rethrow);
      b.seal(rethrow);
      b.setBlock(rethrow);
      b.terminate({ kind: "throw", value: exception });
    }
    this.exitScope(head);
    b.seal(exit);
    b.setBlock(exit);
  }

  private loopBody(body: A.Statement, labels: string[], exit: Block, next: Block) {
    this.frames.push({ kind: "break", labels, plainBreak: true, breakTarget: exit, continueTarget: next });
    this.statement(body);
    this.frames.pop();
    if (!this.b.dead) this.b.jump(next);
  }

  private switchStatement(s: A.SwitchStatement, labels: string[]) {
    const b = this.b;
    const discriminant = this.expression(s.discriminant);
    const scope = this.info.scopes.get(s);
    this.enterScope(scope, s.cases.flatMap((c) => c.consequent));
    const exit = b.newBlock();
    const bodies = s.cases.map(() => b.newBlock());
    /* cases that are all string literals (React's on tag and attribute names): one runtime call
     * finds the first that matches, and each test compares its index */
    const tests = s.cases.flatMap((c) => (c.test ? [c.test] : []));
    const strings = tests.length >= 2 && tests.every((t) => t.type === "Literal" && typeof t.value === "string")
      ? tests.map((t) => (t as A.Literal).value as string) : null;
    const index = strings && b.emit("switch_string", [discriminant], { cases: strings });
    let k = 0;
    /* tests, in order; then the default clause (wherever it is), or out */
    s.cases.forEach((c, i) => {
      if (!c.test) return;
      b.loc = c.loc;
      const eq = index ? b.emit("strict_eq", [index, b.const(k++)]) : b.emit("strict_eq", [discriminant, this.expression(c.test)]);
      const next = b.newBlock();
      b.terminate({ kind: "branch", cond: eq, then: bodies[i]!, else: next });
      b.seal(next);
      b.setBlock(next);
    });
    const defaultIndex = s.cases.findIndex((c) => !c.test);
    b.jump(defaultIndex >= 0 ? bodies[defaultIndex]! : exit);

    this.frames.push({ kind: "break", labels, plainBreak: true, breakTarget: exit, continueTarget: null });
    s.cases.forEach((c, i) => {
      b.seal(bodies[i]!);  // preds: its test, the default jump, fallthrough from the previous body
      b.setBlock(bodies[i]!);
      this.statements(c.consequent);
      if (!b.dead) b.jump(bodies[i + 1] ?? exit);  // fall through
    });
    this.frames.pop();
    this.exitScope(scope);
    b.seal(exit);
    b.setBlock(exit);
  }

  private breakOrContinue(kind: "break" | "continue", label: string | null) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f.kind !== "break") continue;
      const matches = label ? f.labels.includes(label) : kind === "break" ? f.plainBreak : f.continueTarget !== null;
      if (matches && (kind === "break" || f.continueTarget)) return this.transfer({ kind, frame: i }, this.frames.length);
    }
    throw new Error(`no target for ${kind} ${label ?? ""}`);  // sema checked it
  }

  /**
   * Jumps to a break/continue target or out of the function, from a point
   * nested inside frames[0 .. below). The first finally on the way intercepts
   * the jump; its dispatch calls transfer() again from outside it.
   */
  private transfer(to: { kind: "break" | "continue"; frame: number } | { kind: "return" }, below: number) {
    const b = this.b;
    const targetFrame = to.kind === "return" ? -1 : to.frame;
    for (let i = below - 1; i > targetFrame; i--) {
      const f = this.frames[i]!;
      if (f.kind === "iterator") {
        /* leaving a for…of closes its iterator; continuing the same loop doesn't */
        if (!(to.kind === "continue" && to.frame === f.loopFrame)) {
          if (f.async) this.asyncIterClose(f.rec);
          else b.emit("iter_close", [f.rec]);
        }
        continue;
      }
      if (f.kind !== "finally") continue;
      const key = to.kind === "return" ? "return" : `${to.kind}:${to.frame}`;
      let exit = f.exits.find((e) => e.key === key);
      if (!exit) {
        exit = { code: f.exits.length + 2, key, perform: () => this.transfer(to, i) };
        f.exits.push(exit);
      }
      b.writeVariable(f.completion, b.const(exit.code));
      b.jump(f.entry);
      return;
    }
    if (to.kind === "return") {
      b.terminate({ kind: "return", value: b.readVariable(this.retval) });
    } else {
      const f = this.frames[to.frame] as BreakFrame;
      b.jump(to.kind === "break" ? f.breakTarget : f.continueTarget!);
    }
  }

  private tryStatement(s: A.TryStatement) {
    const b = this.b;
    const outer = b.current.handler;
    const after = b.newBlock(outer);

    /* finally: entered normally (NORMAL), by an exception (THROW), or by a crossing jump (exit code) */
    let fin: FinallyFrame | null = null;
    let finallyLanding: Block | null = null;
    if (s.finalizer) {
      fin = { kind: "finally", entry: b.newBlock(outer), completion: { name: "completion" }, exits: [] };
      finallyLanding = b.newBlock(outer);
    }
    const catchLanding = s.handler ? b.newBlock(finallyLanding ?? outer) : null;

    if (fin) this.frames.push(fin);
    const tryBlock = b.newBlock(catchLanding ?? finallyLanding);
    b.jump(tryBlock);
    b.seal(tryBlock);
    b.setBlock(tryBlock);
    this.statement(s.block);
    const leave = () => {
      if (b.dead) return;
      if (fin) {
        b.writeVariable(fin.completion, b.const(NORMAL));
        b.jump(fin.entry);
      } else {
        b.jump(after);
      }
    };
    leave();

    if (s.handler && catchLanding) {
      b.seal(catchLanding);
      b.setBlock(catchLanding);
      b.loc = s.handler.loc;
      const exception = b.emit("take_exception", []);
      const catchScope = this.info.scopes.get(s.handler);
      this.enterScope(catchScope);
      if (s.handler.param) this.destructure(s.handler.param, exception, true);
      this.statement(s.handler.body);
      this.exitScope(catchScope);
      leave();
    }
    if (fin) this.frames.pop();

    if (fin && finallyLanding && s.finalizer) {
      b.seal(finallyLanding);
      b.setBlock(finallyLanding);
      if (!b.dead) {  /* nothing before the finally can throw: no exceptional entry */
        b.writeVariable(this.pendingException, b.emit("take_exception", []));
        b.writeVariable(fin.completion, b.const(THROW));
        b.jump(fin.entry);
      }

      b.seal(fin.entry);
      b.setBlock(fin.entry);
      this.statement(s.finalizer);
      if (!b.dead) {
        /* dispatch on how the finally was entered */
        const completion = b.readVariable(fin.completion);
        const cases: { code: number; perform: () => void }[] = [
          { code: NORMAL, perform: () => b.jump(after) },
          { code: THROW, perform: () => b.terminate({ kind: "throw", value: b.readVariable(this.pendingException) }) },
          ...fin.exits,
        ];
        cases.forEach((c, i) => {
          if (i === cases.length - 1) return c.perform();  // the last case needs no test
          const is = b.emit("strict_eq", [completion, b.const(c.code)]);
          const yes = b.newBlock(), no = b.newBlock();
          b.terminate({ kind: "branch", cond: is, then: yes, else: no });
          b.seal(yes);
          b.seal(no);
          b.setBlock(yes);
          c.perform();
          b.setBlock(no);
        });
      }
    }
    b.seal(after);
    b.setBlock(after);
  }

  // ---- Expressions -------------------------------------------------------------

  private expression(e: A.Expression): Instr {
    const b = this.b;
    b.loc = e.loc;
    switch (e.type) {
      case "Literal":
        return b.const(e.value);
      case "BigIntLiteral":
        return b.emit("bigint", [], { bigint: e.value });
      case "RegExpLiteral":
        return b.emit("regexp", [], { regexp: { pattern: e.pattern, flags: e.flags } });
      case "Identifier":
        return this.read(this.info.references.get(e)!, e);
      case "UnaryExpression": {
        if (e.operator === "delete") return this.delete(e);
        const v = e.operator === "typeof" && e.argument.type === "Identifier"
          ? this.read(this.info.references.get(e.argument)!, e.argument, true)
          : this.expression(e.argument);
        b.loc = e.loc;
        if ((e.operator === "-" || e.operator === "~") && this.isInt(e.argument))
          return e.operator === "-" ? this.int64("-", b.const(0), v) : this.int64("^", v, b.const(-1));
        switch (e.operator) {
          case "-": return b.emit("neg", [v]);
          case "+": return b.emit("to_number", [v]);
          case "!": return b.emit("not", [v]);
          case "~": return b.emit("bitnot", [v]);
          case "typeof": return b.emit("typeof", [v]);
          case "void": return b.const(undefined);
        }
        break;
      }
      case "UpdateExpression": {
        const target = this.targetRef(e.argument, true);
        const old = this.readTarget(target);
        b.loc = e.loc;
        if (this.isInt(e.argument)) {
          const updated = this.int64(e.operator === "++" ? "+" : "-", old, b.const(1));
          this.writeTarget(target, updated);
          return e.prefix ? updated : old;
        }
        const num = b.emit("to_numeric", [old]);
        const updated = b.emit(e.operator === "++" ? "inc" : "dec", [num]);
        this.writeTarget(target, updated);
        return e.prefix ? updated : num;
      }
      case "BinaryExpression": {
        if (e.operator === "in" && e.left.type === "Identifier" && e.left.name.startsWith("#")) {
          const name = this.expression(e.left), obj = this.expression(e.right);
          b.loc = e.loc;
          return b.emit("private_in", [name, obj]);
        }
        const left = this.expression(e.left);
        const right = this.expression(e.right);
        b.loc = e.loc;
        if (this.isInt(e)) return this.int64(e.operator, left, right);
        return b.emit(BINARY[e.operator], [left, right]);
      }
      case "LogicalExpression":
        return this.logical(e.operator, () => this.expression(e.left), () => this.expression(e.right));
      case "AssignmentExpression":
        return this.assignment(e);
      case "ConditionalExpression": {
        const result: VarKey = {};
        const cond = this.expression(e.test);
        const then = b.newBlock(), otherwise = b.newBlock(), join = b.newBlock();
        b.terminate({ kind: "branch", cond, then, else: otherwise });
        b.seal(then);
        b.seal(otherwise);
        b.setBlock(then);
        b.writeVariable(result, this.expression(e.consequent));
        b.jump(join);
        b.setBlock(otherwise);
        b.writeVariable(result, this.expression(e.alternate));
        b.jump(join);
        b.seal(join);
        b.setBlock(join);
        return b.readVariable(result);
      }
      case "CallExpression":
        return this.call(e);
      case "NewExpression": {
        const ctor = this.directConstructor(e);
        const callee = this.expression(e.callee);
        if (ctor) {
          /* every argument is evaluated; the constructor gets exactly its parameters */
          const args = e.arguments.map((a) => this.expression(a as A.Expression));
          while (args.length < ctor.params.length) args.push(b.const(undefined));
          b.loc = e.loc;
          return b.emit("construct_direct", [callee, ...args.slice(0, ctor.params.length)], { target: this.m.ids.get(ctor)!, text: calleeText(e.callee) });
        }
        if (hasSpread(e.arguments)) {
          const list = this.argumentList(e.arguments);
          b.loc = e.loc;
          return b.emit("new_spread", [callee, list], { target: calleeText(e.callee) });
        }
        const args = e.arguments.map((a) => this.expression(a as A.Expression));
        b.loc = e.loc;
        return b.emit("new", [callee, ...args], { target: calleeText(e.callee) });
      }
      case "MemberExpression": {
        const ref = this.memberRef(e);
        b.loc = e.loc;
        return this.getMember(ref);
      }
      case "ChainExpression":
        return this.chain(() => this.expression(e.expression), () => b.const(undefined));
      case "ObjectExpression":
        return this.objectLiteral(e);
      case "ArrayExpression": {
        if (hasSpread(e.elements)) return this.argumentList(e.elements);
        const elements = e.elements.map((x) => (x ? this.expression(x as A.Expression) : b.emit("empty", [])));
        b.loc = e.loc;
        return b.emit("new_array", elements);
      }
      case "ThisExpression":
        return this.thisExpr();
      case "HostFunction":
        b.loc = e.loc;
        return b.emit("host_function", [], { target: e.name });
      case "TemplateLiteral": {
        /* head + ToString(e1) + middle + …: ToString, not + (it prefers toString to valueOf) */
        let acc: Instr | null = e.quasis[0] ? b.const(e.quasis[0]) : null;
        for (let i = 0; i < e.expressions.length; i++) {
          const v = this.expression(e.expressions[i]!);
          b.loc = e.loc;
          const s = b.emit("to_string", [v]);
          acc = acc ? b.emit("add", [acc, s]) : s;
          const quasi = e.quasis[i + 1]!;
          if (quasi) acc = b.emit("add", [acc, b.const(quasi)]);
        }
        return acc ?? b.const("");
      }
      case "TemplateObject": {
        const slot = this.m.globals.length;
        this.m.globals.push({ name: "template", slot });
        b.loc = e.loc;
        return b.emit("template_object", [], { index: slot, template: { cooked: e.cooked, raw: e.raw } });
      }
      case "ImportMeta": {
        let slot = this.m.importMetaSlots.get(e.file);
        if (slot === undefined) {
          slot = this.m.globals.length;
          this.m.globals.push({ name: "import.meta", slot });
          this.m.importMetaSlots.set(e.file, slot);
        }
        b.loc = e.loc;
        return b.emit("import_meta", [], { index: slot, target: e.file, slot: e.main ? 1 : 0 });
      }
      case "ImportCall": {
        const source = this.expression(e.source);
        const options = e.options ? this.expression(e.options) : b.const(undefined);
        b.loc = e.loc;
        return b.emit("dynamic_import", [source, options], { target: e.file });
      }
      case "FunctionExpression":
        return this.functionValue(e);
      case "ClassExpression":
        return this.classValue(e);
      case "SuperMember": {
        const ref = this.memberRef(e);
        b.loc = e.loc;
        return this.getMember(ref);
      }
      case "SuperCall":
        return this.superCall(e);
      case "DefineField": {
        /* CreateDataPropertyOrThrow on `this`, or a private field (§7.3.33) */
        const obj = this.thisExpr();
        if (e.private) {
          const name = this.expression(e.key);
          const v = e.value ? this.named(e.value, (e.key as A.Identifier).name) : b.const(undefined);
          b.loc = e.loc;
          b.emit("private_add", [obj, name, v], { index: 0 });
        } else if (e.computed) {
          const key = this.expression(e.key);
          const v = e.value ? this.expression(e.value) : b.const(undefined);
          b.loc = e.loc;
          b.emit("define_field", [obj, key, v]);
        } else {
          const k = (e.key as A.Literal).value as string | number;
          const v = e.value ? this.named(e.value, String(k)) : b.const(undefined);
          b.loc = e.loc;
          b.emit("define_field", [obj, v], { key: propKey(k) });
        }
        return b.const(undefined);
      }
      case "AddPrivateMethod": {
        const obj = this.thisExpr();
        b.emit("private_add", [obj, this.expression(e.name), this.expression(e.fn)], { index: e.kind === "method" ? 1 : e.kind === "get" ? 2 : 3 });
        return b.const(undefined);
      }
      case "YieldExpression":
        return e.delegate ? this.yieldStar(e) : this.yieldExpr(e);
      case "AwaitExpression":
        return this.awaitExpr(e);
      case "NewTarget":
        return this.ownerNewTarget();
      case "SequenceExpression": {
        let last: Instr | null = null;
        for (const x of e.expressions) last = this.expression(x);
        return last!;
      }
      case "Unsupported":
        return notSupported(e.detail, e);
    }
    throw new Error("unreachable");
  }

  /** An optional chain: `inner` lowers it, and a nullish value at a `?.` inside skips the
   *  rest; the chain's value is then `short()` (undefined, or true for delete). */
  private chain(inner: () => Instr, short: () => Instr): Instr {
    const b = this.b;
    const outer = this.chainShort, chain: { block: Block | null } = { block: null };
    this.chainShort = chain;
    let value: Instr;
    try {
      value = inner();
    } finally {
      this.chainShort = outer;
    }
    if (!chain.block) return value;
    const result: VarKey = {};
    const join = b.newBlock();
    b.writeVariable(result, value);
    b.jump(join);
    b.seal(chain.block);
    b.setBlock(chain.block);
    b.writeVariable(result, short());
    b.jump(join);
    b.seal(join);
    b.setBlock(join);
    return b.readVariable(result);
  }

  /** `?.` after `v`: nullish leaves the chain. */
  private optional(v: Instr) {
    const b = this.b, chain = this.chainShort!;
    chain.block ??= b.newBlock();
    const next = b.newBlock();
    b.terminate({ kind: "branch", cond: b.emit("is_nullish", [v]), then: chain.block, else: next });
    b.seal(next);
    b.setBlock(next);
  }

  /** a && b, a || b, a ?? b: the right side runs only when needed. */
  private logical(op: "&&" | "||" | "??", left: () => Instr, right: () => Instr): Instr {
    const b = this.b;
    const result: VarKey = {};
    const l = left();
    b.writeVariable(result, l);
    const evalRight = b.newBlock(), join = b.newBlock();
    if (op === "&&") b.terminate({ kind: "branch", cond: l, then: evalRight, else: join });
    else if (op === "||") b.terminate({ kind: "branch", cond: l, then: join, else: evalRight });
    else b.terminate({ kind: "branch", cond: b.emit("is_nullish", [l]), then: evalRight, else: join });
    b.seal(evalRight);
    b.setBlock(evalRight);
    b.writeVariable(result, right());
    b.jump(join);
    b.seal(join);
    b.setBlock(join);
    return b.readVariable(result);
  }

  private assignment(e: A.AssignmentExpression): Instr {
    const b = this.b;
    if (e.target.type === "ObjectPattern" || e.target.type === "ArrayPattern") {
      const value = this.expression(e.value);
      b.loc = e.loc;
      this.destructure(e.target, value, false);
      return value;
    }
    if (e.operator === "=") {
      const target = this.targetRef(e.target, false);
      const value = e.target.type === "Identifier" ? this.named(e.value, nameOf(e.target)) : this.expression(e.value);
      b.loc = e.loc;
      this.writeTarget(target, value);
      return value;
    }
    const target = this.targetRef(e.target, true);
    if (e.operator === "&&=" || e.operator === "||=" || e.operator === "??=") {
      /* x ||= v: assigns only when the right side is evaluated */
      return this.logical(e.operator.slice(0, 2) as "&&" | "||" | "??", () => this.readTarget(target), () => {
        const value = e.target.type === "Identifier" ? this.named(e.value, nameOf(e.target)) : this.expression(e.value);
        b.loc = e.loc;
        this.writeTarget(target, value);
        return value;
      });
    }
    const old = this.readTarget(target);
    const rhs = this.expression(e.value);
    b.loc = e.loc;
    const operator = e.operator.slice(0, -1) as A.BinaryOperator;
    const value = INT_OPERATORS.has(operator) && this.isInt(e.target as A.Expression) && this.isInt(e.value)
      ? this.int64(operator, old, rhs) : b.emit(BINARY[operator], [old, rhs]);
    this.writeTarget(target, value);
    return value;
  }

  // ---- Properties ------------------------------------------------------------------

  /** Evaluates a member expression's object, then its key. */
  private memberRef(e: A.MemberExpression | A.SuperMember): MemberRef {
    let obj: Instr, superCallee: Instr | undefined;
    if (e.type === "SuperMember") {
      /* `this` first (a ReferenceError before super()), then the key */
      obj = this.thisExpr();
      superCallee = this.ownerCallee();
    } else {
      obj = this.expression(e.object);
      if (e.optional) this.optional(obj);
      if (e.private) return { obj, key: this.expression(e.property), private: true };
    }
    const p = e.property;
    let key: PropKey | Instr;
    if (!e.computed) key = propKey((p as A.Identifier).name);
    else if (p.type === "Literal" && (typeof p.value === "string" || typeof p.value === "number")) key = propKey(p.value);
    else key = this.expression(p);
    return superCallee ? { obj, key, superCallee } : { obj, key };
  }

  private getMember(ref: MemberRef): Instr {
    if (ref.private) return this.b.emit("private_get", [ref.obj, ref.key as Instr]);
    if (ref.superCallee) {
      if (isConst(ref.key)) return this.b.emit("super_get", [ref.superCallee, ref.obj], { key: ref.key });
      return this.b.emit("super_get", [ref.superCallee, ref.obj, ref.key]);
    }
    if (isConst(ref.key)) return this.b.emit("get_prop", [ref.obj], { key: ref.key });
    return this.b.emit("get_elem", [ref.obj, ref.key]);
  }

  private setMember(ref: MemberRef, value: Instr) {
    if (ref.private) {
      this.b.emit("private_set", [ref.obj, ref.key as Instr, value]);
      return;
    }
    if (ref.superCallee) {
      if (isConst(ref.key)) this.b.emit("super_set", [ref.superCallee, ref.obj, value], { key: ref.key });
      else this.b.emit("super_set", [ref.superCallee, ref.obj, ref.key, value]);
      return;
    }
    if (isConst(ref.key)) this.b.emit("set_prop", [ref.obj, value], { key: ref.key });
    else this.b.emit("set_elem", [ref.obj, ref.key, value]);
  }

  // ---- this, super, classes ------------------------------------------------------

  /** A binding's current value, without a TDZ check. */
  private loadBinding(binding: Binding): Instr {
    if (this.isLocal(binding)) return this.b.readVariable(binding);
    const { env, depth, slot } = this.envAccess(binding);
    return this.b.emit("env_load", [env], { index: depth, slot, name: binding.name });
  }

  /** The function object `super` resolves against, and new.target: the enclosing non-arrow
   *  function's (an arrow reads them through the environment). */
  private ownerCallee(): Instr {
    const owner = thisOwner(this.fn);
    return owner === this.fn ? this.hidden.callee! : this.loadBinding(owner.calleeBinding!);
  }

  private ownerNewTarget(): Instr {
    const owner = thisOwner(this.fn);
    return owner === this.fn ? this.hidden.newTarget! : this.loadBinding(owner.newTargetBinding!);
  }

  /** A derived constructor's own `this`: a ReferenceError before super(). */
  private readThis(): Instr {
    return this.b.emit("check_this", [this.loadBinding(this.fn.thisBinding!)], { name: "this" });
  }

  private thisExpr(): Instr {
    const b = this.b;
    const owner = thisOwner(this.fn);
    if (owner.node.type === "Program") return owner.node.module ? b.const(undefined) : b.emit("global_this", []);
    if (owner === this.fn) return this.derivedCtor ? this.readThis() : this.thisValue!;
    /* an arrow's `this` is its enclosing function's, through the environment */
    const { env, depth, slot } = this.envAccess(owner.thisBinding!);
    const v = b.emit("env_load", [env], { index: depth, slot, name: "this" });
    const ownerNode = owner.node as A.FunctionExpression;
    return ownerNode.classCtor?.derived ? b.emit("check_this", [v]) : v;
  }

  /** super(...args) (§13.3.7.1): construct the parent with this new.target, then bind `this`, once. */
  private superCall(e: A.SuperCall): Instr {
    const b = this.b;
    const owner = thisOwner(this.fn);  // an arrow's super() is its constructor's
    const callee = this.ownerCallee(), newTarget = this.ownerNewTarget();
    let result: Instr;
    if (e.forwardArgs) {
      /* the rest array is fresh and unobservable: it is the argument list */
      const list = this.expression((e.arguments[0] as A.SpreadElement).argument);
      b.loc = e.loc;
      result = b.emit("super_construct_spread", [callee, newTarget, list]);
    } else if (hasSpread(e.arguments)) {
      const list = this.argumentList(e.arguments);
      b.loc = e.loc;
      result = b.emit("super_construct_spread", [callee, newTarget, list]);
    } else {
      const args = e.arguments.map((a) => this.expression(a as A.Expression));
      b.loc = e.loc;
      result = b.emit("super_construct", [callee, newTarget, ...args]);
    }
    const bound = b.emit("bind_this", [this.loadBinding(owner.thisBinding!), result], { name: "this" });
    this.write(owner.thisBinding!, bound);
    /* then the instance's fields (§13.3.7.1 step 10) */
    if (owner === this.fn && (this.fn.node as A.FunctionExpression).initRef) this.runInitializer(bound);
    else if (e.initRef) b.emit("call", [this.read(this.info.references.get(e.initRef)!, e.initRef), bound], { target: "the field initializer" });
    return bound;
  }

  /** Calls the class's instance initializer (private methods, then fields) on a new `this`. */
  private runInitializer(thisVal: Instr) {
    const ref = (this.fn.node as A.FunctionExpression).initRef!;
    const init = this.read(this.info.references.get(ref)!, ref);
    this.b.emit("call", [init, thisVal], { target: "the field initializer" });
  }

  /** A class (§15.7.14 ClassDefinitionEvaluation): the constructor, its prototype linked to
   *  the parent's, then each member (with its home object), then the inner name. */
  private classValue(c: A.ClassDeclaration | A.ClassExpression, inferredName?: string): Instr {
    const b = this.b;
    const scope = this.info.scopes.get(c)!;
    this.enterScope(scope);
    /* fresh private names for this evaluation of the class */
    for (const name of c.privateNames)
      this.write(scope.bindings.get(name)!, b.emit("new_private_name", [b.const(name)], { name }));
    const heritage = c.superClass ? this.expression(c.superClass) : null;
    b.loc = c.loc;
    const name = functionName(c.id ? nameOf(c.id) : inferredName ?? "");
    this.m.inferredNames.set(c.ctor, name);
    const ctor = this.makeFunction(c.ctor, name || undefined);
    const proto = b.emit("class_setup", [ctor, heritage ?? b.emit("empty", [])], { name: "prototype" });
    for (const m of c.members) {
      b.loc = m.loc;
      const target = m.static ? ctor : proto;
      if (m.kind === "fieldKey") {
        this.write(scope.bindings.get(m.store!)!, b.emit("to_property_key", [this.expression(m.key)]));
        continue;
      }
      const kind = m.kind === "method" ? 0 : m.kind === "get" ? 1 : 2;
      if (m.private) {
        /* a private method: added to each instance by the initializer, or (static) to the class now */
        const name = (m.key as A.Identifier).name;
        this.m.inferredNames.set(m.value!, m.kind === "method" ? name : `${m.kind} ${name}`);
        const fn = this.makeFunction(m.value!);
        b.emit("set_home", [fn, target]);
        if (m.static) b.emit("private_add", [ctor, this.loadBinding(scope.bindings.get(name)!), fn], { index: kind + 1 });
        else this.write(scope.bindings.get(m.store!)!, fn);
        continue;
      }
      let key: PropKey | Instr;
      if (m.computed) key = b.emit("to_property_key", [this.expression(m.key)]);
      else {
        key = propKey(m.key.type === "Identifier" ? m.key.name : (m.key as A.Literal).value as string | number);
        const base = "index" in key ? String(key.index) : key.name;
        this.m.inferredNames.set(m.value!, m.kind === "method" ? base : `${m.kind} ${base}`);
      }
      const fn = this.makeFunction(m.value!);
      b.emit("set_home", [fn, target]);
      if (isConst(key)) b.emit("define_class_member", [target, fn], { index: kind, key });
      else b.emit("define_class_member", [target, key, fn], { index: kind });
    }
    if (c.instanceInit) {
      const init = this.makeFunction(c.instanceInit);
      b.emit("set_home", [init, proto]);
      this.write(scope.bindings.get("%init")!, init);
    }
    const inner = c.id ? scope.bindings.get(c.id.name) : undefined;
    if (inner) this.write(inner, ctor);
    if (c.staticInit) {
      /* static fields and blocks, in order, with the class as `this` */
      const init = this.makeFunction(c.staticInit);
      b.emit("set_home", [init, ctor]);
      b.emit("call", [init, ctor], { target: "the static initializer" });
    }
    this.exitScope(scope);
    return ctor;
  }

  /** An assignment target, evaluated once. `readFirst`: a compound assignment or update,
   *  which converts a computed key once for both the read and the write. */
  private targetRef(t: A.Target, readFirst: boolean): { id: A.Identifier } | MemberRef {
    if (t.type === "Identifier") return { id: t };
    const ref = this.memberRef(t);
    if (readFirst && !isConst(ref.key) && !ref.private) ref.key = this.b.emit("to_property_key", [ref.key]);
    return ref;
  }

  private readTarget(t: { id: A.Identifier } | MemberRef): Instr {
    return "id" in t ? this.read(this.info.references.get(t.id)!, t.id) : this.getMember(t);
  }

  private writeTarget(t: { id: A.Identifier } | MemberRef, value: Instr) {
    if ("id" in t) this.assign(t.id, value);
    else this.setMember(t, value);
  }

  private delete(e: A.UnaryExpression): Instr {
    const b = this.b;
    const arg = e.argument;
    if (arg.type === "SuperMember") notSupported("delete of a super property (a ReferenceError)", arg);
    if (arg.type === "ChainExpression") return this.chain(() => this.delete({ ...e, argument: arg.expression }), () => b.const(true));
    if (arg.type === "MemberExpression") {
      const ref = this.memberRef(arg);
      b.loc = e.loc;
      if (isConst(ref.key)) return b.emit("delete_prop", [ref.obj], { key: ref.key });
      return b.emit("delete_elem", [ref.obj, ref.key]);
    }
    if (arg.type === "Identifier") {
      /* sloppy only (strict is an early error): declared bindings can't be deleted */
      if (this.info.references.get(arg)!.binding) return b.const(false);
      b.loc = e.loc;
      return b.emit("delete_prop", [b.emit("global_this", [])], { key: propKey(arg.name) });  // a global object property
    }
    this.expression(arg);
    return b.const(true);
  }

  /** An object literal's method or accessor that uses `super` gets the object as its home. */
  private homeObject(p: A.Property, fn: Instr, obj: Instr) {
    const f = p.value;
    if (f.type !== "FunctionExpression" || !f.method || f.arrow) return;
    if (this.info.functions.get(f)!.usesSuper) this.b.emit("set_home", [fn, obj]);
  }

  private objectLiteral(e: A.ObjectExpression): Instr {
    const b = this.b;
    b.loc = e.loc;
    const obj = b.emit("new_object", []);
    for (const p of e.properties) {
      if (p.type === "SpreadElement") {
        const v = this.expression(p.argument);
        b.loc = p.loc;
        b.emit("object_spread", [obj, v]);
        continue;
      }
      /* accessors: index 0 get, 1 set; named "get x" / "set x" */
      const accessor = p.kind === "init" ? null : { index: p.kind === "get" ? 0 : 1 };
      if (p.isProto) {
        const v = this.expression(p.value);
        b.emit("set_proto", [obj, v]);
      } else if (p.computed) {
        const key = b.emit("to_property_key", [this.expression(p.key)]);
        const v = this.expression(p.value);
        this.homeObject(p, v, obj);
        if (accessor) b.emit("define_accessor", [obj, key, v], accessor);
        else b.emit("define_elem", [obj, key, v]);
      } else {
        const k = p.key.type === "Identifier" ? p.key.name : (p.key as A.Literal).value as string | number;
        const v = this.named(p.value, accessor ? `${p.kind} ${String(k)}` : String(k));
        this.homeObject(p, v, obj);
        if (accessor) b.emit("define_accessor", [obj, v], { ...accessor, key: propKey(k) });
        else b.emit("define_prop", [obj, v], { key: propKey(k) });
      }
    }
    return obj;
  }

  private call(e: A.CallExpression): Instr {
    const b = this.b;
    const callee = e.callee;
    /* a method call: `this` is the object the method was read from */
    if (callee.type === "MemberExpression" || callee.type === "SuperMember") {
      const ref = this.memberRef(callee);
      b.loc = callee.loc;
      const f = this.getMember(ref);
      if (e.optional) this.optional(f);
      return this.genericCall(f, ref.obj, e, calleeText(callee));
    }
    if (callee.type === "ChainExpression" && callee.expression.type === "MemberExpression") {
      /* (a?.b)(): `this` is a, as for a.b() */
      const member = callee.expression, thisVal: VarKey = {};
      const f = this.chain(() => {
        const ref = this.memberRef(member);
        b.loc = member.loc;
        b.writeVariable(thisVal, ref.obj);
        return this.getMember(ref);
      }, () => {
        b.writeVariable(thisVal, b.const(undefined));
        return b.const(undefined);
      });
      return this.genericCall(f, b.readVariable(thisVal), e, calleeText(callee));
    }
    if (e.optional) {
      const f = this.expression(callee);
      this.optional(f);
      return this.genericCall(f, b.const(undefined), e, calleeText(callee));
    }
    const ref = callee.type === "Identifier" ? this.info.references.get(callee)! : null;
    const binding = ref?.binding ?? null;
    if (callee.type !== "Identifier" || !binding || binding.kind !== "function") {
      if (callee.type === "Identifier" && !binding && HOST_FUNCTIONS.has(callee.name) && !hasSpread(e.arguments) && !this.m.printAssigned) {
        const args = e.arguments.map((a) => this.expression(a as A.Expression));
        b.loc = e.loc;
        return b.emit("call_runtime", args, { target: callee.name });
      }
      /* any other value: the generic entry, `this` undefined */
      return this.genericCall(this.expression(callee), b.const(undefined), e, calleeText(callee));
    }
    const target = this.m.declaredFunctions.get(binding);
    /* direct: a top-level declaration never reassigned; anything else through its value */
    if (binding.scope !== this.info.program.scope || binding.reassigned || !target || hasSpread(e.arguments) || target.argumentsBinding || target.generator)
      return this.genericCall(this.expression(callee), b.const(undefined), e, calleeText(callee));
    const decl = target.node as A.FunctionDeclaration;
    /* every argument is evaluated; the callee gets exactly its parameters, `this` first if it
     * uses it, and the arguments past them as its rest array */
    const args = e.arguments.map((a) => this.expression(a as A.Expression));
    while (args.length < decl.params.length) args.push(b.const(undefined));
    b.loc = e.loc;
    const hidden = [...(target.usesThis ? [b.const(undefined)] : []), ...(target.usesNewTarget ? [b.const(undefined)] : [])];
    const rest = decl.rest ? [b.emit("new_array", args.slice(decl.params.length))] : [];
    return b.emit("call_direct", [...hidden, ...args.slice(0, decl.params.length), ...rest], { target: this.m.ids.get(decl)! });
  }

  /** `new F(…)` where F is a constructor this module compiles, read through a binding nothing
   *  reassigns: a function declaration or a base class. Its constructor's
   *  node, whose direct entry the C calls when F's value is that function, or null. */
  private directConstructor(e: A.NewExpression): A.FunctionDeclaration | A.FunctionExpression | null {
    if (e.callee.type !== "Identifier" || hasSpread(e.arguments)) return null;
    const binding = this.info.references.get(e.callee)?.binding;
    if (!binding || binding.reassigned) return null;
    let ctor: A.FunctionDeclaration | A.FunctionExpression | undefined;
    if (binding.kind === "function") {
      ctor = this.m.declaredFunctions.get(binding)?.node as A.FunctionDeclaration | undefined;
    } else if (binding.kind === "class" || (binding.kind === "const" && binding.scope.kind === "class")) {
      /* the class's own name inside it, or its declaration's binding */
      const cls = this.m.classesById.get(binding.node);
      if (cls && !cls.superClass) ctor = cls.ctor;
    } else {
      /* `var C = class {…}` or `= function () {…}` (what bundlers make of declarations): before
       * it runs, C is undefined, which the C's check sends to js_construct */
      const init = this.info.initializers.get(binding);
      if (init?.type === "ClassExpression" && !init.superClass) ctor = init.ctor;
      else if (init?.type === "FunctionExpression") ctor = init;
    }
    if (!ctor) return null;
    const fn = this.info.functions.get(ctor);
    if (!fn || fn.generator || fn.async || fn.arrow || fn.argumentsBinding || ctor.rest) return null;
    return ctor;
  }

  /** A call through the generic entry; arguments with spreads go as one array. */
  private genericCall(f: Instr, thisVal: Instr, e: A.CallExpression, text: string): Instr {
    const b = this.b;
    if (hasSpread(e.arguments)) {
      const list = this.argumentList(e.arguments);
      b.loc = e.loc;
      return b.emit("call_spread", [f, thisVal, list], { target: text });
    }
    const args = e.arguments.map((a) => this.expression(a as A.Expression));
    b.loc = e.loc;
    return b.emit("call", [f, thisVal, ...args], { target: text });
  }

  /** An argument list or array literal with spreads: a new array, filled in order
   *  (a spread through the iterator protocol). */
  private argumentList(items: (A.Argument | null)[]): Instr {
    const b = this.b;
    const list = b.emit("new_array", []);
    for (const item of items) {
      if (item === null) b.emit("array_append", [list, b.emit("empty", [])]);  // a hole
      else if (item.type === "SpreadElement") {
        const v = this.expression(item.argument);
        b.loc = item.loc;
        b.emit("array_spread", [list, v]);
      } else b.emit("array_append", [list, this.expression(item)]);
    }
    return list;
  }
}
