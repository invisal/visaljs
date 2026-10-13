import { describe, expect, it } from "vitest";

import type { Expression, Program, Statement } from "../src/frontend/ast.ts";
import { firstUnsupported, parseModule, parseScript } from "../src/frontend/adapter.ts";
import { CompileError } from "../src/frontend/errors.ts";

const parse = (src: string) => parseScript(src, "test.js");
const firstStatement = (src: string): Statement => parse(src).body[0]!;
const expr = (src: string): Expression => {
  const s = firstStatement(`(${src});`);
  if (s.type !== "ExpressionStatement") throw new Error("not an expression");
  return s.expression;
};

/** The AST without locations, for readable comparisons. */
function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (k !== "loc") out[k] = strip(v);
    return out;
  }
  return node;
}

function error(src: string): CompileError {
  try {
    const u = firstUnsupported(parse(src));
    if (u) throw u;
  } catch (e) {
    if (e instanceof CompileError) return e;
    throw e;
  }
  throw new Error(`expected a compile error for: ${src}`);
}

describe("modules", () => {
  const mod = (src: string) => parseModule(src, "m.js");

  it("keeps exported declarations and records the exported names", () => {
    const p = mod("export const a = 1, { b } = o;\nexport function f() {}\nexport class C {}\nexport { a as x, f };\nexport default 2;");
    expect(p.module && p.strict).toBe(true);
    expect(p.body.map((s) => s.type)).toEqual(["VariableDeclaration", "FunctionDeclaration", "ClassDeclaration", "ExportLocals", "VariableDeclaration"]);
    expect(p.exportedNames.map((e) => e.name)).toEqual(["a", "b", "f", "C", "x", "f", "default"]);
  });

  it("names anonymous default declarations so nothing can refer to them", () => {
    expect(strip(mod("export default function () {}").body[0])).toMatchObject({ type: "FunctionDeclaration", id: { name: "*default*" } });
    expect(strip(mod("export default class {}").body[0])).toMatchObject({ type: "ClassDeclaration", id: { name: "*default*" } });
  });

  it("parses top-level await as await, and leaves imports to the bundler", () => {
    expect(strip(mod("await (x);").body[0])).toMatchObject({ type: "ExpressionStatement", expression: { type: "AwaitExpression" } });
    expect(firstUnsupported(mod('import x from "y";'))?.message).toMatch(/import declarations/);
    expect(firstUnsupported(mod('export * from "y";'))?.message).toMatch(/export … from/);
  });

  it("binds host primitives imported from visaljs:host first, as const declarations", () => {
    /* a host package's table (the driver passes node/'s) */
    const hosts = { cwd: { c: "js_host_cwd", length: 0 }, fsExists: { c: "js_host_fs_exists", length: 1 } };
    const hostMod = (src: string) => parseModule(src, "m.js", undefined, undefined, hosts);
    const p = hostMod('print(1);\nimport { cwd, fsExists as exists } from "visaljs:host";');
    expect(strip(p.body[0])).toMatchObject({
      type: "VariableDeclaration", kind: "const",
      declarations: [{ id: { name: "cwd" }, init: { type: "HostFunction", name: "cwd" } },
                     { id: { name: "exists" }, init: { type: "HostFunction", name: "fsExists" } }],
    });
    expect(p.body[1]!.type).toBe("ExpressionStatement");
    expect(() => hostMod('import { nope } from "visaljs:host";')).toThrow(/visaljs:host has no export 'nope'/);
    expect(() => hostMod('import host from "visaljs:host";')).toThrow(/only named exports/);
  });

  it("parses import.meta and import() with the original file they belong to", () => {
    const p = parseModule("import.meta;\nimport(x, { with: {} });", "/app/m.js", undefined, "/app/main.js");
    expect(strip(p.body[0])).toMatchObject({ expression: { type: "ImportMeta", file: "/app/m.js", main: false } });
    expect(strip(p.body[1])).toMatchObject({ expression: { type: "ImportCall", source: { type: "Identifier", name: "x" }, options: { type: "ObjectExpression" }, file: "/app/m.js" } });
    expect(strip(parseModule("import.meta;", "/app/main.js").body[0])).toMatchObject({ expression: { type: "ImportMeta", main: true } });
    expect(() => mod("import();")).toThrow();
    expect(error("import.meta;").message).toMatch(/outside a module/);
  });

  it("turns templates into TemplateLiteral, and tagged ones into calls with a TemplateObject", () => {
    expect(strip(mod("`a${x}b${y}`;").body[0])).toMatchObject({ expression: { type: "TemplateLiteral", quasis: ["a", "b", ""] } });
    expect(strip(mod("t`a\\u{zz}${x}\r\nb`;").body[0])).toMatchObject({
      expression: { type: "CallExpression", callee: { name: "t" },
                    arguments: [{ type: "TemplateObject", cooked: [null, "\nb"], raw: ["a\\u{zz}", "\nb"] }, { name: "x" }] },
    });
    expect(error("`a\\u{zz}`;").kind).toBe("SyntaxError");  /* only tagged templates allow it */
  });

  it("rejects module syntax in classic scripts, and `with` in modules", () => {
    expect(error('export var x;').kind).toBe("SyntaxError");
    expect(error('import x from "y";').kind).toBe("SyntaxError");
    expect(() => mod("with (o) {}")).toThrow(/with statement/);
  });
});

describe("literals", () => {
  it("decodes numbers in every notation", () => {
    for (const [src, value] of [
      ["0x10", 16], ["0o17", 15], ["0b101", 5], ["1_000_000", 1000000], ["1e3", 1000],
      [".5", 0.5], ["5.", 5], ["0.1", 0.1], ["9007199254740993", 9007199254740992], ["1e400", Infinity],
    ] as const) {
      expect(strip(expr(src))).toEqual({ type: "Literal", value });
    }
  });

  it("decodes string escapes", () => {
    expect(strip(expr(String.raw`"aA\x42\n\u{1F600}"`))).toEqual({ type: "Literal", value: "aAB\n😀" });
    expect(strip(expr("`no substitutions`"))).toEqual({ type: "Literal", value: "no substitutions" });
    expect(strip(expr("'it\\'s'"))).toEqual({ type: "Literal", value: "it's" });
  });

  it("has true, false, null; undefined is an identifier", () => {
    expect(strip(expr("true"))).toEqual({ type: "Literal", value: true });
    expect(strip(expr("null"))).toEqual({ type: "Literal", value: null });
    expect(strip(expr("undefined"))).toEqual({ type: "Identifier", name: "undefined" });
  });
});

describe("expressions", () => {
  it("keeps precedence and drops parentheses", () => {
    expect(strip(expr("1 + 2 * (3 - x)"))).toEqual({
      type: "BinaryExpression",
      operator: "+",
      left: { type: "Literal", value: 1 },
      right: {
        type: "BinaryExpression",
        operator: "*",
        left: { type: "Literal", value: 2 },
        right: { type: "BinaryExpression", operator: "-", left: { type: "Literal", value: 3 }, right: { type: "Identifier", name: "x" } },
      },
    });
  });

  it("distinguishes logical, assignment, update, unary and sequence forms", () => {
    expect(expr("a ?? b").type).toBe("LogicalExpression");
    expect(strip(expr("x += 2"))).toMatchObject({ type: "AssignmentExpression", operator: "+=", target: { name: "x" } });
    expect(strip(expr("(x) = 1"))).toMatchObject({ type: "AssignmentExpression", target: { name: "x" } });
    expect(strip(expr("x ??= y"))).toMatchObject({ operator: "??=" });
    expect(strip(expr("i++"))).toEqual({ type: "UpdateExpression", operator: "++", prefix: false, argument: { type: "Identifier", name: "i" } });
    expect(strip(expr("--i"))).toMatchObject({ operator: "--", prefix: true });
    expect(strip(expr("typeof x"))).toMatchObject({ type: "UnaryExpression", operator: "typeof" });
    expect(strip(expr("void 0"))).toMatchObject({ type: "UnaryExpression", operator: "void" });
    expect(strip(expr("(-x) ** 2 === 1 ? f(1, 2) : g()"))).toMatchObject({ type: "ConditionalExpression" });
    expect(strip(expr("a, b, c"))).toMatchObject({ type: "SequenceExpression", expressions: [{ name: "a" }, { name: "b" }, { name: "c" }] });
  });
});

describe("objects and properties", () => {
  it("converts member expressions, dotted and computed", () => {
    expect(strip(expr("a.b[c]"))).toEqual({
      type: "MemberExpression",
      object: { type: "MemberExpression", object: { type: "Identifier", name: "a" }, property: { type: "Identifier", name: "b" }, computed: false },
      property: { type: "Identifier", name: "c" },
      computed: true,
    });
    expect(strip(expr("o.x = 1"))).toMatchObject({ type: "AssignmentExpression", target: { type: "MemberExpression", computed: false } });
    expect(strip(expr("o[k]++"))).toMatchObject({ type: "UpdateExpression", argument: { type: "MemberExpression", computed: true } });
  });

  it("converts object literals: keys, shorthand, computed, __proto__", () => {
    const o = strip(expr('{ a: 1, "b c": 2, 3: 3, [k]: 4, d, __proto__: p, "__proto__": q, ["__proto__"]: r }')) as { properties: unknown[] };
    expect(o.properties).toEqual([
      { type: "Property", kind: "init", key: { type: "Identifier", name: "a" }, computed: false, value: { type: "Literal", value: 1 }, isProto: false },
      { type: "Property", kind: "init", key: { type: "Literal", value: "b c" }, computed: false, value: { type: "Literal", value: 2 }, isProto: false },
      { type: "Property", kind: "init", key: { type: "Literal", value: 3 }, computed: false, value: { type: "Literal", value: 3 }, isProto: false },
      { type: "Property", kind: "init", key: { type: "Identifier", name: "k" }, computed: true, value: { type: "Literal", value: 4 }, isProto: false },
      { type: "Property", kind: "init", key: { type: "Identifier", name: "d" }, computed: false, value: { type: "Identifier", name: "d" }, isProto: false },
      { type: "Property", kind: "init", key: { type: "Identifier", name: "__proto__" }, computed: false, value: { type: "Identifier", name: "p" }, isProto: true },
      { type: "Property", kind: "init", key: { type: "Literal", value: "__proto__" }, computed: false, value: { type: "Identifier", name: "q" }, isProto: true },
      { type: "Property", kind: "init", key: { type: "Literal", value: "__proto__" }, computed: true, value: { type: "Identifier", name: "r" }, isProto: false },
    ]);
  });

  it("converts arrays with holes, new, this, delete, in, instanceof", () => {
    expect(strip(expr("[1, , 2, ]"))).toEqual({ type: "ArrayExpression", elements: [{ type: "Literal", value: 1 }, null, { type: "Literal", value: 2 }] });
    expect(strip(expr("new F"))).toEqual({ type: "NewExpression", callee: { type: "Identifier", name: "F" }, arguments: [] });
    expect(strip(expr("new a.B(1)"))).toMatchObject({ type: "NewExpression", callee: { type: "MemberExpression" }, arguments: [{ value: 1 }] });
    expect(strip(expr("this"))).toEqual({ type: "ThisExpression" });
    expect(strip(expr("delete o.x"))).toMatchObject({ type: "UnaryExpression", operator: "delete", argument: { type: "MemberExpression" } });
    expect(strip(expr("k in o"))).toMatchObject({ type: "BinaryExpression", operator: "in" });
    expect(strip(expr("e instanceof E"))).toMatchObject({ type: "BinaryExpression", operator: "instanceof" });
  });

  it("converts function expressions and methods", () => {
    expect(strip(expr('function f(a, b) { "use strict"; }'))).toMatchObject({
      type: "FunctionExpression",
      id: { name: "f" },
      params: [{ name: "a" }, { name: "b" }],
      strict: true,
      method: false,
    });
    expect(strip(expr("function () {}"))).toMatchObject({ type: "FunctionExpression", id: null, method: false });
    expect(strip(expr("{ m(x) { return x; } }"))).toMatchObject({
      properties: [{ key: { name: "m" }, value: { type: "FunctionExpression", id: null, params: [{ name: "x" }], method: true } }],
    });
    expect(strip(expr("(function* () {})"))).toMatchObject({ type: "FunctionExpression", generator: true });
    expect(strip(expr("(async function () {})"))).toMatchObject({ type: "FunctionExpression", async: true });
    expect(strip(expr("(async function* () {})"))).toMatchObject({ type: "FunctionExpression", async: true, generator: true });
  });

  it("converts arrows, defaults, rest parameters, spreads and accessors", () => {
    expect(strip(expr("(a, b = 1, ...c) => a"))).toMatchObject({
      type: "FunctionExpression",
      arrow: true,
      method: true,
      params: [{ name: "a" }, { name: "b" }],
      defaults: [null, { type: "Literal", value: 1 }],
      rest: { name: "c" },
      body: { body: [{ type: "ReturnStatement", argument: { name: "a" } }] },
    });
    expect(strip(expr("x => { return x; }"))).toMatchObject({ arrow: true, body: { body: [{ type: "ReturnStatement" }] } });
    expect(strip(expr("f(1, ...xs)"))).toMatchObject({ arguments: [{ type: "Literal" }, { type: "SpreadElement", argument: { name: "xs" } }] });
    expect(strip(expr("[...a, , b]"))).toMatchObject({ elements: [{ type: "SpreadElement" }, null, { name: "b" }] });
    expect(strip(expr("{ get x() { return 1; }, set x(v) {} }"))).toMatchObject({
      properties: [{ kind: "get", value: { method: true } }, { kind: "set", value: { params: [{ name: "v" }] } }],
    });
    expect(error("(function (...a, b) {});").kind).toBe("SyntaxError");
    expect(error("({ get x(a) {} });").kind).toBe("SyntaxError");
    expect(error("({ set x() {} });").kind).toBe("SyntaxError");
  });

  it("converts classes: heritage, constructor, members, super and new.target", () => {
    const c = strip(firstStatement("class B extends A { constructor(x) { super(x); new.target; } m() { return super.m(); } static get s() {} [k]() {} }")) as Record<string, unknown>;
    expect(c).toMatchObject({
      type: "ClassDeclaration",
      id: { name: "B" },
      superClass: { name: "A" },
      ctor: { classCtor: { derived: true }, inClass: true, params: [{ name: "x" }] },
      members: [
        { kind: "method", static: false, key: { name: "m" }, computed: false },
        { kind: "get", static: true, key: { name: "s" } },
        { kind: "method", computed: true, key: { name: "k" } },
      ],
    });
    const body = (c.ctor as { body: { body: unknown[] } }).body.body;
    expect(body).toMatchObject([{ expression: { type: "SuperCall", arguments: [{ name: "x" }] } }, { expression: { type: "NewTarget" } }]);
    /* a default constructor is synthesized: derived ones forward their arguments */
    expect(strip(firstStatement("class C extends D {}"))).toMatchObject({
      ctor: { rest: { name: "args" }, body: { body: [{ expression: { type: "SuperCall", arguments: [{ type: "SpreadElement" }] } }] } },
    });
    expect(strip(expr("class { }"))).toMatchObject({ type: "ClassExpression", id: null, superClass: null, ctor: { classCtor: { derived: false } } });
    expect(error("class A { constructor() {} constructor() {} }").kind).toBe("SyntaxError");
    expect(error("class A { get constructor() {} }").kind).toBe("SyntaxError");
    expect(error("class A { static prototype() {} }").kind).toBe("SyntaxError");
  });

  it("turns fields, private methods and static blocks into initializer methods", () => {
    const c = strip(firstStatement("class A { a = 1; [k] = 2; #p = 3; static s = 4; #m() {} static { x; } }")) as Record<string, unknown>;
    expect(c).toMatchObject({
      privateNames: ["#p", "#m"],
      hidden: ["%fk0", "%pm1", "%init"],
      ctor: { initRef: { name: "%init" } },
      members: [
        { kind: "fieldKey", computed: true, key: { name: "k" }, store: "%fk0" },
        { kind: "method", private: true, key: { name: "#m" }, store: "%pm1" },
      ],
    });
    /* instance: the private method first, then the fields in order */
    expect((c.instanceInit as { body: { body: unknown[] } }).body.body).toMatchObject([
      { expression: { type: "AddPrivateMethod", name: { name: "#m" }, fn: { name: "%pm1" } } },
      { expression: { type: "DefineField", key: { value: "a" }, computed: false } },
      { expression: { type: "DefineField", key: { name: "%fk0" }, computed: true } },
      { expression: { type: "DefineField", key: { name: "#p" }, private: true } },
    ]);
    expect((c.staticInit as { body: { body: unknown[] } }).body.body).toMatchObject([
      { expression: { type: "DefineField", key: { value: "s" } } },
      { type: "BlockStatement" },
    ]);
    expect(strip(expr("o.#p"))).toMatchObject({ type: "MemberExpression", private: true, property: { name: "#p" } });
    expect(error("class A { #p; #p; }").kind).toBe("SyntaxError");
    expect(error("class A { #constructor; }").kind).toBe("SyntaxError");
    expect(error("class A { constructor = 1; }").kind).toBe("SyntaxError");
    expect(() => parse("class A { get #a() {} set #a(v) {} }")).not.toThrow();
  });

  it("records each function's source range for toString", () => {
    const src = "class A { static  m() {} } var f = function g() {}; ({ get x() { return 1; } });";
    const p = parse(src);
    const cls = p.body[0] as { ctor: { source: { start: number; end: number } }; members: { value: { source: { start: number; end: number } } }[] };
    const text = (r: { start: number; end: number }) => src.slice(r.start, r.end);
    expect(text(cls.ctor.source)).toBe("class A { static  m() {} }");  // a constructor shows its class
    expect(text(cls.members[0]!.value.source)).toBe("m() {}");  // without `static`
    const f = (p.body[1] as { declarations: { init: { source: { start: number; end: number } } }[] }).declarations[0]!.init;
    expect(text(f.source)).toBe("function g() {}");
    const getter = strip(p.body[2]) as { expression: { properties: { value: { source: null } }[] } };
    expect(getter.expression.properties[0]!.value.source).toEqual({ start: src.indexOf("get x"), end: src.indexOf(" });") });
  });

  it("rejects invalid targets and shorthand initializers", () => {
    expect(error("({ a = 1 });").kind).toBe("SyntaxError");
    expect(error("o?.x = 1;").kind).toBe("SyntaxError");
    expect(error("f() = 1;").kind).toBe("SyntaxError");
  });
});

describe("statements", () => {
  it("parses declarations and functions", () => {
    const p = parse(`"use strict";
var a = 1; let b; const c = a + 1;
function add(x, y) { return x + y; }`);
    expect(p.strict).toBe(true);
    expect(strip(p.body[1])).toEqual({
      type: "VariableDeclaration",
      kind: "var",
      declarations: [{ type: "VariableDeclarator", id: { type: "Identifier", name: "a" }, init: { type: "Literal", value: 1 } }],
    });
    expect(strip(p.body[2])).toMatchObject({ kind: "let", declarations: [{ id: { name: "b" }, init: null }] });
    expect(strip(p.body[3])).toMatchObject({ kind: "const" });
    expect(strip(p.body[4])).toMatchObject({
      type: "FunctionDeclaration",
      id: { name: "add" },
      params: [{ name: "x" }, { name: "y" }],
      body: { type: "BlockStatement", body: [{ type: "ReturnStatement" }] },
      strict: false,
    });
  });

  it("parses every control-flow form", () => {
    const p = parse(`
if (a) b(); else { c(); }
while (x) x--;
do { y++; } while (y < 10);
for (let i = 0; i < n; i++) continue;
for (;;) break;
outer: for (i = 0; ; ) { break outer; }
switch (k) { case 1: f(); break; default: g(); }
try { h(); } catch (e) { throw e; } finally { done(); }
try { h(); } catch { }
;`);
    expect(p.body.map((s) => s.type)).toEqual([
      "IfStatement", "WhileStatement", "DoWhileStatement", "ForStatement", "ForStatement",
      "LabeledStatement", "SwitchStatement", "TryStatement", "TryStatement", "EmptyStatement",
    ]);
    expect(strip(p.body[3])).toMatchObject({ init: { type: "VariableDeclaration", kind: "let" }, update: { type: "UpdateExpression" } });
    expect(strip(p.body[4])).toMatchObject({ init: null, test: null, update: null });
    expect(strip(p.body[6])).toMatchObject({ cases: [{ test: { value: 1 } }, { test: null }] });
    expect(strip(p.body[7])).toMatchObject({ handler: { param: { name: "e" } }, finalizer: { type: "BlockStatement" } });
    expect(strip(p.body[8])).toMatchObject({ handler: { param: null }, finalizer: null });
  });

  it("detects the directive prologue exactly", () => {
    expect(parse("'use strict'; x;").strict).toBe(true);
    expect(parse('"other"; "use strict"; x;').strict).toBe(true);
    expect(parse('x; "use strict";').strict).toBe(false);
    expect(parse('"use\\x20strict";').strict).toBe(false);  // escapes don't count
    const f = firstStatement('function f() { "use strict"; }') as Extract<Statement, { type: "FunctionDeclaration" }>;
    expect(f.strict).toBe(true);
  });
});

describe("source locations", () => {
  it("records 1-based line and column", () => {
    const p: Program = parse("let a = 1;\n  foo(bar);");
    const call = p.body[1]!;
    expect(call.loc).toEqual({ file: "test.js", line: 2, column: 3 });
    if (call.type !== "ExpressionStatement" || call.expression.type !== "CallExpression") throw new Error();
    expect(call.expression.arguments[0]!.loc).toEqual({ file: "test.js", line: 2, column: 7 });
  });
});

describe("errors", () => {
  it("reports syntax errors with locations", () => {
    const e = error("let x = ;\n");
    expect(e.kind).toBe("SyntaxError");
    expect(e.loc).toMatchObject({ line: 1, column: 9 });
    expect(e.message).toMatch(/^test\.js:1:9: SyntaxError: /);
    expect(error("function f( {").kind).toBe("SyntaxError");
    expect(error("-2 ** 2").kind).toBe("SyntaxError");
  });

  it("reports early errors the TypeScript parser leaves to its checker", () => {
    expect(error("1 = x;").kind).toBe("SyntaxError");
    expect(error("f() = 1;").kind).toBe("SyntaxError");
    expect(error("++f();").kind).toBe("SyntaxError");
    expect(error("a ?? b || c;").kind).toBe("SyntaxError");
    expect(error("a && b ?? c;").kind).toBe("SyntaxError");
    expect(() => parse("(a && b) ?? c;")).not.toThrow();
  });

  it("rejects TypeScript-only syntax as a JavaScript syntax error", () => {
    for (const src of ["let x: number = 1;", "function f(a: string) {}", "x as any;", "interface I {}", "type T = 1;", "x!;"]) {
      expect(error(src).kind, src).toBe("SyntaxError");
    }
    // …but not valid JavaScript that merely looks like it: (f < string) > (x)
    expect(strip(expr("f<string>(x)"))).toMatchObject({ type: "BinaryExpression", operator: ">" });
  });

  it("keeps a BigInt literal's value in decimal", () => {
    expect(strip(expr("0x1F_00n"))).toMatchObject({ type: "BigIntLiteral", value: "7936" });
    expect(strip(expr("18446744073709551616n"))).toMatchObject({ type: "BigIntLiteral", value: "18446744073709551616" });
  });

  it("keeps a regex literal's pattern and flags as written", () => {
    expect(strip(expr("/a\\/[/]b/gu"))).toMatchObject({ type: "RegExpLiteral", pattern: "a\\/[/]b", flags: "gu" });
  });

  it("keeps converting past unsupported constructs, as Unsupported nodes", () => {
    const p = parse("@d class A {}\nf(1);\nwith (o) {}\nlet b = 2;");
    expect(p.body).toHaveLength(4);
    expect(strip(p.body[0])).toMatchObject({ type: "Unsupported", detail: "decorators" });
    expect(strip(p.body[1])).toMatchObject({ type: "ExpressionStatement" });
    expect(p.unsupported.map((u) => [u.detail, u.loc.line])).toEqual([["decorators", 1], ["`with`", 3]]);
    /* a syntax error after an unsupported construct still wins */
    expect(error("@d class A {}\nlet y = ;").kind).toBe("SyntaxError");
  });

  it("names the features it does not support", () => {
    const cases: [string, RegExp][] = [
      ["@d class A {}", /decorators/],
    ];
    for (const [src, re] of cases) {
      const e = error(src);
      expect(e.kind, src).toBe("NotSupported");
      expect(e.message, src).toMatch(re);
    }
  });
});
