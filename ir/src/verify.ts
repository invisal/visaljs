// The IR verifier: run after every pass in tests and debug builds.
// Checks CFG consistency, SSA dominance, phi arity, exception-edge rules and
// representation consistency (a repr agrees with the type).
import { isExceptionalEdge, OPS, readsDouble, successors, throwingInstr, typedCallFits, type Block, type FunctionIR, type Instr } from "./ir.ts";
import { Any, isSubtype, Number_, T, typeName, type Repr, type Type } from "./types.ts";
import { isStatic } from "./static.ts";

export class VerifyError extends Error {
  readonly problems: string[];
  constructor(fn: FunctionIR, problems: string[]) {
    super(`IR verification failed for ${fn.name}:\n  ${problems.join("\n  ")}`);
    this.name = "VerifyError";
    this.problems = problems;
  }
}

/** Immediate dominators (Cooper, Harvey, Kennedy: "A Simple, Fast Dominance Algorithm"). */
export function dominators(fn: FunctionIR): Map<Block, Block> {
  const order: Block[] = [];  // reverse postorder
  const seen = new Set<Block>();
  const visit = (b: Block) => {
    seen.add(b);
    for (const s of successors(b)) if (!seen.has(s)) visit(s);
    order.unshift(b);
  };
  const entry = fn.blocks[0]!;
  visit(entry);
  const index = new Map(order.map((b, i) => [b, i]));
  const preds = new Map<Block, Block[]>(order.map((b) => [b, []]));
  for (const b of order) for (const s of successors(b)) preds.get(s)!.push(b);

  const idom = new Map<Block, Block>([[entry, entry]]);
  const intersect = (a: Block, b: Block) => {
    while (a !== b) {
      while (index.get(a)! > index.get(b)!) a = idom.get(a)!;
      while (index.get(b)! > index.get(a)!) b = idom.get(b)!;
    }
    return a;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const b of order) {
      if (b === entry) continue;
      let dom: Block | null = null;
      for (const p of preds.get(b)!) if (idom.has(p)) dom = dom ? intersect(p, dom) : p;
      if (dom && idom.get(b) !== dom) {
        idom.set(b, dom);
        changed = true;
      }
    }
  }
  return idom;
}

export function dominates(idom: Map<Block, Block>, a: Block, b: Block): boolean {
  for (let x = b; ; x = idom.get(x)!) {
    if (x === a) return true;
    if (idom.get(x) === x || !idom.has(x)) return false;
  }
}

export function verify(fn: FunctionIR): void {
  const problems: string[] = [];
  const bad = (msg: string) => problems.push(msg);
  const blocks = new Set(fn.blocks);
  const defs = new Map<Instr, Block>();
  const ids = new Set<number>();

  const entry = fn.blocks[0];
  if (!entry) throw new VerifyError(fn, ["no blocks"]);
  for (const b of fn.blocks) {
    if (b.fn !== fn) bad(`bb${b.id} belongs to another function`);
    if (!b.term) bad(`bb${b.id} has no terminator`);
    for (const i of [...b.phis, ...b.instrs]) {
      if (ids.has(i.id)) bad(`value %${i.id} defined twice`);
      ids.add(i.id);
      defs.set(i, b);
      if (i.block !== b) bad(`%${i.id} says it's in bb${i.block.id} but is in bb${b.id}`);
    }
  }
  for (const p of fn.params) if (defs.get(p) !== entry) bad(`param %${p.id} is not in the entry block`);

  /* CFG: stored predecessors match the terminators and handlers */
  const preds = new Map<Block, Set<Block>>(fn.blocks.map((b) => [b, new Set()]));
  for (const b of fn.blocks)
    for (const s of successors(b)) {
      if (!blocks.has(s)) bad(`bb${b.id} jumps to bb${s.id}, which isn't in the function`);
      else preds.get(s)!.add(b);
    }
  for (const b of fn.blocks) {
    const expected = preds.get(b)!;
    if (b === entry && expected.size) bad("the entry block has predecessors");
    const stored = new Set(b.preds);
    if (stored.size !== expected.size || [...expected].some((p) => !stored.has(p)))
      bad(`bb${b.id} preds [${b.preds.map((p) => `bb${p.id}`).join(", ")}] != [${[...expected].map((p) => `bb${p.id}`).join(", ")}]`);
  }
  if (problems.length) throw new VerifyError(fn, problems);

  const idom = dominators(fn);
  for (const b of fn.blocks) if (!idom.has(b)) bad(`bb${b.id} is unreachable`);

  const usable = (v: Instr, at: Block, index: number, what: string) => {
    const d = defs.get(v);
    if (!d) return bad(`${what} uses %${v.id}, which isn't defined in this function`);
    if (!OPS[v.op].result) return bad(`${what} uses %${v.id} (${v.op}), which has no result`);
    if (d === at) {
      const pos = v.op === "phi" ? -1 : at.instrs.indexOf(v);
      if (pos >= index) bad(`${what} uses %${v.id} before its definition`);
    } else if (!dominates(idom, d, at)) {
      bad(`${what} uses %${v.id} (bb${d.id}), which doesn't dominate bb${at.id}`);
    }
  };

  /* representation follows type: a double holds only Numbers, an int32_t only Int32s, a bool only Booleans (C emission
     converts between reprs where a value is used); an int64_t only ints and Int32s */
  const REPR_TYPE: Record<Repr, Type> = { boxed: Any | T.Empty, f64: Number_, i32: T.Int32, i64: T.Int64 | T.Int32, bool: T.Boolean };
  const reprFits = (repr: Repr, t: Type) => isSubtype(t, REPR_TYPE[repr]);
  /* a JavaScript function's Numbers are doubles: an int64 (C's arithmetic) stays in static code */
  const int64 = (t: Type) => (t & T.Int64) !== 0 && isSubtype(t, T.Int64 | T.Int32);
  for (const i of [...fn.params, ...fn.blocks.flatMap((b) => [...b.phis, ...b.instrs])]) {
    if (!reprFits(i.repr, i.type)) bad(`%${i.id} ${i.op} is ${i.repr} but its type is ${typeName(i.type)}`);
    if (!isStatic(fn) && int64(i.type)) bad(`%${i.id} ${i.op} is an int64 outside static code`);
    /* a direct call's result is its callee's return repr: a throw then shows as the pending exception */
    if (i.repr !== "boxed" && ((i.mayThrow && i.op !== "call_direct" && i.op !== "int_div" && i.op !== "int_mod" && !readsDouble(i) && !typedCallFits(i)) || !OPS[i.op].result)) bad(`%${i.id} ${i.op} is ${i.repr} but can throw or has no result`);
  }
  const ret = fn.returnRepr ?? "boxed";
  for (const b of fn.blocks)
    if (b.term?.kind === "return" && !reprFits(ret, b.term.value.type)) bad(`bb${b.id} returns ${typeName(b.term.value.type)} from a function returning ${ret}`);

  for (const b of fn.blocks) {
    /* phis: exactly one input per predecessor; inputs available at the end of that edge */
    for (const phi of b.phis) {
      if (phi.op !== "phi") bad(`%${phi.id} in the phi list is ${phi.op}`);
      const incoming = phi.incoming ?? [];
      const from = new Set(incoming.map((i) => i.block));
      if (from.size !== incoming.length || from.size !== b.preds.length || b.preds.some((p) => !from.has(p)))
        bad(`phi %${phi.id} in bb${b.id} has inputs from [${incoming.map((i) => `bb${i.block.id}`).join(", ")}], preds are [${b.preds.map((p) => `bb${p.id}`).join(", ")}]`);
      for (const { block: pred, value } of incoming) {
        usable(value, pred, pred.instrs.length + 1, `phi %${phi.id} (from bb${pred.id})`);
        if (isExceptionalEdge(pred, b) && value === throwingInstr(pred))
          bad(`phi %${phi.id} takes %${value.id} along its own exception edge, where it has no value`);
      }
    }

    /* instructions */
    b.instrs.forEach((ins, index) => {
      const info = OPS[ins.op];
      if (ins.op === "phi") bad(`phi %${ins.id} among the instructions of bb${b.id}`);
      if (info.arity !== "any" && ins.operands.length !== info.arity) bad(`%${ins.id} ${ins.op} has ${ins.operands.length} operands, wants ${info.arity}`);
      if (ins.mayThrow && !info.mayThrow) bad(`%${ins.id} ${ins.op} is marked mayThrow but the op can't throw`);
      for (const o of ins.operands) usable(o, b, index, `%${ins.id} ${ins.op}`);
      if (ins.op === "const" && !ins.lit) bad(`const %${ins.id} has no value`);
      if (ins.op === "param" && b !== entry) bad(`param %${ins.id} outside the entry block`);
      if (ins.op === "take_exception") {
        if (index !== 0) bad(`take_exception %${ins.id} isn't the first instruction of bb${b.id}`);
        if (b.preds.some((p) => !isExceptionalEdge(p, b))) bad(`bb${b.id} takes an exception but is reached normally`);
      }
      /* in a protected block, a throwing instruction ends the block (see ir.ts) */
      if (b.handler && ins.mayThrow && index !== b.instrs.length - 1) bad(`%${ins.id} may throw to bb${b.handler.id} but isn't last in bb${b.id}`);
    });
    if (b.handler && throwingInstr(b) && b.term?.kind === "throw") bad(`bb${b.id} has two exception sources`);

    /* handler blocks take the exception first */
    const handled = b.preds.length > 0 && b.preds.every((p) => isExceptionalEdge(p, b));
    if (handled && b.instrs[0]?.op !== "take_exception") bad(`handler bb${b.id} doesn't start with take_exception`);

    const t = b.term;
    const end = b.instrs.length;
    if (t?.kind === "branch") usable(t.cond, b, end, `branch in bb${b.id}`);
    if (t?.kind === "return" || t?.kind === "throw") usable(t.value, b, end, `${t.kind} in bb${b.id}`);
  }
  if (problems.length) throw new VerifyError(fn, problems);
}
