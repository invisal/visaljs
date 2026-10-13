// Dead-code elimination: removes values nothing reads whose operation has no effect
// (it can't throw, call user code or change state; allocating a fresh object is fine), and the
// values only they read. The C emitter already skips such values; removing them keeps dumps
// readable and the later passes' work small.
import { type FunctionIR, type Instr, type ModuleIR, type Op } from "@visaljs/ir";

import { functionsOf, removeInstrs, useCounts } from "./cfg.ts";
import type { Count, Pass } from "./index.ts";

/** Operations with no effect but their result. */
const REMOVABLE = new Set<Op>([
  "num_add", "num_sub", "num_mul", "num_div", "num_mod", "num_neg", "num_inc", "num_dec",
  "num_lt", "num_le", "num_gt", "num_ge", "num_eq", "num_ne",
  "num_bitand", "num_bitor", "num_bitxor", "num_bitnot", "num_shl", "num_sar", "num_shr",
  "phi", "const", "empty", "bigint", "load_global", "global_this", "env_load", "sloppy_this",
  "strict_eq", "strict_ne", "switch_string", "not", "to_boolean", "is_nullish", "typeof", "not_empty",
  "new_object", "new_array", "make_function", "make_arguments", "host_function",
  "same_function", "function_env", "construct_result",
]);

export const dce: Pass = {
  name: "dce",
  run(m: ModuleIR, count: Count) {
    for (const fn of functionsOf(m)) count("removed", "dead value", dceFunction(fn));
    return m;
  },
};

/** Returns how many values it removed. */
export function dceFunction(fn: FunctionIR): number {
  const uses = useCounts(fn);
  const dead = new Set<Instr>();
  const removable = (i: Instr) => REMOVABLE.has(i.op) && !i.mayThrow && !dead.has(i);
  const work: Instr[] = [];
  for (const b of fn.blocks) for (const i of [...b.phis, ...b.instrs]) if (!uses.get(i) && removable(i)) work.push(i);
  const kill = (i: Instr) => {
    dead.add(i);
    const inputs = i.op === "phi" ? i.incoming!.map((inc) => inc.value) : i.operands;
    for (const v of inputs) {
      if (v === i) continue;
      const n = uses.get(v)! - 1;
      uses.set(v, n);
      if (!n && removable(v)) work.push(v);
    }
  };
  for (;;) {
    while (work.length) {
      const i = work.pop()!;
      if (!dead.has(i)) kill(i);
    }
    /* a loop phi only it reads: its count never reaches 0 */
    for (const b of fn.blocks)
      for (const phi of b.phis)
        if (!dead.has(phi) && uses.get(phi) === phi.incoming!.filter((inc) => inc.value === phi).length) work.push(phi);
    if (!work.length) break;
  }
  removeInstrs(fn, dead);
  return dead.size;
}
