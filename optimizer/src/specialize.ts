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
// Anywhere, not just in loops: a call is big anyway.
import { Number_, T, isSubtype, type Instr, type ModuleIR, type Op } from "@visaljs/ir";

import { clearMayThrow, functionsOf, loopDepths, removeInstrs, removeUnreachable, useCounts } from "./cfg.ts";
import type { Count, Pass } from "./index.ts";

/** Each generic operator's Number form. */
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

/** The built-in a one-argument call may run inline, if any: `Math.sqrt(x)` …,
 *  `s.charCodeAt(i)`, `String.fromCharCode(c)` (named by its C helper's suffix). */
function inlineBuiltin(i: Instr): string | null {
  const callee = i.op === "call" && i.operands.length === 3 ? i.operands[0]! : null;
  if (callee?.op !== "get_prop" || !("name" in callee.key!)) return null;
  const name = callee.key.name;
  const global = (g: string) => callee.operands[0]!.op === "global_name" && callee.operands[0]!.target === g;
  if (MATH_INLINE.has(name) && global("Math")) return `math_${name}`;
  if (name === "fromCharCode" && global("String")) return "from_char_code";
  if (name === "charCodeAt" && i.operands[1] === callee.operands[0]) return "char_code_at";  // s.charCodeAt: `this` is s
  return null;
}

/** Element access's form for a Number key. */
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
          /* typed code trusts the built-ins: s.charCodeAt(i), a string's unit (the method read is dead) */
          if (fn.meta?.declared && inlineBuiltin(i) === "char_code_at" && isSubtype(i.operands[1]!.type, T.String)) {
            edges ||= i.mayThrow;
            clearMayThrow(i);
            const method = i.operands[0]!;  /* String.prototype.charCodeAt: reading it does nothing else */
            if (method.mayThrow) edges = true;
            if (uses.get(method) === 1) unread.add(method);
            i.op = "char_code_at";
            i.operands = [i.operands[1]!, i.operands[2]!];
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
          if (!form || !i.operands.every((o) => isSubtype(o.type, Number_))) {
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
