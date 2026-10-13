// Our AST: a small ESTree-style tree. Only frontend/adapter.ts
// builds it from the TypeScript parser; every later stage reads only this.
//
// It covers the language the compiler handles: scripts and modules, functions, classes,
// generators and async functions, and the expression and statement forms.

import type { Loc } from "@visaljs/ir";

/** 1-based line and column (UTF-16 units) in the original file (the IR's Loc). */
export type { Loc };

interface Base {
  loc: Loc;
}

// ---- Program ---------------------------------------------------------------

export interface Program extends Base {
  type: "Program";
  body: Statement[];
  strict: boolean;  // "use strict" directive prologue, or a module
  /** An ES module: strict, its top-level bindings its own (not the global
   *  object's), `this` undefined, top-level `await`. Otherwise a classic script. */
  module: boolean;
  /** A module's exported names, for the duplicate check. Nothing imports them: the module is
   *  the whole program (the bundle). */
  exportedNames: { name: string; loc: Loc }[];
  /** The file's text: Function.prototype.toString returns slices of it. */
  source: string;
  /** Constructs the compiler doesn't handle yet, in source order. They appear in
   *  the tree as Unsupported nodes, so analysis can still find syntax errors. */
  unsupported: { detail: string; loc: Loc }[];
}

/** A statement or expression the compiler doesn't handle yet (Program.unsupported). */
export interface Unsupported extends Base {
  type: "Unsupported";
  detail: string;
}

// ---- Statements ------------------------------------------------------------

export type Statement =
  | VariableDeclaration
  | FunctionDeclaration
  | ExpressionStatement
  | BlockStatement
  | EmptyStatement
  | IfStatement
  | WhileStatement
  | DoWhileStatement
  | ForStatement
  | ForInStatement
  | ForOfStatement
  | BreakStatement
  | ContinueStatement
  | ReturnStatement
  | ThrowStatement
  | TryStatement
  | SwitchStatement
  | LabeledStatement
  | ClassDeclaration
  | ExportLocals
  | Unsupported;

/** `export { a, b as c }` (no `from`): the local names must be top-level declarations of the
 *  module; nothing else happens at run time. */
export interface ExportLocals extends Base {
  type: "ExportLocals";
  locals: Identifier[];
}

/** A class (§15.7). `ctor` is always there: a default one is synthesized
 *  (`constructor(...args) { super(...args); }` when derived).
 *
 *  Fields and static blocks become two synthesized methods: `instanceInit` (private
 *  methods, then instance fields; the constructor calls it once `this` exists) and
 *  `staticInit` (static fields and blocks, in order; called once with the class as
 *  `this`). `privateNames` (`#x`) and `hidden` (`%init`, `%fk0` computed field keys,
 *  `%pm0` private methods) are const bindings of the class scope. */
interface ClassBase extends Base {
  superClass: Expression | null;
  ctor: FunctionExpression;
  members: ClassMember[];
  privateNames: string[];
  hidden: string[];
  instanceInit: FunctionExpression | null;
  staticInit: FunctionExpression | null;
}

export interface ClassDeclaration extends ClassBase {
  type: "ClassDeclaration";
  id: Identifier;
}

export interface ClassExpression extends ClassBase {
  type: "ClassExpression";
  id: Identifier | null;
}

/** A method, getter or setter, on the prototype or (`static`) the constructor; or
 *  (`fieldKey`) a computed field key, evaluated in order and kept in the hidden binding
 *  `store`. A private method (`key` the Identifier `#x`) is kept in `store` for the
 *  instance initializer, or (static) added to the constructor. */
export interface ClassMember extends Base {
  type: "ClassMember";
  kind: "method" | "get" | "set" | "fieldKey";
  static: boolean;
  key: Expression;
  computed: boolean;
  value: FunctionExpression | null;
  private: boolean;
  store: string | null;
}

export interface VariableDeclaration extends Base {
  type: "VariableDeclaration";
  kind: "var" | "let" | "const";
  declarations: VariableDeclarator[];
}

export interface VariableDeclarator extends Base {
  type: "VariableDeclarator";
  id: Pattern;
  init: Expression | null;
}

// ---- Destructuring (§8.6.2, §13.15.5) ----------------------------------------------------

/** What a declaration binds: a name, or a pattern of names. */
export type Pattern = Identifier | ObjectPattern | ArrayPattern;
/** A pattern's leaf or nested pattern. In a binding pattern the leaves are Identifiers that
 *  are declared; in an assignment pattern any assignment target. */
export type PatternTarget = Target | ObjectPattern | ArrayPattern;

/** `{ a, b: [c], [k]: d = 1, ...rest }` */
export interface ObjectPattern extends Base {
  type: "ObjectPattern";
  properties: PatternProperty[];
  rest: PatternTarget | null;
}

export interface PatternProperty extends Base {
  type: "PatternProperty";
  key: Expression;  // an Identifier or Literal naming the key, or any expression when computed
  computed: boolean;
  target: PatternTarget;
  init: Expression | null;  // the default, used when the value is undefined
}

/** `[a, , b = 1, ...rest]`: a null element is a hole (skips one value). */
export interface ArrayPattern extends Base {
  type: "ArrayPattern";
  elements: (PatternElement | null)[];
  rest: PatternTarget | null;
}

export interface PatternElement extends Base {
  type: "PatternElement";
  target: PatternTarget;
  init: Expression | null;
}

/** The names a binding pattern declares, in source order. */
export function boundNames(p: PatternTarget): Identifier[] {
  switch (p.type) {
    case "Identifier": return [p];
    case "ObjectPattern": return [...p.properties.flatMap((q) => boundNames(q.target)), ...(p.rest ? boundNames(p.rest) : [])];
    case "ArrayPattern": return [...p.elements.flatMap((e) => (e ? boundNames(e.target) : [])), ...(p.rest ? boundNames(p.rest) : [])];
    default: return [];  // member targets only appear in assignment patterns
  }
}

/** Parameters: `defaults[i]` is params[i]'s initializer (or null); `rest` collects the
 *  arguments after them. Anything but plain names makes the list "not simple" (§15.1.3). */
interface Parameters {
  params: Pattern[];
  defaults: (Expression | null)[];
  rest: Pattern | null;
  /** Its source text as UTF-16 offsets in the file (§20.2.3.5): what toString returns. A
   *  class constructor's is the whole class. null: synthesized, never observable. */
  source: { start: number; end: number } | null;
}

export interface FunctionDeclaration extends Base, Parameters {
  type: "FunctionDeclaration";
  id: Identifier;
  body: BlockStatement;
  strict: boolean;  // own "use strict" directive (strictness is inherited in sema)
  commonJS?: boolean;  // own COMMONJS_DIRECTIVE: sloppy, though in module code (sema)
  generator?: boolean;  // function*
  async?: boolean;  // async function: returns a promise; may `await`
}

/** A function expression, an object literal's method or accessor (`method`: no
 *  `prototype`, not a constructor), or an arrow function (`arrow`: `this` and
 *  `arguments` are the enclosing function's; a concise body becomes a return).
 *  `id`: the expression's own name, visible only inside it. */
export interface FunctionExpression extends Base, Parameters {
  type: "FunctionExpression";
  id: Identifier | null;
  body: BlockStatement;
  strict: boolean;
  commonJS?: boolean;  // own COMMONJS_DIRECTIVE: sloppy, though in module code (sema)
  method: boolean;
  arrow: boolean;
  /** A class's constructor: `derived` when the class has `extends`. Class code is strict. */
  classCtor: { derived: boolean } | null;
  /** A class member or constructor: strict, whatever its own directives say. */
  inClass: boolean;
  /** A class's field initializer or static initializer: no `arguments`, no `return`. */
  fieldInit: boolean;
  /** A constructor of a class with instance fields or private methods: the `%init` binding it calls. */
  initRef: Identifier | null;
  generator?: boolean;  // function* and *method()
  async?: boolean;  // async functions, methods and arrows
}

/** `await v`, in an async function's body. */
export interface AwaitExpression extends Base {
  type: "AwaitExpression";
  argument: Expression;
}

/** `yield v` / `yield* iterable`, in a generator's body. */
export interface YieldExpression extends Base {
  type: "YieldExpression";
  argument: Expression | null;
  delegate: boolean;
}

/** In an initializer: defines a field on `this` (§7.3.33 DefineField). `key`: a Literal
 *  naming it, an Identifier reading a hidden computed key (`computed`), or an Identifier
 *  naming a private name (`private`). */
export interface DefineField extends Base {
  type: "DefineField";
  key: Expression;
  computed: boolean;
  private: boolean;
  value: Expression | null;
}

/** In an instance initializer: adds a private method or accessor (kept in `fn`) to `this`. */
export interface AddPrivateMethod extends Base {
  type: "AddPrivateMethod";
  name: Identifier;
  fn: Identifier;
  kind: "method" | "get" | "set";
}

/** `super(...)`, in a derived class constructor. `initRef`: set by analysis for a super()
 *  inside an arrow of a constructor whose class has fields (the `%init` binding it runs). */
export interface SuperCall extends Base {
  type: "SuperCall";
  arguments: Argument[];
  /** A default derived constructor's `super(...args)`: the arguments pass on as they are,
   *  without iterating `args` (§15.7.14: a patched Array.prototype[@@iterator] isn't seen). */
  forwardArgs?: boolean;
  initRef?: Identifier;
}

/** `super.name` or `super[expr]`: a property of the home object's prototype, with `this` as receiver. */
export interface SuperMember extends Base {
  type: "SuperMember";
  property: Expression;
  computed: boolean;
}

/** `new.target`. */
export interface NewTarget extends Base {
  type: "NewTarget";
}

/** `...x` in an argument list, array literal or object literal. */
export interface SpreadElement extends Base {
  type: "SpreadElement";
  argument: Expression;
}

/** What has its own function scope (sema's FunctionInfo). */
export type FunctionNode = Program | FunctionDeclaration | FunctionExpression;

export interface ExpressionStatement extends Base {
  type: "ExpressionStatement";
  expression: Expression;
}

export interface BlockStatement extends Base {
  type: "BlockStatement";
  body: Statement[];
}

export interface EmptyStatement extends Base {
  type: "EmptyStatement";
}

export interface IfStatement extends Base {
  type: "IfStatement";
  test: Expression;
  consequent: Statement;
  alternate: Statement | null;
}

export interface WhileStatement extends Base {
  type: "WhileStatement";
  test: Expression;
  body: Statement;
}

export interface DoWhileStatement extends Base {
  type: "DoWhileStatement";
  body: Statement;
  test: Expression;
}

export interface ForStatement extends Base {
  type: "ForStatement";
  init: VariableDeclaration | Expression | null;
  test: Expression | null;
  update: Expression | null;
  body: Statement;
}

/** `for (left in right) body` (§14.7.5). `left`: a declaration of one binding without an
 *  initializer (let/const get a fresh binding per iteration), or any assignment target. */
export interface ForInStatement extends Base {
  type: "ForInStatement";
  left: VariableDeclaration | PatternTarget;
  right: Expression;
  body: Statement;
}

/** `for (left of right) body` (§14.7.5): like for…in, over an iterable's values. */
export interface ForOfStatement extends Base {
  type: "ForOfStatement";
  left: VariableDeclaration | PatternTarget;
  right: Expression;
  body: Statement;
  await?: boolean;  // for await (…of…): an async iterator, each step awaited (§14.7.5)
}

export interface BreakStatement extends Base {
  type: "BreakStatement";
  label: Identifier | null;
}

export interface ContinueStatement extends Base {
  type: "ContinueStatement";
  label: Identifier | null;
}

export interface ReturnStatement extends Base {
  type: "ReturnStatement";
  argument: Expression | null;
}

export interface ThrowStatement extends Base {
  type: "ThrowStatement";
  argument: Expression;
}

export interface TryStatement extends Base {
  type: "TryStatement";
  block: BlockStatement;
  handler: CatchClause | null;
  finalizer: BlockStatement | null;
}

export interface CatchClause extends Base {
  type: "CatchClause";
  param: Pattern | null;  // `catch {}` has none
  body: BlockStatement;
}

export interface SwitchStatement extends Base {
  type: "SwitchStatement";
  discriminant: Expression;
  cases: SwitchCase[];
}

export interface SwitchCase extends Base {
  type: "SwitchCase";
  test: Expression | null;  // null: `default:`
  consequent: Statement[];
}

export interface LabeledStatement extends Base {
  type: "LabeledStatement";
  label: Identifier;
  body: Statement;
}

// ---- Expressions -----------------------------------------------------------

export type Expression =
  | Literal
  | RegExpLiteral
  | BigIntLiteral
  | Identifier
  | UnaryExpression
  | UpdateExpression
  | BinaryExpression
  | LogicalExpression
  | AssignmentExpression
  | ConditionalExpression
  | CallExpression
  | ChainExpression
  | NewExpression
  | SequenceExpression
  | MemberExpression
  | ObjectExpression
  | ArrayExpression
  | ThisExpression
  | HostFunction
  | TemplateLiteral
  | TemplateObject
  | ImportMeta
  | ImportCall
  | FunctionExpression
  | ClassExpression
  | SuperCall
  | SuperMember
  | NewTarget
  | DefineField
  | AddPrivateMethod
  | YieldExpression
  | AwaitExpression
  | Unsupported;

export interface Literal extends Base {
  type: "Literal";
  value: number | string | boolean | null;
}

/** A BigInt literal (§12.9.3): its value in decimal digits, without the `n`. */
export interface BigIntLiteral extends Base {
  type: "BigIntLiteral";
  value: string;
}

/** A regular expression literal (§13.2.7): the pattern as written between the slashes, and the
 *  flags. The driver checks and compiles it when the program is built. */
export interface RegExpLiteral extends Base {
  type: "RegExpLiteral";
  pattern: string;
  flags: string;
}

export interface Identifier extends Base {
  type: "Identifier";
  name: string;
  /** The name before the bundler renamed it (from the source map): function names use it. */
  original?: string;
}

export type UnaryOperator = "-" | "+" | "!" | "~" | "typeof" | "void" | "delete";

export interface UnaryExpression extends Base {
  type: "UnaryExpression";
  operator: UnaryOperator;
  argument: Expression;
}

export interface UpdateExpression extends Base {
  type: "UpdateExpression";
  operator: "++" | "--";
  prefix: boolean;
  argument: Target;
}

export type BinaryOperator =
  | "+" | "-" | "*" | "/" | "%" | "**"
  | "<<" | ">>" | ">>>" | "&" | "|" | "^"
  | "==" | "!=" | "===" | "!==" | "<" | "<=" | ">" | ">="
  | "in" | "instanceof";

export interface BinaryExpression extends Base {
  type: "BinaryExpression";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export interface LogicalExpression extends Base {
  type: "LogicalExpression";
  operator: "&&" | "||" | "??";
  left: Expression;
  right: Expression;
}

export type AssignmentOperator =
  | "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "**="
  | "<<=" | ">>=" | ">>>=" | "&=" | "|=" | "^="
  | "&&=" | "||=" | "??=";

/** A pattern target only with `=` (destructuring assignment). */
export interface AssignmentExpression extends Base {
  type: "AssignmentExpression";
  operator: AssignmentOperator;
  target: Target | ObjectPattern | ArrayPattern;
  value: Expression;
}

export interface ConditionalExpression extends Base {
  type: "ConditionalExpression";
  test: Expression;
  consequent: Expression;
  alternate: Expression;
}

export type Argument = Expression | SpreadElement;

/** `optional`: `f?.(…)`, inside a ChainExpression. */
export interface CallExpression extends Base {
  type: "CallExpression";
  callee: Expression;
  arguments: Argument[];
  optional?: boolean;
}

/** An optional chain (`a?.b.c`, `f?.()`): a member or call with `optional` somewhere inside
 *  `expression` (along its objects and callees). A nullish value there short-circuits the
 *  rest of the chain, to undefined. */
export interface ChainExpression extends Base {
  type: "ChainExpression";
  expression: Expression;
}

export interface NewExpression extends Base {
  type: "NewExpression";
  callee: Expression;
  arguments: Argument[];
}

/** `object.name` (property: an Identifier naming the key), `object[expr]` (computed), or
 *  `object.#x` (private: the Identifier `#x` reads the class's private name). */
export interface MemberExpression extends Base {
  type: "MemberExpression";
  object: Expression;
  property: Expression;
  computed: boolean;
  private?: boolean;
  optional?: boolean;  // `a?.b`, inside a ChainExpression
}

/** What assignment and update expressions write to. */
export type Target = Identifier | MemberExpression | SuperMember;

export interface ObjectExpression extends Base {
  type: "ObjectExpression";
  properties: (Property | SpreadElement)[];
}

/** `key: value` (shorthand `{ x }` and methods too), or an accessor (`kind` get/set:
 *  `value` is its function). `key`: an Identifier or a Literal naming the key, or any
 *  expression when computed. `__proto__: v` (not computed, not shorthand) sets the
 *  prototype instead (§B.3.1). */
export interface Property extends Base {
  type: "Property";
  kind: "init" | "get" | "set";
  key: Expression;
  computed: boolean;
  value: Expression;
  isProto: boolean;
}

export interface ArrayExpression extends Base {
  type: "ArrayExpression";
  elements: (Expression | SpreadElement | null)[];  // null: a hole
}

export interface ThisExpression extends Base {
  type: "ThisExpression";
}

/** `` `a${x}b` `` (§13.2.8): the strings (cooked) around each substitution; quasis has one
 *  more element than expressions. */
export interface TemplateLiteral extends Base {
  type: "TemplateLiteral";
  quasis: string[];
  expressions: Expression[];
}

/** A tagged template's first argument (§13.2.8.4 GetTemplateObject): the same frozen array of
 *  cooked strings (undefined for an invalid escape), with `raw`, every time the site runs. */
export interface TemplateObject extends Base {
  type: "TemplateObject";
  cooked: (string | null)[];
  raw: string[];
}

/** `import.meta` (§13.3.12) of the original module at `file` (absolute): one object per file. */
export interface ImportMeta extends Base {
  type: "ImportMeta";
  file: string;
  /** the program's entry module (Node's import.meta.main) */
  main: boolean;
}

/** `import(source, options)` (§13.3.10) left in the program: resolved against `file`. */
export interface ImportCall extends Base {
  type: "ImportCall";
  source: Expression;
  options: Expression | null;
  file: string;
}

/** A host primitive: what `import { name } from "visaljs:host"` binds. */
export interface HostFunction extends Base {
  type: "HostFunction";
  name: string;
}

export interface SequenceExpression extends Base {
  type: "SequenceExpression";
  expressions: Expression[];
}

export type Node =
  | Program
  | Statement
  | Expression
  | VariableDeclarator
  | CatchClause
  | SwitchCase
  | Property
  | ClassMember
  | ObjectPattern
  | ArrayPattern
  | PatternProperty
  | PatternElement;
