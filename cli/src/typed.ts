// "use static" files, compiled as one typed unit with their declared types.
//
// The program's bundle leaves them out: an import of one resolves to "visaljs:host", and each
// of their exports becomes a host primitive whose C function is the export's generic entry in
// the unit (which checks its arguments against the declared types: a TypeError for any other).
// The unit's files are checked by tsc and against the subset (static/subset.ts), linked into one
// module (static/link.ts), their declared types read with tsc's checker, and compiled as a
// "harness script" (emitHarnessScript): its own prefix, its tables registered and its top level
// run before the program's.
//
// A Float64Array's element is a number there, as its type says: past the end, NaN (undefined as
// a number).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { analyze, emitHarnessScript, HOST_MODULE, type HostPrimitives, lower, programNames } from "@visaljs/compiler";
import { type FunctionIR, type Instr, type IntKind, type ModuleIR, OPS, STATIC_TYPES, T, type Type, type TypedCall, viewOf, type ViewKind } from "@visaljs/ir";
import { optimize, type PassReport } from "@visaljs/optimizer";
import type { Plugin } from "rolldown";
import ts from "typescript";

import { compileError, linkUnit, locKey } from "./static/link.ts";
import { checkSubset } from "./static/subset.ts";

export const TYPED_PREFIX = "vt_";

/** A file that starts with the "use static" directive (after comments). */
const DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(["'])use static\1/;

function isTypedFile(file: string): boolean {
  return /\.[cm]?tsx?$/.test(file) && DIRECTIVE.test(readFileSync(file, "utf8"));
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

/** A function's integer declarations: its locals' (by name), its parameters' (by index), its
 *  return's. */
interface Ints {
  locals: Map<string, IntKind>;
  params: Map<number, IntKind>;
  /** its parameters in the source (the IR's has hidden ones first) */
  paramCount: number;
  returns: IntKind | undefined;
}

const TYPES_FILE = resolve(import.meta.dirname, "..", "types", "visaljs.d.ts");

/** The integer a type annotation names: "visaljs"'s `int` or `i32`, through imports and aliases. */
function intKind(checker: ts.TypeChecker, node: ts.TypeNode | undefined): IntKind | undefined {
  if (!node || !ts.isTypeReferenceNode(node)) return undefined;
  let symbol = checker.getSymbolAtLocation(node.typeName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  if (!symbol || !declaration || !ts.isTypeAliasDeclaration(declaration)) return undefined;
  if (resolve(declaration.getSourceFile().fileName) !== TYPES_FILE) return intKind(checker, declaration.type);
  return Object.hasOwn(STATIC_TYPES, symbol.name) ? STATIC_TYPES[symbol.name]!.int : undefined;
}

type FunctionWithBody = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/** Each function's integer declarations, by where it starts (locKey), nested functions too. Two
 *  bindings of one name in a function with different types are an error: the IR knows a local
 *  by its name. */
function intDeclarations(checker: ts.TypeChecker, sf: ts.SourceFile, out: Map<string, Ints>) {
  const declare = (fn: FunctionWithBody) => {
    const ints: Ints = { locals: new Map(), params: new Map(), paramCount: fn.parameters.length, returns: intKind(checker, fn.type) };
    const kinds = new Map<string, IntKind | undefined>();
    const bind = (name: ts.Identifier, kind: IntKind | undefined) => {
      if (kinds.has(name.text) && kinds.get(name.text) !== kind)
        throw compileError(name, `'${name.text}' is declared twice in this function with different types: give one of them another name`);
      kinds.set(name.text, kind);
    };
    fn.parameters.forEach((p, k) => {
      const kind = intKind(checker, p.type);
      if (ts.isIdentifier(p.name)) bind(p.name, kind);
      if (kind) ints.params.set(k, kind);
    });
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionLike(n)) return;  /* a nested function's are its own */
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        const kind = intKind(checker, n.type);
        bind(n.name, kind);
        if (kind) ints.locals.set(n.name.text, kind);
      }
      ts.forEachChild(n, visit);
    };
    if (fn.body) ts.forEachChild(fn.body, visit);
    if (ints.locals.size || ints.params.size || ints.returns) out.set(locKey(fn), ints);
  };
  const visit = (n: ts.Node): void => {
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.body) declare(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

interface Signature {
  types: Type[];
  views: (ViewKind | undefined)[];
}

/** The declared parameter types of a file's top-level functions, by where each starts: each a
 *  type static code takes, or an error. */
function declaredSignatures(checker: ts.TypeChecker, sf: ts.SourceFile, out: Map<string, Signature>) {
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name) continue;
    const types = st.parameters.map((p) => {
      const kind = intKind(checker, p.type);
      if (kind) return kind === "i64" ? STATIC_TYPES.int!.type : STATIC_TYPES.i32!.type;
      const type = checker.getTypeAtLocation(p);
      const t = irType(type);
      if (t === null) throw compileError(p, `parameter '${p.name.getText(sf)}' of '${st.name!.text}': ${checker.typeToString(type)} isn't a static type yet`);
      return t;
    });
    const views = st.parameters.map((p) => viewOf(checker.getTypeAtLocation(p).getSymbol()?.name ?? ""));
    out.set(locKey(st), { types, views });
  }
}

/** tsc's primitive types (and their literals), by the name STATIC_TYPES knows them by. */
const PRIMITIVE_FLAGS: [ts.TypeFlags, string][] = [
  [ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral, "number"],
  [ts.TypeFlags.String | ts.TypeFlags.StringLiteral, "string"],
  [ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral, "boolean"],
  [ts.TypeFlags.Undefined, "undefined"],
  [ts.TypeFlags.Null, "null"],
];

/** A TypeScript type as the IR's, if static code takes it. */
function irType(t: ts.Type): Type | null {
  if (t.isUnion()) {
    let u: Type = T.None;
    for (const part of t.types) {
      const p = irType(part);
      if (p === null) return null;
      u |= p;
    }
    return u;
  }
  const name = PRIMITIVE_FLAGS.find(([flags]) => t.flags & flags)?.[1];
  if (name) return STATIC_TYPES[name]!.type;
  return viewOf(t.getSymbol()?.name ?? "") ? T.Object : null;
}

type Block = FunctionIR["blocks"][number];

/** Makes conversions in fn: v as an integer of `type` (to_i32, to_i64), inserted at position `at`
 *  of block b. */
function converter(fn: FunctionIR) {
  let next = 1 + Math.max(0, ...fn.params.map((p) => p.id), ...fn.blocks.flatMap((b) => [...b.phis, ...b.instrs].map((i) => i.id)));
  return (b: Block, v: Instr, at: number, type: IntKind): Instr => {
    const w: Instr = { id: next++, op: type === "i32" ? "to_i32" : "to_i64", operands: [v], type: T.None, repr: "boxed", mayThrow: false, block: b, loc: null, ...(v.name ? { name: v.name } : {}) };
    b.instrs.splice(at, 0, w);
    return w;
  };
}

/** Every use of a replaced value in fn takes its replacement, but the instructions in `keep`. */
function replaceUses(fn: FunctionIR, replaced: Map<Instr, Instr>, keep = new Set<Instr>()) {
  const swap = (v: Instr) => replaced.get(v) ?? v;
  for (const b of fn.blocks) {
    for (const phi of b.phis) for (const inc of phi.incoming!) inc.value = swap(inc.value);
    for (const i of b.instrs) if (!keep.has(i)) i.operands = i.operands.map(swap);
    const term = b.term;
    if (term?.kind === "branch") term.cond = swap(term.cond);
    else if (term?.kind === "return" || term?.kind === "throw") term.value = swap(term.value);
  }
}

/** C semantics for the integers: what a function stores in one (a local, a parameter on entry, a
 *  return value) is converted to it (specialize and the int64 arithmetic make what feeds it C's). */
function convertInts(fn: FunctionIR, ints: Ints) {
  const convert = converter(fn);
  const replaced = new Map<Instr, Instr>();
  for (const b of fn.blocks)
    for (const i of [...b.instrs]) {
      const type = i.name ? ints.locals.get(i.name) : undefined;
      if (!type || i.op === "param" || i.op === "empty" || !OPS[i.op].result) continue;  /* empty: a `let` before its declaration */
      const at = b.instrs.indexOf(i);
      if (b.handler && i.mayThrow && at === b.instrs.length - 1) continue;  /* it ends a protected block: left as it is */
      replaced.set(i, convert(b, i, at + 1, type));
    }
  /* an int parameter, on entry: whoever called (any Number is taken; an i32's is checked) */
  const hidden = fn.params.length - ints.paramCount;
  const entry = fn.blocks[0]!;
  let at = entry.instrs.findIndex((i) => i.op !== "param");
  for (const [k, type] of ints.params) {
    if (type === "i32") continue;
    const p = fn.params[hidden + k]!;
    const w = convert(entry, p, at < 0 ? entry.instrs.length : at, type);
    replaced.set(p, w);
    at = entry.instrs.indexOf(w) + 1;
  }
  if (ints.returns)
    for (const b of fn.blocks)
      if (b.term?.kind === "return") b.term.value = convert(b, b.term.value, b.instrs.length, ints.returns);
  replaceUses(fn, replaced, new Set(replaced.values()));
}

/** A function's name in C, as the emitter makes it (its ident). */
function ident(name: string): string {
  let out = "";
  for (const ch of name) out += /[A-Za-z0-9_]/.test(ch) ? ch : `_u${ch.codePointAt(0)!.toString(16)}_`;
  return out;
}

/** Compiles the typed files as one unit. */
export function buildTypedUnit(files: readonly string[], primitives: HostPrimitives): TypedUnit {
  const program = ts.createProgram([...files, TYPES_FILE], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, skipLibCheck: true,
  });
  checkSubset(program, files);  /* first: its errors say what static code can't do, tsc's what the types don't allow */
  const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error && files.includes(d.file?.fileName ?? ""));
  if (errors.length) throw new Error(ts.formatDiagnostics(errors, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }));
  const checker = program.getTypeChecker();
  const ints = new Map<string, Ints>();
  const signatures = new Map<string, Signature>();
  for (const file of files) {
    const sf = program.getSourceFile(file)!;
    intDeclarations(checker, sf, ints);
    declaredSignatures(checker, sf, signatures);
  }
  const { ast, exports: exported } = linkUnit(program, files, primitives);

  const ir = lower(ast, analyze(ast));
  for (const fn of [ir.main, ...ir.functions]) fn.dialect = "static";
  const at = (fn: FunctionIR) => (fn.loc ? `${fn.loc.file}:${fn.loc.line}:${fn.loc.column}` : "");
  for (const fn of ir.functions) {
    const meta = fn.meta!;
    const fnInts = ints.get(at(fn));
    if (fnInts) convertInts(fn, fnInts);
    const sig = signatures.get(at(fn));
    if (!sig) continue;
    const hidden = fn.params.length - sig.types.length;
    meta.declared = fn.params.map((_, k) => (k < hidden ? undefined : sig.types[k - hidden]));
    meta.declaredViews = fn.params.map((_, k) => (k < hidden ? undefined : sig.views[k - hidden]));
    meta.external = true;
  }
  /* a call of a function with integer parameters: C's implicit conversion of each argument to the
     parameter's type, so that (n - 1) passes as an int and the call takes the typed entry */
  const byName = new Map(ir.functions.map((f) => [f.name, f]));
  for (const fn of ir.functions) {
    const convert = converter(fn);
    for (const b of fn.blocks)
      for (const i of [...b.instrs]) {
        const callee = i.op === "call_direct" ? byName.get(i.target!) : undefined;
        const calleeInts = callee ? ints.get(at(callee)) : undefined;
        if (!callee || !calleeInts?.params.size) continue;
        const hidden = callee.params.length - calleeInts.paramCount;
        for (const [k, type] of calleeInts.params) {
          const arg = i.operands[hidden + k];
          if (arg) i.operands[hidden + k] = convert(b, arg, b.instrs.indexOf(i), type);  /* fewer arguments: undefined */
        }
      }
  }
  const exports: Record<string, { c: string; length: number }> = {};
  const exportedFns = new Map<string, string>();
  for (const [name, loc] of exported) {
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

/** The program's calls of typed exports: a call whose callee is the export's host import (the
 *  host function, or the module binding one store sets to it). Before optimizing. */
export function annotateTypedCalls(m: ModuleIR, calls: Record<string, TypedCall>) {
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
  for (const fn of all)
    for (const b of fn.blocks)
      for (const i of b.instrs) {
        const name = i.op === "call" ? target(i.operands[0]!) : undefined;
        if (name) i.typedCall = calls[name]!;
      }
}
