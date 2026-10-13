// @visaljs/optimizer: IR → IR passes between lowering and C emission: type
// inference, unboxing, removing checks that can't fire. Each pass takes a valid module and
// returns one: the IR verifier checks every pass's output, so passes can be written, reordered
// and tested on their own. They run in the order of DEFAULT_PASSES: module bindings to SSA
// values and inlining first, so inference sees more; dead code goes before inference and again
// after specialization; unboxing last, once types are final. Each pass counts what it did
// (`visaljs build` prints the counts under its optimizing step).
import { type ModuleIR, verify } from "@visaljs/ir";

import { dce } from "./dce.ts";
import { elideArguments } from "./elide-arguments.ts";
import { inferTypes } from "./infer-types.ts";
import { inline } from "./inline.ts";
import { promoteGlobals } from "./promote-globals.ts";
import { simplify } from "./simplify.ts";
import { specialize } from "./specialize.ts";
import { unbox } from "./unbox.ts";

export { dce } from "./dce.ts";
export { elideArguments } from "./elide-arguments.ts";
export { inferTypes } from "./infer-types.ts";
export { inline } from "./inline.ts";
export { promoteGlobals } from "./promote-globals.ts";
export { simplify } from "./simplify.ts";
export { specialize } from "./specialize.ts";
export { unbox } from "./unbox.ts";

/** Counts something a pass did: `count("removed", "dead value", 12)` (the plural: the noun
 *  with an s, unless given). */
export type Count = (verb: string, noun: string, n?: number, plural?: string) => void;

export interface Pass {
  name: string;
  run(m: ModuleIR, count: Count): ModuleIR;
}

/** One thing a pass counted. */
export interface Tally {
  verb: string;
  noun: string;
  plural: string;
  n: number;
}

/** What each pass run did, in order. */
export interface PassReport {
  pass: string;
  tallies: Tally[];
}

/** The passes `optimize` runs by default, in order. */
export const DEFAULT_PASSES: readonly Pass[] = [promoteGlobals, inline, dce, inferTypes, simplify, specialize, elideArguments, dce, unbox];

function verifyModule(m: ModuleIR, after: string) {
  try {
    for (const fn of [m.main, ...m.functions]) verify(fn);
  } catch (e) {
    if (after) (e as Error).message = `after the ${after} pass: ${(e as Error).message}`;
    throw e;
  }
}

/** Runs the passes over a module, verifying it before and after each. `report`, if given,
 *  receives what each pass counted. */
export function optimize(m: ModuleIR, passes: readonly Pass[] = DEFAULT_PASSES, report?: PassReport[]): ModuleIR {
  verifyModule(m, "");
  for (const pass of passes) {
    const tallies: Tally[] = [];
    m = pass.run(m, (verb, noun, n = 1, plural = `${noun}s`) => {
      if (!n) return;
      const t = tallies.find((t) => t.verb === verb && t.noun === noun);
      if (t) t.n += n;
      else tallies.push({ verb, noun, plural, n });
    });
    verifyModule(m, pass.name);
    report?.push({ pass: pass.name, tallies });
  }
  return m;
}

/** A report as lines, one per pass that did something (a pass run twice: its counts summed),
 *  grouped by verb: "simplify: removed 5 exception checks, 2 conversions; folded 1 branch". */
export function formatReport(report: readonly PassReport[]): string[] {
  const byPass = new Map<string, Tally[]>();
  for (const { pass, tallies } of report) {
    const sum = byPass.get(pass) ?? [];
    for (const t of tallies) {
      const same = sum.find((s) => s.verb === t.verb && s.noun === t.noun);
      if (same) same.n += t.n;
      else sum.push({ ...t });
    }
    byPass.set(pass, sum);
  }
  return [...byPass].filter(([, tallies]) => tallies.length).map(([pass, tallies]) => {
    const verbs = [...new Set(tallies.map((t) => t.verb))];
    const phrases = verbs.map((verb) => `${verb} ${tallies.filter((t) => t.verb === verb)
      .map((t) => `${t.n.toLocaleString("en-US")} ${t.n === 1 ? t.noun : t.plural}`).join(", ")}`);
    return `${pass}: ${phrases.join("; ")}`;
  });
}
