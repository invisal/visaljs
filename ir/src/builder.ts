// Builds a FunctionIR, constructing SSA on the fly (Braun et al., "Simple and
// Efficient Construction of Static Single Assignment Form", CC 2013).
//
// Local variables are keys (lowering uses sema Bindings): writeVariable /
// readVariable per block, phis created lazily and completed when a block is
// sealed (all its predecessors known). Trivial phis are removed in finish().
import type { Loc } from "./loc.ts";
import { OPS, successors, type Block, type FunctionIR, type Instr, type JSConst, type Op, type Terminator } from "./ir.ts";
import { Any, T } from "./types.ts";

export type VarKey = object;

export class FunctionBuilder {
  readonly fn: FunctionIR;
  current: Block;
  loc: Loc | null = null;
  private nextId = 0;
  private nextBlock = 0;
  private readonly currentDef = new Map<VarKey, Map<Block, Instr>>();
  private readonly incomplete = new Map<Block, Map<VarKey, Instr>>();
  private readonly sealed = new Set<Block>();
  /** Phis found trivial: replaced by another value (resolved in finish()). */
  private readonly replaced = new Map<Instr, Instr>();

  constructor(name: string, paramNames: string[], strict: boolean, loc: Loc | null) {
    this.fn = { name, params: [], blocks: [], strict, loc };
    this.current = this.newBlock(null);
    this.seal(this.current);
    this.fn.params = paramNames.map((p, index) => this.emit("param", [], { index, name: p }));
  }

  // ---- Blocks ------------------------------------------------------------

  newBlock(handler: Block | null = this.current?.handler ?? null): Block {
    const b: Block = { id: this.nextBlock++, fn: this.fn, phis: [], instrs: [], term: null, handler, preds: [] };
    this.fn.blocks.push(b);
    return b;
  }

  /** Continues emitting in `b`. */
  setBlock(b: Block) {
    this.current = b;
  }

  /** The current block is finished (it has a terminator): emitting more would be dead code. */
  get terminated(): boolean {
    return this.current.term !== null;
  }

  /** Code here can't run: the block is terminated, or sealed without predecessors. */
  get dead(): boolean {
    const b = this.current;
    return b.term !== null || (b !== this.fn.blocks[0] && this.sealed.has(b) && b.preds.length === 0);
  }

  /** All predecessors of `b` are known: complete its pending phis. */
  seal(b: Block) {
    if (this.sealed.has(b)) return;
    this.sealed.add(b);
    const pending = this.incomplete.get(b);
    if (pending) for (const [key, phi] of pending) this.addPhiOperands(key, phi);
    this.incomplete.delete(b);
  }

  private addEdge(from: Block, to: Block) {
    if (this.sealed.has(to) && !to.preds.includes(from)) throw new Error(`bb${to.id} is sealed: no new predecessor bb${from.id}`);
    if (!to.preds.includes(from)) to.preds.push(from);
  }

  terminate(term: Terminator extends infer U ? (U extends unknown ? Omit<U, "loc"> : never) : never) {
    if (this.current.term) throw new Error(`bb${this.current.id} already terminated`);
    const t = { ...term, loc: this.loc } as Terminator;
    this.current.term = t;
    if (t.kind === "jump") this.addEdge(this.current, t.target);
    if (t.kind === "branch") {
      this.addEdge(this.current, t.then);
      this.addEdge(this.current, t.else);
    }
    if (t.kind === "throw" && this.current.handler) this.addEdge(this.current, this.current.handler);
  }

  jump(target: Block) {
    this.terminate({ kind: "jump", target });
  }

  // ---- Instructions ------------------------------------------------------

  emit(op: Op, operands: Instr[], extra: Partial<Pick<Instr, "lit" | "index" | "target" | "text" | "name" | "type" | "key" | "slot" | "table" | "template" | "regexp" | "bigint" | "cases">> = {}): Instr {
    if (this.current.term) throw new Error(`emitting ${op} into terminated bb${this.current.id}`);
    const info = OPS[op];
    if (info.arity !== "any" && operands.length !== info.arity) throw new Error(`${op} takes ${info.arity} operands`);
    const instr: Instr = {
      id: this.nextId++,
      op,
      operands,
      type: extra.type ?? Any,
      repr: "boxed",
      mayThrow: info.mayThrow,
      block: this.current,
      loc: this.loc,
      ...extra,
    };
    this.current.instrs.push(instr);
    /* A throwing instruction inside a try ends its block: the handler sees the values before it. */
    if (instr.mayThrow && this.current.handler) {
      const from = this.current;
      const next = this.newBlock(from.handler);
      from.term = { kind: "jump", target: next, loc: this.loc };
      this.addEdge(from, next);
      this.addEdge(from, from.handler!);
      this.seal(next);
      this.current = next;
    }
    return instr;
  }

  const(value: JSConst): Instr {
    const type =
      value === undefined ? T.Undefined
      : value === null ? T.Null
      : typeof value === "boolean" ? T.Boolean
      : typeof value === "string" ? T.String
      : Number.isInteger(value) && Math.abs(value) <= 2147483647 && !Object.is(value, -0) ? T.Int32
      : T.Double;
    return this.emit("const", [], { lit: { value }, type });
  }

  // ---- SSA variables -----------------------------------------------------

  writeVariable(key: VarKey, value: Instr, block: Block = this.current) {
    let defs = this.currentDef.get(key);
    if (!defs) this.currentDef.set(key, (defs = new Map()));
    defs.set(block, value);
  }

  readVariable(key: VarKey, block: Block = this.current): Instr {
    const v = this.currentDef.get(key)?.get(block);
    if (v) return this.resolve(v);
    return this.readVariableRecursive(key, block);
  }

  private readVariableRecursive(key: VarKey, block: Block): Instr {
    let value: Instr;
    if (!this.sealed.has(block)) {
      value = this.newPhi(block, key);
      let pending = this.incomplete.get(block);
      if (!pending) this.incomplete.set(block, (pending = new Map()));
      pending.set(key, value);
    } else if (block.preds.length === 1) {
      value = this.readVariable(key, block.preds[0]!);
    } else if (block.preds.length === 0) {
      throw new Error(`variable read before any write, in bb${block.id}`);
    } else {
      const phi = this.newPhi(block, key);
      this.writeVariable(key, phi, block);  // breaks cycles through loops
      value = this.addPhiOperands(key, phi);
    }
    this.writeVariable(key, value, block);
    return value;
  }

  private newPhi(block: Block, key: VarKey): Instr {
    const name = (key as { name?: string }).name;
    const phi: Instr = {
      id: this.nextId++, op: "phi", operands: [], type: Any, repr: "boxed", mayThrow: false,
      block, loc: null, incoming: [], ...(name ? { name } : {}),
    };
    block.phis.push(phi);
    return phi;
  }

  private addPhiOperands(key: VarKey, phi: Instr): Instr {
    for (const pred of phi.block.preds) phi.incoming!.push({ block: pred, value: this.readVariable(key, pred) });
    return this.tryRemoveTrivialPhi(phi);
  }

  /** A phi whose inputs are all one value (or itself) is that value. */
  private tryRemoveTrivialPhi(phi: Instr): Instr {
    let same: Instr | null = null;
    for (const { value } of phi.incoming!) {
      const v = this.resolve(value);
      if (v === same || v === phi) continue;
      if (same) return phi;
      same = v;
    }
    if (!same) return phi;  // unreachable or self-only: left for finish()
    this.replaced.set(phi, same);
    return same;
  }

  private resolve(v: Instr): Instr {
    let r = v;
    while (this.replaced.has(r)) r = this.replaced.get(r)!;
    return r;
  }

  // ---- Finishing ---------------------------------------------------------

  /** Drops unreachable blocks and trivial phis, and rewrites every use. */
  finish(): FunctionIR {
    for (const b of this.fn.blocks)
      if (!this.sealed.has(b)) throw new Error(`bb${b.id} was never sealed`);

    const reachable = new Set<Block>();
    const work = [this.fn.blocks[0]!];
    while (work.length) {
      const b = work.pop()!;
      if (reachable.has(b)) continue;
      reachable.add(b);
      work.push(...successors(b));
    }
    this.fn.blocks = this.fn.blocks.filter((b) => reachable.has(b));
    for (const b of this.fn.blocks) {
      b.preds = b.preds.filter((p) => reachable.has(p));
      for (const phi of b.phis) phi.incoming = phi.incoming!.filter((i) => reachable.has(i.block));
    }

    /* trivial phis, to a fixpoint (removing one can make another trivial) */
    for (let changed = true; changed; ) {
      changed = false;
      for (const b of this.fn.blocks)
        for (const phi of b.phis) {
          if (this.replaced.has(phi)) continue;
          if (this.tryRemoveTrivialPhi(phi) !== phi) changed = true;
        }
    }
    for (const b of this.fn.blocks) {
      b.phis = b.phis.filter((p) => !this.replaced.has(p));
      for (const phi of b.phis) for (const i of phi.incoming!) i.value = this.resolve(i.value);
      for (const ins of b.instrs) ins.operands = ins.operands.map((o) => this.resolve(o));
      const t = b.term;
      if (t && (t.kind === "branch")) t.cond = this.resolve(t.cond);
      if (t && (t.kind === "return" || t.kind === "throw")) t.value = this.resolve(t.value);
    }
    return this.fn;
  }
}
