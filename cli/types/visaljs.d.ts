// The types a "use static" file can import: `import type { int } from "visaljs"`. Integers with
// C semantics: what is stored in one (a local, a parameter, a return value, an argument) is
// converted to it (truncated toward zero, wrapped); +, -, * wrap, / and % are integer division
// (a zero divisor: a RangeError), and the bitwise operators are 64-bit.
declare module "visaljs" {
  /** A 64-bit integer (an int64_t). A JS Number when it leaves typed code: exact up to 2^53. */
  export type int = number;
  /** A 32-bit integer (an int32_t), for code that wraps at 32 bits (hashes, C ports). */
  export type i32 = number;
}
