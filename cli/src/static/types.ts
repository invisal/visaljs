// Static code's types as tsc's checker sees them: the integers "visaljs" declares (erased to
// number by tsc, so known by symbol), and the parameter types its checked entries test.
import { resolve } from "node:path";

import { type IntKind, STATIC_TYPES, T, type Type, viewOf, type ViewKind } from "@visaljs/ir";
import ts from "typescript";

import { compileError, locKey } from "./link.ts";

export const TYPES_FILE = resolve(import.meta.dirname, "..", "..", "types", "visaljs.d.ts");

/** The integer a type annotation names: "visaljs"'s `int` or `i32`, through imports and aliases. */
export function intKind(checker: ts.TypeChecker, node: ts.TypeNode | undefined): IntKind | undefined {
  if (!node || !ts.isTypeReferenceNode(node)) return undefined;
  let symbol = checker.getSymbolAtLocation(node.typeName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  if (!symbol || !declaration || !ts.isTypeAliasDeclaration(declaration)) return undefined;
  if (resolve(declaration.getSourceFile().fileName) !== TYPES_FILE) return intKind(checker, declaration.type);
  return Object.hasOwn(STATIC_TYPES, symbol.name) ? STATIC_TYPES[symbol.name]!.int : undefined;
}

export interface Signature {
  types: Type[];
  views: (ViewKind | undefined)[];
}

/** What a parameter of each integer takes: an int any Number (an int64_t, converted by the
 *  caller as C would); an i32 any Number too, converted to it on entry. */
const INT_PARAMETERS: Record<IntKind, Type> = { i64: STATIC_TYPES.int!.type, i32: STATIC_TYPES.number!.type };

/** The declared parameter types of a file's top-level functions, by where each starts: each a
 *  type static code takes, or an error. */
export function declaredSignatures(checker: ts.TypeChecker, sf: ts.SourceFile, out: Map<string, Signature>) {
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name) continue;
    const types = st.parameters.map((p) => {
      const kind = intKind(checker, p.type);
      if (kind) return INT_PARAMETERS[kind];
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
