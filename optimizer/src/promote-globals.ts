// Module bindings as SSA values. A top-level `let`/`const`/`var` lives in a
// mod_globals slot, read and written with load_global / store_global, so a loop at the top level
// works on memory and inference learns nothing about it. A slot that only `main` reads and writes
// (no function names the binding) becomes SSA values in `main`, as lowering makes for a
// function's locals: a load is the value of the last store on the way, a phi where paths join.
//
// SSA construction, iterative (big bundles have big mains): blocks in reverse postorder; a block
// with one predecessor already visited starts with that block's final value, any other block
// with a phi (a loop header's inputs are only known after the loop). Phis whose inputs are all
// one value are that value. Exception edges need nothing special: a store can't throw, and in a
// `try` a throwing instruction ends its block, so the value at the end of a block is the one its
// handler sees.
import { Any, T, type Block, type FunctionIR, type Instr, type ModuleIR } from "@visaljs/ir";

import { functionsOf, removeInstrs, replaceUses, reversePostorder } from "./cfg.ts";
import type { Count, Pass } from "./index.ts";

export const promoteGlobals: Pass = {
  name: "promote-globals",
  run(m: ModuleIR, count: Count) {
    /* slots another function uses (or a template / import.meta cache) stay in memory */
    const shared = new Set<number>();
    for (const fn of functionsOf(m))
      for (const b of fn.blocks)
        for (const i of b.instrs) {
          const slotOp = i.op === "load_global" || i.op === "store_global";
          if ((slotOp && fn !== m.main) || i.op === "template_object" || i.op === "import_meta") shared.add(i.index!);
        }
    const slots = new Set<number>();
    for (const b of m.main.blocks)
      for (const i of b.instrs) if ((i.op === "load_global" || i.op === "store_global") && !shared.has(i.index!)) slots.add(i.index!);
    if (slots.size) count("promoted", "module binding", promote(m.main, slots, m));
    return m;
  },
};

function promote(fn: FunctionIR, slots: Set<number>, m: ModuleIR): number {
  let nextId = 1 + Math.max(0, ...fn.blocks.flatMap((b) => [...b.phis, ...b.instrs].map((i) => i.id)));
  const entry = fn.blocks[0]!;
  const names = new Map(m.globals.map((g) => [g.slot, g.name]));
  /* before main runs, every slot is undefined (mod_globals' initialization) */
  const undef: Instr = {
    id: nextId++, op: "const", operands: [], type: T.Undefined, repr: "boxed", mayThrow: false,
    block: entry, loc: null, lit: { value: undefined },
  };
  entry.instrs.unshift(undef);

  const order = reversePostorder(fn);
  const visited = new Set<Block>();
  const atEnd = new Map<Block, Map<number, Instr>>();
  const pending: { phi: Instr; slot: number }[] = [];
  const replacements = new Map<Instr, Instr>();
  const dead = new Set<Instr>();
  for (const b of order) {
    const current = new Map<number, Instr>();
    if (b === entry) {
      for (const s of slots) current.set(s, undef);
    } else if (b.preds.length === 1 && visited.has(b.preds[0]!)) {
      for (const [s, v] of atEnd.get(b.preds[0]!)!) current.set(s, v);
    } else {
      for (const s of slots) {
        const name = names.get(s);
        const phi: Instr = {
          id: nextId++, op: "phi", operands: [], type: Any, repr: "boxed", mayThrow: false,
          block: b, loc: null, incoming: [], ...(name ? { name } : {}),
        };
        b.phis.push(phi);
        pending.push({ phi, slot: s });
        current.set(s, phi);
      }
    }
    for (const i of b.instrs) {
      if ((i.op !== "load_global" && i.op !== "store_global") || !slots.has(i.index!)) continue;
      if (i.op === "store_global") current.set(i.index!, i.operands[0]!);
      else replacements.set(i, current.get(i.index!)!);
      dead.add(i);
    }
    atEnd.set(b, current);
    visited.add(b);
  }
  for (const { phi, slot } of pending) phi.incoming = phi.block.preds.map((p) => ({ block: p, value: atEnd.get(p)!.get(slot)! }));

  /* trivial phis (all inputs one value, or the phi itself) are that value, to a fixpoint */
  const resolve = (v: Instr): Instr => {
    while (replacements.has(v)) v = replacements.get(v)!;
    return v;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const { phi } of pending) {
      if (replacements.has(phi)) continue;
      let same: Instr | null = null;
      let trivial = true;
      for (const inc of phi.incoming!) {
        const v = resolve(inc.value);
        if (v === phi || v === same) continue;
        if (same) {
          trivial = false;
          break;
        }
        same = v;
      }
      if (trivial && same) {
        replacements.set(phi, same);
        dead.add(phi);
        changed = true;
      }
    }
  }
  replaceUses(fn, replacements);
  removeInstrs(fn, dead);
  return slots.size;
}
