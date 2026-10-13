import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { analyze, emitProgram, lower, parseModule } from "@visaljs/compiler";
import { printModule } from "@visaljs/ir";
import { describe, expect, it } from "vitest";

import { optimize } from "../src/index.ts";

/* Golden tests: test/golden/*.js (a module) → its optimized IR (*.ir) and C (*.c), with the
   default passes. UPDATE_GOLDEN=1 rewrites them. */
const GOLDEN = join(import.meta.dirname, "golden");

describe("golden optimized IR and C", () => {
  for (const file of readdirSync(GOLDEN).filter((f) => f.endsWith(".js"))) {
    it(file, () => {
      const ast = parseModule(readFileSync(join(GOLDEN, file), "utf8"), file);
      const ir = optimize(lower(ast, analyze(ast)));
      for (const [ext, actual] of [[".ir", printModule(ir)], [".c", emitProgram(ir)]] as const) {
        const golden = join(GOLDEN, file.replace(/\.js$/, ext));
        if (process.env.UPDATE_GOLDEN) writeFileSync(golden, actual);
        expect(actual, ext).toBe(readFileSync(golden, "utf8"));
      }
    });
  }
});
