// Differential tests: each tests/differential/*.js runs under Node (live, the
// installed version) and compiled by visaljs; stdout, stderr and the exit status must match.
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { differential } from "./diff.ts";

const DIR = import.meta.dirname;
const OUT = mkdtempSync(join(tmpdir(), "visaljs-differential-"));

// a build takes about 2 minutes on a loaded runner: 5 minutes leaves room
const TIMEOUT = 300000;

describe("differential (Node vs visaljs)", () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".js")).sort()) {
    it(file, async () => {
      const outcome = await differential(join(DIR, file), OUT);
      expect(outcome.differences.join("\n")).toBe("");
    }, TIMEOUT);
  }

  it("reports where a program differs", async () => {
    /* eval of source text isn't supported: a known difference */
    const file = join(OUT, "eval.js");
    writeFileSync(file, 'console.log("same line");\ntry { console.log(eval("1 + 1")); } catch (e) { console.log(e.name); }\n');
    const outcome = await differential(file, OUT);
    expect(outcome.differences).toEqual([
      'stdout differs at line 2:\n    node:     "2"\n    visaljs: "TypeError"',
    ]);
  }, TIMEOUT);
});
