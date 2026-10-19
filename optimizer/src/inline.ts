// Inlining behind guards: a small function's body copied into its caller. It
// removes the call, and lets the passes after it see both sides at once.
//
// Three kinds of sites:
//   - call_direct: the callee is known; its body replaces the call.
//   - construct_direct (step 10): `new F(…)`. When F's value is that constructor's function
//     object (the guard), `this` is made inline (new_instance) and the body runs; otherwise the
//     original construct_direct does what it did.
//   - obj.key(…) (a call of a get_prop's result) where exactly one function of the module is a
//     method named `key` (a class member or an object literal's method): when the value read is
//     that function (the guard), its body runs; otherwise the original call.
// The guard compares the function object with the closure the inlined function makes
// (same_function), so it holds whatever the receiver is: an object with its own `key`, a patched
// prototype, a different class all just take the original call.
//
// What's inlined: functions of up to INLINE_SIZE instructions that don't pause (generators,
// async), read `arguments` or a rest parameter, with the caller's strictness (the C of a
// property store depends on it). Sites inside a `try` are left alone: a throwing instruction
// there must end its block. Recursion stops at the rounds: a function is never copied into
// itself, and each round only inlines what the round before left.
import { OPS, type Block, type FunctionIR, type Instr, type ModuleIR, type Op, T, Any } from "@visaljs/ir";

import { functionsOf, pauses } from "./cfg.ts";
import type { Count, Pass } from "./index.ts";

/** A callee's largest size, in instructions. 40 made a large program's C 10% bigger than 20 did
 *  (each copy is C to compile) and ran no faster. */
const INLINE_SIZE = 20;
/** A caller's largest size it grows to, in instructions. */
const CALLER_SIZE = 3000;
const ROUNDS = 2;

export const inline: Pass = {
  name: "inline",
  run(m: ModuleIR, count: Count) {
    const byName = new Map(m.functions.map((fn) => [fn.name, fn]));
    const methods = methodsByKey(m, byName);
    for (let round = 0; round < ROUNDS; round++)
      for (const fn of functionsOf(m)) {
        const n = inlineFunction(fn, byName, methods);
        count("inlined", "call", n.calls);
        count("inlined", "constructor", n.constructors);
        count("inlined", "method call", n.methods);
      }
    return m;
  },
};

/** The functions installed as methods under each key: class members and object literals'
 *  methods (define_class_member, define_prop of a make_function). */
function methodsByKey(m: ModuleIR, byName: Map<string, FunctionIR>): Map<string, FunctionIR[]> {
  const out = new Map<string, FunctionIR[]>();
  const add = (key: string, fn: FunctionIR | undefined) => {
    if (!fn) return;
    const list = out.get(key) ?? [];
    if (!list.includes(fn)) list.push(fn);
    out.set(key, list);
  };
  for (const fn of functionsOf(m))
    for (const b of fn.blocks)
      for (const i of b.instrs) {
        if (!i.key || !("name" in i.key)) continue;
        const value = i.operands.at(-1);
        if (value?.op !== "make_function") continue;
        if ((i.op === "define_class_member" && i.index === 0) || i.op === "define_prop") add(i.key.name, byName.get(value.target!));
        /* anything else storing a function under the key makes the guess less sure: still guarded */
      }
  return out;
}

function size(fn: FunctionIR): number {
  return fn.blocks.reduce((n, b) => n + b.instrs.length + b.phis.length, 0);
}

/** Whether `callee`'s body can be copied into `caller`. */
function inlinable(callee: FunctionIR, caller: FunctionIR): boolean {
  const meta = callee.meta;
  if (!meta || callee === caller || pauses(callee) || meta.takesArguments || meta.hasRest) return false;
  if (callee.strict !== caller.strict || size(callee) > INLINE_SIZE) return false;
  if (meta.classCtor === "derived") return false;
  if (!callee.blocks.some((b) => b.term?.kind === "return")) return false;  /* always throws: nothing to join */
  return callee.blocks.every((b) => b.instrs.every((i) => i.op !== "make_arguments" && i.op !== "derived_return" && i.op !== "bind_this"));
}

interface Counts {
  calls: number;
  constructors: number;
  methods: number;
}

function inlineFunction(fn: FunctionIR, byName: Map<string, FunctionIR>, methods: Map<string, FunctionIR[]>): Counts {
  const n: Counts = { calls: 0, constructors: 0, methods: 0 };
  if (pauses(fn)) return n;
  /* the sites as they are now: what inlining copies in waits for the next round */
  const sites: { i: Instr; callee: FunctionIR; kind: keyof Counts }[] = [];
  for (const b of fn.blocks) {
    if (b.handler) continue;
    for (const i of b.instrs) {
      if (i.slowPath) continue;
      if (i.op === "call_direct" || i.op === "construct_direct") {
        const callee = byName.get(i.target!);
        if (callee && inlinable(callee, fn)) sites.push({ i, callee, kind: i.op === "call_direct" ? "calls" : "constructors" });
      } else if (i.op === "call") {
        const f = i.operands[0]!;
        if (f.op !== "get_prop" || !f.key || !("name" in f.key)) continue;
        const candidates = methods.get(f.key.name);
        if (candidates?.length !== 1) continue;
        const callee = candidates[0]!;
        if (!callee.meta!.constructor && inlinable(callee, fn)) sites.push({ i, callee, kind: "methods" });
      }
    }
  }
  for (const site of sites) {
    if (size(fn) + size(site.callee) > CALLER_SIZE) break;
    inlineSite(fn, site.i, site.callee);
    n[site.kind]++;
  }
  return n;
}

/** Ids for new values and blocks of `fn`. */
class Fresh {
  private value: number;
  private block: number;
  constructor(fn: FunctionIR) {
    this.value = Math.max(-1, ...fn.params.map((p) => p.id), ...fn.blocks.flatMap((b) => [...b.phis, ...b.instrs].map((i) => i.id))) + 1;
    this.block = Math.max(...fn.blocks.map((b) => b.id)) + 1;
  }
  valueId() {
    return this.value++;
  }
  blockId() {
    return this.block++;
  }
}

function newBlock(fn: FunctionIR, fresh: Fresh, handler: Block | null): Block {
  const b: Block = { id: fresh.blockId(), fn, phis: [], instrs: [], term: null, handler, preds: [] };
  fn.blocks.push(b);
  return b;
}

function newInstr(fresh: Fresh, b: Block, op: Op, operands: Instr[], extra: Partial<Instr> = {}): Instr {
  const i: Instr = { id: fresh.valueId(), op, operands, type: Any, repr: "boxed", mayThrow: OPS[op].mayThrow, block: b, loc: null, ...extra };
  return i;
}

function append(b: Block, i: Instr): Instr {
  i.block = b;
  b.instrs.push(i);
  return i;
}

function jump(from: Block, to: Block, loc: Instr["loc"]) {
  from.term = { kind: "jump", target: to, loc };
  to.preds.push(from);
}

/** Replaces the call `site` in `fn` by `callee`'s body, guarded unless it's a call_direct. */
function inlineSite(fn: FunctionIR, site: Instr, callee: FunctionIR) {
  const fresh = new Fresh(fn);
  const block = site.block;
  const at = block.instrs.indexOf(site);
  const loc = site.loc;
  const meta = callee.meta!;

  /* the block splits at the call: what follows it moves to `after`, which every path joins */
  const after = newBlock(fn, fresh, block.handler);
  after.instrs = block.instrs.splice(at + 1);
  for (const i of after.instrs) i.block = after;
  after.term = block.term;
  block.term = null;
  block.instrs.splice(at, 1);  // the call: the slow path's, or gone
  for (const s of successorsOf(after)) {
    s.preds = s.preds.map((p) => (p === block ? after : p));
    for (const phi of s.phis) for (const inc of phi.incoming!) if (inc.block === block) inc.block = after;
  }

  /* the guard: the function value is the closure `callee` makes, in this realm */
  const kind = site.op;
  const fnValue = kind === "call_direct" ? null : site.operands[0]!;
  let entryFrom = block;
  const results: { block: Block; value: Instr }[] = [];
  if (fnValue) {
    const guard = append(block, newInstr(fresh, block, "same_function", [fnValue], { target: callee.name, type: T.Boolean, loc }));
    const fast = newBlock(fn, fresh, null);
    const slow = newBlock(fn, fresh, null);
    block.term = { kind: "branch", cond: guard, then: fast, else: slow, loc };
    fast.preds.push(block);
    slow.preds.push(block);
    append(slow, site);
    site.slowPath = true;
    jump(slow, after, loc);
    results.push({ block: slow, value: site });
    entryFrom = fast;
  }

  /* what the parameters are: the direct entry's hidden ones first, then the arguments */
  const undef = (b: Block) => append(b, newInstr(fresh, b, "const", [], { lit: { value: undefined }, type: T.Undefined, loc }));
  let thisValue: Instr | null = null;
  const values: Instr[] = [];
  if (kind === "call_direct") {
    values.push(...site.operands);
  } else {
    const f = fnValue!;
    if (kind === "construct_direct") {
      const slots = constructorSlots(callee);
      thisValue = append(entryFrom, newInstr(fresh, entryFrom, "new_instance", [f], { index: slots, type: T.Object, loc }));
      /* new_instance can throw (in principle): its own block, so the body after it starts clean */
      const next = newBlock(fn, fresh, null);
      jump(entryFrom, next, loc);
      entryFrom = next;
    }
    const args = kind === "construct_direct" ? site.operands.slice(1) : site.operands.slice(2);
    if (meta.takesEnv) values.push(append(entryFrom, newInstr(fresh, entryFrom, "function_env", [f], { loc })));
    if (meta.takesCallee) values.push(f);
    if (meta.takesThis) values.push(kind === "construct_direct" ? thisValue! : site.operands[1]!);
    if (meta.takesNewTarget) values.push(kind === "construct_direct" ? f : undef(entryFrom));
    const declared = callee.params.length - values.length;
    for (let k = 0; k < declared; k++) values.push(args[k] ?? undef(entryFrom));
  }

  /* the body: every block and value copied, the parameters mapped, each `return` a jump to `after` */
  const blockMap = new Map<Block, Block>();
  const valueMap = new Map<Instr, Instr>();
  callee.params.forEach((p, k) => valueMap.set(p, values[k]!));
  for (const b of callee.blocks) blockMap.set(b, { id: fresh.blockId(), fn, phis: [], instrs: [], term: null, handler: null, preds: [] });
  for (const b of callee.blocks) blockMap.get(b)!.handler = b.handler ? blockMap.get(b.handler)! : null;
  const copies: [Instr, Instr][] = [];
  const copy = (i: Instr, into: Block): Instr => {
    const c: Instr = { ...i, id: fresh.valueId(), block: into, operands: [] };
    if (i.op === "set_prop" && addsToThis(callee, i)) c.addsProp = true;
    valueMap.set(i, c);
    copies.push([i, c]);
    return c;
  };
  for (const b of callee.blocks) {
    const nb = blockMap.get(b)!;
    for (const phi of b.phis) nb.phis.push(copy(phi, nb));
    for (const i of b.instrs) if (i.op !== "param") nb.instrs.push(copy(i, nb));
  }
  const mapped = (v: Instr) => valueMap.get(v) ?? v;
  for (const [orig, c] of copies) if (orig.op !== "phi") c.operands = orig.operands.map(mapped);
  for (const b of callee.blocks) {
    const nb = blockMap.get(b)!;
    nb.preds = b.preds.map((p) => blockMap.get(p)!);
    for (const phi of nb.phis) phi.incoming = phi.incoming!.map((inc) => ({ block: blockMap.get(inc.block)!, value: mapped(inc.value) }));
    const t = b.term!;
    if (t.kind === "jump") nb.term = { ...t, target: blockMap.get(t.target)! };
    else if (t.kind === "branch") nb.term = { ...t, cond: mapped(t.cond), then: blockMap.get(t.then)!, else: blockMap.get(t.else)! };
    else if (t.kind === "throw") nb.term = { ...t, value: mapped(t.value) };
    else if (t.kind === "unreachable") nb.term = { ...t };
    else {
      /* return: `new` gives the object made unless the body returned one (§10.2.2) */
      let value = mapped(t.value);
      if (kind === "construct_direct")
        value = isUndefinedConst(value) ? thisValue! : append(nb, newInstr(fresh, nb, "construct_result", [value, thisValue!], { type: T.Object, loc }));
      nb.term = null;
      jump(nb, after, t.loc);
      results.push({ block: nb, value });
    }
  }
  fn.blocks.push(...blockMap.values());
  jump(entryFrom, blockMap.get(callee.blocks[0]!)!, loc);

  /* the call's value: one result, or a phi of them where the paths join */
  let result: Instr;
  if (results.length === 1) result = results[0]!.value;
  else {
    result = newInstr(fresh, after, "phi", [], { incoming: results, type: Any, loc });
    after.phis.push(result);
  }
  replaceAll(fn, site, result);
}

function isUndefinedConst(v: Instr): boolean {
  return v.op === "const" && v.lit!.value === undefined;
}

function successorsOf(b: Block): Block[] {
  const t = b.term;
  const out: Block[] = [];
  if (t?.kind === "jump") out.push(t.target);
  if (t?.kind === "branch") out.push(t.then, t.else);
  if (b.handler) out.push(b.handler);
  return [...new Set(out)];
}

/** Every use of `from` (but its own, on the slow path) reads `to`. */
function replaceAll(fn: FunctionIR, from: Instr, to: Instr) {
  if (from === to) return;
  for (const b of fn.blocks) {
    for (const phi of b.phis) for (const inc of phi.incoming!) if (inc.value === from && phi !== to) inc.value = to;
    for (const i of b.instrs) i.operands = i.operands.map((o) => (o === from ? to : o));
    const t = b.term;
    if (t?.kind === "branch" && t.cond === from) t.cond = to;
    if ((t?.kind === "return" || t?.kind === "throw") && t.value === from) t.value = to;
  }
}

/** The direct entry's `this` (after its environment and function object). */
function thisParam(fn: FunctionIR): Instr | null {
  const m = fn.meta;
  return m?.takesThis ? fn.params[Number(m.takesEnv) + Number(m.takesCallee)] ?? null : null;
}

/** `this.key = v` in a constructor: most likely adding the property (C: js_set_prop_add). */
export function addsToThis(fn: FunctionIR, i: Instr): boolean {
  return i.op === "set_prop" && !!fn.meta?.constructor && !fn.meta.arrow && "name" in i.key! && i.operands[0] === thisParam(fn);
}

/** The inline slots of `new F` instances: one per property F's constructor adds (up to 16), or
 *  JS_DEFAULT_INLINE_SLOTS (4). The same count as construct_direct's C (one shape per F). */
export function constructorSlots(fn: FunctionIR): number {
  const keys = new Set<string>();
  for (const b of fn.blocks) for (const i of b.instrs) if (addsToThis(fn, i)) keys.add((i.key as { name: string }).name);
  return keys.size ? Math.min(keys.size, 16) : 4;
}
