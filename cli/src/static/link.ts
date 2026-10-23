// The static unit's files as one module, linked by tsc's checker instead of a bundler: a bundler
// folds constants with JavaScript's arithmetic (1 / 4 * 4 to 1, where static code's integer
// division gives 0) and loses each declaration's type. A name resolves to its declaration by
// symbol; a top-level name declared in more than one file is renamed in all but the first.
import { normalize, relative, resolve } from "node:path";

import { CompileError, convertStaticUnit, HOST_MODULE, type HostPrimitives, type StaticUnitSource } from "@visaljs/compiler";
import type * as A from "@visaljs/compiler/ast";
import ts from "typescript";

import { arrayElement, fieldOf, intKind } from "./types.ts";

export interface LinkedUnit {
  ast: A.Program;
  /** Each export's function, by export name: where its declaration starts (file:line:column). */
  exports: Map<string, string>;
}

/** A file's name in locations, as the program's: relative to the working directory. */
export function fileName(sf: ts.SourceFile): string {
  return normalize(relative(process.cwd(), sf.fileName));
}

/** A node's position as the adapter writes a location: the key that finds its IR function. */
export function locKey(node: ts.Node): string {
  const sf = node.getSourceFile();
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${fileName(sf)}:${line + 1}:${character + 1}`;
}

export function compileError(node: ts.Node, detail: string): CompileError {
  const sf = node.getSourceFile();
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return new CompileError("SyntaxError", detail, { file: fileName(sf), line: line + 1, column: character + 1 });
}

/** The file an import names, when it is one of the unit's. */
export function importedFile(checker: ts.TypeChecker, node: ts.ImportDeclaration | ts.ExportDeclaration, files: ReadonlySet<string>): string | undefined {
  const symbol = node.moduleSpecifier ? checker.getSymbolAtLocation(node.moduleSpecifier) : undefined;
  const file = symbol?.valueDeclaration && ts.isSourceFile(symbol.valueDeclaration) ? resolve(symbol.valueDeclaration.fileName) : undefined;
  return file && files.has(file) ? file : undefined;
}

/** The names a file's top level declares, with their symbols. */
function topLevel(checker: ts.TypeChecker, sf: ts.SourceFile): Map<string, ts.Symbol> {
  const out = new Map<string, ts.Symbol>();
  const add = (name: ts.Identifier) => {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) out.set(name.text, symbol);
  };
  const addBinding = (b: ts.BindingName): void => {
    if (ts.isIdentifier(b)) add(b);
    else for (const e of b.elements) if (!ts.isOmittedExpression(e)) addBinding(e.name);
  };
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) add(st.name);
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) addBinding(d.name);
    else if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === HOST_MODULE) {
      const bindings = st.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) add(e.name);
    }
  }
  return out;
}

/** The files in dependency order (an imported file before its importers); a cycle is an error. */
function ordered(checker: ts.TypeChecker, sources: readonly ts.SourceFile[], files: ReadonlySet<string>): ts.SourceFile[] {
  const byFile = new Map(sources.map((sf) => [resolve(sf.fileName), sf]));
  const out: ts.SourceFile[] = [];
  const state = new Map<ts.SourceFile, "visiting" | "done">();
  const visit = (sf: ts.SourceFile, from: ts.Node | undefined): void => {
    if (state.get(sf) === "done") return;
    if (state.get(sf) === "visiting") throw compileError(from!, `static files import each other in a cycle (${sf.fileName}): their top levels would run in no order`);
    state.set(sf, "visiting");
    for (const st of sf.statements)
      if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) {
        const file = importedFile(checker, st, files);
        if (file) visit(byFile.get(file)!, st);
      }
    state.set(sf, "done");
    out.push(sf);
  };
  for (const sf of sources) visit(sf, undefined);
  return out;
}

/** Links the unit's files (checked by tsc, and by the subset). */
export function linkUnit(program: ts.Program, files: readonly string[], hostPrimitives: HostPrimitives): LinkedUnit {
  const checker = program.getTypeChecker();
  const fileSet = new Set(files.map((f) => resolve(f)));
  const sources = ordered(checker, files.map((f) => program.getSourceFile(f)!), fileSet);

  /* a name declared by more than one file: renamed in every file after the first */
  const renamed = new Map<ts.Symbol, string>();
  const seen = new Set<string>();
  sources.forEach((sf, k) => {
    for (const [name, symbol] of topLevel(checker, sf)) {
      if (seen.has(name)) renamed.set(symbol, `${name}$${k}`);
      seen.add(name);
    }
  });
  const declarationOf = (id: ts.Identifier): ts.Symbol | undefined => {
    const symbol = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
      ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
    if (!symbol) return undefined;
    if (renamed.has(symbol) || !(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
    return checker.getAliasedSymbol(symbol);
  };
  const unit: StaticUnitSource = {
    files: sources,
    rename: (id) => {
      const symbol = declarationOf(id);
      return symbol ? renamed.get(symbol) : undefined;
    },
    linked: (node) => importedFile(checker, node, fileSet) !== undefined,
    fileName,
    intKind: (type) => intKind(checker, type),
    arrayElement: (node) => arrayElement(checker, node),
    field: (node) => fieldOf(checker, node),
  };

  /* the exports: a function declaration, by its export name (unique across the unit) */
  const exports = new Map<string, string>();
  const exportedFrom = new Map<string, string>();
  const exportFunction = (name: string, at: ts.Node, declaration: ts.Node | undefined) => {
    if (exportedFrom.has(name)) throw compileError(at, `typed unit: '${name}' is exported by ${exportedFrom.get(name)} and ${at.getSourceFile().fileName}`);
    if (Object.hasOwn(hostPrimitives, name)) throw compileError(at, `typed unit: export '${name}' is a host primitive's name`);
    if (!declaration || !ts.isFunctionDeclaration(declaration))
      throw compileError(at, `typed unit: export '${name}' is not a function declaration whose parameters are all number, string or boolean`);
    for (const p of declaration.parameters) {
      const type = checker.getTypeAtLocation(p);
      const cls = classIn(checker, type, new Set());
      if (cls) throw compileError(p, `export '${name}' takes ${checker.typeToString(type)}: static code's ${cls} instances stay in the unit yet`);
    }
    const returns = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(declaration)!);
    const cls = classIn(checker, returns, new Set());
    if (cls) throw compileError(declaration.type ?? at, `export '${name}' returns ${checker.typeToString(returns)}: static code's ${cls} instances stay in the unit yet`);
    exportedFrom.set(name, at.getSourceFile().fileName);
    exports.set(name, locKey(declaration));
  };
  for (const sf of sources)
    for (const { name, at } of exportsOf(sf)) {
      const declaration = ts.isExportSpecifier(at) ? checker.getExportSpecifierLocalTargetSymbol(at)?.valueDeclaration
        : ts.isFunctionDeclaration(at.parent) ? at.parent : undefined;
      exportFunction(name, at, declaration);
    }
  return { ast: convertStaticUnit(unit, hostPrimitives), exports };
}

/** Whether a type is a class's instance, a class a static file declares. */
export function isUnitClass(t: ts.Type): boolean {
  const symbol = t.getSymbol();
  return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Class) !== 0
    && symbol.declarations!.some((d) => ts.isClassDeclaration(d) && !d.getSourceFile().isDeclarationFile);
}

/** A class of the unit a value of type `t` can hold or reach (its properties, elements, what
 *  its functions return), by name. */
export function classIn(checker: ts.TypeChecker, t: ts.Type, seen: Set<ts.Type>): string | undefined {
  if (seen.has(t)) return undefined;
  seen.add(t);
  if (t.isUnionOrIntersection()) return t.types.map((p) => classIn(checker, p, seen)).find((c) => c);
  if (isUnitClass(t)) return t.getSymbol()!.name;
  if (!(t.flags & ts.TypeFlags.Object)) return undefined;
  /* a library's types (Array's methods) only through their type arguments: walking their members
   * meets a new instantiation at every step */
  const own = t.getSymbol()?.declarations?.some((d) => !d.getSourceFile().isDeclarationFile) ?? false;
  const reached = [
    ...((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(t as ts.TypeReference) : []),
    ...(own ? checker.getPropertiesOfType(t).map((p) => checker.getTypeOfSymbol(p)) : []),
    ...(own ? t.getCallSignatures().map((sig) => sig.getReturnType()) : []),
  ];
  return reached.map((r) => classIn(checker, r, seen)).find((c) => c);
}

/** A static file's exported values, by name: where each is named (a function's name, a
 *  variable's declaration, an export specifier). Read from the syntax alone, for the program's
 *  bundle too (boundary.ts). */
export function exportsOf(sf: ts.SourceFile): { name: string; at: ts.Node }[] {
  const out: { name: string; at: ts.Node }[] = [];
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && ts.isFunctionDeclaration(st) && st.name) out.push({ name: st.name.text, at: st.name });
    else if (exported && ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations) out.push({ name: d.name.getText(sf), at: d });
    else if (ts.isExportDeclaration(st) && !st.isTypeOnly && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause))
      for (const spec of st.exportClause.elements) if (!spec.isTypeOnly) out.push({ name: spec.name.text, at: spec });
  }
  return out;
}
