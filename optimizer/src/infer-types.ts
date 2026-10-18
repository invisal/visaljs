// Type inference: each value's `type`, the set of kinds of JS value it can
// hold. Sparse forward dataflow over SSA, optimistic: every result starts at None and only grows
// to a fixpoint (the lattice is a bitset of 10 kinds, so that's quick). A phi is the union of its
// inputs; an operation's type comes from its operands' (`transfer`). Operations it knows nothing
// about are Unknown: any JS value, or EMPTY.
import { dominators, isSubtype, Number_, OPS, Primitive, readsDouble, T, Unknown, type Block, type FunctionIR, type Instr, type ModuleIR, type Op, type Type } from "@visaljs/ir";

import { callers, closedFunctions, functionsOf, pauses, reversePostorder } from "./cfg.ts";
import { trustedBuiltin } from "./specialize.ts";
import type { Count, Pass } from "./index.ts";

export const inferTypes: Pass = {
  name: "infer-types",
  run(m: ModuleIR, count: Count) {
    const closed = inferModule(m);
    const kindOf = (i: Instr) => KINDS.find(([, t]) => i.type !== T.None && isSubtype(i.type, t));
    for (const fn of functionsOf(m)) {
      for (const b of fn.blocks)
        for (const i of [...b.phis, ...b.instrs]) {
          if (!OPS[i.op].result || i.op === "const" || i.op === "empty" || i.op === "param") continue;
          const kind = kindOf(i);
          if (kind) count("proved", kind[0]);
        }
      /* parameters from the call sites */
      if (closed.has(fn)) for (const p of fn.params) if (kindOf(p)) count("typed", "parameter");
    }
    return m;
  },
};

/** What inference knows across functions: a closed function's parameters are the
 *  union of what its call sites pass; a direct call's result is the union of what its callee
 *  returns. Both start at None and grow: a function is inferred again when its parameters or a
 *  callee's return type grew, to a fixpoint. */
interface Signatures {
  params: Map<Instr, Type>;
  returns: Map<string, Type>;
}

/** Infers every function's types; returns the closed functions. */
function inferModule(m: ModuleIR): Set<FunctionIR> {
  const closed = closedFunctions(m);
  const sig: Signatures = { params: new Map(), returns: new Map() };
  for (const fn of m.functions) {
    if (!pauses(fn)) sig.returns.set(fn.name, T.None);
    const declared = fn.meta?.declared;
    fn.params.forEach((p, k) => sig.params.set(p, declared?.[k] ?? (closed.has(fn) ? T.None : Unknown & ~T.Empty)));
  }
  const byName = new Map(m.functions.map((fn) => [fn.name, fn]));
  const callerMap = callers(m);
  const work = new Set(functionsOf(m));
  while (work.size) {
    const fn: FunctionIR = work.values().next().value!;
    work.delete(fn);
    inferFunction(fn, sig);
    /* what it returns: its callers see it */
    if (sig.returns.has(fn.name)) {
      let ret: Type = T.None;
      for (const b of fn.blocks) if (b.term?.kind === "return") ret |= b.term.value.type & ~T.Empty;
      if (ret !== sig.returns.get(fn.name)) {
        sig.returns.set(fn.name, ret);
        for (const c of callerMap.get(fn) ?? []) work.add(c);
      }
    }
    /* what it passes: its closed callees' parameters */
    for (const b of fn.blocks)
      for (const i of b.instrs) {
        const callee = i.op === "call_direct" ? byName.get(i.target!) : undefined;
        if (!callee || !closed.has(callee) || callee.meta?.declared) continue;  /* declared: as declared */
        callee.params.forEach((p, k) => {
          const old = sig.params.get(p)!;
          const next = old | (i.operands[k]!.type & ~T.Empty);
          if (next !== old) {
            sig.params.set(p, next);
            work.add(callee);
          }
        });
      }
  }
  return closed;
}

/** How the report counts values proven of one kind (constants aside). */
const KINDS: [string, Type][] = [
  ["number", Number_], ["boolean", T.Boolean], ["string", T.String], ["object", T.Object],
];

/** The type of a constant's value (as the builder gives it). */
export function constType(v: unknown): Type {
  if (v === undefined) return T.Undefined;
  if (v === null) return T.Null;
  if (typeof v === "boolean") return T.Boolean;
  if (typeof v === "string") return T.String;
  return Number.isInteger(v) && Math.abs(v as number) <= 2147483647 && !Object.is(v, -0) ? T.Int32 : T.Double;
}

const NUMERIC_INPUT: Type = Primitive & ~T.BigInt;  // ToNumeric of these is a Number (Symbol throws)

/** Whether a numeric operator's result can be a BigInt: only when every operand can (a BigInt or
 *  an object, whose valueOf could return one). A BigInt mixed with a Number is a TypeError, so
 *  one operand that can't be a BigInt makes the result a Number. */
function bigint(ops: Type[]): Type {
  return ops.some((t) => (t & ~NUMERIC_INPUT) === 0) ? T.None : T.BigInt;
}

function numeric(...ops: Type[]): Type {
  return Number_ | bigint(ops);
}

/** Typed code's 64-bit `int` arithmetic, C's: +, -, *, /, %, ++, --, unary -, and the bitwise
 *  operators of integers: ints and int32s with one of them an int, or in a typed function any
 *  integers (1 / 4 is 0, as in C; a float literal, 1.0, isn't one). Wrapping; / and % integer division. */
const INT64_OPS = new Set<Instr["op"]>([
  "add", "sub", "mul", "div", "mod", "neg", "inc", "dec", "bitand", "bitor", "bitxor", "bitnot", "shl", "sar", "shr",
  "num_add", "num_sub", "num_mul", "num_div", "num_mod", "num_neg", "num_inc", "num_dec",
  "num_bitand", "num_bitor", "num_bitxor", "num_bitnot", "num_shl", "num_sar", "num_shr", "int_div", "int_mod",
]);
export function int64Arith(i: Instr, type: (v: Instr) => Type): boolean {
  if (!INT64_OPS.has(i.op)) return false;
  const integral = (o: Instr) => isSubtype(type(o), T.Int64 | T.Int32) && !o.floatLit;
  const typed = i.block.fn.meta?.declared !== undefined;
  return (typed || i.operands.some((o) => isSubtype(type(o), T.Int64) && type(o) !== T.None)) && i.operands.every(integral)
    && i.operands.some((o) => type(o) !== T.None);
}

/** A bitwise operator's result: ToInt32 of a Number is an int32 (never -0). */
function int32(...ops: Type[]): Type {
  return T.Int32 | bigint(ops);
}

const BOOLEAN = new Set<Instr["op"]>([
  "not", "to_boolean", "is_nullish", "not_empty", "strict_eq", "strict_ne", "eq", "ne",
  "lt", "le", "gt", "ge", "in", "instanceof", "delete_prop", "delete_elem", "private_in", "same_function",
  "identical", "strict_eq_atom", "is_type", "strict_eq_num",
]);
const OBJECT = new Set<Instr["op"]>([
  "new_object", "new_array", "make_function", "make_arguments", "host_function", "regexp",
  "template_object", "global_this", "object_rest", "iter_rest", "new", "new_spread", "construct_direct", "class_setup",
  "new_instance", "construct_result",
]);

/** Whether a branch on the way to `at` proved `x < b` ("up": x + 1 stays an int32) or `x > b`
 *  ("down": x - 1 does), for x and b int32s. */
interface Bound {
  (x: Instr, at: Block, dir: "up" | "down"): boolean;
  /** The value without conversions that don't change a Number (`i++` is to_numeric, then inc). */
  root(v: Instr): Instr;
}

const RELATION: Partial<Record<Op, "<" | ">" | "<=" | ">=">> = {
  lt: "<", gt: ">", le: "<=", ge: ">=", num_lt: "<", num_gt: ">", num_le: "<=", num_ge: ">=",
};
const NEGATED = { "<": ">=", ">": "<=", "<=": ">", ">=": "<" } as const;
const FLIPPED = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" } as const;

/** Range facts: walks up the dominator tree from `at`; a block entered only by one
 *  edge of a branch on a comparison knows the comparison's outcome. For int32s neither side is
 *  NaN, so the else edge knows the opposite. */
function bounds(fn: FunctionIR, type: (v: Instr) => Type): Bound {
  let idom: Map<Block, Block> | null = null;
  const int32 = (v: Instr) => isSubtype(type(v) & ~T.Empty, T.Int32);
  const root = (v: Instr): Instr => {
    while ((v.op === "to_numeric" || v.op === "to_number" || v.op === "check_tdz") && isSubtype(type(v), Number_)) v = v.operands[0]!;
    return v;
  };
  const bound = (x: Instr, at: Block, dir: "up" | "down"): boolean => {
    idom ??= dominators(fn);
    if (!int32(x)) return false;
    for (let a = at; ; ) {
      const p = a.preds.length === 1 ? a.preds[0]! : null;
      const term = p?.term;
      if (p && term?.kind === "branch" && term.then !== term.else && p.handler !== a) {
        let rel = RELATION[term.cond.op];
        const [l, r] = term.cond.operands.map(root);
        if (rel && (l === x || r === x)) {
          if (term.else === a) rel = NEGATED[rel];
          if (r === x) rel = FLIPPED[rel];
          const other = l === x ? r! : l!;
          const lit = other.op === "const" && typeof other.lit!.value === "number" ? other.lit!.value : null;
          if (int32(other)) {
            if (dir === "up" && (rel === "<" || (rel === "<=" && lit !== null && lit < 2147483647))) return true;
            if (dir === "down" && (rel === ">" || (rel === ">=" && lit !== null && lit > -2147483648))) return true;
          }
        }
      }
      const up = idom.get(a);
      if (!up || up === a) return false;
      a = up;
    }
  };
  return Object.assign(bound, { root });
}

/** x + 1 or x - 1 (`i++`, `i += 1`, `i--`) of an int32 x the branches bound: an int32. */
function step(i: Instr, bound: Bound | null): boolean {
  if (!bound) return false;
  const root = bound.root;
  const one = (v: Instr) => v.op === "const" && v.lit!.value === 1;
  const [a, b] = i.operands;
  switch (i.op) {
    case "inc": case "num_inc": return bound(root(a!), i.block, "up");
    case "dec": case "num_dec": return bound(root(a!), i.block, "down");
    case "add": case "num_add":
      return (one(b!) && bound(root(a!), i.block, "up")) || (one(a!) && bound(root(b!), i.block, "up"));
    case "sub": case "num_sub": return one(b!) && bound(root(a!), i.block, "down");
    default: return false;
  }
}

function transfer(i: Instr, type: (v: Instr) => Type, sig: Signatures | null, bound: Bound | null = null): Type {
  if (step(i, bound)) return T.Int32;
  const [a, b] = i.operands;
  /* an operator's operands are never EMPTY: lowering checks bindings (check_tdz) and iterator
     results (not_empty) before using them */
  const t = (v: Instr) => type(v) & ~T.Empty;
  if (BOOLEAN.has(i.op)) return T.Boolean;
  if (OBJECT.has(i.op)) return T.Object;
  if (int64Arith(i, t)) return T.Int64;
  switch (i.op) {
    case "const": return constType(i.lit!.value);
    case "empty": return T.Empty;
    case "phi": return i.incoming!.reduce<Type>((u, inc) => u | type(inc.value), T.None);
    case "check_tdz": return t(a!);
    case "typeof": case "to_string": return T.String;
    case "bigint": return T.BigInt;
    case "switch_string": return T.Int32;
    case "to_number": return Number_;
    case "to_numeric": return isSubtype(t(a!), Number_) && t(a!) !== T.None ? t(a!) : numeric(t(a!));  /* a Number as it is (an int stays one) */
    case "add": {
      const ta = t(a!), tb = t(b!);
      if (ta === T.String || tb === T.String) return T.String;
      /* string concatenation needs a string (or an object's primitive) on one side */
      const strings = (ta | tb) & (T.String | T.Object) ? T.String : T.None;
      return strings | numeric(ta, tb);
    }
    case "sub": case "mul": case "div": case "mod": case "exp":
      return numeric(t(a!), t(b!));
    case "shr":  // BigInts have no >>>: a TypeError
      return Number_;
    case "neg": case "inc": case "dec":
      return numeric(t(a!));
    case "bitand": case "bitor": case "bitxor": case "shl": case "sar":
      return int32(t(a!), t(b!));
    case "bitnot":
      return int32(t(a!));
    case "num_add": case "num_sub": case "num_mul": case "num_div": case "num_mod": case "num_shr":
    case "num_neg": case "num_inc": case "num_dec":
      return Number_;
    case "num_bitand": case "num_bitor": case "num_bitxor": case "num_bitnot": case "num_shl": case "num_sar":
      return T.Int32;
    case "num_lt": case "num_le": case "num_gt": case "num_ge": case "num_eq": case "num_ne":
      return T.Boolean;
    case "get_prop":  // a string's length: its own, non-writable, at most 2^30 - 1
      return i.key && "name" in i.key && i.key.name === "length" && isSubtype(t(a!), T.String) ? T.Int32 : Unknown;
    case "call_direct":
      return sig?.returns.get(i.target!) ?? Unknown;
    case "get_elem": case "get_index":  /* typed code's typed array view: an element, or (an integer array's) undefined past the end */
      if (readsDouble(i)) return T.Int32 | T.Double;
      if (i.taView && i.block.fn.meta?.declared) return T.Int32 | T.Undefined;
      return Unknown;
    case "char_code_at":  /* a unit, or NaN past the end */
    case "math":
      return Number_;
    case "int_add": case "int_sub": case "int_mul":
      return T.Int32;
    case "to_i64":
      return T.Int64;
    case "to_i32":
      return T.Int32;
    case "call": {
      /* typed code trusts the built-ins to be the standard ones, as tsc's types do */
      if (trustedBuiltin(i, t)) return Number_;
      /* a typed unit's export: its declared result, whichever entry runs (the checked one throws
         for arguments of other types) */
      return i.typedCall ? i.typedCall.returns : Unknown;
    }
    default:
      return Unknown;
  }
}

/** Infers one function's types; `sig`: what is known of parameters and direct calls' results
 *  (absent: nothing). */
export function inferFunction(fn: FunctionIR, sig: Signatures | null = null) {
  /* (`t` and `bound` read the types as they grow) */
  const order = reversePostorder(fn);
  const values: Instr[] = [];
  for (const b of order) for (const i of [...b.phis, ...b.instrs]) if (OPS[i.op].result) values.push(i);
  const type = new Map<Instr, Type>(values.map((i) => [i, T.None]));
  for (const p of fn.params) type.set(p, sig?.params.get(p) ?? Unknown & ~T.Empty);
  /* a value from another function (never in valid IR) or not yet visited: assume nothing */
  const t = (v: Instr) => type.get(v) ?? Unknown;
  const bound = bounds(fn, t);
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of values) {
      if (i.op === "param") continue;
      const old = type.get(i)!;
      const next = old | transfer(i, t, sig, bound);  // monotone: types only grow
      if (next !== old) {
        type.set(i, next);
        changed = true;
      }
    }
  }
  for (const [i, ty] of type) i.type = ty;
}
