import { describe, expect, it } from "vitest";

import { MetadataError, parseMetadata } from "./metadata.ts";
import { globToRegExp, parseSkipList, skipReason } from "./skip.ts";
import { runBatch } from "./batch.ts";
import { compareWithSnapshot, inShard, mergeShards, parseShard, type Summary } from "./main.ts";
import { compileUnits, harnessFiles, renderUnit } from "./units.ts";

const test = (frontmatter: string, body = "") => `// Copyright\n/*---\n${frontmatter}\n---*/\n${body}`;

describe("parseMetadata", () => {
  it("reads includes, flags, features and folded descriptions", () => {
    const meta = parseMetadata(
      test(`description: >
  Checks
  things
includes: [compareArray.js, propertyHelper.js]
flags: [onlyStrict]
features:
  - Symbol
  - let`),
    );
    expect(meta.description).toBe("Checks things");
    expect(meta.includes).toEqual(["compareArray.js", "propertyHelper.js"]);
    expect([...meta.flags]).toEqual(["onlyStrict"]);
    expect(meta.features).toEqual(["Symbol", "let"]);
    expect(meta.negative).toBeNull();
  });

  it("reads negative tests", () => {
    const meta = parseMetadata(test("negative:\n  phase: parse\n  type: SyntaxError"));
    expect(meta.negative).toEqual({ phase: "parse", type: "SyntaxError" });
  });

  it("accepts CR and CRLF line terminators", () => {
    const meta = parseMetadata("/*---\rflags: [raw]\r\nfeatures: [let]\r---*/");
    expect([...meta.flags]).toEqual(["raw"]);
    expect(meta.features).toEqual(["let"]);
  });

  it("rejects missing or malformed frontmatter", () => {
    expect(() => parseMetadata("var x;")).toThrow(MetadataError);
    expect(() => parseMetadata(test("negative:\n  phase: later\n  type: X"))).toThrow(MetadataError);
    expect(() => parseMetadata(test("includes: nope.js"))).toThrow(MetadataError);
    expect(() => parseMetadata(test("a: b: c"))).toThrow(MetadataError);
  });
});

describe("compileUnits", () => {
  const units = (fm: string) => compileUnits("a/b.js", parseMetadata(test(fm)));

  it("runs default tests twice, sloppy and strict", () => {
    expect(units("description: x").map((u) => u.mode)).toEqual(["sloppy", "strict"]);
  });

  it("honors onlyStrict, noStrict, raw and module", () => {
    expect(units("flags: [onlyStrict]").map((u) => u.mode)).toEqual(["strict"]);
    expect(units("flags: [noStrict]").map((u) => u.mode)).toEqual(["sloppy"]);
    expect(units("flags: [raw]").map((u) => u.mode)).toEqual(["sloppy"]);
    expect(units("flags: [module]").map((u) => u.mode)).toEqual(["module"]);
  });

  it("maps negative phases and async to expectations", () => {
    expect(units("negative: {phase: parse, type: SyntaxError}")[0]!.expect).toEqual({
      kind: "compile-error",
      type: "SyntaxError",
    });
    expect(units("negative: {phase: resolution, type: SyntaxError}")[0]!.expect.kind).toBe("compile-error");
    expect(units("negative: {phase: runtime, type: TypeError}")[0]!.expect).toEqual({
      kind: "runtime-error",
      type: "TypeError",
    });
    expect(units("flags: [async]")[0]!.expect).toEqual({ kind: "async" });
  });

  it("builds the harness prefix", () => {
    const meta = (fm: string) => parseMetadata(test(fm));
    expect(harnessFiles(meta("description: x"))).toEqual(["assert.js", "sta.js"]);
    expect(harnessFiles(meta("flags: [async]\nincludes: [asyncHelpers.js]"))).toEqual([
      "assert.js",
      "sta.js",
      "doneprintHandle.js",
      "asyncHelpers.js",
    ]);
    expect(harnessFiles(meta("flags: [raw]\nincludes: [x.js]"))).toEqual([]);
  });

  it("renders strict scripts with the directive first", () => {
    const [sloppy, strict] = units("includes: [x.js]");
    const read = (f: string) => `/*${f}*/`;
    expect(renderUnit(sloppy!, "T;", read)).toBe("/*assert.js*/\n/*sta.js*/\n/*x.js*/\nT;");
    expect(renderUnit(strict!, "T;", read)).toBe('"use strict";\n/*assert.js*/\n/*sta.js*/\n/*x.js*/\nT;');
  });
});

describe("skip list", () => {
  const list = parseSkipList(`
# comment
feature  Temporal
path     language/eval-code/**   # eval is a non-goal
path     built-ins/*/weird.js
`);
  const meta = (features: string[]) => ({ ...parseMetadata(test("description: x")), features });

  it("skips by feature and by path glob", () => {
    expect(skipReason(list, "built-ins/Temporal/x.js", meta(["Temporal"]))).toBe("feature Temporal");
    expect(skipReason(list, "language/eval-code/direct/a.js", meta([]))).toMatch(/^path/);
    expect(skipReason(list, "built-ins/Array/weird.js", meta([]))).toMatch(/^path/);
    expect(skipReason(list, "built-ins/Array/sub/weird.js", meta([]))).toBeNull();
    expect(skipReason(list, "language/statements/if/a.js", meta(["let"]))).toBeNull();
  });

  it("escapes regex characters in globs", () => {
    expect(globToRegExp("a.b/**").test("aXb/c")).toBe(false);
    expect(globToRegExp("a.b/**").test("a.b/c/d.js")).toBe(true);
  });

  it("rejects malformed lines", () => {
    expect(() => parseSkipList("feature")).toThrow(/test262.skip:1/);
    expect(() => parseSkipList("dir foo")).toThrow(/unknown kind/);
  });
});

describe("running units", () => {
  const negative = (body: string, phase = "parse", type = "SyntaxError") => test(`negative:\n  phase: ${phase}\n  type: ${type}`, body);
  const unitsOf = (src: string) => compileUnits("x.js", parseMetadata(src));
  const harness = () => "";
  /** Runs every unit of each source; the results, in order. */
  const run = (...sources: string[]) =>
    runBatch(sources.flatMap((source) => unitsOf(source).map((unit) => ({ unit, source }))), harness);

  it("passes a negative syntax test the front end rejects, and fails one it accepts", () => {
    expect(run(negative("$DONOTEVALUATE();\nlet x = ;")).map((r) => r.outcome)).toEqual(["pass", "pass"]);
    expect(run(negative("let x = 1;")).map((r) => r.outcome)).toEqual(["fail", "fail"]);
    /* "not supported yet" proves nothing about the program being invalid */
    expect(run(negative("@d class A {}"))[0]).toMatchObject({ outcome: "fail" });
    /* an invalid regex literal is an early error */
    expect(run(negative("/(/;")).map((r) => r.outcome)).toEqual(["pass", "pass"]);
  }, 120000);  /* the program the front end accepts is compiled, as the tests below */

  it("compiles, runs and classifies the rest, one batch", () => {
    const results = run(
      test("description: ok", "if (1 + 1 !== 2) throw 1;"),
      test("description: fails", 'throw new TypeError("boom");'),
      negative('throw new TypeError("x");', "runtime", "TypeError"),
      negative("1;", "runtime", "TypeError"),
      test("description: later", "@d class A {}"),
      test("description: m\nflags: [module]", "var x = 1; if (this !== undefined || globalThis.x !== undefined) throw 1; await 0;"),
      test("description: imports\nflags: [module]", 'import { y } from "./y_FIXTURE.js";'),
    );
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ["pass", "passed"], ["pass", "passed"],
      ["fail", "failed"], ["fail", "failed"],
      ["pass", "passed"], ["pass", "passed"],
      ["fail", "failed"], ["fail", "failed"],
      ["fail", "unsupported"], ["fail", "unsupported"],
      ["pass", "passed"],         // a module: its own top-level bindings, `this` undefined, top-level await
      ["fail", "unsupported"],    // imports wait for the bundler
    ]);
    expect(results[2]!.detail).toBe("Uncaught TypeError: boom");
  }, 300000);  /* the first to build the test host, and with it the runtime: 100–120 s on CI's 4 cores */

  it("runs the harness compiled into the host before the unit", () => {
    const results = run(
      test("description: assert", 'assert.sameValue(typeof Test262Error, "function"); assert.throws(TypeError, () => null.x);'),
      test("description: strict\nflags: [onlyStrict]", "assert.throws(ReferenceError, () => { undeclared = 1; });"),
      test("description: a failing assertion\nflags: [noStrict]", "assert.sameValue(1, 2);"),
      test("description: an include\nincludes: [compareArray.js]\nflags: [noStrict]", "assert.compareArray([1, 2], [1, 2]);"),
    );
    expect(results.map((r) => r.reason)).toEqual(["passed", "passed", "passed", "failed", "passed"]);
    expect(results[3]!.detail).toMatch(/^Uncaught Test262Error: Expected SameValue\(«1», «2»\)/);
  }, 120000);

  it("isolates a hang: a timeout for that unit only", () => {
    const results = run(
      test("description: hang\nflags: [onlyStrict]", "for (;;) {}"),
      test("description: after\nflags: [onlyStrict]", "1;"),
    );
    expect(results.map((r) => r.reason)).toEqual(["timeout", "passed"]);
  }, 120000);

  it("finds regressions against the snapshot", () => {
    expect(compareWithSnapshot(["a sloppy", "c strict"], ["a sloppy", "b sloppy"])).toEqual({
      regressions: ["b sloppy"],
      newlyPassing: ["c strict"],
    });
  });
});

describe("shards", () => {
  it("parses I/N, 1-based", () => {
    expect(parseShard("2/4")).toEqual({ index: 1, count: 4 });
    for (const bad of ["0/4", "5/4", "1/0", "a/b", "3"]) expect(() => parseShard(bad)).toThrow();
  });

  it("puts every file in exactly one shard, about evenly", () => {
    const paths = Array.from({ length: 4000 }, (_, i) => `built-ins/X/t${i}.js`);
    const sizes = [0, 1, 2, 3].map((index) => paths.filter((p) => inShard(p, { index, count: 4 })).length);
    expect(sizes.reduce((a, b) => a + b)).toBe(paths.length);
    for (const n of sizes) expect(n).toBeGreaterThan(900);
    expect(paths.every((p) => inShard(p, null))).toBe(true);
  });

  it("merges every shard's Summary into the full suite's", () => {
    const part = (index: number, unit: string, failing: string): { shard: { index: number; count: number }; summary: Summary } => ({
      shard: { index, count: 2 },
      summary: {
        files: 2, skipped: 0, units: 2, run: 2, passed: 1, failed: 1, badMetadata: 0, byMode: { strict: 2 },
        byDir: { "built-ins": { files: 2, skipped: 0, units: 2, run: 2, passed: 1, failed: 1 } },
        blocked: null, byReason: { passed: 1, failed: 1 }, passing: [unit], failures: [{ unit: failing, reason: "failed" }],
      },
    });
    const merged = mergeShards([part(1, "b.js script", "d.js script"), part(0, "a.js script", "c.js script")]);
    expect(merged).toMatchObject({ files: 4, units: 4, passed: 2, failed: 2, byMode: { strict: 4 }, byReason: { passed: 2, failed: 2 } });
    expect(merged.byDir["built-ins"]!.passed).toBe(2);
    expect(merged.passing).toEqual(["a.js script", "b.js script"]);
    expect(merged.failures.map((f) => f.unit)).toEqual(["c.js script", "d.js script"]);
    expect(() => mergeShards([part(0, "a.js script", "c.js script")])).toThrow(/each of the N shards/);
    expect(() => mergeShards([part(0, "a.js script", "c.js script"), part(0, "a.js script", "c.js script")])).toThrow();
  });
});
