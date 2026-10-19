// Static code's types as tsc's checker sees them: the integers "visaljs" declares (erased to
// number by tsc, so known by symbol), and the parameter types its checked entries test.
import { resolve } from "node:path";

import { type IntKind, STATIC_TYPES, T, type Type, viewOf, type ViewKind } from "@visaljs/ir";
import type { ElementKind } from "@visaljs/compiler/ast";
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
  /** the parameters that are arrays (the unit's own functions take them, its exports not yet) */
  arrays: ts.ParameterDeclaration[];
}

/** What a parameter of each integer takes: an int any Number (an int64_t, converted by the
 *  caller as C would); an i32 any Number too, converted to it on entry. */
const INT_PARAMETERS: Record<IntKind, Type> = { i64: STATIC_TYPES.int!.type, i32: STATIC_TYPES.number!.type };

/** The declared parameter types of a file's top-level functions, by where each starts: each a
 *  type static code takes, or an error. */
export function declaredSignatures(checker: ts.TypeChecker, sf: ts.SourceFile, out: Map<string, Signature>) {
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name) continue;
    const arrays: ts.ParameterDeclaration[] = [];
    const types = st.parameters.map((p) => {
      const kind = intKind(checker, p.type);
      if (kind) return INT_PARAMETERS[kind];
      const type = checker.getTypeAtLocation(p);
      if (checker.isArrayType(type)) {
        arrays.push(p);
        return T.Object;  /* its elements are checked as they are read */
      }
      const t = irType(type);
      if (t === null) throw compileError(p, `parameter '${p.name.getText(sf)}' of '${st.name!.text}': ${checker.typeToString(type)} isn't a static type yet`);
      return t;
    });
    const views = st.parameters.map((p) => viewOf(checker.getTypeAtLocation(p).getSymbol()?.name ?? ""));
    out.set(locKey(st), { types, views, arrays });
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

/** The primitive every part of a type is (its literals too), by the name an array's element kind has. */
function primitiveOf(t: ts.Type): "number" | "string" | "boolean" | undefined {
  const parts = t.isUnion() ? t.types : [t];
  for (const [flags, name] of [[ts.TypeFlags.NumberLike, "number"], [ts.TypeFlags.StringLike, "string"], [ts.TypeFlags.BooleanLike, "boolean"]] as const)
    if (parts.every((p) => p.flags & flags)) return name;
  return undefined;
}

/** The element type an array type annotation writes (T[], Array<T>, readonly T[], an alias of one). */
function elementNode(checker: ts.TypeChecker, node: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (!node) return undefined;
  if (ts.isArrayTypeNode(node)) return node.elementType;
  if (ts.isTypeOperatorNode(node) || ts.isParenthesizedTypeNode(node)) return elementNode(checker, node.type);
  if (!ts.isTypeReferenceNode(node)) return undefined;
  const name = node.typeName.getText();
  if ((name === "Array" || name === "ReadonlyArray") && node.typeArguments?.length === 1) return node.typeArguments[0];
  let symbol = checker.getSymbolAtLocation(node.typeName);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations?.[0];
  return declaration && ts.isTypeAliasDeclaration(declaration) ? elementNode(checker, declaration.type) : undefined;
}

/** The array type annotation an expression's value was declared with, if one says: a variable's
 *  or parameter's (or its initializer's), a call's declared return type, a cast's. */
function declaredArrayType(checker: ts.TypeChecker, node: ts.Expression): ts.TypeNode | undefined {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return declaredArrayType(checker, node.expression);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return node.type;
  if (ts.isCallExpression(node)) {
    const declaration = checker.getResolvedSignature(node)?.getDeclaration();
    return declaration && !ts.isJSDocSignature(declaration) ? declaration.type : undefined;
  }
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (!declaration || !(ts.isVariableDeclaration(declaration) || ts.isParameter(declaration))) return undefined;
  if (declaration.type) return declaration.type;
  return declaration.initializer ? declaredArrayType(checker, declaration.initializer) : undefined;
}

/** The element kind of the array `node` is, if it is one: number, i32 (the annotation names it:
 *  tsc erases it to number), string, boolean; an array of anything else is an error. */
export function arrayElement(checker: ts.TypeChecker, node: ts.Expression): ElementKind | undefined {
  const type = checker.getTypeAtLocation(node);
  if (!checker.isArrayType(type)) return undefined;
  const element = checker.getTypeArguments(type as ts.TypeReference)[0]!;
  const kind = primitiveOf(element);
  if (!kind) throw compileError(node, `static code doesn't have arrays of ${checker.typeToString(element)} yet`);
  if (kind !== "number") return kind;
  const int = intKind(checker, elementNode(checker, declaredArrayType(checker, node)));
  if (int === "i64") throw compileError(node, "static code doesn't have int[] yet: an i32[], or a number[]");
  return int ?? "number";
}
