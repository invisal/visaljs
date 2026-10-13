// Compile-time errors, reported at original source locations.
import type { Loc } from "./ast.ts";

/**
 * - "SyntaxError": the program is invalid JavaScript. test262 negative tests
 *   with phase parse/resolution pass only on this kind.
 * - "NotSupported": valid JavaScript the compiler doesn't handle yet.
 */
export type CompileErrorKind = "SyntaxError" | "NotSupported";

export class CompileError extends Error {
  readonly kind: CompileErrorKind;
  readonly detail: string;
  readonly loc: Loc;

  constructor(kind: CompileErrorKind, detail: string, loc: Loc) {
    super(`${loc.file}:${loc.line}:${loc.column}: ${kind === "SyntaxError" ? "SyntaxError" : "not supported yet"}: ${detail}`);
    this.name = "CompileError";
    this.kind = kind;
    this.detail = detail;
    this.loc = loc;
  }
}
