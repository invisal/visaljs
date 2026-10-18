// Number operators: a generic operator whose operands are all proven Numbers
// becomes its num_* form. The generic one (`js_add`) is an out-of-line runtime call that first
// tells strings, objects and BigInts apart; num_add is an inline int32 add with an overflow
// check, falling back to a double add. They can't throw, allocate or call user code.
//
// Element access with a Number key: `a[i]` becomes get_index, `a[i] = v`
// set_index. Their C reads or writes a dense array's element inline (an array, an int32 key below
// the used length, not a hole) and is get_elem / set_elem otherwise, so they still can throw.
//
// Number paths: an operator inference couldn't type stays generic, but if its
// operands can be Numbers and it runs in a loop, its C tests for Numbers and takes the inline
// path first (`js_sub_fast`), calling `js_sub` only otherwise: values read from properties and
// elements are usually Numbers in numeric code. Loops only, so that binaries don't grow for code
// that runs once.
//
// Built-in calls with one argument: `Math.sqrt(x)` (abs, floor, ceil, trunc), `s.charCodeAt(i)`,
// `String.fromCharCode(c)`. Their C compares the callee with the built-in and, when it is and
// the argument suits, does its work inline (C's sqrt; reading the unit), else makes the call.
// Anywhere, not just in loops: a call is big anyway. `f.apply(t, args)` and `f.call(t, …)` the
// same way: f called directly when the method is the built-in (every emit and once wrapper).
import { Number_, T, isSubtype, type FunctionIR, type Instr, type JSConst, type ModuleIR, type Op, type Type } from "@visaljs/ir";

import { int64Arith } from "./infer-types.ts";
import { clearMayThrow, functionsOf, loopDepths, removeInstrs, removeUnreachable, useCounts } from "./cfg.ts";
import type { Count, Pass } from "./index.ts";

export const NUMBER_FORM: Partial<Record<Op, Op>> = {
  add: "num_add", sub: "num_sub", mul: "num_mul", div: "num_div", mod: "num_mod",
  neg: "num_neg", inc: "num_inc", dec: "num_dec",
  lt: "num_lt", le: "num_le", gt: "num_gt", ge: "num_ge",
  eq: "num_eq", ne: "num_ne", strict_eq: "num_eq", strict_ne: "num_ne",  // on Numbers, == is ===
  bitand: "num_bitand", bitor: "num_bitor", bitxor: "num_bitxor", bitnot: "num_bitnot",
  shl: "num_shl", sar: "num_sar", shr: "num_shr",
};

/** The generic operators with a Number path (the rest of NUMBER_FORM's, and ToNumeric). */
const NUMBER_FIRST = new Set<Op>([
  "add", "sub", "mul", "div", "mod", "neg", "inc", "dec", "lt", "le", "gt", "ge", "eq", "ne",
  "bitand", "bitor", "bitxor", "bitnot", "shl", "sar", "shr", "to_numeric",
]);

/** Math functions of one Number whose C form generated code may call inline. */
const MATH_INLINE = new Set(["sqrt", "abs", "floor", "ceil", "trunc"]);

/** The built-in a call may run inline, if any: `Math.sqrt(x)` …, `s.charCodeAt(i)`,
 *  `String.fromCharCode(c)` with one argument, `f.apply(…)` and `f.call(…)` (named by its C
 *  helper's suffix). */
function inlineBuiltin(i: Instr): string | null {
  const callee = i.op === "call" ? i.operands[0]! : null;
  if (callee?.op !== "get_prop" || !("name" in callee.key!)) return null;
  const name = callee.key.name;
  /* f.apply(t, args), f.call(t, …): `this` is f */
  if (((name === "apply" && i.operands.length <= 4) || name === "call") && i.operands[1] === callee.operands[0]) return name;
  if (i.operands.length !== 3) return null;
  const global = (g: string) => callee.operands[0]!.op === "global_name" && callee.operands[0]!.target === g;
  if (MATH_INLINE.has(name) && global("Math")) return `math_${name}`;
  if (name === "fromCharCode" && global("String")) return "from_char_code";
  if (name === "charCodeAt" && i.operands[1] === callee.operands[0]) return "char_code_at";  // s.charCodeAt: `this` is s
  return null;
}

/** What typed code ("use static", which trusts the built-ins to be the standard ones) makes of a
 *  built-in call: s.charCodeAt(i) of a string, or Math's sqrt/abs/floor/ceil/trunc of a Number,
 *  the C helper's suffix; null for anything else. `type`: the values' types. */
export function trustedBuiltin(i: Instr, type: (v: Instr) => Type): string | null {
  if (!i.block.fn.meta?.declared) return null;
  const name = inlineBuiltin(i);
  if (name === "char_code_at") return isSubtype(type(i.operands[1]!), T.String) ? name : null;
  if (name?.startsWith("math_")) return isSubtype(type(i.operands[2]!), Number_) ? name : null;
  return null;
}

/** The bitwise operators: ToInt32 (ToUint32) of their operands first. */
const TRUNCATING = new Set<Op>(["num_bitor", "num_bitand", "num_bitxor", "num_shl", "num_sar", "num_shr"]);

/** Wrapping int32 arithmetic (`(a + b) | 0` of int32s, an i32's to_i32), by the Number operator. */
const INT_FORM: Partial<Record<Op, Op>> = { num_add: "int_add", num_sub: "int_sub", num_mul: "int_mul", num_inc: "int_add", num_dec: "int_sub" };

/** A constant 1 before `i`, for x++ as x + 1. */
function one(i: Instr): Instr {
  const b = i.block;
  const c: Instr = { id: nextId(b.fn), op: "const", operands: [], type: T.Int32, repr: "boxed", mayThrow: false, block: b, loc: i.loc, lit: { value: 1 } };
  b.instrs.splice(b.instrs.indexOf(i), 0, c);
  return c;
}

function nextId(fn: FunctionIR): number {
  return 1 + Math.max(0, ...fn.params.map((p) => p.id), ...fn.blocks.flatMap((b) => [...b.phis, ...b.instrs].map((i) => i.id)));
}

/** Kinds of value whose === compares contents, not bits: two Numbers (1 and 1.0 boxed
 *  differently, NaN), two strings (equal units in two cells), two BigInts. */
const BY_CONTENT = Number_ | T.String | T.BigInt;

const NONE = Symbol("no literal");

/** A comparison js_strict_equals (js_eq) needn't make: `typeof x === "function"`, `x == null`,
 *  `x === "literal"`, and === where the operands can't both be Numbers, strings or BigInts
 *  (`x === undefined`, objects): a C bool test of boxed values. Rewrites `i`; false: kept. */
function simplerComparison(i: Instr): boolean {
  const strict = i.op === "strict_eq" || i.op === "strict_ne";
  if (!strict && i.op !== "eq" && i.op !== "ne") return false;
  const negated = i.op === "strict_ne" || i.op === "ne" ? 1 : 0;
  const literal = (v: Instr): JSConst | typeof NONE => (v.op === "const" ? v.lit!.value : NONE);
  for (const [x, y] of [[i.operands[0]!, i.operands[1]!], [i.operands[1]!, i.operands[0]!]] as const) {
    const lit = literal(y);
    if (x.op === "typeof" && typeof lit === "string") {  /* typeof's result is one of its names: either works */
      Object.assign(i, { op: "is_type", operands: [x.operands[0]!], target: lit, index: negated });
      return true;
    }
    if (!strict && (lit === null || lit === undefined)) {  /* x == null: null or undefined (no document.all here) */
      Object.assign(i, { op: "is_type", operands: [x], target: "nullish", index: negated });
      return true;
    }
    if (strict && typeof lit === "string") {
      Object.assign(i, { op: "strict_eq_atom", operands: [x, y], index: negated });
      return true;
    }
    if (strict && typeof lit === "number" && !Number.isNaN(lit) && !(x.op === "const" && typeof x.lit!.value === "number")) {
      Object.assign(i, { op: "strict_eq_num", operands: [x, y], index: negated });
      return true;
    }
  }
  if (strict && (i.operands[0]!.type & i.operands[1]!.type & BY_CONTENT) === 0) {
    Object.assign(i, { op: "identical", index: negated });
    return true;
  }
  return false;
}

const INDEX_FORM: Partial<Record<Op, Op>> = { get_elem: "get_index", set_elem: "set_index" };

export const specialize: Pass = {
  name: "specialize",
  run(m: ModuleIR, count: Count) {
    for (const fn of functionsOf(m)) {
      let edges = false;
      const depth = loopDepths(fn);
      const uses = useCounts(fn);
      const unread = new Set<Instr>();
      for (const b of fn.blocks)
        for (const i of b.instrs) {
          /* an i32's conversion: the int32 arithmetic feeding it wraps, as C's */
          if (i.op === "to_i32")
            for (const x of i.operands)
              if (INT_FORM[x.op] && uses.get(x) === 1 && x.operands.every((o) => isSubtype(o.type, T.Int32))) {
                if (x.op === "num_inc" || x.op === "num_dec") x.operands = [x.operands[0]!, one(x)];
                x.op = INT_FORM[x.op]!;
                count("wrapped", "int operation");
              }
          /* typed code trusts the built-ins: s.charCodeAt(i), a string's unit; Math.sqrt(x), C's.
             Reading the method (and Math) does nothing else: it goes when nothing else reads it. */
          const trusted = trustedBuiltin(i, (v) => v.type);
          if (trusted) {
            edges ||= i.mayThrow;
            clearMayThrow(i);
            const method = i.operands[0]!;
            if (method.mayThrow) edges = true;
            if (uses.get(method) === 1) {
              unread.add(method);
              const holder = method.operands[0]!;  /* Math */
              if (trusted !== "char_code_at" && holder.op === "global_name" && uses.get(holder) === 2) {  /* the callee's and `this` */
                unread.add(holder);
                edges = true;
              }
            }
            if (trusted === "char_code_at") {
              i.op = "char_code_at";
              i.operands = [i.operands[1]!, i.operands[2]!];
            } else {
              i.op = "math";
              i.target = trusted.slice("math_".length);
              i.operands = [i.operands[2]!];
            }
            count("inlined", "built-in call");
            continue;
          }
          const builtin = inlineBuiltin(i);
          if (builtin) {
            i.builtin = builtin;
            count("inlined", "built-in call");
            continue;
          }
          const index = INDEX_FORM[i.op];
          if (index && isSubtype(i.operands[1]!.type, Number_)) {
            i.op = index;
            count("inlined", "element access", 1, "element accesses");
            continue;
          }
          const form = NUMBER_FORM[i.op];
          /* None isn't a Number: a closed function with no calls left (all inlined) has None parameters,
             and its C must still compile */
          const numbers = i.operands.every((o) => isSubtype(o.type, Number_) && o.type !== T.None);
          if (!numbers && simplerComparison(i)) {
            edges ||= i.mayThrow;  /* == can call valueOf; x == null can't */
            clearMayThrow(i);
            count("simplified", "comparison");
            continue;
          }
          if (!form || !numbers) {
            if (NUMBER_FIRST.has(i.op) && depth.get(b)! > 0 && i.operands.every((o) => o.type & Number_)) {
              i.numberFirst = true;
              count("added", "number fast path");
            }
            continue;
          }
          edges ||= i.mayThrow;
          clearMayThrow(i);
          i.op = form;
          count("inlined", "number operator");
          /* an int's / and %: C's integer division; a zero divisor throws (a constant one can't) */
          if ((form === "num_div" || form === "num_mod") && int64Arith(i, (v) => v.type)) {
            i.op = form === "num_div" ? "int_div" : "int_mod";
            const d = i.operands[1]!;
            i.mayThrow = !(d.op === "const" && d.lit!.value !== 0);
            count("inlined", "integer division", 1, "integer divisions");
            continue;
          }
          /* (a + b) | 0 of int32s: the bitwise operator truncates its operands to 32 bits, so a + b
             wrapping in an int32 gives it the same bits */
          if (TRUNCATING.has(form) && !int64Arith(i, (v) => v.type))
            for (const x of i.operands)
              if (INT_FORM[x.op] && uses.get(x) === 1 && x.operands.every((o) => isSubtype(o.type, T.Int32))) {
                if (x.op === "num_inc" || x.op === "num_dec") x.operands = [x.operands[0]!, one(x)];
                x.op = INT_FORM[x.op]!;
                count("wrapped", "int operation");
              }
        }
      if (unread.size) {
        for (const v of unread) clearMayThrow(v);
        removeInstrs(fn, unread);
      }
      if (edges) removeUnreachable(fn);
    }
    return m;
  },
};
