// "use static" files, compiled as one typed unit with their declared types.
//
// The program's bundle leaves them out (boundary.ts): each of their exports becomes a host
// primitive whose C function is the export's generic entry in the unit (which checks its
// arguments against the declared types: a TypeError for any other). The unit's files (and the
// static files they import) are checked by tsc, their classes nominal (nominal.ts), and against
// the subset (subset.ts), linked into one module (link.ts), their declared types read with tsc's
// checker, and compiled as a "harness script" (emitHarnessScript): its own prefix, its tables
// registered and its top level run before the program's.
//
// A Float64Array's element is a number there, as its type says: past the end, NaN (undefined as
// a number).
import { analyze, emitHarnessScript, type HostPrimitives, lower, programNames } from "@visaljs/compiler";
import { type FunctionIR, T, type Type, type TypedCall } from "@visaljs/ir";
import { optimize, type PassReport } from "@visaljs/optimizer";
import ts from "typescript";

import { isStaticSource } from "./boundary.ts";
import { compileError, linkUnit } from "./link.ts";
import { nominalDiagnostic, nominalProgram } from "./nominal.ts";
import { checkSubset } from "./subset.ts";
import { declaredSignatures, type Signature, TYPES_FILE } from "./types.ts";

export const TYPED_PREFIX = "vt_";

export interface TypedUnit {
  c: string;
  atoms: Map<string, string>;
  /** Each export as a host primitive: its generic entry. */
  exports: HostPrimitives;
  /** Each export as the program calls it: its typed and checked entries. */
  calls: Record<string, TypedCall>;
  /** The names its code uses: the program installs the built-ins they name too. */
  names: string[];
  report: PassReport[];
}

/** A function's name in C, as the emitter makes it (its ident). */
function ident(name: string): string {
  let out = "";
  for (const ch of name) out += /[A-Za-z0-9_]/.test(ch) ? ch : `_u${ch.codePointAt(0)!.toString(16)}_`;
  return out;
}

/** Compiles the typed files as one unit. */
export function buildTypedUnit(imported: readonly string[], primitives: HostPrimitives): TypedUnit {
  const program = nominalProgram(imported, [TYPES_FILE], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, skipLibCheck: true,
  });
  /* a static file only static code imports is the unit's too */
  const files = program.getSourceFiles().filter((sf) => isStaticSource(sf.fileName, sf.text)).map((sf) => sf.fileName);
  checkSubset(program, files);  /* first: its errors say what static code can't do, tsc's what the types don't allow */
  const errors = ts.getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error && files.includes(d.file?.fileName ?? "")).map(nominalDiagnostic);
  if (errors.length) throw new Error(ts.formatDiagnostics(errors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }));
  const checker = program.getTypeChecker();
  const signatures = new Map<string, Signature>();
  for (const file of files) declaredSignatures(checker, program.getSourceFile(file)!, signatures);
  const { ast, exports: exported } = linkUnit(program, files, primitives);

  const ir = lower(ast, analyze(ast));
  const at = (fn: FunctionIR) => (fn.loc ? `${fn.loc.file}:${fn.loc.line}:${fn.loc.column}` : "");
  for (const fn of ir.functions) {
    const meta = fn.meta!;
    const sig = signatures.get(at(fn));
    if (!sig) continue;
    const hidden = fn.params.length - sig.types.length;
    meta.declared = fn.params.map((_, k) => (k < hidden ? undefined : sig.types[k - hidden]));
    meta.declaredViews = fn.params.map((_, k) => (k < hidden ? undefined : sig.views[k - hidden]));
    meta.external = true;
  }
  const exports: Record<string, { c: string; length: number }> = {};
  const exportedFns = new Map<string, string>();
  for (const [name, loc] of exported) {
    const array = signatures.get(loc)?.arrays[0];
    if (array) throw compileError(array, `export '${name}' takes an array: static code doesn't take arrays from JavaScript yet`);
    const fn = ir.functions.find((f) => at(f) === loc)!;
    exportedFns.set(name, fn.name);
    exports[name] = { c: `${TYPED_PREFIX}jsf_${ident(fn.name)}__generic`, length: fn.meta!.length };
  }
  const report: PassReport[] = [];
  const optimized = optimize(ir, undefined, report);
  /* how the program calls each export: the typed entry takes the declared parameters only */
  const calls: Record<string, TypedCall> = {};
  for (const [name, fnName] of exportedFns) {
    const fn = optimized.functions.find((f) => f.name === fnName)!;
    const declared = fn.meta!.declared!;
    if (declared.some((t) => t === undefined)) continue;  /* hidden parameters (this, …): the checked entry only */
    let returns: Type = T.None;
    for (const b of fn.blocks) if (b.term?.kind === "return") returns |= b.term.value.type & ~T.Empty;
    calls[name] = {
      direct: `${TYPED_PREFIX}jsf_${ident(fn.name)}`,
      generic: exports[name]!.c,
      params: fn.params.map((p, k) => ({ type: declared[k]!, repr: p.repr, ...(fn.meta!.declaredViews?.[k] ? { view: fn.meta!.declaredViews[k] } : {}) })),
      returns: returns === T.None ? T.Undefined : returns & T.Int64 ? (returns & ~T.Int64) | T.Int32 | T.Double : returns,
      returnRepr: fn.returnRepr ?? "boxed",
    };
  }
  const unit = emitHarnessScript(optimized, TYPED_PREFIX, new Map(), { hostPrimitives: primitives });
  return { c: unit.c, atoms: new Map(unit.atoms), exports, calls, report, names: [...programNames(ast)] };
}
