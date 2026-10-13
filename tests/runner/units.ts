// Turns one test262 file into its compile units.
import type { TestMetadata } from "./metadata.ts";

export type Mode = "sloppy" | "strict" | "module";

export type Expectation =
  | { kind: "normal" }
  | { kind: "async" }
  | { kind: "compile-error"; type: string }
  | { kind: "runtime-error"; type: string };

export interface CompileUnit {
  /** Path relative to test262's `test/` directory. */
  path: string;
  mode: Mode;
  /** Harness files (relative to `harness/`) prepended in order. */
  harness: string[];
  expect: Expectation;
}

export function harnessFiles(meta: TestMetadata): string[] {
  if (meta.flags.has("raw")) return [];
  const files = ["assert.js", "sta.js"];
  if (meta.flags.has("async")) files.push("doneprintHandle.js");
  for (const inc of meta.includes) if (!files.includes(inc)) files.push(inc);
  return files;
}

function modes(meta: TestMetadata): Mode[] {
  const f = meta.flags;
  if (f.has("module")) return ["module"];
  if (f.has("raw") || f.has("noStrict")) return ["sloppy"];
  if (f.has("onlyStrict")) return ["strict"];
  return ["sloppy", "strict"];
}

function expectation(meta: TestMetadata): Expectation {
  const n = meta.negative;
  if (n) return n.phase === "runtime" ? { kind: "runtime-error", type: n.type } : { kind: "compile-error", type: n.type };
  return meta.flags.has("async") ? { kind: "async" } : { kind: "normal" };
}

export function compileUnits(path: string, meta: TestMetadata): CompileUnit[] {
  const harness = harnessFiles(meta);
  const expect = expectation(meta);
  return modes(meta).map((mode) => ({ path, mode, harness, expect }));
}

/** The source text compiled for a unit: the harness, then the test. A module unit is one ES
 *  module (`--no-bundle`); its harness becomes part of the module, as a bundler would make it. */
export function renderUnit(unit: CompileUnit, testSource: string, readHarness: (file: string) => string): string {
  const parts = unit.mode === "strict" ? ['"use strict";\n'] : [];
  for (const file of unit.harness) parts.push(readHarness(file), "\n");
  parts.push(testSource);
  return parts.join("");
}
