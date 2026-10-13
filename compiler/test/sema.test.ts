import { describe, expect, it } from "vitest";

import type * as A from "../src/frontend/ast.ts";
import { parseModule, parseScript } from "../src/frontend/adapter.ts";
import { CompileError } from "../src/frontend/errors.ts";
import { analyze, type Reference, type SemanticInfo } from "../src/sema/analyze.ts";

const run = (src: string) => analyze(parseScript(src, "t.js"));

/** The references to `name`, in source order. */
function refs(info: SemanticInfo, name: string): Reference[] {
  return [...info.references.values()]
    .filter((r) => r.id.name === name)
    .sort((a, b) => a.id.loc.line - b.id.loc.line || a.id.loc.column - b.id.loc.column);
}

function err(src: string): CompileError {
  try {
    run(src);
  } catch (e) {
    if (e instanceof CompileError) return e;
    throw e;
  }
  throw new Error(`expected an error for: ${src}`);
}

const syntaxError = (src: string) => expect(err(src).kind, src).toBe("SyntaxError");
const ok = (src: string) => expect(() => run(src), src).not.toThrow();

describe("resolution", () => {
  it("resolves to the innermost declaration", () => {
    const info = run(`
let x = 1;
{ let x = 2; x; }
x;
function f(x) { return x; }
y;`);
    const xs = refs(info, "x");
    expect(xs.map((r) => r.binding?.kind)).toEqual(["let", "let", "param"]);
    expect(xs[0]!.binding).not.toBe(xs[1]!.binding);
    expect(refs(info, "y")[0]!.binding).toBeNull();  // a global lookup
  });

  it("hoists var and functions to the function scope", () => {
    const info = run(`
function f() { g(); { var v = 1; } return v; function g() {} }`);
    const v = refs(info, "v")[0]!.binding!;
    expect(v.kind).toBe("var");
    expect(v.scope.kind).toBe("function");
    expect(refs(info, "g")[0]!.binding!.kind).toBe("function");
  });

  it("gives for-in its own scope: let is in TDZ in the object, var belongs to the function", () => {
    const info = run(`for (let k in k) k; function f() { for (var v in {}) v; }`);
    const ks = refs(info, "k");
    expect(ks.every((r) => r.binding?.scope.node.type === "ForInStatement")).toBe(true);
    expect(ks.map((r) => r.tdz)).toEqual([true, false]);
    expect(refs(info, "v")[0]!.binding!.scope.node.type).toBe("FunctionDeclaration");
    syntaxError("for (let a, b in {}) {}");
    syntaxError("for (let a = 1 in {}) {}");
    syntaxError("for (1 in {}) {}");
    ok("x: for (var p in {}) { continue x; }");
    ok("for (const c in {}) {}");
  });

  it("gives for-of the same head scope as for-in; no initializers", () => {
    const info = run(`for (const v of v) v;`);
    expect(refs(info, "v").map((r) => r.tdz)).toEqual([true, false]);
    syntaxError("for (var a = 1 of []) {}");
    syntaxError("for (let a, b of []) {}");
    ok("for (x.y of []) {} for (let of of []) {}");
  });

  it("declares every name in a destructuring pattern, with its early errors", () => {
    const info = run(`let { a, b: [c, ...d], ...e } = o; function f([p], { q } = {}) { p; q; } try {} catch ([x]) { x; }`);
    for (const n of ["a", "c", "d", "e"]) expect(refs(info, n)).toEqual([]);  // declarations, not references
    expect(refs(info, "p")[0]!.binding!.kind).toBe("param");
    expect(refs(info, "x")[0]!.binding!.kind).toBe("catch");
    syntaxError("let [a, a] = [];");
    syntaxError("let { a };");
    syntaxError("var [b];");
    syntaxError("let [...r,] = [];");
    syntaxError("let { ...r, s } = {};");
    syntaxError("[...r = 1] = [];");
    syntaxError("({ ...{ a } } = {});");
    syntaxError("([a]) = [];");
    syntaxError("[a] += 1;");
    syntaxError("({ m() {} } = {});");
    syntaxError("'use strict'; [eval] = [];");
    syntaxError("function g({ a }) { 'use strict'; }");
    syntaxError("(function ([a], a) { 'use strict'; })");
    ok("[a.b, c[0], ...d.e] = []; ({ x: y.z = 1, w = 2 } = {}); for ([k, v] of []); for ({ n } in {});");
  });

  it("knows generators, and their early errors", () => {
    const info = run(`function* g(a) { yield a; } { function* inBlock() {} }`);
    expect([...info.functions.values()].filter((f) => f.generator).length).toBe(2);
    expect(refs(info, "inBlock")).toEqual([]);  // no Annex B var twin for a generator
    syntaxError("if (x) function* g() {}");
    syntaxError("l: function* g() {}");
    syntaxError("function* g(a = yield) {}");
    ok("function* g() { yield; yield* [1]; var o = { *m() { yield 1; } }; }");
  });

  it("checks a module's exports and its top-level await", () => {
    const mod = (src: string) => analyze(parseModule(src, "m.js"));
    const info = mod("var v; let l; function f() {} export { v, l, f as g }; await 1;");
    expect(info.program.awaits && info.program.async && info.program.strict).toBe(true);
    expect(() => mod("export { nope };")).toThrow(/not defined in module/);
    expect(() => mod("export var a; export { a };")).toThrow(/Duplicate export of 'a'/);
    expect(() => mod("export default 1; export default 2;")).toThrow(/Duplicate export of 'default'/);
    expect(() => mod("var await;")).toThrow(/reserved/);
    expect(() => mod("function f() { await 1; }")).toThrow(/only valid in async functions/);
    expect(mod("for await (const x of y);").program.awaits).toBe(true);
    expect(mod("async function f() { await 1; }").program.awaits).toBe(false);  // the function's, not the module's
  });

  it("knows async functions, and where await may appear", () => {
    const info = run(`async function f(a) { await a; } var g = async () => await 1; var o = { async m() {} };`);
    expect([...info.functions.values()].filter((f) => f.async).length).toBe(3);
    syntaxError("function f() { await 1; }");
    syntaxError("async function f() { function g() { await 1; } }");
    syntaxError("async function f() { (() => await 1)(); }");
    syntaxError("async function f(a = await 1) {}");
    syntaxError("if (x) async function f() {}");
    ok("async function f() { (async () => await 1)(); class C { async m() { await this; } } }");
    syntaxError("function f() { for await (x of y); }");
    ok("async function* g() { for await (const x of y) yield* x; await 1; }");
  });

  it("gives for-let its own scope, and catch its parameter", () => {
    const info = run(`for (let i = 0; i < 2; i++) i; try {} catch (e) { e; }`);
    expect(refs(info, "i").every((r) => r.binding?.scope.node.type === "ForStatement")).toBe(true);
    expect(refs(info, "e")[0]!.binding!.kind).toBe("catch");
  });
});

describe("facts for lowering", () => {
  it("marks captured bindings", () => {
    const info = run(`
function outer() { let a = 1, b = 2; function inner() { return a; } return b + inner(); }`);
    const a = refs(info, "a")[0]!.binding!, b = refs(info, "b")[0]!.binding!;
    expect(a.captured).toBe(true);
    expect(b.captured).toBe(false);
  });

  it("marks reassigned bindings (a function binding never reassigned can be called directly)", () => {
    const info = run(`
function f() {} function g() {} g = 1;
function h() {} var h;
function k() {} var k = 2;
let n = 0; n++; let m = 0;`);
    const b = (name: string) => [...info.declarations.values()].find((x) => x.name === name)!;
    expect(b("f").reassigned).toBe(false);
    expect(b("g").reassigned).toBe(true);
    expect(b("h").reassigned).toBe(false);  // `var h;` shares the binding but writes nothing
    expect(b("k").reassigned).toBe(true);
    expect(b("n").reassigned).toBe(true);
    expect(b("m").reassigned).toBe(false);
  });

  it("needs a TDZ check only where initialization may not have happened", () => {
    const info = run(`
f();
let x = 1;
x;
function f() { return x; }
{ y; let y = 2; y; }
let z = z;
switch (k) { case 0: let w = 1; w; break; case 1: w; }`);
    expect(refs(info, "x").map((r) => r.tdz)).toEqual([false, true]);  // after the declaration; inside a function
    expect(refs(info, "y").map((r) => r.tdz)).toEqual([true, false]);
    expect(refs(info, "z").map((r) => r.tdz)).toEqual([true]);          // its own initializer
    expect(refs(info, "w").map((r) => r.tdz)).toEqual([false, true]);   // another case clause
  });

  it("gives sloppy block functions a var twin (Annex B.3.3), strict ones not", () => {
    const sloppy = run(`function f() { { function g() {} } return g; }`);
    const g = [...sloppy.declarations.values()].find((b) => b.name === "g")!;
    expect(g.scope.kind).toBe("block");
    expect(g.annexBVar?.kind).toBe("var");
    expect(refs(sloppy, "g")[0]!.binding).toBe(g.annexBVar);

    const strict = run(`"use strict"; function f() { { function g() {} } return g; }`);
    expect(refs(strict, "g")[0]!.binding).toBeNull();
    /* no twin when a var would conflict: the let wins, and the function stays block-scoped */
    const blocked = run(`function f() { let g; { function g() {} } }`);
    expect([...blocked.declarations.values()].find((b) => b.kind === "function")!.annexBVar).toBeNull();
  });

  it("records strictness per function", () => {
    const info = run(`function a() {} function b() { "use strict"; function c() {} }`);
    const strict = [...info.functions.values()].filter((f) => f.node.type === "FunctionDeclaration").map((f) => [(f.node as A.FunctionDeclaration).id.name, f.strict]);
    expect(strict).toEqual([["a", false], ["b", true], ["c", true]]);
  });
});

describe("function expressions", () => {
  it("scopes a named expression's name to its own body, read-only", () => {
    const info = run("var g = function f() { f; }; f;");
    const fs = refs(info, "f");
    expect(fs[0]!.binding?.kind).toBe("self");
    expect(fs[1]!.binding).toBeNull();  // not visible outside
    expect(run("var g = function f() { var f; f; };").references.size).toBeGreaterThan(0);
    const shadowed = refs(run("var g = function f() { var f = 1; f; };"), "f");
    expect(shadowed.at(-1)!.binding?.kind).toBe("var");  // the body's var shadows it
  });

  it("records which functions use this, and captures across function expressions", () => {
    const info = run("function a() { return this; } var b = function () { return 1; }; function c(x) { return function () { return x; }; }");
    const byName = (n: string) => [...info.functions.values()].find((f) => f.node.type !== "Program" && f.node.id?.name === n)!;
    expect(byName("a").usesThis).toBe(true);
    expect([...info.functions.values()].filter((f) => f.usesThis)).toHaveLength(1);
    expect(refs(info, "x")[0]!.binding!.captured).toBe(true);
  });

  it("checks early errors inside function expressions", () => {
    syntaxError('(function () { "use strict"; var eval; });');
    syntaxError("(function (a, a) { 'use strict'; });");
    syntaxError("(function () { let x; var x; });");
    syntaxError("({ m() { break; } });");
    ok("(function (a, a) {});");
  });
});

describe("parameters and arrows", () => {
  it("rejects what non-simple parameter lists forbid", () => {
    syntaxError('function f(a = 1) { "use strict"; }');
    syntaxError('(function (...r) { "use strict"; });');
    syntaxError("function f(a, a = 1) {}");
    syntaxError("(a, a) => 1;");
    syntaxError("({ m(a, a) {} });");
    ok("function f(a, a) {}");  // sloppy, simple: allowed
  });

  it("puts later parameters in TDZ while defaults run", () => {
    const info = run("function f(a = b, b = a) {}");
    expect(refs(info, "b")[0]!.tdz).toBe(true);   // b read before it's initialized
    expect(refs(info, "a")[0]!.tdz).toBe(false);  // a is initialized by then
  });

  it("gives an arrow's this to the enclosing function, as a captured binding", () => {
    const info = run("function f() { return () => this; } function g() { return this; }");
    const fn = (n: string) => [...info.functions.values()].find((x) => x.node.type === "FunctionDeclaration" && x.node.id.name === n)!;
    expect(fn("f").usesThis).toBe(true);
    expect(fn("f").thisBinding?.captured).toBe(true);
    expect(fn("g").thisBinding).toBeNull();
    expect([...info.functions.values()].find((x) => x.arrow)!.usesThis).toBe(false);
  });
});

describe("classes", () => {
  it("rejects super and new.target where they can't be", () => {
    syntaxError("class A { constructor() { super(); } }");  // not derived
    syntaxError("class A extends B { m() { super(); } }");  // not a constructor
    syntaxError("function f() { super.x; }");
    syntaxError("new.target;");
    syntaxError("if (x) class C {}");
    syntaxError("class let {}");
    ok("class A extends B { constructor() { super(); super.x; new.target; } m() { super.m(); } }");
    ok("({ m() { super.m(); } });");
    ok("function f() { new.target; }");
  });

  it("makes class code strict and binds the class name let-like, and inside, const", () => {
    syntaxError("class A { m() { var eval; } }");  // strict inside
    const info = run("let before = C; class C { m() { C; } }");
    const cs = refs(info, "C");
    expect(cs[0]!.tdz).toBe(true);  // read before the declaration
    expect(cs[1]!.binding!.kind).toBe("const");  // the inner name
    expect(cs[1]!.binding).not.toBe(cs[0]!.binding);
  });

  it("checks fields, private names and static blocks", () => {
    syntaxError("class A { x = arguments; }");
    syntaxError("class A { static { arguments; } }");
    syntaxError("class A { static { return; } }");
    syntaxError("class A { m() { this.#nope; } }");
    syntaxError("class A { #p; m() { delete this.#p; } }");
    syntaxError("#p in {};");
    ok("class A { #p; static has(o) { return #p in o; } m() { return () => this.#p; } }");
    ok("class A { x = function () { return arguments; }; }");  // a nested function has its own
  });

  it("gives a derived constructor a this binding that starts uninitialized", () => {
    const info = run("class A extends B { constructor() { super(); this.x = 1; } }");
    const ctor = [...info.functions.values()].find((f) => f.node.type === "FunctionExpression" && f.node.classCtor)!;
    expect(ctor.thisBinding?.kind).toBe("this");
    expect(ctor.usesSuper && ctor.usesNewTarget).toBe(true);
  });
});

describe("early errors", () => {
  it("rejects delete of an identifier in strict code and duplicate __proto__", () => {
    syntaxError('"use strict"; delete x;');
    syntaxError('function f(a) { "use strict"; delete a; }');
    ok("delete x; delete o.x; delete o[k];");
    syntaxError("({ __proto__: a, __proto__: b });");
    syntaxError('({ __proto__: a, "__proto__": b });');
    ok('({ __proto__: a, ["__proto__"]: b, __proto__ });');  // computed and shorthand don't count
  });

  it("rejects conflicting declarations", () => {
    syntaxError("let a; let a;");
    syntaxError("let a; var a;");
    syntaxError("var a; let a;");
    syntaxError("let a; { var a; }");
    syntaxError("{ let a; { var a; } }");
    syntaxError("const a = 1; function a() {}");
    syntaxError("function f(a) { let a; }");
    syntaxError("{ function g() {} let g; }");
    syntaxError("try {} catch (e) { let e; }");
    syntaxError('"use strict"; { function g() {} function g() {} }');
    ok("var a; var a; function a() {} function a() {}");
    ok("function f(a) { var a; }");
    ok("{ function g() {} function g() {} }");  // sloppy, Annex B.3.2.4
    ok("try {} catch (e) { var e; }");          // Annex B.3.5
    ok("let a; { let a; }");
  });

  it("requires const initializers and forbids `let` as a lexical name", () => {
    syntaxError("const a;");
    syntaxError("let let = 1;");
    ok("var let = 1;");
  });

  it("applies strict-mode restrictions", () => {
    syntaxError('"use strict"; var yield;');
    syntaxError('"use strict"; var eval;');
    syntaxError('"use strict"; eval = 1;');
    syntaxError('"use strict"; arguments++;');
    syntaxError('"use strict"; function f(a, a) {}');
    syntaxError('function f(a, a) { "use strict"; }');
    syntaxError('function eval() { "use strict"; }');
    syntaxError('"use strict"; static;');
    syntaxError('"use strict"; implements = 1;');
    ok("var yield = 1; eval = 1; function f(a, a) {} static;");
  });

  it("checks break, continue, labels and return", () => {
    syntaxError("break;");
    syntaxError("continue;");
    syntaxError("while (1) { function f() { break; } }");  // doesn't cross functions
    syntaxError("L: { break M; }");
    syntaxError("L: { continue L; }");
    syntaxError("L: L: ;");
    syntaxError("return 1;");
    ok("switch (1) { case 1: break; }");
    ok("L: { break L; }");
    ok("L: M: while (1) { continue L; }");
    ok("L: for (;;) { M: while (1) { break L; } }");
    ok("L: ; L: ;");
    ok("function f() { return; }");
  });

  it("rejects declarations in single-statement positions", () => {
    syntaxError("if (x) let y = 1;");
    syntaxError("while (x) const y = 1;");
    syntaxError("while (x) function f() {}");
    syntaxError("while (x) L: function f() {}");
    syntaxError('"use strict"; if (x) function f() {}');
    syntaxError('"use strict"; L: function f() {}');
    ok("if (x) function f() {} else function g() {}");  // sloppy, Annex B.3.4
    ok("L: function f() {}");
  });

  it("finds early errors next to code it can't compile yet", () => {
    syntaxError("var o = {}; o.x = 1;\nlet a; let a;");
    syntaxError("class C {}\nbreak;");
  });

  it("resolves arguments to the owning function's arguments object", () => {
    const info = run("function f(a) { return () => arguments; } function g() { var arguments; arguments; } function h(arguments) { arguments; }");
    const fn = (n: string) => [...info.functions.values()].find((x) => x.node.type === "FunctionDeclaration" && x.node.id.name === n)!;
    expect(fn("f").argumentsBinding?.kind).toBe("arguments");
    expect(fn("f").argumentsBinding?.captured).toBe(true);  // read by the arrow
    expect(fn("f").scope.bindings.get("a")!.captured).toBe(true);  // mapped: the parameter lives in the environment
    expect(fn("g").argumentsBinding?.kind).toBe("var");  // `var arguments` is the object itself
    expect(fn("h").argumentsBinding).toBeNull();  // a parameter named arguments wins
    expect(refs(run("arguments;"), "arguments")[0]!.binding).toBeNull();  // at script level: a global name
    const strict = [...run('function s(a) { "use strict"; arguments; }').functions.values()].find((x) => x.node.type === "FunctionDeclaration")!;
    expect(strict.scope.bindings.get("a")!.captured).toBe(false);  // unmapped: no aliasing, the parameter stays local
  });
});
