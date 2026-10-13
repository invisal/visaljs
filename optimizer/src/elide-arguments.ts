// The arguments object, unmade when nothing can tell (plan: React's createElement reads its
// children as arguments[i]). A function that uses `arguments` takes the call's arguments as a
// hidden array, fresh per call (the generic entry's js_new_array_from: no direct calls), and
// make_arguments turns it into the arguments object on every call: an allocation, and each
// argument defined on it. When every use of that object is `arguments.length` or
// `arguments[i]` with a Number `i` (get_index, after specialize), the array answers the same:
// the same elements and length, both own data properties, and nothing else holds the array to
// change them. Those reads then take the array, and DCE removes the unused make_arguments.
//
// Only an unmapped object (strict code, or parameters that aren't simple): a mapped one's
// elements alias the parameters, which the function may assign. Any other use (a call
// argument, a phi, a closure's environment, `arguments.callee`, a non-Number key, a write)
// keeps the object.
import { type FunctionIR, type Instr, type ModuleIR } from "@visaljs/ir";

import { functionsOf } from "./cfg.ts";
import type { Count, Pass } from "./index.ts";

export const elideArguments: Pass = {
  name: "elide-arguments",
  run(m: ModuleIR, count: Count) {
    for (const fn of functionsOf(m)) count("removed", "arguments object", elide(fn));
    return m;
  },
};

/** A read the hidden array answers as the arguments object would: `.length`, or [Number]. */
function arrayRead(i: Instr, obj: Instr): boolean {
  if (i.op === "get_prop") return i.operands[0] === obj && i.key !== undefined && "name" in i.key && i.key.name === "length";
  if (i.op === "get_index") return i.operands[0] === obj && i.operands[1] !== obj;
  return false;
}

function elide(fn: FunctionIR): number {
  const candidates = new Set<Instr>();
  for (const b of fn.blocks)
    for (const i of b.instrs) if (i.op === "make_arguments" && !i.table && i.operands[0]!.op === "param") candidates.add(i);
  if (!candidates.size) return 0;
  /* any use but an array read keeps the object */
  const reads: Instr[] = [];
  const escape = (v: Instr) => candidates.delete(v);
  for (const b of fn.blocks) {
    for (const phi of b.phis) for (const inc of phi.incoming!) escape(inc.value);
    for (const i of b.instrs)
      for (const o of i.operands) {
        if (!candidates.has(o)) continue;
        if (arrayRead(i, o)) reads.push(i);
        else escape(o);
      }
    const t = b.term;
    if (t?.kind === "branch") escape(t.cond);
    if (t?.kind === "return" || t?.kind === "throw") escape(t.value);
  }
  for (const i of reads) if (candidates.has(i.operands[0]!)) i.operands[0] = i.operands[0]!.operands[0]!;
  return candidates.size;
}
