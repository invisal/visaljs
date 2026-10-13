import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { firstUnsupported, parseScript } from "../src/frontend/adapter.ts";
import { emitProgram } from "../src/emit/c.ts";
import { CompileError } from "../src/frontend/errors.ts";
import { printModule } from "@visaljs/ir";
import { verify } from "@visaljs/ir";
import { lower } from "../src/lower/lower.ts";
import { analyze } from "../src/sema/analyze.ts";

function compile(src: string, file = "t.js") {
  const ast = parseScript(src, file);
  const info = analyze(ast);
  const u = firstUnsupported(ast);
  if (u) throw u;
  const ir = lower(ast, info);
  for (const fn of [ir.main, ...ir.functions]) verify(fn);
  return ir;
}

/* Golden tests: test/golden/*.js → *.ir and *.c. UPDATE_GOLDEN=1 rewrites them. */
const GOLDEN = join(import.meta.dirname, "golden");

describe("golden IR and C", () => {
  for (const file of readdirSync(GOLDEN).filter((f) => f.endsWith(".js"))) {
    it(file, () => {
      const ir = compile(readFileSync(join(GOLDEN, file), "utf8"), file);
      for (const [ext, actual] of [[".ir", printModule(ir)], [".c", emitProgram(ir)]] as const) {
        const golden = join(GOLDEN, file.replace(/\.js$/, ext));
        if (process.env.UPDATE_GOLDEN) writeFileSync(golden, actual);
        expect(actual, ext).toBe(readFileSync(golden, "utf8"));
      }
    });
  }
});

describe("C emission details", () => {
  it("writes doubles as exact hex floats and escapes C strings", async () => {
    const { hexFloat, cString } = await import("../src/emit/c.ts");
    expect(hexFloat(0.1)).toBe("0x1.999999999999ap-4");
    expect(hexFloat(-2.5)).toBe("-0x1.4p1");
    expect(hexFloat(5e-324)).toBe("0x0.0000000000001p-1022");
    expect(hexFloat(-0)).toBe("-0.0");
    expect(cString('a"b\\c?\né')).toBe('"a\\"b\\\\c\\?\\012\\303\\251"');
  });
});

describe("lowering", () => {
  it("pads and truncates arguments of direct calls, evaluating all of them", () => {
    const ir = compile("function f(a, b) { return a; }\nf(1); f(1, 2, g());\nfunction g() {}");
    const calls = ir.main.blocks.flatMap((b) => b.instrs).filter((i) => i.op === "call_direct");
    expect(calls.map((c) => [c.target, c.operands.length])).toEqual([["f", 2], ["g", 0], ["f", 2]]);
  });

  it("keeps block-level lexicals of the script local, and top-level ones global", () => {
    const ir = compile("let g = 1; { let local = g; print(local); }");
    expect(ir.globals.map((x) => x.name)).toEqual(["g"]);
  });

  it("uses constants for undefined, NaN and Infinity", () => {
    const ir = compile("print(undefined, NaN, Infinity);");
    expect(printModule(ir)).toMatch(/const undefined\n.*const NaN\n.*const Infinity/s);
  });

  it("throws a TypeError at runtime for an assignment to a const, after the right side", () => {
    const out = printModule(compile("const c = 1; function f() { c = g(); } function g() {}"));
    expect(out).toMatch(/call_direct g\(\).*check_tdz.*call_runtime throw_const_assign\(\)/s);
  });

  it("names what isn't supported yet", () => {
    const cases: [string, RegExp][] = [
      ["class A extends Object { m() { return delete super.x; } }", /delete of a super property/],
    ];
    for (const [src, re] of cases) {
      let error: unknown;
      try {
        compile(src);
      } catch (e) {
        error = e;
      }
      expect(error, src).toBeInstanceOf(CompileError);
      expect((error as CompileError).kind, src).toBe("NotSupported");
      expect((error as CompileError).message, src).toMatch(re);
    }
  });
});
