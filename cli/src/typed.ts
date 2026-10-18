// PROTOTYPE: "use visaljs" files, compiled as one typed unit with their declared types.
//
// The program's bundle leaves them out: an import of one resolves to "visaljs:host", and each
// of their exports becomes a host primitive whose C function is the export's generic entry in
// the unit (which checks its arguments against the declared types). The unit is bundled on its
// own, its functions' parameter types read with tsc's checker, and compiled as a "harness
// script" (emitHarnessScript): its own prefix, its tables registered and its top level run
// before the program's.
//
// Prototype limits: parameters of type number, string or boolean (and unions of them, null,
// undefined); the unit imports only other "use visaljs" files and "visaljs:host"; export names
// are unique across the unit and don't collide with the host's primitives.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { analyze, emitHarnessScript, HOST_MODULE, type HostPrimitives, lower, parseModule, programNames } from "@visaljs/compiler";
import { type FunctionIR, type Instr, type ModuleIR, T, type Type, type TypedCall } from "@visaljs/ir";
import { optimize, type PassReport } from "@visaljs/optimizer";
import { type Plugin, rolldown } from "rolldown";
import ts from "typescript";

export const TYPED_DIRECTIVE = "use visaljs";
export const TYPED_PREFIX = "vt_";

/** Whether a file starts with the "use visaljs" directive. */
export function isTypedFile(file: string): boolean {
  if (!/\.[cm]?tsx?$/.test(file)) return false;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  return /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(["'])use visaljs\1/.test(text);
}

/** The program's bundle: a typed file's import resolves to the host module (its exports are
 *  host primitives); `found` collects the typed files. */
export function typedImports(found: Set<string>): Plugin {
  return {
    name: "visaljs-typed-imports",
    async resolveId(source, importer, { kind }) {
      if (source === HOST_MODULE || !importer || kind !== "import-statement") return null;
      const r = await this.resolve(source, importer, { skipSelf: true });
      if (!r || r.external || !isTypedFile(r.id)) return null;
      found.add(r.id);
      return { id: HOST_MODULE, external: true };
    },
  };
}

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

/** The declared parameter types of the top-level functions of the typed files, by name. */
function declaredSignatures(files: readonly string[]): Map<string, Type[]> {
  const program = ts.createProgram([...files], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, skipLibCheck: true,
  });
  const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error && files.includes(d.file?.fileName ?? ""));
  if (errors.length) throw new Error(ts.formatDiagnostics(errors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }));
  const checker = program.getTypeChecker();
  const out = new Map<string, Type[]>();
  for (const file of files) {
    const sf = program.getSourceFile(file)!;
    for (const st of sf.statements) {
      if (!ts.isFunctionDeclaration(st) || !st.name) continue;
      out.set(st.name.text, st.parameters.map((p) => {
        const t = irType(checker, checker.getTypeAtLocation(p));
        if (t === null) throw new Error(`${file}: ${st.name!.text}(${p.name.getText(sf)}): the prototype takes number, string or boolean parameters, not ${checker.typeToString(checker.getTypeAtLocation(p))}`);
        return t;
      }));
    }
  }
  return out;
}

/** A TypeScript type as the IR's, if the prototype takes it. */
function irType(checker: ts.TypeChecker, t: ts.Type): Type | null {
  if (t.isUnion()) {
    let u: Type = T.None;
    for (const part of t.types) {
      const p = irType(checker, part);
      if (p === null) return null;
      u |= p;
    }
    return u;
  }
  const f = t.flags;
  if (f & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) return T.Int32 | T.Double;
  if (f & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) return T.String;
  if (f & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return T.Boolean;
  if (f & ts.TypeFlags.Undefined) return T.Undefined;
  if (f & ts.TypeFlags.Null) return T.Null;
  return null;
}

/** A function's name in C, as the emitter makes it (its ident). */
function ident(name: string): string {
  let out = "";
  for (const ch of name) out += /[A-Za-z0-9_]/.test(ch) ? ch : `_u${ch.codePointAt(0)!.toString(16)}_`;
  return out;
}

/** Compiles the typed files as one unit. */
export async function buildTypedUnit(files: readonly string[], primitives: HostPrimitives): Promise<TypedUnit> {
  const signatures = declaredSignatures(files);
  const ENTRY = "\0visaljs-typed-entry";
  const bundle = await rolldown({
    input: ENTRY,
    external: [HOST_MODULE],
    plugins: [{
      name: "visaljs-typed-entry",
      resolveId: (s) => (s === ENTRY ? s : null),
      load: (id) => (id === ENTRY ? files.map((f) => `export * from ${JSON.stringify(resolve(f))};`).join("\n") : null),
    }],
    logLevel: "silent",
  });
  const { output } = await bundle.generate({ format: "esm" });
  await bundle.close();
  const code = output[0].code;

  /* `export { local as name, … }`: the bundle's export clause */
  const exported = new Map<string, string>();
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g))
    for (const part of m[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [local, name] = part.split(/\s+as\s+/);
      exported.set(name ?? local!, local!);
    }

  const ast = parseModule(code, "typed.js", undefined, undefined, primitives);
  const ir = lower(ast, analyze(ast));
  /* each function's untyped copy: what a typed function's generic entry runs for arguments that
     aren't the declared types (lowered again: the same module slots, its own function names) */
  const copy = lower(ast, analyze(ast));
  const untypedName = (name: string) => `${name}$untyped`;
  for (const fn of copy.functions) {
    fn.name = untypedName(fn.name);
    for (const b of fn.blocks)
      for (const i of b.instrs)
        if (i.target && (i.op === "call_direct" || i.op === "make_function" || i.op === "same_function" || i.op === "construct_direct")) i.target = untypedName(i.target);
  }
  const byJsName = new Map<string, number>();
  for (const fn of ir.functions) byJsName.set(fn.meta!.jsName, (byJsName.get(fn.meta!.jsName) ?? 0) + 1);
  const exports: Record<string, { c: string; length: number }> = {};
  for (const fn of ir.functions) {
    const meta = fn.meta!;
    const sig = signatures.get(meta.jsName);
    if (!sig || byJsName.get(meta.jsName) !== 1 || meta.generator || meta.async || meta.hasRest) continue;
    const hidden = fn.params.length - sig.length;
    if (hidden < 0) continue;
    meta.declared = fn.params.map((_, k) => (k < hidden ? undefined : sig[k - hidden]));
    meta.external = true;
    meta.untyped = untypedName(fn.name);
    const twin = copy.functions.find((f) => f.name === meta.untyped)!;
    twin.meta!.external = true;
  }
  ir.functions.push(...copy.functions);
  for (const [name, local] of exported) {
    const fn = ir.functions.find((f) => f.meta!.jsName === local && f.meta!.declared);
    if (!fn) throw new Error(`typed unit: export '${name}' is not a typed function declaration`);
    if (Object.hasOwn(primitives, name)) throw new Error(`typed unit: export '${name}' is a host primitive's name`);
    exports[name] = { c: `${TYPED_PREFIX}jsf_${ident(fn.name)}__generic`, length: fn.meta!.length };
  }
  const report: PassReport[] = [];
  const optimized = optimize(ir, undefined, report);
  /* how the program calls each export: the typed entry takes the declared parameters only */
  const calls: Record<string, TypedCall> = {};
  for (const [name, local] of exported) {
    const fn = optimized.functions.find((f) => f.meta!.jsName === local && f.meta!.declared)!;
    const declared = fn.meta!.declared!;
    if (declared.some((t) => t === undefined)) continue;  /* hidden parameters (this, …): the checked entry only */
    let returns: Type = T.None;
    for (const b of fn.blocks) if (b.term?.kind === "return") returns |= b.term.value.type & ~T.Empty;
    calls[name] = {
      direct: `${TYPED_PREFIX}jsf_${ident(fn.name)}`,
      generic: exports[name]!.c,
      params: fn.params.map((p, k) => ({ type: declared[k]!, repr: p.repr })),
      returns: returns === T.None ? T.Undefined : returns,
      returnRepr: fn.returnRepr ?? "boxed",
    };
  }
  const unit = emitHarnessScript(optimized, TYPED_PREFIX, new Map(), { hostPrimitives: primitives });
  return { c: unit.c, atoms: new Map(unit.atoms), exports, calls, report, names: [...programNames(ast)] };
}

/** The program's calls of typed exports: a call whose callee is the export's host import (the
 *  host function, or the module binding one store sets to it). Before optimizing. */
export function annotateTypedCalls(m: ModuleIR, calls: Record<string, TypedCall>): number {
  const all = [m.main, ...m.functions];
  const slots = new Map<number, string>();
  const stores = new Map<number, number>();
  for (const fn of all)
    for (const b of fn.blocks)
      for (const i of b.instrs) {
        if (i.op !== "store_global" || i.operands[0]!.op === "empty") continue;
        stores.set(i.index!, (stores.get(i.index!) ?? 0) + 1);
        const v = i.operands[0]!;
        if (v.op === "host_function" && Object.hasOwn(calls, v.target!)) slots.set(i.index!, v.target!);
      }
  const target = (callee: Instr): string | undefined => {
    const v = callee.op === "check_tdz" ? callee.operands[0]! : callee;
    if (v.op === "host_function") return Object.hasOwn(calls, v.target!) ? v.target : undefined;
    if (v.op === "load_global" && stores.get(v.index!) === 1) return slots.get(v.index!);
    return undefined;
  };
  let n = 0;
  for (const fn of all as FunctionIR[])
    for (const b of fn.blocks)
      for (const i of b.instrs) {
        if (i.op !== "call") continue;
        const name = target(i.operands[0]!);
        if (name) {
          i.typedCall = calls[name]!;
          n++;
        }
      }
  return n;
}
