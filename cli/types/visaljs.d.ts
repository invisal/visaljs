// The types a "use visaljs" file can import: `import type { int } from "visaljs"`.
declare module "visaljs" {
  /** A 32-bit integer with C semantics: what is stored in one is truncated to 32 bits, and its
   *  arithmetic wraps. */
  export type int = number;
}
