import { FunctionBuilder, type ModuleIR } from "@visaljs/ir";
import { describe, expect, it } from "vitest";

import { formatReport, optimize, type Pass, type PassReport } from "../src/index.ts";

/* the smallest module: a main that returns 0 */
function emptyModule(): ModuleIR {
  const b = new FunctionBuilder("main", [], true, null);
  b.terminate({ kind: "return", value: b.const(0) });
  return { main: b.finish(), functions: [], globals: [], source: "" };
}

describe("optimize (the pass pipeline)", () => {
  it("runs the passes in order and returns the last one's module", () => {
    const seen: string[] = [];
    const pass = (name: string): Pass => ({ name, run: (m) => (seen.push(name), m) });
    const m = emptyModule();
    expect(optimize(m, [pass("a"), pass("b")])).toBe(m);
    expect(seen).toEqual(["a", "b"]);
  });

  it("names the pass whose output fails verification", () => {
    const broken: Pass = { name: "breaker", run: (m) => ({ ...m, main: { ...m.main, blocks: [] } }) };
    expect(() => optimize(emptyModule(), [broken])).toThrow(/after the breaker pass/);
  });

  it("reports what each pass counted, summed per pass", () => {
    const counting = (name: string, verb: string, noun: string, n: number): Pass => ({ name, run: (m, count) => (count(verb, noun, n), m) });
    const report: PassReport[] = [];
    optimize(emptyModule(), [
      counting("dce", "removed", "dead value", 2), counting("idle", "did", "nothing", 0), counting("dce", "removed", "dead value", 1234),
      counting("simplify", "removed", "conversion", 1), counting("simplify", "removed", "TDZ check", 3), counting("simplify", "folded", "branch", 1),
    ], report);
    expect(formatReport(report)).toEqual(["dce: removed 1,236 dead values", "simplify: removed 1 conversion, 3 TDZ checks; folded 1 branch"]);
  });
});
