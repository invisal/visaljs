// What static code may contain: an allowlist. Anything else is a compile error at its location,
// never a silent fallback to JavaScript's semantics. Growing the subset means adding to these
// lists, with a test in tests/static/.
import { resolve } from "node:path";

import { HOST_MODULE } from "@visaljs/compiler";
import ts from "typescript";

import { compileError, importedFile, isUnitClass } from "./link.ts";
import { BRAND } from "./nominal.ts";
import { intKind } from "./types.ts";

const K = ts.SyntaxKind;

const STATEMENTS = new Set<ts.SyntaxKind>([
  K.FunctionDeclaration, K.VariableStatement, K.VariableDeclarationList, K.VariableDeclaration, K.Block, K.IfStatement,
  K.ForStatement, K.ForOfStatement, K.WhileStatement, K.DoStatement, K.ReturnStatement, K.BreakStatement, K.ContinueStatement,
  K.ExpressionStatement, K.SwitchStatement, K.CaseBlock, K.CaseClause, K.DefaultClause, K.ThrowStatement, K.TryStatement,
  K.CatchClause, K.EmptyStatement, K.LabeledStatement, K.TypeAliasDeclaration, K.InterfaceDeclaration,
]);

const EXPRESSIONS = new Set<ts.SyntaxKind>([
  K.Identifier, K.NumericLiteral, K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateExpression, K.TemplateHead,
  K.TemplateMiddle, K.TemplateTail, K.TemplateSpan, K.TrueKeyword, K.FalseKeyword, K.NullKeyword, K.BinaryExpression,
  K.PrefixUnaryExpression, K.PostfixUnaryExpression, K.ConditionalExpression, K.CallExpression, K.NewExpression,
  K.PropertyAccessExpression, K.ElementAccessExpression, K.ArrayLiteralExpression, K.ObjectLiteralExpression,
  K.PropertyAssignment, K.ShorthandPropertyAssignment, K.ParenthesizedExpression, K.ArrowFunction, K.FunctionExpression,
  K.TypeOfExpression, K.NonNullExpression, K.AsExpression, K.SatisfiesExpression, K.Parameter,
]);

/** What isn't allowed yet, in words, for the error. */
const NAMED: Partial<Record<ts.SyntaxKind, string>> = {
  [K.ClassExpression]: "class expressions", [K.SuperKeyword]: "`super`",
  [K.EnumDeclaration]: "enums", [K.ModuleDeclaration]: "namespaces", [K.Decorator]: "decorators",
  [K.YieldExpression]: "generators", [K.AwaitExpression]: "async functions", [K.DeleteExpression]: "`delete`",
  [K.ForInStatement]: "for…in", [K.SpreadElement]: "spread", [K.SpreadAssignment]: "spread",
  [K.ObjectBindingPattern]: "destructuring", [K.ArrayBindingPattern]: "destructuring",
  [K.TaggedTemplateExpression]: "tagged templates", [K.RegularExpressionLiteral]: "regular expressions",
  [K.BigIntLiteral]: "BigInt", [K.VoidExpression]: "`void`", [K.MetaProperty]: "import.meta and new.target",
  [K.ImportKeyword]: "import()", [K.MethodDeclaration]: "methods", [K.GetAccessor]: "getters", [K.SetAccessor]: "setters",
  [K.WithStatement]: "`with`", [K.DebuggerStatement]: "`debugger`", [K.ExportAssignment]: "default exports",
};

/** A module's top level: declarations only (top-level code runs, in an order across files). */
const TOP_LEVEL = new Set<ts.SyntaxKind>([
  K.FunctionDeclaration, K.VariableStatement, K.TypeAliasDeclaration, K.InterfaceDeclaration, K.ImportDeclaration, K.ExportDeclaration, K.EmptyStatement,
  K.ClassDeclaration,
]);

/** What a class member may say of itself: no `static`, `declare`, `abstract`, `async`. */
const MEMBER_MODIFIERS = new Set<ts.SyntaxKind>([K.PublicKeyword, K.PrivateKeyword, K.ProtectedKeyword, K.ReadonlyKeyword]);

const notYet = (what: string) => `static code doesn't have ${what} yet`;

/** Checks the unit's files against the subset; throws the first error. */
export function checkSubset(program: ts.Program, files: readonly string[]) {
  const checker = program.getTypeChecker();
  const fileSet = new Set(files.map((f) => resolve(f)));
  for (const file of files) {
    const sf = program.getSourceFile(file)!;
    sf.statements.forEach((st, k) => {
      if (k === 0 && ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression)) return;  /* "use static" */
      if (NAMED[st.kind]) throw compileError(st, notYet(NAMED[st.kind]!));
      if (!TOP_LEVEL.has(st.kind)) throw compileError(st, "a static file only declares: top-level statements would run code, in no order across files");
      if (ts.isImportDeclaration(st)) return checkImport(checker, st, fileSet);
      if (ts.isExportDeclaration(st)) {
        if (st.moduleSpecifier) throw compileError(st, notYet("re-exports (export … from)"));
        return;
      }
      if (ts.isClassDeclaration(st)) return checkClass(checker, st);
      visit(st, checker);
    });
  }
}

function checkImport(checker: ts.TypeChecker, st: ts.ImportDeclaration, files: ReadonlySet<string>) {
  const specifier = (st.moduleSpecifier as ts.StringLiteral).text;
  if (specifier === HOST_MODULE || specifier === "visaljs" || importedFile(checker, st, files)) {
    if (st.importClause?.name || (st.importClause?.namedBindings && ts.isNamespaceImport(st.importClause.namedBindings)))
      throw compileError(st, notYet("default and namespace imports"));
    return;
  }
  throw compileError(st.moduleSpecifier, `static code imports only static files, "visaljs" and ${HOST_MODULE}: '${specifier}' isn't one`);
}

/** A class: fields, a constructor and methods. The unit's files may export it to each other;
 *  the program sees only exported functions, whose types don't reach an instance (link.ts). */
function checkClass(checker: ts.TypeChecker, c: ts.ClassDeclaration) {
  const decorator = ts.getDecorators(c)?.[0];
  if (decorator) throw compileError(decorator, notYet("decorators"));
  const modifier = ts.getModifiers(c)?.find((m) => m.kind !== K.ExportKeyword);
  if (modifier) throw compileError(modifier, notYet(`${modifier.getText()} classes`));
  for (const h of c.heritageClauses ?? []) {
    if (h.token === K.ExtendsKeyword) throw compileError(h, notYet("`extends`"));
    visitType(h);
  }
  for (const m of c.members) {
    if (ts.isSemicolonClassElement(m)) continue;
    const modifier = ts.canHaveModifiers(m) ? ts.getModifiers(m)?.find((x) => !MEMBER_MODIFIERS.has(x.kind)) : undefined;
    if (modifier) throw compileError(modifier, notYet(`${modifier.getText()} members`));
    if (ts.isConstructorDeclaration(m) || ts.isMethodDeclaration(m)) {
      if (!m.body) throw compileError(m, notYet("overloads"));
      if (m.asteriskToken) throw compileError(m, notYet("generators and async functions"));
      const property = ts.isConstructorDeclaration(m) ? m.parameters.find((p) => ts.getModifiers(p)?.length) : undefined;
      if (property) throw compileError(property, "a parameter property isn't JavaScript (Node's type stripping rejects it): declare the field");
    }
    if (ts.isMethodDeclaration(m) && intKind(checker, m.type))
      throw compileError(m.type!, `${notYet("methods that return an int or i32")}: return a number`);
    if (ts.isPropertyDeclaration(m) && intKind(checker, m.type))
      throw compileError(m.type!, `${notYet("int or i32 fields")}: declare a number`);
    if ((ts.isPropertyDeclaration(m) || ts.isMethodDeclaration(m)) && !ts.isIdentifier(m.name))
      throw compileError(m.name, notYet("member names other than identifiers"));
    if (ts.isPropertyDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isMethodDeclaration(m)) ts.forEachChild(m, (n) => visit(n, checker));
    else visit(m, checker);
  }
}

/** Where `this` is the class's instance: its constructor's, a method's, a field initializer's (arrows see their parent's). */
function inClassMember(node: ts.Node): boolean {
  let at = node.parent;
  while (!ts.isSourceFile(at) && !ts.isPropertyDeclaration(at) && !(ts.isFunctionLike(at) && !ts.isArrowFunction(at))) at = at.parent;
  return (ts.isConstructorDeclaration(at) || ts.isMethodDeclaration(at) || ts.isPropertyDeclaration(at)) && ts.isClassDeclaration(at.parent);
}

/** Whether a type is one of the unit's classes, or has one in a union. */
function namesClass(t: ts.Type): boolean {
  return (t.isUnion() ? t.types : [t]).some(isUnitClass);
}

/** A type: anything tsc takes but `any`. */
function visitType(node: ts.Node): void {
  if (node.kind === K.AnyKeyword) throw compileError(node, "`any` isn't a static type: name the type");
  ts.forEachChild(node, visitType);
}

function visit(node: ts.Node, checker: ts.TypeChecker): void {
  if (ts.isTypeNode(node)) return visitType(node);
  if (node.kind === K.ThisKeyword) {
    if (inClassMember(node)) return;
    throw compileError(node, "static code has `this` only in a class's constructor, methods and field initializers");
  }
  if (ts.isClassDeclaration(node)) throw compileError(node, "a static file declares its classes at its top level");
  if (ts.isIdentifier(node) && node.text === BRAND) throw compileError(node, `'${BRAND}' is static code's own name`);
  if (ts.isAsExpression(node) && namesClass(checker.getTypeAtLocation(node.type))
      && !checker.isTypeAssignableTo(checker.getTypeAtLocation(node.expression), checker.getTypeAtLocation(node.type)))
    throw compileError(node, `a cast doesn't make a ${node.type.getText()}: static code's classes are nominal, only \`new\` makes one`);
  if (NAMED[node.kind]) throw compileError(node, notYet(NAMED[node.kind]!));  /* before tokens: regular expressions are tokens */
  if (ts.isToken(node) || ts.isModifier(node) || ts.isTypeParameterDeclaration(node)) return;
  if (ts.isFunctionLike(node) && ((node as ts.FunctionLikeDeclaration).asteriskToken || ts.getModifiers(node as ts.FunctionDeclaration)?.some((m) => m.kind === K.AsyncKeyword)))
    throw compileError(node, notYet("generators and async functions"));
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return visitType(node);
  if (!STATEMENTS.has(node.kind) && !EXPRESSIONS.has(node.kind)) throw compileError(node, notYet(ts.SyntaxKind[node.kind]));
  ts.forEachChild(node, (n) => visit(n, checker));
}
