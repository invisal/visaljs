// Static code ("use static" files): its dialect, and the types it declares. A new type is an
// entry in STATIC_TYPES (and a declaration in cli/types/visaljs.d.ts when "visaljs" exports it).
import type { FunctionIR } from "./ir.ts";
import { isSubtype, T, type Type } from "./types.ts";
import { VIEWS, type ViewKind } from "./views.ts";

/** How a function's operators behave: JavaScript's, or static code's (C's integers, trusted
 *  built-ins). Every function of a static file is static, nested ones included. */
export type Dialect = "js" | "static";

export function isStatic(fn: FunctionIR): boolean {
  return fn.dialect === "static";
}

/** Static code's integers, C's: what is stored in one is converted to it, arithmetic wraps. */
export type IntKind = "i32" | "i64";

export interface StaticType {
  type: Type;
  int?: IntKind;
  /** its name in an ERR_INVALID_ARG_TYPE message */
  words: string;
}

/** By the name the source writes: tsc erases `int` and `i32` to number, so they are known by name. */
export const STATIC_TYPES: Record<string, StaticType> = {
  boolean: { type: T.Boolean, words: "boolean" },
  number: { type: T.Int32 | T.Double, words: "number" },
  int: { type: T.Int64, int: "i64", words: "number" },  /* takes any Number, converted */
  i32: { type: T.Int32, int: "i32", words: "i32" },
  string: { type: T.String, words: "string" },
  undefined: { type: T.Undefined, words: "undefined" },
  null: { type: T.Null, words: "null" },
};

/** A declared parameter's type as ERR_INVALID_ARG_TYPE words it: "of type string or undefined",
 *  "an instance of Float64Array". */
export function expectedText(t: Type, view?: ViewKind): string {
  if (view) return `an instance of ${VIEWS[view].ctor}`;
  const parts = Object.values(STATIC_TYPES).filter((s) => isSubtype(s.type, t));
  const widest = parts.filter((s) => !parts.some((o) => o !== s && isSubtype(s.type, o.type)));
  const names = [...new Set(widest.map((s) => s.words))];
  return `of type ${names.length > 2 ? `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}` : names.join(" or ")}`;
}
