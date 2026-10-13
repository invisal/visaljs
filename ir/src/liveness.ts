// Liveness: which values a generator must save at each pause point. Backward
// dataflow over the SSA blocks: a phi's operand is live out of the predecessor it comes
// from, not into the phi's block; exception edges count (successors() includes handlers).
import { successors, type Block, type FunctionIR, type Instr } from "./ir.ts";

/** Values worth tracking: constants and EMPTY are rematerialized, never saved. */
const tracked = (i: Instr) => i.op !== "const" && i.op !== "empty";

function usesOf(b: Block): Instr[][] {
  const t = b.term;
  const termUses = t?.kind === "branch" ? [t.cond] : t?.kind === "return" || t?.kind === "throw" ? [t.value] : [];
  return [...b.instrs.map((i) => i.operands), termUses];
}

/**
 * For each pause point (`isPause`), the values live right after it, not counting the
 * pause's own result (which the resume provides).
 */
export function liveAfterPauses(fn: FunctionIR, isPause: (i: Instr) => boolean): Map<Instr, Instr[]> {
  const liveIn = new Map<Block, Set<Instr>>(fn.blocks.map((b) => [b, new Set()]));
  const liveOutOf = (b: Block): Set<Instr> => {
    const out = new Set<Instr>();
    for (const s of successors(b)) {
      for (const v of liveIn.get(s)!) out.add(v);
      for (const p of s.phis) for (const inc of p.incoming ?? []) if (inc.block === b && tracked(inc.value)) out.add(inc.value);
    }
    return out;
  };
  /* live before `b`'s first instruction, given what is live at its end */
  const walk = (b: Block, live: Set<Instr>, onInstr?: (i: Instr, liveAfter: Set<Instr>) => void) => {
    const [termUses] = usesOf(b).slice(-1);
    for (const u of termUses!) if (tracked(u)) live.add(u);
    for (let k = b.instrs.length - 1; k >= 0; k--) {
      const i = b.instrs[k]!;
      onInstr?.(i, live);
      live.delete(i);
      for (const u of i.operands) if (tracked(u)) live.add(u);
    }
    for (const p of b.phis) live.delete(p);  // defined on entry (their operands: on the edges)
    return live;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = fn.blocks.length - 1; k >= 0; k--) {
      const b = fn.blocks[k]!;
      const next = walk(b, liveOutOf(b));
      const old = liveIn.get(b)!;
      if (next.size !== old.size || [...next].some((v) => !old.has(v))) {
        liveIn.set(b, next);
        changed = true;
      }
    }
  }
  const result = new Map<Instr, Instr[]>();
  for (const b of fn.blocks)
    walk(b, liveOutOf(b), (i, after) => {
      if (isPause(i)) result.set(i, [...after].filter((v) => v !== i));
    });
  return result;
}
