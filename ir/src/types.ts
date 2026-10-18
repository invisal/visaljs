// The IR's type lattice: a bitset, so unions are cheap.
//
//                               Any
//   ┌──────────┬─────────┬───────┼─────────┬──────────┬──────────┐
// Number    Boolean   String  Symbol    BigInt    Undefined/Null  Object
//   │
// Int32

export type Type = number;

export const T = {
  None: 0,
  Undefined: 1 << 0,
  Null: 1 << 1,
  Boolean: 1 << 2,
  Int32: 1 << 3,      // a Number that is an int32 (and not -0)
  Double: 1 << 4,     // every other Number
  String: 1 << 5,
  Symbol: 1 << 6,
  BigInt: 1 << 7,
  Object: 1 << 8,
  Empty: 1 << 9,      // internal: an uninitialized binding (TDZ), never JS-visible
  Int64: 1 << 10,     // a typed file's ("use visaljs") `int`: a Number held as a C int64_t (C semantics)
} as const;

export const Number_: Type = T.Int32 | T.Double | T.Int64;
export const Primitive: Type = T.Undefined | T.Null | T.Boolean | Number_ | T.String | T.Symbol | T.BigInt;
export const Any: Type = Primitive | T.Object;
/** Nothing known: any JS value, or EMPTY (what an uninitialized binding reads). */
export const Unknown: Type = Any | T.Empty;

export function isSubtype(a: Type, b: Type): boolean {
  return (a & ~b) === 0;
}

const NAMED: [Type, string][] = [
  [Any | T.Empty, "Any|Empty"],
  [Any, "Any"],
  [Primitive, "Primitive"],
  [Number_, "Number"],
];
const BITS: [Type, string][] = [
  [T.Undefined, "Undefined"], [T.Null, "Null"], [T.Boolean, "Boolean"], [T.Int32, "Int32"], [T.Double, "Double"],
  [T.String, "String"], [T.Symbol, "Symbol"], [T.BigInt, "BigInt"], [T.Object, "Object"], [T.Empty, "Empty"], [T.Int64, "Int64"],
];

export function typeName(t: Type): string {
  for (const [bits, name] of NAMED) if (t === bits) return name;
  if (t === T.None) return "None";
  const parts: string[] = [];
  let rest = t;
  if ((rest & Number_) === Number_) {
    parts.push("Number");
    rest &= ~Number_;
  }
  for (const [bit, name] of BITS) if (rest & bit) parts.push(name);
  return parts.join("|");
}

/** C representation. */
export type Repr = "boxed" | "f64" | "i32" | "i64" | "bool";
