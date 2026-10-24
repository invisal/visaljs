// Simplification from types, after infer-types:
// - conversions of a value already of the target type are the value (`to_numeric` of a Number:
//   every `i++`), and so is a TDZ check of a value that can't be EMPTY, a method's receiver proven
//   an object, an inlined typed argument proven its declared type;
// - an operator whose operand types rule out every error (and any user code) can't throw: its
//   `mayThrow` is cleared, so C emission drops its exception check;
// - a branch whose condition's truthiness is known becomes a jump, and blocks no longer
//   reached go.
import { accepts, Number_, OPS, Primitive, T, isSubtype, type Block, type FunctionIR, type Instr, type ModuleIR, type Op, type Type } from "@visaljs/ir";

import { clearMayThrow, functionsOf, removeEdge, removeInstrs, removeUnreachable, replaceUses } from "./cfg.ts";
import type { Count, Pass } from "./index.ts";

const NUMERIC = new Set<Op>(["add", "sub", "mul", "div", "mod", "exp", "neg", "inc", "dec", "shl", "sar", "shr", "bitand", "bitor", "bitxor", "bitnot"]);
const RELATIONAL = new Set<Op>(["lt", "le", "gt", "ge"]);
/** Primitives every conversion accepts: a Symbol throws in ToNumber and ToString. */
const CONVERTIBLE: Type = Primitive & ~T.Symbol;

/** Whether `i` can't throw, given its operands' types. Then it can't call user code either:
 *  only objects (valueOf, toString, getters) could. */
export function provenSafe(i: Instr): boolean {
  const all = (t: Type) => i.operands.every((o) => isSubtype(o.type, t));
  if (NUMERIC.has(i.op)) return all(Number_);  // BigInt: RangeError (division by zero), TypeError (mixing)
  if (RELATIONAL.has(i.op)) return all(CONVERTIBLE);
  if (i.op === "eq" || i.op === "ne") return all(Primitive);
  if (i.op === "to_numeric") return all(CONVERTIBLE);
  if (i.op === "to_number") return all(CONVERTIBLE & ~T.BigInt);
  return false;
}

/** The value `i` always equals, if it's a conversion or check that changes nothing. */
function identity(i: Instr): Instr | null {
  const [a] = i.operands;
  switch (i.op) {
    case "to_numeric": return isSubtype(a!.type, Number_ | T.BigInt) ? a! : null;
    case "to_number": return isSubtype(a!.type, Number_) ? a! : null;
    case "to_boolean": return isSubtype(a!.type, T.Boolean) ? a! : null;
    case "to_string": return isSubtype(a!.type, T.String) ? a! : null;
    case "check_tdz": return a!.type & T.Empty ? null : a!;
    case "receiver": return isSubtype(a!.type, T.Object) && a!.type !== T.None ? a! : null;
    case "declared_check": return !i.check!.view && a!.type !== T.None && isSubtype(a!.type & ~T.Empty, accepts(i.check!.type)) ? a! : null;
    default: return null;
  }
}

/** A condition's truthiness, when its type or value decides it. */
function truthiness(v: Instr): boolean | null {
  if (v.op === "const") return Boolean(v.lit!.value);
  if (v.type === T.None) return null;
  if (isSubtype(v.type, T.Object)) return true;  // no document.all here: every object is truthy
  if (isSubtype(v.type, T.Undefined | T.Null)) return false;
  return null;
}

export const simplify: Pass = {
  name: "simplify",
  run(m: ModuleIR, count: Count) {
    for (const fn of functionsOf(m)) simplifyFunction(fn, count);
    return m;
  },
};

function simplifyFunction(fn: FunctionIR, count: Count) {
  const replacements = new Map<Instr, Instr>();
  const dead = new Set<Instr>();
  for (const b of fn.blocks)
    for (const i of b.instrs) {
      const same = identity(i);
      if (same) {
        replacements.set(i, same);
        dead.add(i);
        clearMayThrow(i);  // it's gone: in a try, so is its edge to the handler
        count("removed", i.op === "check_tdz" ? "TDZ check" : "conversion");
      } else if (i.mayThrow && OPS[i.op].mayThrow && provenSafe(i)) {
        clearMayThrow(i);
        count("removed", "exception check");
      }
    }
  replaceUses(fn, replacements);
  removeInstrs(fn, dead);
  for (const b of fn.blocks) if (foldBranch(b)) count("folded", "branch", 1, "branches");
  const before = fn.blocks.length;
  if (removeUnreachable(fn)) count("removed", "unreachable block", before - fn.blocks.length);
}

function foldBranch(b: Block): boolean {
  const t = b.term;
  if (t?.kind !== "branch") return false;
  const known = truthiness(t.cond);
  if (known === null) return false;
  const [taken, other] = known ? [t.then, t.else] : [t.else, t.then];
  b.term = { kind: "jump", target: taken, loc: t.loc };
  if (other !== taken) removeEdge(b, other);
  return true;
}
