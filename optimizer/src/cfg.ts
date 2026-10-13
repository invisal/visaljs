// Helpers the passes share: walking a module's functions and blocks, rewriting uses, removing
// instructions and blocks while keeping the IR valid (predecessors, phi inputs, handler edges).
import { dominates, dominators, successors, type Block, type FunctionIR, type Instr, type ModuleIR } from "@visaljs/ir";

export function functionsOf(m: ModuleIR): FunctionIR[] {
  return [m.main, ...m.functions];
}

/** The blocks in reverse postorder: each block before its successors, except along back edges. */
export function reversePostorder(fn: FunctionIR): Block[] {
  const order: Block[] = [];
  const seen = new Set<Block>();
  /* iterative DFS: big functions would overflow the JS stack */
  const stack: { b: Block; next: Block[] }[] = [];
  const push = (b: Block) => {
    seen.add(b);
    stack.push({ b, next: successors(b) });
  };
  push(fn.blocks[0]!);
  while (stack.length) {
    const top = stack.at(-1)!;
    const s = top.next.shift();
    if (s === undefined) {
      order.push(top.b);
      stack.pop();
    } else if (!seen.has(s)) {
      push(s);
    }
  }
  return order.reverse();
}

/** Every value an instruction, phi or terminator reads, with a way to replace it. */
function forEachUse(fn: FunctionIR, f: (v: Instr, set: (w: Instr) => void) => void) {
  for (const b of fn.blocks) {
    for (const phi of b.phis) for (const inc of phi.incoming!) f(inc.value, (w) => (inc.value = w));
    for (const i of b.instrs) i.operands.forEach((o, k) => f(o, (w) => (i.operands[k] = w)));
    const t = b.term;
    if (t?.kind === "branch") f(t.cond, (w) => (t.cond = w));
    if (t?.kind === "return" || t?.kind === "throw") f(t.value, (w) => (t.value = w));
  }
}

/** How many times each value is read. */
export function useCounts(fn: FunctionIR): Map<Instr, number> {
  const counts = new Map<Instr, number>();
  forEachUse(fn, (v) => counts.set(v, (counts.get(v) ?? 0) + 1));
  return counts;
}

/** Replaces every use of each key by its value (chains resolved), in one walk. The replaced
 *  instructions stay where they are: DCE removes them once unused. */
export function replaceUses(fn: FunctionIR, replacements: Map<Instr, Instr>) {
  if (!replacements.size) return;
  const resolve = (v: Instr) => {
    while (replacements.has(v)) v = replacements.get(v)!;
    return v;
  };
  forEachUse(fn, (v, set) => {
    const r = resolve(v);
    if (r !== v) set(r);
  });
}

/** Removes instructions and phis (nothing may use them any more). */
export function removeInstrs(fn: FunctionIR, dead: Set<Instr>) {
  if (!dead.size) return;
  for (const b of fn.blocks) {
    b.phis = b.phis.filter((p) => !dead.has(p));
    b.instrs = b.instrs.filter((i) => !dead.has(i));
  }
}

/** Removes the edge from → to: `to` loses the predecessor and its phis the input. */
export function removeEdge(from: Block, to: Block) {
  to.preds = to.preds.filter((p) => p !== from);
  for (const phi of to.phis) phi.incoming = phi.incoming!.filter((i) => i.block !== from);
}

/** Proves `i` can't throw. In a `try` it was the instruction that raises its block's exceptions,
 *  so the block's edge to the handler goes too (call removeUnreachable afterwards: the handler
 *  may have lost its last predecessor). */
export function clearMayThrow(i: Instr) {
  if (!i.mayThrow) return;
  const b = i.block;
  const before = new Set(successors(b));
  i.mayThrow = false;
  const after = new Set(successors(b));
  for (const s of before) if (!after.has(s)) removeEdge(b, s);
}

/** Drops blocks no path from the entry reaches, and phi inputs from them. Returns whether any went. */
export function removeUnreachable(fn: FunctionIR): boolean {
  const reachable = new Set(reversePostorder(fn));
  if (reachable.size === fn.blocks.length) return false;
  fn.blocks = fn.blocks.filter((b) => reachable.has(b));
  for (const b of fn.blocks) {
    b.preds = b.preds.filter((p) => reachable.has(p));
    for (const phi of b.phis) phi.incoming = phi.incoming!.filter((i) => reachable.has(i.block));
  }
  return true;
}

/** How many loops contain each block (natural loops: a back edge's target, the loop's header,
 *  dominates its source; back edges to one header make one loop). */
export function loopDepths(fn: FunctionIR): Map<Block, number> {
  const idom = dominators(fn);
  const loops = new Map<Block, Set<Block>>();
  for (const b of fn.blocks)
    for (const header of successors(b)) {
      if (!dominates(idom, header, b)) continue;
      /* header, and every block that reaches b without passing through header */
      const body = loops.get(header) ?? new Set<Block>([header]);
      loops.set(header, body);
      const work = [b];
      while (work.length) {
        const x = work.pop()!;
        if (body.has(x)) continue;
        body.add(x);
        work.push(...x.preds);
      }
    }
  const depth = new Map<Block, number>(fn.blocks.map((b) => [b, 0]));
  for (const body of loops.values()) for (const x of body) depth.set(x, depth.get(x)! + 1);
  return depth;
}

/** Whether a function's body runs split at pause points (generators, async functions, a `main`
 *  with top-level await): its frame saves JSValues, and its `return` isn't its call's result. */
export function pauses(fn: FunctionIR): boolean {
  if (fn.meta?.generator || fn.meta?.async) return true;
  return fn.blocks.some((b) => b.instrs.some((i) => i.op === "async_start"));
}

/** The functions only ever called directly: no function object is made of them,
 *  so every call is a call_direct in this module, with one operand per parameter. Their
 *  parameters' types are what the call sites pass, and their direct entry's C signature is the
 *  optimizer's to choose. */
export function closedFunctions(m: ModuleIR): Set<FunctionIR> {
  const byName = new Map(m.functions.map((fn) => [fn.name, fn]));
  const closed = new Set(m.functions.filter((fn) => fn.meta && !pauses(fn)));
  for (const fn of functionsOf(m))
    for (const b of fn.blocks)
      for (const i of b.instrs) {
        if (i.op !== "make_function" && i.op !== "call_direct") continue;
        const target = byName.get(i.target!);
        if (target && (i.op === "make_function" || i.operands.length !== target.params.length)) closed.delete(target);
      }
  return closed;
}

/** Each function's direct callers' functions, by callee. */
export function callers(m: ModuleIR): Map<FunctionIR, Set<FunctionIR>> {
  const byName = new Map(m.functions.map((fn) => [fn.name, fn]));
  const result = new Map<FunctionIR, Set<FunctionIR>>();
  for (const fn of functionsOf(m))
    for (const b of fn.blocks)
      for (const i of b.instrs) {
        const target = i.op === "call_direct" ? byName.get(i.target!) : undefined;
        if (!target) continue;
        const set = result.get(target);
        if (set) set.add(fn);
        else result.set(target, new Set([fn]));
      }
  return result;
}
