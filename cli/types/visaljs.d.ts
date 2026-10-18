// The types a "use visaljs" file can import: `import type { i32, u8 } from "visaljs"`. Integers
// with C semantics: what is stored in one (a local, a parameter, a return value) is truncated to
// its width, and their arithmetic wraps.
declare module "visaljs" {
  export type i8 = number;
  export type u8 = number;
  export type i16 = number;
  export type u16 = number;
  export type i32 = number;
  /** i32 */
  export type int = number;
}
