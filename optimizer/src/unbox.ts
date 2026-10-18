// Unboxing (representation follows type): a value's `repr` is how C
// holds it. A Number operator's result (num_*) or a phi that only holds Numbers can be a C
// double (`f64`), a Number comparison a C bool (`bool`); everything else stays a boxed JSValue.
// C emission converts where a value meets a use of another repr: `js_number(d)` to box a double,
// `js_as_number(v)` to unbox a proven Number (it can't fail), `js_bool` / `js_as_bool`.
//
// Unboxing pays only when the value is used unboxed more than boxed: boxing a double back
// (`js_number`: a range check and an int32 conversion) costs more than unboxing. So each
// candidate starts as a double and becomes boxed while its boxed uses cost more than its
// unboxed ones, to a fixpoint (a value turning boxed changes what its operands' uses want). A
// use counts 10× per loop around it. A loop counter only compared with an unknown value or
// passed to calls stays boxed (its +1 is then the boxed num_inc, still inline); an array index
// takes a double (js_get_index_f64).
//
// Across functions: a closed function's (closedFunctions) parameters are
// candidates like phis, and its call sites' arguments are uses that want the parameter's repr.
// One whose every `return` is a Number returns a C double (a Boolean: a bool); its direct calls'
// results then are doubles too.
//
// Int32s: a value inference proved an int32 (bitwise results, a loop counter its
// bound keeps in range) is a C int32_t (`i32`) instead of a double, with the same choice of
// boxed or not.
//
// Generator and async functions stay boxed: their frames save JSValues across pauses.
import { declaredCallFits, isSubtype, Number_, T, typedCallFits, type Block, type Instr, type ModuleIR, type Op, type Repr, type Type } from "@visaljs/ir";

import { closedFunctions, functionsOf, loopDepths, pauses } from "./cfg.ts";
import type { Count, Pass } from "./index.ts";

const F64 = new Set<Op>([
  "char_code_at", "math", "int_add", "int_sub", "int_mul",
  "num_add", "num_sub", "num_mul", "num_div", "num_mod", "num_neg", "num_inc", "num_dec",
  "num_bitand", "num_bitor", "num_bitxor", "num_bitnot", "num_shl", "num_sar", "num_shr",
]);
const BOOL = new Set<Op>(["num_lt", "num_le", "num_gt", "num_ge", "num_eq", "num_ne"]);

/** How the report names each unboxed repr. */
const REPR_NOUN: Record<Repr, string> = { boxed: "", f64: "double", i32: "int32", bool: "bool" };

/** Boxing a double for a use, against unboxing a JSValue (per use, before loop weights). */
const BOX_COST = 2;
const UNBOX_COST = 1;

export const unbox: Pass = {
  name: "unbox",
  run(m: ModuleIR, count: Count) {
    unboxModule(m);
    for (const fn of functionsOf(m)) {
      for (const v of [...fn.params, ...fn.blocks.flatMap((b) => [...b.phis, ...b.instrs])])
        if (v.repr !== "boxed") count("unboxed", REPR_NOUN[v.repr]);
      if (fn.returnRepr && fn.returnRepr !== "boxed") count("unboxed", "return value");
    }
    return m;
  },
};

/** A use of a value: the instruction or phi reading it (null: a terminator), where, and which
 *  operand it is. */
interface Use {
  user: Instr | null;
  block: Block;
  index: number;
}

/** The repr that holds every value of type `t` unboxed, if any. */
function unboxedRepr(t: Type): Repr | null {
  if (t === T.None) return null;
  if (isSubtype(t, T.Int32)) return "i32";
  if (isSubtype(t, Number_)) return "f64";
  if (isSubtype(t, T.Boolean)) return "bool";
  return null;
}

function unboxModule(m: ModuleIR) {
  const closed = closedFunctions(m);
  const byName = new Map(m.functions.map((fn) => [fn.name, fn]));
  const fns = functionsOf(m).filter((fn) => !pauses(fn));

  /* return values: a closed or declared function's, when every return is one kind */
  for (const fn of m.functions.filter((fn) => closed.has(fn) || (fn.meta?.declared && !pauses(fn)))) {
    const returns = fn.blocks.flatMap((b) => (b.term?.kind === "return" ? [b.term.value] : []));
    const repr = unboxedRepr(returns.reduce<Type>((u, v) => u | v.type, T.None));
    if (repr) fn.returnRepr = repr;
  }

  const uses = new Map<Instr, Use[]>();
  const weights = new Map<Block, number>();
  const use = (v: Instr, u: Use) => {
    const list = uses.get(v);
    if (list) list.push(u);
    else uses.set(v, [u]);
  };
  const candidates: Instr[] = [];
  for (const fn of fns) {
    const depth = loopDepths(fn);
    for (const b of fn.blocks) weights.set(b, 10 ** Math.min(depth.get(b) ?? 0, 6));
    for (const b of fn.blocks) {
      for (const phi of b.phis) phi.incoming!.forEach((inc, k) => use(inc.value, { user: phi, block: inc.block, index: k }));  // converted on the edge
      for (const i of b.instrs) i.operands.forEach((o, k) => use(o, { user: i, block: b, index: k }));
      const t = b.term;
      if (t?.kind === "branch") use(t.cond, { user: null, block: b, index: 0 });
      if (t?.kind === "return" || t?.kind === "throw") use(t.value, { user: null, block: b, index: t.kind === "return" ? 1 : 0 });
    }
    const declared = fn.meta?.declared;
    const params = closed.has(fn) ? fn.params : declared ? fn.params.filter((_, k) => declared[k] !== undefined) : [];
    for (const v of [...params, ...fn.blocks.flatMap((b) => b.phis)]) {
      const repr = unboxedRepr(v.type);
      if (repr === "bool") v.repr = "bool";
      else if (repr) candidates.push(v);
    }
    for (const b of fn.blocks)
      for (const i of b.instrs) {
        if (F64.has(i.op)) candidates.push(i);
        else if (BOOL.has(i.op) || i.op === "same_function") i.repr = "bool";  /* an inlining guard: a C condition */
        else if (i.op === "call_direct") {
          const callee = byName.get(i.target!);
          i.repr = callee && declaredCallFits(i, callee) ? callee.returnRepr ?? "boxed" : "boxed";  /* else through the checked entry */
        }
        else if (typedCallFits(i)) i.repr = i.typedCall!.returnRepr;  /* a typed unit's typed entry */
      }
  }
  /* an int32 in an int32_t, any other Number in a double */
  for (const c of candidates) c.repr = isSubtype(c.type, T.Int32) ? "i32" : "f64";

  /* the repr a use wants its value in */
  const wants = (u: Use): Repr => {
    if (!u.user) return u.index === 1 ? (u.block.fn.returnRepr ?? "boxed") : "boxed";  // a branch on a Number tests it boxed (js_truthy)
    if (u.user.op === "phi") return u.user.repr;
    if (F64.has(u.user.op) || BOOL.has(u.user.op)) return u.user.repr === "boxed" ? "boxed" : "f64";
    if ((u.user.op === "get_index" || u.user.op === "set_index") && u.index === 1) return "f64";  // a double key: js_get_index_f64
    if (u.user.op === "call_direct") {
      const callee = byName.get(u.user.target!);
      if (callee?.meta?.declared && !declaredCallFits(u.user, callee)) return "boxed";
      return callee && (closed.has(callee) || callee.meta?.declared?.[u.index] !== undefined) ? callee.params[u.index]!.repr : "boxed";
    }
    if (u.index >= 2 && typedCallFits(u.user)) return u.user.typedCall!.params[u.index - 2]!.repr;
    return "boxed";
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of candidates) {
      if (c.repr === "boxed") continue;
      let boxed = 0;
      let unboxed = 0;
      for (const u of uses.get(c) ?? []) {
        if (wants(u) !== "boxed") unboxed += UNBOX_COST * weights.get(u.block)!;
        else boxed += BOX_COST * weights.get(u.block)!;
      }
      if (boxed > unboxed) {
        c.repr = "boxed";
        changed = true;
      }
    }
  }
}
