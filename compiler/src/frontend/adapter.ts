// The front-end adapter: the only module that imports `typescript`.
// Parses JavaScript with the TypeScript compiler API and converts it to our AST.
import { normalize, resolve as resolvePath } from "node:path";

import ts from "typescript";

import type { IntKind } from "@visaljs/ir";
import type * as A from "./ast.ts";
import { boundNames } from "./ast.ts";
import { CompileError, type CompileErrorKind } from "./errors.ts";
import { COMMONJS_DIRECTIVE, HOST_MODULE, type HostPrimitives } from "./host.ts";
import type { SourceMap } from "./sourcemap.ts";

/** A construct the compiler doesn't handle yet: converted to an Unsupported node
 *  at the nearest statement or expression, so conversion (and later analysis)
 *  can go on and find the program's syntax errors, which take precedence. */
class Deferred {
  readonly detail: string;
  readonly node: ts.Node;
  constructor(detail: string, node: ts.Node) {
    this.detail = detail;
    this.node = node;
  }
}

/** The first construct that isn't supported yet, as the error to report once
 *  analysis has found no syntax error. */
export function firstUnsupported(program: A.Program): CompileError | null {
  const u = program.unsupported[0];
  return u ? new CompileError("NotSupported", u.detail, u.loc) : null;
}

/** Parses a classic script (`visaljs --script`). */
export function parseScript(text: string, file: string): A.Program {
  return parse(text, file, false);
}

/** Parses an ES module: the bundle, or one file with `--no-bundle`. */
/** Whether a template part has an escape that has no cooked value (only tagged templates allow it). */
function invalidEscape(part: ts.TemplateLiteralLikeNode): boolean {
  /* TokenFlags.ContainsInvalidEscape: internal to TypeScript, like parseDiagnostics */
  return (((part as unknown as { templateFlags?: number }).templateFlags ?? 0) & 2048) !== 0;
}

/** A template part's raw text (§12.9.6 TRV): the source between its delimiters, line terminators
 *  CR and CRLF as LF. */
function rawText(part: ts.TemplateLiteralLikeNode, sf: ts.SourceFile): string {
  const text = part.getText(sf);
  const open = 1;  /* ` or } */
  const close = ts.isNoSubstitutionTemplateLiteral(part) || part.kind === ts.SyntaxKind.TemplateTail ? 1 : 2;  /* ` or ${ */
  return text.slice(open, text.length - close).replace(/\r\n?/g, "\n");
}

/** Imports are bound before the module body runs: host imports go first. */
function hoistHostImports(body: A.Statement[]): A.Statement[] {
  const isHost = (s: A.Statement) => s.type === "VariableDeclaration" && s.declarations[0]?.init?.type === "HostFunction";
  return [...body.filter(isHost), ...body.filter((s) => !isHost(s))];
}

/** `map`: the bundler's source map. Locations then point at the original files (`file`, the
 *  bundle's own name, only where the bundler generated the code), and identifiers the bundler
 *  renamed keep their original name for function names. `hostPrimitives`: what
 *  "visaljs:host" exports (the host packages', from the driver). */
export function parseModule(text: string, file: string, map?: SourceMap, entry?: string, hostPrimitives: HostPrimitives = {}): A.Program {
  return parse(text, file, true, map, entry, hostPrimitives);
}

/** A static unit ("use static" TypeScript files, already checked by tsc) linked by its caller. */
export interface StaticUnitSource {
  /** in dependency order */
  files: readonly ts.SourceFile[];
  /** A name's name in the unit, where it differs (a top-level name declared in more than one file). */
  rename(id: ts.Identifier): string | undefined;
  /** An import the unit resolves itself (of another of its files): left out. */
  linked(node: ts.ImportDeclaration): boolean;
  /** A file's name in locations (as the program's are, relative to the working directory). */
  fileName(sf: ts.SourceFile): string;
  /** The integer a type names ("visaljs"'s int or i32, through aliases), if it names one. */
  intKind(type: ts.TypeNode | undefined): IntKind | undefined;
}

/** A static unit as one module: its types ignored, its files' top levels one after another.
 *  Its functions can't be printed (Function.prototype.toString): their source is in many files. */
export function convertStaticUnit(unit: StaticUnitSource, hostPrimitives: HostPrimitives): A.Program {
  const programs = unit.files.map((sf) => new Converter(sf, true, undefined, resolvePath(sf.fileName), hostPrimitives, unit).program());
  return {
    ...programs[0]!,
    static: true,
    body: hoistHostImports(programs.flatMap((p) => p.body)),
    exportedNames: programs.flatMap((p) => p.exportedNames),
    source: "",
    unsupported: programs.flatMap((p) => p.unsupported),
  };
}

function parse(text: string, file: string, module: boolean, map?: SourceMap, entry?: string, hostPrimitives: HostPrimitives = {}): A.Program {
  /* the goal symbol is ours to choose: the parser then treats `await` at top level (and
   * import/export) as a module's, or not at all */
  const setExternalModuleIndicator = (s: ts.SourceFile) => {
    (s as unknown as { externalModuleIndicator: unknown }).externalModuleIndicator = module ? s : undefined;
  };
  const sf = ts.createSourceFile(file, text, { languageVersion: ts.ScriptTarget.Latest, setExternalModuleIndicator }, false, ts.ScriptKind.JS);
  // Syntax errors: parseDiagnostics isn't in the public typings, but it is how the
  // parser reports them. Keeping that knowledge here is what the adapter is for.
  const diagnostics = (sf as unknown as { parseDiagnostics: ts.DiagnosticWithLocation[] }).parseDiagnostics
    .filter((d) => d.code !== PRIVATE_IN_OPTIONAL_CHAIN);
  if (diagnostics.length) {
    const d = diagnostics[0]!;
    throw new CompileError("SyntaxError", ts.flattenDiagnosticMessageText(d.messageText, "\n"), locAt(sf, d.start, map));
  }
  return new Converter(sf, module, map, resolvePath(entry ?? file), hostPrimitives).program();
}

function locAt(sf: ts.SourceFile, pos: number, map: SourceMap | undefined, file = normalize(sf.fileName)): A.Loc {
  const { line, character } = sf.getLineAndCharacterOfPosition(pos);
  const loc = { file, line: line + 1, column: character + 1 };  /* TypeScript's / as \ on Windows */
  return map?.original(loc.line, loc.column) ?? loc;
}

/** A numeric literal written as a floating-point one (1.0, 1e3): a double to static code, as in C. */
function isFloatWritten(raw: string): boolean {
  return /[.eE]/.test(raw) && !/^0[xXbBoO]/.test(raw);
}

/** `import type …`, or an import of types only (`import { type a }`). */
function typeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause || clause.isTypeOnly) return clause !== undefined;
  const bindings = clause.namedBindings;
  return !clause.name && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.every((e) => e.isTypeOnly);
}

/** TypeScript rejects `a?.#x` (still parsed as usual); ES2022 allows it. */
const PRIVATE_IN_OPTIONAL_CHAIN = 18030;

/** Readable names for constructs the compiler doesn't handle. */
const LATER: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.SuperKeyword]: "`super`",
  [ts.SyntaxKind.PropertyDeclaration]: "class fields",
  [ts.SyntaxKind.ClassStaticBlockDeclaration]: "class static blocks",
  [ts.SyntaxKind.WithStatement]: "`with`",
  [ts.SyntaxKind.SpreadElement]: "spread",
  [ts.SyntaxKind.GetAccessor]: "getters in object literals",
  [ts.SyntaxKind.SetAccessor]: "setters in object literals",
  [ts.SyntaxKind.PrivateIdentifier]: "private names",
};

const BINARY: Partial<Record<ts.SyntaxKind, A.BinaryOperator>> = {
  [ts.SyntaxKind.PlusToken]: "+",
  [ts.SyntaxKind.MinusToken]: "-",
  [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.SlashToken]: "/",
  [ts.SyntaxKind.PercentToken]: "%",
  [ts.SyntaxKind.AsteriskAsteriskToken]: "**",
  [ts.SyntaxKind.LessThanLessThanToken]: "<<",
  [ts.SyntaxKind.GreaterThanGreaterThanToken]: ">>",
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: ">>>",
  [ts.SyntaxKind.AmpersandToken]: "&",
  [ts.SyntaxKind.BarToken]: "|",
  [ts.SyntaxKind.CaretToken]: "^",
  [ts.SyntaxKind.EqualsEqualsToken]: "==",
  [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.LessThanToken]: "<",
  [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.GreaterThanToken]: ">",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.InKeyword]: "in",
  [ts.SyntaxKind.InstanceOfKeyword]: "instanceof",
};

const LOGICAL: Partial<Record<ts.SyntaxKind, "&&" | "||" | "??">> = {
  [ts.SyntaxKind.AmpersandAmpersandToken]: "&&",
  [ts.SyntaxKind.BarBarToken]: "||",
  [ts.SyntaxKind.QuestionQuestionToken]: "??",
};

const ASSIGNMENT: Partial<Record<ts.SyntaxKind, A.AssignmentOperator>> = {
  [ts.SyntaxKind.EqualsToken]: "=",
  [ts.SyntaxKind.PlusEqualsToken]: "+=",
  [ts.SyntaxKind.MinusEqualsToken]: "-=",
  [ts.SyntaxKind.AsteriskEqualsToken]: "*=",
  [ts.SyntaxKind.SlashEqualsToken]: "/=",
  [ts.SyntaxKind.PercentEqualsToken]: "%=",
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken]: "**=",
  [ts.SyntaxKind.LessThanLessThanEqualsToken]: "<<=",
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ">>=",
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: ">>>=",
  [ts.SyntaxKind.AmpersandEqualsToken]: "&=",
  [ts.SyntaxKind.BarEqualsToken]: "|=",
  [ts.SyntaxKind.CaretEqualsToken]: "^=",
  [ts.SyntaxKind.AmpersandAmpersandEqualsToken]: "&&=",
  [ts.SyntaxKind.BarBarEqualsToken]: "||=",
  [ts.SyntaxKind.QuestionQuestionEqualsToken]: "??=",
};

class Converter {
  private readonly sf: ts.SourceFile;
  private readonly module: boolean;
  private readonly unsupportedList: A.Program["unsupported"] = [];
  private readonly exportedNames: A.Program["exportedNames"] = [];
  /** Converting a module's `export [default] declaration`: those modifiers are allowed. */
  private exporting = false;
  private readonly map: SourceMap | undefined;
  private readonly entry: string;
  private readonly hostPrimitives: HostPrimitives;
  /** Converting a static unit's TypeScript: types are skipped, not errors. */
  private readonly unit: StaticUnitSource | undefined;

  constructor(sf: ts.SourceFile, module: boolean, map: SourceMap | undefined, entry: string, hostPrimitives: HostPrimitives, unit?: StaticUnitSource) {
    this.sf = sf;
    this.module = module;
    this.map = map;
    this.entry = entry;
    this.hostPrimitives = hostPrimitives;
    this.unit = unit;
  }

  /** The absolute path of the original file `node` comes from (for import.meta and import()). */
  private originalFile(node: ts.Node): string {
    const { line, character } = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf));
    return this.map?.originalSource(line + 1, character + 1) ?? resolvePath(this.sf.fileName);
  }

  private loc(node: ts.Node): A.Loc {
    return locAt(this.sf, node.getStart(this.sf), this.map, this.unit?.fileName(this.sf));
  }

  private fail(kind: CompileErrorKind, detail: string, node: ts.Node): never {
    if (kind === "NotSupported") throw new Deferred(detail, node);
    throw new CompileError(kind, detail, this.loc(node));
  }

  private unsupported(node: ts.Node): never {
    this.fail("NotSupported", LATER[node.kind] ?? ts.SyntaxKind[node.kind], node);
  }

  /** Converts with `convert`, turning a Deferred into an Unsupported node. */
  private orUnsupported<T>(node: ts.Node, convert: () => T): T | A.Unsupported {
    try {
      return convert();
    } catch (e) {
      if (!(e instanceof Deferred)) throw e;
      const loc = this.loc(e.node);
      this.unsupportedList.push({ detail: e.detail, loc });
      return { type: "Unsupported", loc: this.loc(node), detail: e.detail };
    }
  }

  /** TypeScript-only syntax the parser accepts in .js files: a JS syntax error. */
  private noTypes(node: ts.Node & { type?: ts.Node | undefined; typeParameters?: unknown; typeArguments?: unknown }) {
    if (this.unit) return;
    if (node.type) this.fail("SyntaxError", "type annotations are TypeScript, not JavaScript", node.type);
    if (node.typeParameters || node.typeArguments) this.fail("SyntaxError", "type arguments are TypeScript, not JavaScript", node);
  }

  /** "use strict" as the first directives of a body (only exact, unescaped text counts). */
  private hasUseStrict(statements: readonly ts.Statement[]): boolean {
    return this.hasDirective(statements, "use strict");
  }

  /** A directive in a body's directive prologue, as exact, unescaped text. */
  private hasDirective(statements: readonly ts.Statement[], directive: string): boolean {
    for (const s of statements) {
      if (!ts.isExpressionStatement(s) || !ts.isStringLiteral(s.expression)) return false;
      const raw = s.expression.getText(this.sf);
      if (raw === `"${directive}"` || raw === `'${directive}'`) return true;
    }
    return false;
  }

  /** The bundler's mark on a CommonJS module's wrapper: { commonJS: true }, else nothing. */
  private commonJSFlag(statements: readonly ts.Statement[]): { commonJS?: true } {
    return this.hasDirective(statements, COMMONJS_DIRECTIVE) ? { commonJS: true } : {};
  }

  program(): A.Program {
    return {
      type: "Program",
      loc: { file: this.unit?.fileName(this.sf) ?? normalize(this.sf.fileName), line: 1, column: 1 },
      body: this.module ? hoistHostImports(this.sf.statements.map((s) => this.moduleItem(s)))
                        : this.sf.statements.map((s) => this.statement(s)),
      strict: this.module || this.hasUseStrict(this.sf.statements),
      module: this.module,
      exportedNames: this.exportedNames,
      source: this.sf.text,
      unsupported: this.unsupportedList,
    };
  }

  // ---- Statements --------------------------------------------------------

  private statements(list: readonly ts.Statement[]): A.Statement[] {
    return list.map((s) => this.statement(s));
  }

  private block(node: ts.Block): A.BlockStatement {
    return { type: "BlockStatement", loc: this.loc(node), body: this.statements(node.statements) };
  }

  private identifier(node: ts.Node): A.Identifier {
    if (!ts.isIdentifier(node)) this.fail("SyntaxError", "identifier expected", node);
    const renamed = this.unit?.rename(node);
    const id: A.Identifier = { type: "Identifier", loc: this.loc(node), name: renamed ?? node.text, ...(renamed ? { original: node.text } : {}) };
    if (this.map) {
      const { line, character } = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf));
      const original = this.map.originalName(line + 1, character + 1);
      if (original !== undefined && original !== node.text) id.original = original;
    }
    return id;
  }

  /** A binding: a name, or an object or array binding pattern (§14.3.3). */
  private bindingPattern(node: ts.BindingName): A.Pattern {
    const loc = this.loc(node);
    if (ts.isIdentifier(node)) return this.identifier(node);
    const element = (e: ts.BindingElement) => ({ target: this.bindingPattern(e.name), init: e.initializer ? this.expression(e.initializer) : null });
    if (ts.isObjectBindingPattern(node)) {
      const properties: A.PatternProperty[] = [];
      let rest: A.Pattern | null = null;
      node.elements.forEach((e, i) => {
        if (e.dotDotDotToken) {
          if (i !== node.elements.length - 1 || node.elements.hasTrailingComma) this.fail("SyntaxError", "Rest element must be last element", e);
          if (!ts.isIdentifier(e.name)) this.fail("SyntaxError", "`...` must be followed by an identifier in declaration contexts", e);
          if (e.initializer) this.fail("SyntaxError", "Rest element may not have a default initializer", e);
          rest = this.identifier(e.name);
          return;
        }
        const { key, computed } = e.propertyName ? this.propertyName(e.propertyName) : { key: this.identifier(e.name), computed: false };
        properties.push({ type: "PatternProperty", loc: this.loc(e), key, computed, ...element(e) });
      });
      return { type: "ObjectPattern", loc, properties, rest };
    }
    const elements: (A.PatternElement | null)[] = [];
    let rest: A.Pattern | null = null;
    node.elements.forEach((e, i) => {
      if (ts.isOmittedExpression(e)) return void elements.push(null);
      if (e.dotDotDotToken) {
        if (i !== node.elements.length - 1 || node.elements.hasTrailingComma) this.fail("SyntaxError", "Rest element must be last element", e);
        if (e.initializer) this.fail("SyntaxError", "Rest element may not have a default initializer", e);
        rest = this.bindingPattern(e.name);
        return;
      }
      elements.push({ type: "PatternElement", loc: this.loc(e), ...element(e) });
    });
    return { type: "ArrayPattern", loc, elements, rest };
  }

  /** An assignment target, where an object or array literal is a destructuring pattern
   *  (§13.15.5: its AssignmentPattern reparse). */
  private assignTarget(node: ts.Expression, what: string): A.PatternTarget {
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) return this.assignmentPattern(node);
    let inner: ts.Expression = node;
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
    if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner))
      this.fail("SyntaxError", "Invalid destructuring assignment target", node);  // `([a]) = b`
    return this.target(node, what);
  }

  /** A pattern element `target = default`. */
  private patternElement(node: ts.Expression): { target: A.PatternTarget; init: A.Expression | null } {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return { target: this.assignTarget(node.left, "in destructuring assignment"), init: this.expression(node.right) };
    return { target: this.assignTarget(node, "in destructuring assignment"), init: null };
  }

  private assignmentPattern(node: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): A.ObjectPattern | A.ArrayPattern {
    const loc = this.loc(node);
    const restTarget = (e: ts.Expression, last: boolean, list: ts.NodeArray<ts.Node>): A.PatternTarget => {
      if (!last || list.hasTrailingComma) this.fail("SyntaxError", "Rest element must be last element", e);
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        this.fail("SyntaxError", "Rest element may not have a default initializer", e);
      return this.assignTarget(e, "in destructuring assignment");
    };
    if (ts.isObjectLiteralExpression(node)) {
      const properties: A.PatternProperty[] = [];
      let rest: A.PatternTarget | null = null;
      node.properties.forEach((p, i) => {
        const last = i === node.properties.length - 1;
        if (ts.isSpreadAssignment(p)) {
          const r = restTarget(p.expression, last, node.properties);
          if (r.type === "ObjectPattern" || r.type === "ArrayPattern") this.fail("SyntaxError", "`...` must be followed by an assignable reference in assignment contexts", p);
          rest = r;
          return;
        }
        if (ts.isShorthandPropertyAssignment(p)) {
          const id = this.identifier(p.name);
          const init = p.objectAssignmentInitializer ? this.expression(p.objectAssignmentInitializer) : null;
          properties.push({ type: "PatternProperty", loc: this.loc(p), key: { ...id }, computed: false, target: id, init });
          return;
        }
        if (ts.isPropertyAssignment(p)) {
          const { key, computed } = this.propertyName(p.name);
          properties.push({ type: "PatternProperty", loc: this.loc(p), key, computed, ...this.patternElement(p.initializer) });
          return;
        }
        this.fail("SyntaxError", "Invalid destructuring assignment target", p);  // methods, accessors
      });
      return { type: "ObjectPattern", loc, properties, rest };
    }
    const elements: (A.PatternElement | null)[] = [];
    let rest: A.PatternTarget | null = null;
    node.elements.forEach((e, i) => {
      if (ts.isOmittedExpression(e)) return void elements.push(null);
      if (ts.isSpreadElement(e)) {
        rest = restTarget(e.expression, i === node.elements.length - 1, node.elements);
        return;
      }
      elements.push({ type: "PatternElement", loc: this.loc(e), ...this.patternElement(e) });
    });
    return { type: "ArrayPattern", loc, elements, rest };
  }

  private variableDeclaration(list: ts.VariableDeclarationList): A.VariableDeclaration {
    const flags = list.flags & ts.NodeFlags.BlockScoped;
    if (flags !== 0 && flags !== ts.NodeFlags.Let && flags !== ts.NodeFlags.Const) this.fail("NotSupported", "`using` declarations", list);
    return {
      type: "VariableDeclaration",
      loc: this.loc(list),
      kind: flags === ts.NodeFlags.Let ? "let" : flags === ts.NodeFlags.Const ? "const" : "var",
      declarations: list.declarations.map((d) => {
        this.noTypes(d);
        if (d.exclamationToken && !this.unit) this.fail("SyntaxError", "definite assignment assertions are TypeScript", d);
        const fn = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) ? d.initializer : undefined;
        return {
          type: "VariableDeclarator",
          loc: this.loc(d),
          id: this.declaredInt(this.bindingPattern(d.name), d.type, fn?.type),
          init: d.initializer ? this.expression(d.initializer) : null,
        };
      }),
    };
  }

  private statement(node: ts.Statement): A.Statement {
    return this.orUnsupported(node, () => this.statementInner(node));
  }

  // ---- Modules -----------------------------------------------------------------------

  /** An untagged template's string: an invalid escape (`\u{xyz}`) is a SyntaxError there. */
  private cooked(part: ts.TemplateLiteralLikeNode): string {
    if (invalidEscape(part)) this.fail("SyntaxError", "Invalid escape sequence in template", part);
    return part.text;
  }

  /** `import { a, b as c } from "visaljs:host"` (host prelude code): const bindings
   *  of the host primitives' function objects. A bare `import "visaljs:host"` (the bundler leaves
   *  one when tree-shaking drops every binding) does nothing. */
  private hostImport(node: ts.ImportDeclaration): A.VariableDeclaration | A.EmptyStatement {
    const loc = this.loc(node);
    if (!node.importClause) return { type: "EmptyStatement", loc };
    const bindings = node.importClause?.namedBindings;
    if (!node.importClause || node.importClause.name || !bindings || !ts.isNamedImports(bindings))
      this.fail("SyntaxError", `${HOST_MODULE} has only named exports`, node);
    return {
      type: "VariableDeclaration", loc, kind: "const",
      declarations: bindings.elements.map((spec) => {
        const name = (spec.propertyName ?? spec.name).text;
        if (!Object.hasOwn(this.hostPrimitives, name)) this.fail("SyntaxError", `${HOST_MODULE} has no export '${name}'`, spec);
        return { type: "VariableDeclarator", loc: this.loc(spec), id: this.identifier(spec.name),
                 init: { type: "HostFunction", loc: this.loc(spec), name } } satisfies A.VariableDeclarator;
      }),
    };
  }

  /** A module's top-level item: a statement, or an import/export declaration. The module is
   *  the whole program, so exports only need their declarations (and the early errors). */
  private moduleItem(node: ts.Statement): A.Statement {
    return this.orUnsupported(node, () => {
      const loc = this.loc(node);
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === HOST_MODULE)
        return this.hostImport(node);
      if (this.unit && ts.isImportDeclaration(node) && (this.unit.linked(node) || typeOnly(node))) return { type: "EmptyStatement", loc };
      if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node))
        this.fail("NotSupported", "import declarations: the bundler resolves them", node);
      if (ts.isExportDeclaration(node)) {
        if (node.isTypeOnly && this.unit) return { type: "EmptyStatement", loc };
        if (node.isTypeOnly) this.fail("SyntaxError", "type-only exports are TypeScript", node);
        if (node.moduleSpecifier) this.fail("NotSupported", "export … from: the bundler resolves them", node);
        const clause = node.exportClause;
        const locals: A.Identifier[] = [];
        if (clause && ts.isNamedExports(clause)) {
          for (const spec of clause.elements) {
            const local = spec.propertyName ?? spec.name;
            if (!ts.isIdentifier(local)) this.fail("SyntaxError", "A string export name needs a 'from' clause", local);
            locals.push(this.identifier(local));
            this.exportedNames.push({ name: spec.name.text, loc: this.loc(spec.name) });
          }
        }
        return { type: "ExportLocals", loc, locals };
      }
      if (ts.isExportAssignment(node)) {
        if (node.isExportEquals) this.fail("SyntaxError", "'export =' is TypeScript", node);
        this.exportedNames.push({ name: "default", loc });
        /* `export default expr`: evaluated, kept in a binding nothing can name */
        return {
          type: "VariableDeclaration", loc, kind: "const",
          declarations: [{ type: "VariableDeclarator", loc, id: { type: "Identifier", loc, name: "*default*" }, init: this.expression(node.expression) }],
        };
      }
      const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
      if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return this.statementInner(node);
      const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      this.exporting = true;
      try {
        const s = this.statementInner(node);
        if (isDefault) this.exportedNames.push({ name: "default", loc });
        else if (s.type === "VariableDeclaration") for (const d of s.declarations) for (const id of boundNames(d.id)) this.exportedNames.push({ name: id.name, loc: id.loc });
        else if (s.type === "FunctionDeclaration" || s.type === "ClassDeclaration") this.exportedNames.push({ name: s.id.name, loc: s.id.loc });
        return s;
      } finally {
        this.exporting = false;
      }
    });
  }

  /** `export` and `default` on a module's declaration are fine; anywhere else, an error. */
  private exportModifier(m: ts.ModifierLike): boolean {
    if (m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.DefaultKeyword) return false;
    if (this.exporting) return true;
    return this.fail("SyntaxError", this.module ? "'export' modifier can only appear at the top level of a module"
                                               : "Unexpected token 'export': the program is a classic script, not a module", m);
  }

  private statementInner(node: ts.Statement): A.Statement {
    const loc = this.loc(node);
    switch (node.kind) {
      case ts.SyntaxKind.VariableStatement: {
        const v = node as ts.VariableStatement;
        for (const m of v.modifiers ?? []) if (!this.exportModifier(m)) this.unsupported(m);
        this.exporting = false;  // only this declaration's own modifiers
        return this.variableDeclaration(v.declarationList);
      }
      case ts.SyntaxKind.FunctionDeclaration: {
        const f = node as ts.FunctionDeclaration;
        this.noTypes(f);
        for (const m of f.modifiers ?? []) {
          if (m.kind === ts.SyntaxKind.AsyncKeyword || this.exportModifier(m)) continue;
          this.fail("SyntaxError", `'${m.getText(this.sf)}' modifier`, m);
        }
        const anonymousDefault = !f.name && this.exporting;  // export default function () {}
        this.exporting = false;
        if ((!f.name && !anonymousDefault) || !f.body) this.fail("SyntaxError", "function declaration without a name or body", f);
        return {
          type: "FunctionDeclaration",
          loc,
          id: f.name ? this.declaredInt(this.identifier(f.name), undefined, f.type) : { type: "Identifier", loc, name: "*default*" },
          ...this.returnsInt(f),
          ...this.parameters(f.parameters),
          source: this.range(f),
          body: this.block(f.body),
          strict: this.hasUseStrict(f.body.statements),
          ...this.commonJSFlag(f.body.statements),
          generator: !!f.asteriskToken,
          ...this.asyncFlag(f),
        };
      }
      case ts.SyntaxKind.ClassDeclaration: {
        const c = node as ts.ClassDeclaration;
        if (!c.name && !this.exporting) this.fail("SyntaxError", "A class declaration needs a name", c);
        const id: A.Identifier = c.name ? this.identifier(c.name) : { type: "Identifier", loc, name: "*default*" };
        return { type: "ClassDeclaration", loc, id, ...this.classBody(c) };
      }
      case ts.SyntaxKind.WithStatement:
        if (this.module) return this.fail("SyntaxError", "Strict mode code may not include a with statement", node);
        return this.unsupported(node);
      case ts.SyntaxKind.ImportDeclaration:
      case ts.SyntaxKind.ImportEqualsDeclaration:
      case ts.SyntaxKind.ExportDeclaration:
      case ts.SyntaxKind.ExportAssignment:
        return this.fail("SyntaxError", this.module ? "import and export may only appear at the top level of a module"
                                                    : "Cannot use import or export outside a module (this is a classic script)", node);
      case ts.SyntaxKind.ExpressionStatement:
        return { type: "ExpressionStatement", loc, expression: this.expression((node as ts.ExpressionStatement).expression) };
      case ts.SyntaxKind.Block:
        return this.block(node as ts.Block);
      case ts.SyntaxKind.EmptyStatement:
      case ts.SyntaxKind.DebuggerStatement:  /* no debugger to stop in: does nothing (§14.16) */
        return { type: "EmptyStatement", loc };
      case ts.SyntaxKind.IfStatement: {
        const s = node as ts.IfStatement;
        return {
          type: "IfStatement",
          loc,
          test: this.expression(s.expression),
          consequent: this.statement(s.thenStatement),
          alternate: s.elseStatement ? this.statement(s.elseStatement) : null,
        };
      }
      case ts.SyntaxKind.WhileStatement: {
        const s = node as ts.WhileStatement;
        return { type: "WhileStatement", loc, test: this.expression(s.expression), body: this.statement(s.statement) };
      }
      case ts.SyntaxKind.DoStatement: {
        const s = node as ts.DoStatement;
        return { type: "DoWhileStatement", loc, body: this.statement(s.statement), test: this.expression(s.expression) };
      }
      case ts.SyntaxKind.ForStatement: {
        const s = node as ts.ForStatement;
        let init: A.ForStatement["init"] = null;
        if (s.initializer)
          init = ts.isVariableDeclarationList(s.initializer) ? this.variableDeclaration(s.initializer) : this.expression(s.initializer);
        return {
          type: "ForStatement",
          loc,
          init,
          test: s.condition ? this.expression(s.condition) : null,
          update: s.incrementor ? this.expression(s.incrementor) : null,
          body: this.statement(s.statement),
        };
      }
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.ForInStatement: {
        const s = node as ts.ForInStatement | ts.ForOfStatement;
        const of = ts.isForOfStatement(s);
        const kind = of ? "for-of" : "for-in";
        let left: A.ForInStatement["left"];
        if (!of && ts.isVariableDeclarationList(s.initializer) && s.initializer.declarations.length === 0 && (s.initializer.flags & ts.NodeFlags.Let)) {
          /* sloppy `for (let in o)`: `let` is an identifier; TypeScript parses an empty declaration */
          left = { type: "Identifier", loc: this.loc(s.initializer), name: "let" };
        } else if (ts.isVariableDeclarationList(s.initializer)) {
          const list = s.initializer;
          if (list.declarations.length !== 1) this.fail("SyntaxError", `Invalid left-hand side in ${kind} loop: Must have a single binding.`, list);
          const d = list.declarations[0]!;
          if (d.initializer) {
            if (of || list.flags & ts.NodeFlags.BlockScoped) this.fail("SyntaxError", `${kind} loop variable declaration may not have an initializer.`, d);
            this.fail("NotSupported", "for (var x = … in …) (Annex B)", d);
          }
          left = this.variableDeclaration(list);
        } else {
          left = this.assignTarget(s.initializer, `in ${kind} loop`);
        }
        const loop = { type: of ? "ForOfStatement" : "ForInStatement", loc, left, right: this.expression(s.expression), body: this.statement(s.statement) } as const;
        return of && s.awaitModifier ? { ...loop, type: "ForOfStatement", await: true } : loop;
      }
      case ts.SyntaxKind.BreakStatement:
      case ts.SyntaxKind.ContinueStatement: {
        const s = node as ts.BreakOrContinueStatement;
        const label = s.label ? this.identifier(s.label) : null;
        return node.kind === ts.SyntaxKind.BreakStatement ? { type: "BreakStatement", loc, label } : { type: "ContinueStatement", loc, label };
      }
      case ts.SyntaxKind.ReturnStatement: {
        const s = node as ts.ReturnStatement;
        return { type: "ReturnStatement", loc, argument: s.expression ? this.expression(s.expression) : null };
      }
      case ts.SyntaxKind.ThrowStatement:
        return { type: "ThrowStatement", loc, argument: this.expression((node as ts.ThrowStatement).expression) };
      case ts.SyntaxKind.TryStatement: {
        const s = node as ts.TryStatement;
        const c = s.catchClause;
        if (c?.variableDeclaration) this.noTypes(c.variableDeclaration);
        return {
          type: "TryStatement",
          loc,
          block: this.block(s.tryBlock),
          handler: c
            ? {
                type: "CatchClause",
                loc: this.loc(c),
                param: c.variableDeclaration ? this.bindingPattern(c.variableDeclaration.name) : null,
                body: this.block(c.block),
              }
            : null,
          finalizer: s.finallyBlock ? this.block(s.finallyBlock) : null,
        };
      }
      case ts.SyntaxKind.SwitchStatement: {
        const s = node as ts.SwitchStatement;
        return {
          type: "SwitchStatement",
          loc,
          discriminant: this.expression(s.expression),
          cases: s.caseBlock.clauses.map((c) => ({
            type: "SwitchCase",
            loc: this.loc(c),
            test: ts.isCaseClause(c) ? this.expression(c.expression) : null,
            consequent: this.statements(c.statements),
          })),
        };
      }
      case ts.SyntaxKind.LabeledStatement: {
        const s = node as ts.LabeledStatement;
        return { type: "LabeledStatement", loc, label: this.identifier(s.label), body: this.statement(s.statement) };
      }
      case ts.SyntaxKind.InterfaceDeclaration:
      case ts.SyntaxKind.TypeAliasDeclaration:
        if (this.unit) return { type: "EmptyStatement", loc };
        return this.fail("SyntaxError", "TypeScript declarations are not JavaScript", node);
      case ts.SyntaxKind.EnumDeclaration:
      case ts.SyntaxKind.ModuleDeclaration:
        return this.fail("SyntaxError", "TypeScript declarations are not JavaScript", node);
      default:
        return this.unsupported(node);
    }
  }

  // ---- Expressions -------------------------------------------------------

  /** An assignment or update target. `(x)` counts as x. */
  private target(node: ts.Expression, what: string): A.Target {
    let n: ts.Expression = node;
    while (ts.isParenthesizedExpression(n)) n = n.expression;
    if (ts.isIdentifier(n)) return this.identifier(n);
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      if (ts.isOptionalChain(n)) this.fail("SyntaxError", `Invalid left-hand side ${what}`, node);
      return this.member(n) as A.MemberExpression | A.SuperMember;
    }
    /* a pattern here is parenthesized, or with a compound operator: `([a]) = b`, `[a] += b` */
    if (ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n)) this.fail("SyntaxError", "Invalid destructuring assignment target", node);
    this.fail("SyntaxError", `Invalid left-hand side ${what}`, node);
  }

  /** `a ?? b || c` needs parentheses (an early error). */
  private checkNullishMix(b: ts.BinaryExpression) {
    const op = b.operatorToken.kind;
    const isAndOr = (k: ts.SyntaxKind) => k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken;
    for (const side of [b.left, b.right]) {
      if (!ts.isBinaryExpression(side)) continue;
      const inner = side.operatorToken.kind;
      if ((op === ts.SyntaxKind.QuestionQuestionToken && isAndOr(inner)) || (isAndOr(op) && inner === ts.SyntaxKind.QuestionQuestionToken))
        this.fail("SyntaxError", "'??' can't be mixed with '&&' or '||' without parentheses", side);
    }
  }

  /** A node's source text range, without leading trivia (and, for a class member, after
   *  `static`: toString shows the MethodDefinition alone). */
  private range(node: ts.Node): { start: number; end: number } {
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : [];
    const isStatic = modifiers.find((m) => m.kind === ts.SyntaxKind.StaticKeyword);
    if (!isStatic) return { start: node.getStart(this.sf), end: node.end };
    /* the first token after `static` */
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, this.sf.text);
    scanner.resetTokenState(isStatic.end);
    scanner.scan();
    return { start: scanner.getTokenStart(), end: node.end };
  }

  private parameters(list: ts.NodeArray<ts.ParameterDeclaration>): Omit<A.FunctionDeclaration, "type" | "loc" | "id" | "body" | "strict" | "source"> {
    const params: A.Pattern[] = [];
    const defaults: (A.Expression | null)[] = [];
    let rest: A.Pattern | null = null;
    list.forEach((p, i) => {
      this.noTypes(p);
      if (p.questionToken && !this.unit) this.fail("SyntaxError", "optional parameters are TypeScript", p);
      if (p.dotDotDotToken) {
        if (i !== list.length - 1) this.fail("SyntaxError", "A rest parameter must be last in a parameter list", p);
        if (p.initializer) this.fail("SyntaxError", "Rest parameter may not have a default initializer", p);
        rest = this.bindingPattern(p.name);
        return;
      }
      params.push(this.declaredInt(this.bindingPattern(p.name), p.type));
      defaults.push(p.initializer ? this.expression(p.initializer) : null);
    });
    return { params, defaults, rest };
  }

  /** A function expression, or a method's, accessor's or class constructor's function
   *  (no own name). `cls`: a class member (strict; `static` allowed), or its constructor. */
  private functionExpression(
    f: ts.FunctionExpression | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.ConstructorDeclaration,
    method: boolean,
    cls: { ctor: { derived: boolean } | null; node?: ts.Node } | null = null,
  ): A.FunctionExpression {
    this.noTypes(f);
    for (const m of f.modifiers ?? []) {
      if (m.kind === ts.SyntaxKind.AsyncKeyword && (ts.isFunctionExpression(f) || ts.isMethodDeclaration(f))) continue;
      if (m.kind === ts.SyntaxKind.StaticKeyword && cls && !cls.ctor) continue;
      if (m.kind === ts.SyntaxKind.Decorator) this.fail("NotSupported", "decorators", m);
      this.fail("SyntaxError", `'${m.getText(this.sf)}' modifier`, m);
    }
    if (!f.body) this.fail("SyntaxError", "function without a body", f);
    if (ts.isMethodDeclaration(f) && f.questionToken) this.fail("SyntaxError", "optional methods are TypeScript", f);
    if (ts.isGetAccessor(f) && f.parameters.length) this.fail("SyntaxError", "Getter must not have any formal parameters.", f);
    if (ts.isSetAccessor(f) && (f.parameters.length !== 1 || f.parameters[0]!.dotDotDotToken))
      this.fail("SyntaxError", "Setter must have exactly one formal parameter.", f);
    return {
      type: "FunctionExpression",
      loc: this.loc(f),
      id: !method && !ts.isConstructorDeclaration(f) && f.name && ts.isIdentifier(f.name) ? this.identifier(f.name) : null,
      ...this.returnsInt(f),
      ...this.parameters(f.parameters),
      source: this.range(cls?.ctor && cls.node ? cls.node : f),  // a class constructor shows its class
      body: this.block(f.body),
      strict: this.hasUseStrict(f.body.statements),
      ...this.commonJSFlag(f.body.statements),
      method,
      arrow: false,
      classCtor: cls?.ctor ?? null,
      inClass: cls !== null,
      fieldInit: false,
      initRef: null,
      generator: (ts.isFunctionExpression(f) || ts.isMethodDeclaration(f)) && !!f.asteriskToken,
      ...this.asyncFlag(f),
    };
  }

  /** A class's heritage, constructor, members, fields and static blocks (§15.7). */
  private classBody(c: ts.ClassDeclaration | ts.ClassExpression): Omit<A.ClassExpression, "type" | "id" | "loc"> {
    this.noTypes(c);
    for (const m of c.modifiers ?? []) {
      if (this.exportModifier(m)) continue;
      if (m.kind === ts.SyntaxKind.Decorator) this.fail("NotSupported", "decorators", m);
      this.fail("SyntaxError", `'${m.getText(this.sf)}' modifier`, m);
    }
    this.exporting = false;
    let superClass: A.Expression | null = null;
    for (const h of c.heritageClauses ?? []) {
      if (h.token === ts.SyntaxKind.ImplementsKeyword) this.fail("SyntaxError", "'implements' is TypeScript, not JavaScript", h);
      if (h.types.length !== 1) this.fail("SyntaxError", "Classes can only extend a single class", h);
      this.noTypes(h.types[0]!);
      superClass = this.expression(h.types[0]!.expression);
    }
    const derived = superClass !== null;
    let ctor: A.FunctionExpression | null = null;
    const members: A.ClassMember[] = [];
    const hidden: string[] = [];
    /* private names: one element each, except a getter/setter pair of the same staticness */
    const privates = new Map<string, { kinds: Set<string>; isStatic: boolean }>();
    const declarePrivate = (node: ts.PrivateIdentifier, kind: string, isStatic: boolean) => {
      const name = node.text;
      if (name === "#constructor") this.fail("SyntaxError", "Classes may not have a private field named '#constructor'", node);
      const seen = privates.get(name);
      const pair = seen && seen.isStatic === isStatic && ((kind === "get" && seen.kinds.has("set") && !seen.kinds.has("get")) || (kind === "set" && seen.kinds.has("get") && !seen.kinds.has("set")));
      if (seen && !pair) this.fail("SyntaxError", `Identifier '${name}' has already been declared`, node);
      if (seen) seen.kinds.add(kind);
      else privates.set(name, { kinds: new Set([kind]), isStatic });
    };
    const ident = (loc: A.Loc, name: string): A.Identifier => ({ type: "Identifier", loc, name });
    const installs: A.Statement[] = [];  // instance private methods: before the fields (§7.3.34)
    const instanceBody: A.Statement[] = [];
    const staticBody: A.Statement[] = [];
    const statement = (loc: A.Loc, expression: A.Expression): A.Statement => ({ type: "ExpressionStatement", loc, expression });

    for (const m of c.members) {
      if (ts.isSemicolonClassElement(m)) continue;
      const loc = this.loc(m);
      const modifiers = ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : [];
      const isStatic = modifiers.some((x) => x.kind === ts.SyntaxKind.StaticKeyword);
      if (ts.isConstructorDeclaration(m) && isStatic) {
        /* `static constructor() {}` is a static method named "constructor" */
        if (!m.body) this.fail("SyntaxError", "function without a body", m);
        members.push({ type: "ClassMember", loc, kind: "method", static: true, key: ident(loc, "constructor"), computed: false,
          value: this.functionExpression(m, true, { ctor: null }), private: false, store: null });
        continue;
      }
      if (ts.isConstructorDeclaration(m)) {
        if (!m.body) continue;  // an overload signature: TypeScript
        if (ctor) this.fail("SyntaxError", "A class may only have one constructor", m);
        ctor = this.functionExpression(m, true, { ctor: { derived }, node: c });
        continue;
      }
      if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
        const kind = ts.isGetAccessor(m) ? "get" : ts.isSetAccessor(m) ? "set" : "method";
        if (ts.isPrivateIdentifier(m.name)) {
          declarePrivate(m.name, kind, isStatic);
          const store = `%pm${hidden.length}`;
          hidden.push(store);
          const name = ident(this.loc(m.name), m.name.text);
          members.push({ type: "ClassMember", loc, kind, static: isStatic, key: name, computed: false,
            value: this.functionExpression(m, true, { ctor: null }), private: true, store });
          if (!isStatic) installs.push(statement(loc, { type: "AddPrivateMethod", loc, name: { ...name }, fn: ident(loc, store), kind }));
          continue;
        }
        const { key, computed } = this.propertyName(m.name);
        const name = !computed && (key.type === "Identifier" ? key.name : key.type === "Literal" ? String(key.value) : null);
        /* §15.7.1 early errors */
        if (!isStatic && name === "constructor") this.fail("SyntaxError", "Class constructor may not be an accessor or a generator", m);
        if (isStatic && name === "prototype") this.fail("SyntaxError", "Classes may not have a static property named 'prototype'", m);
        members.push({ type: "ClassMember", loc, kind, static: isStatic, key, computed, value: this.functionExpression(m, true, { ctor: null }), private: false, store: null });
        continue;
      }
      if (ts.isPropertyDeclaration(m)) {
        this.noTypes(m);
        for (const x of modifiers) {
          if (x.kind === ts.SyntaxKind.StaticKeyword) continue;
          if (x.kind === ts.SyntaxKind.AccessorKeyword) this.fail("NotSupported", "auto-accessors (decorators proposal)", x);
          this.fail("SyntaxError", `'${x.getText(this.sf)}' modifier`, x);
        }
        if (m.questionToken || m.exclamationToken) this.fail("SyntaxError", "optional or definite fields are TypeScript", m);
        const value = m.initializer ? this.expression(m.initializer) : null;
        let field: A.DefineField;
        if (ts.isPrivateIdentifier(m.name)) {
          declarePrivate(m.name, "field", isStatic);
          field = { type: "DefineField", loc, key: ident(this.loc(m.name), m.name.text), computed: false, private: true, value };
        } else {
          const { key, computed } = this.propertyName(m.name);
          if (computed) {
            /* evaluated once, in order with the other members: kept in a hidden binding */
            const store = `%fk${hidden.length}`;
            hidden.push(store);
            members.push({ type: "ClassMember", loc, kind: "fieldKey", static: isStatic, key, computed: true, value: null, private: false, store });
            field = { type: "DefineField", loc, key: ident(loc, store), computed: true, private: false, value };
          } else {
            const name = key.type === "Identifier" ? key.name : String((key as A.Literal).value);
            if (name === "constructor" || (isStatic && name === "prototype"))
              this.fail("SyntaxError", `Classes may not have a field named '${name}'`, m);
            field = { type: "DefineField", loc, key: key.type === "Identifier" ? { type: "Literal", loc, value: name } : key, computed: false, private: false, value };
          }
        }
        (isStatic ? staticBody : instanceBody).push(statement(loc, field));
        continue;
      }
      if (ts.isClassStaticBlockDeclaration(m)) {
        staticBody.push(this.block(m.body));
        continue;
      }
      this.unsupported(m);
    }
    if (!ctor) ctor = this.defaultConstructor(c, derived);
    const loc = this.loc(c);
    const init = (body: A.Statement[]): A.FunctionExpression => ({
      type: "FunctionExpression", loc, id: null, params: [], defaults: [], rest: null, source: null,
      body: { type: "BlockStatement", loc, body }, strict: false, method: true, arrow: false,
      classCtor: null, inClass: true, fieldInit: true, initRef: null,
    });
    const instanceInit = installs.length || instanceBody.length ? init([...installs, ...instanceBody]) : null;
    if (instanceInit) {
      hidden.push("%init");
      ctor.initRef = ident(loc, "%init");
    }
    return {
      superClass, ctor, members, privateNames: [...privates.keys()], hidden,
      instanceInit, staticInit: staticBody.length ? init(staticBody) : null,
    };
  }

  /** `constructor() {}`, or `constructor(...args) { super(...args); }` for a derived class (§15.7.14 step 10). */
  private defaultConstructor(c: ts.Node, derived: boolean): A.FunctionExpression {
    const loc = this.loc(c);
    const args: A.Identifier = { type: "Identifier", loc, name: "args" };
    const body: A.Statement[] = derived
      ? [{ type: "ExpressionStatement", loc, expression: { type: "SuperCall", loc, arguments: [{ type: "SpreadElement", loc, argument: { ...args } }], forwardArgs: true } }]
      : [];
    return {
      type: "FunctionExpression", loc, id: null, params: [], defaults: [], rest: derived ? args : null, source: this.range(c),
      body: { type: "BlockStatement", loc, body }, strict: false, method: true, arrow: false,
      classCtor: { derived }, inClass: true, fieldInit: false, initRef: null,
    };
  }

  /** An arrow function: a concise body becomes `{ return body; }`. */
  private arrowFunction(f: ts.ArrowFunction): A.FunctionExpression {
    this.noTypes(f);
    for (const m of f.modifiers ?? []) {
      if (m.kind === ts.SyntaxKind.AsyncKeyword) continue;
      this.fail("SyntaxError", `'${m.getText(this.sf)}' modifier`, m);
    }
    const loc = this.loc(f);
    const concise = !ts.isBlock(f.body);
    const body: A.BlockStatement = ts.isBlock(f.body)
      ? this.block(f.body)
      : { type: "BlockStatement", loc: this.loc(f.body), body: [{ type: "ReturnStatement", loc: this.loc(f.body), argument: this.expression(f.body) }] };
    return {
      type: "FunctionExpression",
      loc,
      id: null,
      ...this.returnsInt(f),
      ...this.parameters(f.parameters),
      source: this.range(f),
      body,
      strict: !concise && ts.isBlock(f.body) && this.hasUseStrict(f.body.statements),
      ...(!concise && ts.isBlock(f.body) ? this.commonJSFlag(f.body.statements) : {}),
      method: true,  // not a constructor, no prototype
      arrow: true,
      classCtor: null,
      inClass: false,
      fieldInit: false,
      initRef: null,
      ...this.asyncFlag(f),
    };
  }

  /** Static code: the integers a declaration names, on its identifier: its type's, and (a
   *  function's name, or a const holding a function) its function's return type's. */
  private declaredInt<P extends A.Pattern>(id: P, type: ts.TypeNode | undefined, returns?: ts.TypeNode): P {
    if (!this.unit || id.type !== "Identifier") return id;
    const int = this.unit.intKind(type);
    const returnsInt = this.unit.intKind(returns);
    return { ...id, ...(int ? { int } : {}), ...(returnsInt ? { returnsInt } : {}) };
  }

  /** Static code: the integer a function's declared return type names. */
  private returnsInt(f: ts.SignatureDeclaration): { returnsInt?: IntKind } {
    const int = this.unit?.intKind(f.type);
    return int ? { returnsInt: int } : {};
  }

  /** `async`: async functions and async generators. */
  private asyncFlag(f: ts.FunctionLikeDeclaration): { async?: true } {
    return f.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? { async: true } : {};
  }

  /** An argument or array element: `...x` is a spread. */
  private argument(node: ts.Expression): A.Argument {
    if (ts.isSpreadElement(node)) return { type: "SpreadElement", loc: this.loc(node), argument: this.expression(node.expression) };
    return this.expression(node);
  }

  /** An optional chain, from its last member or call: the chain links (along objects and
   *  callees) convert without a ChainExpression of their own. */
  private chain(node: ts.Expression): A.ChainExpression {
    return { type: "ChainExpression", loc: this.loc(node), expression: this.chainLink(node) };
  }

  private chainLink(node: ts.Expression): A.Expression {
    if (!ts.isOptionalChain(node)) return this.expression(node);
    if (ts.isNonNullExpression(node) && this.unit) return this.chainLink(node.expression);
    if (ts.isNonNullExpression(node)) this.fail("SyntaxError", "non-null assertions are TypeScript, not JavaScript", node);
    const optional = node.questionDotToken ? { optional: true } : {};
    const loc = this.loc(node);
    if (ts.isCallExpression(node)) {
      this.noTypes(node);
      return { type: "CallExpression", loc, callee: this.chainLink(node.expression), arguments: node.arguments.map((a) => this.argument(a)), ...optional };
    }
    const object = this.chainLink(node.expression);
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isPrivateIdentifier(node.name))
        return { type: "MemberExpression", loc, object, property: { type: "Identifier", loc: this.loc(node.name), name: node.name.text }, computed: false, private: true, ...optional };
      return { type: "MemberExpression", loc, object, property: this.identifier(node.name), computed: false, ...optional };
    }
    return { type: "MemberExpression", loc, object, property: this.expression(node.argumentExpression), computed: true, ...optional };
  }

  private member(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): A.MemberExpression | A.SuperMember | A.ChainExpression {
    if (ts.isOptionalChain(node)) return this.chain(node);
    const loc = this.loc(node);
    if (node.expression.kind === ts.SyntaxKind.SuperKeyword) {
      if (ts.isPropertyAccessExpression(node)) {
        if (ts.isPrivateIdentifier(node.name)) this.fail("SyntaxError", "Unexpected private field", node.name);
        return { type: "SuperMember", loc, property: this.identifier(node.name), computed: false };
      }
      return { type: "SuperMember", loc, property: this.expression(node.argumentExpression), computed: true };
    }
    const object = this.expression(node.expression);
    if (ts.isPropertyAccessExpression(node)) {
      if (ts.isPrivateIdentifier(node.name))
        return { type: "MemberExpression", loc, object, property: { type: "Identifier", loc: this.loc(node.name), name: node.name.text }, computed: false, private: true };
      return { type: "MemberExpression", loc, object, property: this.identifier(node.name), computed: false };
    }
    return { type: "MemberExpression", loc, object, property: this.expression(node.argumentExpression), computed: true };
  }

  /** A property name: an identifier or literal naming the key, or a computed expression. */
  private propertyName(name: ts.PropertyName): { key: A.Expression; computed: boolean } {
    const loc = this.loc(name);
    if (ts.isIdentifier(name)) return { key: this.identifier(name), computed: false };
    if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return { key: { type: "Literal", loc, value: name.text }, computed: false };
    if (ts.isNumericLiteral(name)) return { key: { type: "Literal", loc, value: Number(name.text) }, computed: false };
    if (ts.isComputedPropertyName(name)) return { key: this.expression(name.expression), computed: true };
    return this.unsupported(name);
  }

  private objectLiteral(node: ts.ObjectLiteralExpression): A.ObjectExpression {
    const properties = node.properties.map((p): A.Property | A.SpreadElement => {
      const loc = this.loc(p);
      if (ts.isSpreadAssignment(p)) return { type: "SpreadElement", loc, argument: this.expression(p.expression) };
      if (ts.isPropertyAssignment(p)) {
        const { key, computed } = this.propertyName(p.name);
        const isProto = !computed && ((key.type === "Identifier" && key.name === "__proto__") || (key.type === "Literal" && key.value === "__proto__"));
        return { type: "Property", kind: "init", loc, key, computed, value: this.expression(p.initializer), isProto };
      }
      if (ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) {
        const { key, computed } = this.propertyName(p.name);
        const kind = ts.isGetAccessor(p) ? "get" : ts.isSetAccessor(p) ? "set" : "init";
        return { type: "Property", kind, loc, key, computed, value: this.functionExpression(p, true), isProto: false };
      }
      if (ts.isShorthandPropertyAssignment(p)) {
        if (p.objectAssignmentInitializer) this.fail("SyntaxError", "Invalid shorthand property initializer", p);
        const key: A.Identifier = { type: "Identifier", loc: this.loc(p.name), name: p.name.text };  /* the property's name, never renamed */
        return { type: "Property", kind: "init", loc, key, computed: false, value: this.identifier(p.name), isProto: false };
      }
      return this.unsupported(p);
    });
    return { type: "ObjectExpression", loc: this.loc(node), properties };
  }

  private expression(node: ts.Expression): A.Expression {
    return this.orUnsupported(node, () => this.expressionInner(node));
  }

  private expressionInner(node: ts.Expression): A.Expression {
    const loc = this.loc(node);
    switch (node.kind) {
      case ts.SyntaxKind.NumericLiteral: {
        const value = Number((node as ts.NumericLiteral).text);  // text is normalized: "0x10" → "16"
        return { type: "Literal", loc, value, ...(this.unit && isFloatWritten(node.getText(this.sf)) ? { float: true } : {}) };
      }
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        return { type: "Literal", loc, value: (node as ts.StringLiteral).text };  // escapes already processed
      case ts.SyntaxKind.TemplateExpression: {
        const t = node as ts.TemplateExpression;
        return {
          type: "TemplateLiteral", loc,
          quasis: [this.cooked(t.head), ...t.templateSpans.map((s) => this.cooked(s.literal))],
          expressions: t.templateSpans.map((s) => this.expression(s.expression)),
        };
      }
      case ts.SyntaxKind.TaggedTemplateExpression: {
        /* tag`a${x}b` is a call: tag(templateObject, x), `this` as for tag(…) */
        const t = node as ts.TaggedTemplateExpression;
        if (ts.isOptionalChain(t.tag)) this.fail("SyntaxError", "Invalid tagged template on optional chain", t);
        if (t.typeArguments) this.fail("SyntaxError", "type arguments are TypeScript, not JavaScript", t);
        const parts: ts.TemplateLiteralLikeNode[] = ts.isNoSubstitutionTemplateLiteral(t.template)
          ? [t.template] : [t.template.head, ...t.template.templateSpans.map((s) => s.literal)];
        const object: A.TemplateObject = {
          type: "TemplateObject", loc: this.loc(t.template),
          cooked: parts.map((p) => (invalidEscape(p) ? null : p.text)),
          raw: parts.map((p) => rawText(p, this.sf)),
        };
        const substitutions = ts.isNoSubstitutionTemplateLiteral(t.template) ? [] : t.template.templateSpans.map((s) => this.expression(s.expression));
        return { type: "CallExpression", loc, callee: this.expression(t.tag), arguments: [object, ...substitutions] };
      }
      case ts.SyntaxKind.BigIntLiteral:  /* text is decimal or 0x hex, separators removed: "31n" */
        return { type: "BigIntLiteral", loc, value: BigInt((node as ts.BigIntLiteral).text.slice(0, -1)).toString() };
      case ts.SyntaxKind.RegularExpressionLiteral: {
        const text = (node as ts.RegularExpressionLiteral).text;  /* /pattern/flags, as written */
        const slash = text.lastIndexOf("/");
        return { type: "RegExpLiteral", loc, pattern: text.slice(1, slash), flags: text.slice(slash + 1) };
      }
      case ts.SyntaxKind.TrueKeyword:
        return { type: "Literal", loc, value: true };
      case ts.SyntaxKind.FalseKeyword:
        return { type: "Literal", loc, value: false };
      case ts.SyntaxKind.NullKeyword:
        return { type: "Literal", loc, value: null };
      case ts.SyntaxKind.Identifier:
        return this.identifier(node);
      case ts.SyntaxKind.ParenthesizedExpression:
        return this.expression((node as ts.ParenthesizedExpression).expression);
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const u = node as ts.PrefixUnaryExpression;
        if (u.operator === ts.SyntaxKind.PlusPlusToken || u.operator === ts.SyntaxKind.MinusMinusToken)
          return { type: "UpdateExpression", loc, operator: u.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--", prefix: true, argument: this.target(u.operand, "expression in prefix operation") };
        const op = ({
          [ts.SyntaxKind.MinusToken]: "-",
          [ts.SyntaxKind.PlusToken]: "+",
          [ts.SyntaxKind.ExclamationToken]: "!",
          [ts.SyntaxKind.TildeToken]: "~",
        } as const)[u.operator];
        return { type: "UnaryExpression", loc, operator: op, argument: this.expression(u.operand) };
      }
      case ts.SyntaxKind.PostfixUnaryExpression: {
        const u = node as ts.PostfixUnaryExpression;
        return { type: "UpdateExpression", loc, operator: u.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--", prefix: false, argument: this.target(u.operand, "expression in postfix operation") };
      }
      case ts.SyntaxKind.TypeOfExpression:
        return { type: "UnaryExpression", loc, operator: "typeof", argument: this.expression((node as ts.TypeOfExpression).expression) };
      case ts.SyntaxKind.VoidExpression:
        return { type: "UnaryExpression", loc, operator: "void", argument: this.expression((node as ts.VoidExpression).expression) };
      case ts.SyntaxKind.BinaryExpression: {
        const b = node as ts.BinaryExpression;
        const op = b.operatorToken.kind;
        if (op === ts.SyntaxKind.CommaToken) {
          const left = this.expression(b.left);
          const expressions = left.type === "SequenceExpression" && !ts.isParenthesizedExpression(b.left) ? left.expressions : [left];
          return { type: "SequenceExpression", loc, expressions: [...expressions, this.expression(b.right)] };
        }
        const assign = ASSIGNMENT[op];
        if (assign === "=" && (ts.isObjectLiteralExpression(b.left) || ts.isArrayLiteralExpression(b.left)))
          return { type: "AssignmentExpression", loc, operator: assign, target: this.assignmentPattern(b.left), value: this.expression(b.right) };
        if (assign) return { type: "AssignmentExpression", loc, operator: assign, target: this.target(b.left, "in assignment"), value: this.expression(b.right) };
        const logical = LOGICAL[op];
        if (logical) {
          this.checkNullishMix(b);
          return { type: "LogicalExpression", loc, operator: logical, left: this.expression(b.left), right: this.expression(b.right) };
        }
        const binary = BINARY[op];
        if (binary && ts.isPrivateIdentifier(b.left)) {
          /* `#x in o`: the left side reads the private name */
          if (binary !== "in") this.fail("SyntaxError", "Unexpected private name", b.left);
          return { type: "BinaryExpression", loc, operator: "in", left: { type: "Identifier", loc: this.loc(b.left), name: b.left.text }, right: this.expression(b.right) };
        }
        if (binary) return { type: "BinaryExpression", loc, operator: binary, left: this.expression(b.left), right: this.expression(b.right) };
        return this.unsupported(b.operatorToken);
      }
      case ts.SyntaxKind.ConditionalExpression: {
        const c = node as ts.ConditionalExpression;
        return { type: "ConditionalExpression", loc, test: this.expression(c.condition), consequent: this.expression(c.whenTrue), alternate: this.expression(c.whenFalse) };
      }
      case ts.SyntaxKind.CallExpression: {
        const c = node as ts.CallExpression;
        this.noTypes(c);
        if (ts.isOptionalChain(c)) return this.chain(c);
        if (c.expression.kind === ts.SyntaxKind.SuperKeyword) return { type: "SuperCall", loc, arguments: c.arguments.map((a) => this.argument(a)) };
        if (c.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (c.arguments.length < 1 || c.arguments.length > 2 || c.arguments.some(ts.isSpreadElement))
            this.fail("SyntaxError", "import() takes a specifier and optional options", c);
          return { type: "ImportCall", loc, source: this.expression(c.arguments[0]!), options: c.arguments[1] ? this.expression(c.arguments[1]) : null, file: this.originalFile(c) };
        }
        return { type: "CallExpression", loc, callee: this.expression(c.expression), arguments: c.arguments.map((a) => this.argument(a)) };
      }
      case ts.SyntaxKind.NewExpression: {
        const n = node as ts.NewExpression;
        this.noTypes(n);
        return { type: "NewExpression", loc, callee: this.expression(n.expression), arguments: (n.arguments ?? []).map((a) => this.argument(a)) };
      }
      case ts.SyntaxKind.PropertyAccessExpression:
      case ts.SyntaxKind.ElementAccessExpression:
        return this.member(node as ts.PropertyAccessExpression | ts.ElementAccessExpression);
      case ts.SyntaxKind.ObjectLiteralExpression:
        return this.objectLiteral(node as ts.ObjectLiteralExpression);
      case ts.SyntaxKind.ArrayLiteralExpression:
        return {
          type: "ArrayExpression",
          loc,
          elements: (node as ts.ArrayLiteralExpression).elements.map((e) => (ts.isOmittedExpression(e) ? null : this.argument(e))),
        };
      case ts.SyntaxKind.ThisKeyword:
        return { type: "ThisExpression", loc };
      case ts.SyntaxKind.FunctionExpression:
        return this.functionExpression(node as ts.FunctionExpression, false);
      case ts.SyntaxKind.AwaitExpression:
        return { type: "AwaitExpression", loc, argument: this.expression((node as ts.AwaitExpression).expression) };
      case ts.SyntaxKind.YieldExpression: {
        const y = node as ts.YieldExpression;
        return { type: "YieldExpression", loc, argument: y.expression ? this.expression(y.expression) : null, delegate: !!y.asteriskToken };
      }
      case ts.SyntaxKind.ArrowFunction:
        return this.arrowFunction(node as ts.ArrowFunction);
      case ts.SyntaxKind.ClassExpression: {
        const c = node as ts.ClassExpression;
        return { type: "ClassExpression", loc, id: c.name ? this.identifier(c.name) : null, ...this.classBody(c) };
      }
      case ts.SyntaxKind.MetaProperty: {
        const m = node as ts.MetaProperty;
        if (m.keywordToken === ts.SyntaxKind.NewKeyword && m.name.text === "target") return { type: "NewTarget", loc };
        if (!this.module) return this.fail("SyntaxError", "Cannot use 'import.meta' outside a module", m);
        const file = this.originalFile(m);
        return { type: "ImportMeta", loc, file, main: file === this.entry };
      }
      case ts.SyntaxKind.DeleteExpression:
        return { type: "UnaryExpression", loc, operator: "delete", argument: this.expression((node as ts.DeleteExpression).expression) };
      case ts.SyntaxKind.AsExpression:
      case ts.SyntaxKind.SatisfiesExpression:
      case ts.SyntaxKind.NonNullExpression:
      case ts.SyntaxKind.TypeAssertionExpression:
        if (this.unit) return this.expression((node as ts.AssertionExpression | ts.NonNullExpression | ts.SatisfiesExpression).expression);
        return this.fail("SyntaxError", "type assertions are TypeScript, not JavaScript", node);
      default:
        return this.unsupported(node);
    }
  }
}
