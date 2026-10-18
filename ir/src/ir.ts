// The IR: a CFG of basic blocks over SSA values, with JS-level
// operations and per-block exception handlers.
//
// Exception edges: inside a protected region (block.handler set) an
// instruction that may throw is the LAST instruction of its block, and the
// block's exceptional successor is the handler. The builder guarantees it by
// splitting blocks, so the variable values reaching a handler are exactly
// those before the throwing instruction (and never its result).
import type { Loc } from "./loc.ts";
import { isSubtype, T, type Repr, type Type } from "./types.ts";

export type Op =
  // values
  | "param" | "phi" | "const" | "empty"
  // bindings (local variables are SSA values)
  | "load_global" | "store_global" | "global_name" | "global_typeof_name" | "global_this" | "check_tdz"
  | "declare_global" | "set_global_name"
  | "sloppy_this" | "make_function" | "make_arguments" | "host_function"
  // modules: an original file's import.meta (slot `index` caches it); import() left by the bundler
  | "import_meta" | "dynamic_import"
  // templates (§13.2.8): ToString of a substitution; a tagged template's object (slot `index` caches it)
  | "to_string" | "template_object"
  // a regular expression literal (§13.2.7.3): a new RegExp each evaluation
  | "regexp"
  // a BigInt literal: a static cell
  | "bigint"
  // closures: a scope's captured variables live in an environment
  | "env_new" | "env_copy" | "env_load" | "env_store"
  // operators: generic, on boxed JSValues
  | "add" | "sub" | "mul" | "div" | "mod" | "exp"
  | "shl" | "sar" | "shr" | "bitand" | "bitor" | "bitxor"
  | "eq" | "ne" | "strict_eq" | "strict_ne" | "lt" | "le" | "gt" | "ge"
  // a switch on string literals (Instr.cases): the index of the first case === the operand, or -1
  | "switch_string"
  | "neg" | "bitnot" | "not" | "typeof" | "to_number" | "to_numeric" | "to_boolean" | "is_nullish" | "inc" | "dec"
  // operators on proven Numbers (the optimizer's specialize pass): inline, never throw
  | "num_add" | "num_sub" | "num_mul" | "num_div" | "num_mod" | "num_neg" | "num_inc" | "num_dec"
  | "num_lt" | "num_le" | "num_gt" | "num_ge" | "num_eq" | "num_ne"
  | "num_bitand" | "num_bitor" | "num_bitxor" | "num_bitnot" | "num_shl" | "num_sar" | "num_shr"
  | "in" | "instanceof" | "to_property_key"
  // typed code ("use visaljs"), which trusts the built-ins: s.charCodeAt(i) of a string s, a Number;
  // Math.<Instr.target>(x) of a Number (sqrt, abs, floor, ceil, trunc), C's
  | "char_code_at" | "math"
  // for…in: an iterator over an object's enumerable string keys, and its next key (undefined: done)
  | "for_in_start" | "for_in_next"
  // iterators (for…of): a record from GetIterator, its next value (EMPTY: done), IteratorClose
  | "iter_start" | "iter_next" | "not_empty" | "iter_close" | "iter_close_throw"
  // destructuring: the next value (undefined when done), the rest as an array; objects
  | "iter_value" | "iter_rest" | "require_coercible" | "object_rest" | "object_spread"
  // generators: pause points and what a resume brought
  | "gen_start" | "yield" | "yield_raw" | "resume_is_return" | "resume_mode"
  | "async_start" | "await"
  // async iteration (for await, yield* in async generators): steps whose results are awaited
  | "async_iter_start" | "async_iter_next" | "async_iter_value" | "async_iter_return" | "async_iter_check"
  | "ays_step" | "ays_settled" | "ays_status"
  | "ys_start" | "ys_step" | "ys_status"
  // properties: *_prop take a constant key (Instr.key) and use an inline cache; *_elem a computed one
  | "get_prop" | "set_prop" | "get_elem" | "set_elem" | "delete_prop" | "delete_elem"
  | "get_index" | "set_index"
  // literals
  | "new_object" | "define_prop" | "define_elem" | "define_accessor" | "set_proto" | "new_array"
  | "array_append" | "array_spread"
  // classes (§15.7) and super
  | "class_setup" | "set_home" | "define_class_member" | "super_get" | "super_set"
  | "super_construct" | "super_construct_spread" | "bind_this" | "check_this" | "derived_return"
  | "define_field" | "new_private_name" | "private_add" | "private_get" | "private_set" | "private_in"
  // calls
  | "call_direct" | "call" | "new" | "call_spread" | "new_spread" | "call_runtime"
  // `new F(…)` where F is a constructor of this module: the function
  // value first, then one argument per declared parameter
  | "construct_direct"
  // inlining: whether a value is the closure of function Instr.target (in this
  // realm); a closure's environment; `this` for an inlined `new F` (Instr.index inline slots);
  // [[Construct]]'s result: the body's value if an object, else `this`
  | "same_function" | "function_env" | "new_instance" | "construct_result"
  // exceptions
  | "take_exception";

export interface OpInfo {
  /** Operand count, or "any" for calls. */
  arity: number | "any";
  result: boolean;
  mayThrow: boolean;
  /** Can trigger a GC. */
  allocates: boolean;
  /** Can run user code (valueOf, getters, callees). */
  callsUser: boolean;
}

const pure = (arity: number): OpInfo => ({ arity, result: true, mayThrow: false, allocates: false, callsUser: false });
/** Generic operators: ToPrimitive may call valueOf/toString on objects. */
const generic = (arity: number): OpInfo => ({ arity, result: true, mayThrow: true, allocates: true, callsUser: true });
const call: OpInfo = { arity: "any", result: true, mayThrow: true, allocates: true, callsUser: true };

export const OPS: Record<Op, OpInfo> = {
  param: pure(0),
  phi: { ...pure(0), arity: "any" },
  const: pure(0),
  empty: pure(0),
  load_global: pure(0),
  store_global: { arity: 1, result: false, mayThrow: false, allocates: false, callsUser: false },
  global_name: { arity: 0, result: true, mayThrow: true, allocates: true, callsUser: true },  // ReferenceError; getters
  global_typeof_name: { arity: 0, result: true, mayThrow: true, allocates: true, callsUser: true },  // undefined when absent
  global_this: pure(0),
  /* a script's top-level var (index 0) or function (index 1, operand: the function) as a global property */
  declare_global: { arity: "any", result: false, mayThrow: true, allocates: true, callsUser: false },
  set_global_name: { arity: 1, result: false, mayThrow: true, allocates: true, callsUser: true },  // undeclared `x = v`
  sloppy_this: pure(1),                        // undefined/null → globalThis (a sloppy function's prologue)
  make_arguments: { ...pure(3), allocates: true },  // actual arguments array, callee, env → the arguments object (`table`: mapped)
  make_function: { ...pure(0), arity: "any", allocates: true },  // a new function object for Instr.target; operand: its environment, if it takes one
  host_function: { ...pure(0), allocates: true },
  import_meta: { arity: 0, result: true, mayThrow: true, allocates: true, callsUser: false },  // Instr.target: the file; slot 1: the entry
  dynamic_import: { arity: 2, result: true, mayThrow: true, allocates: true, callsUser: true },  // specifier, options → a promise
  to_string: generic(1),
  template_object: { arity: 0, result: true, mayThrow: true, allocates: true, callsUser: false },
  regexp: { arity: 0, result: true, mayThrow: true, allocates: true, callsUser: false },  // Instr.regexp
  bigint: pure(0),                             // Instr.bigint  // Instr.template  // the function object of host primitive Instr.target
  env_new: { ...pure(1), allocates: true },    // parent → a new environment of Instr.index slots
  env_copy: { ...pure(1), allocates: true },   // a per-iteration copy (for (let …))
  env_load: pure(1),                           // env → vars[slot], `index` parents up
  env_store: { arity: 2, result: false, mayThrow: false, allocates: false, callsUser: false },  // env, value
  check_tdz: { arity: 1, result: true, mayThrow: true, allocates: true, callsUser: false },   // ReferenceError
  add: generic(2), sub: generic(2), mul: generic(2), div: generic(2), mod: generic(2), exp: generic(2),
  shl: generic(2), sar: generic(2), shr: generic(2), bitand: generic(2), bitor: generic(2), bitxor: generic(2),
  eq: generic(2), ne: generic(2), lt: generic(2), le: generic(2), gt: generic(2), ge: generic(2),
  strict_eq: pure(2), strict_ne: pure(2),
  switch_string: pure(1),
  neg: generic(1), bitnot: generic(1), to_number: generic(1), to_numeric: generic(1), inc: generic(1), dec: generic(1),
  not: pure(1), to_boolean: pure(1), is_nullish: pure(1),
  num_add: pure(2), num_sub: pure(2), num_mul: pure(2), num_div: pure(2), num_mod: pure(2),
  num_neg: pure(1), num_inc: pure(1), num_dec: pure(1),
  num_lt: pure(2), num_le: pure(2), num_gt: pure(2), num_ge: pure(2), num_eq: pure(2), num_ne: pure(2),
  num_bitand: pure(2), num_bitor: pure(2), num_bitxor: pure(2), num_bitnot: pure(1),
  num_shl: pure(2), num_sar: pure(2), num_shr: pure(2),
  typeof: { ...pure(1), allocates: false },
  char_code_at: { ...pure(2), allocates: true },  // a rope is flattened
  math: pure(1),
  in: generic(2), instanceof: generic(2), to_property_key: generic(1),
  for_in_start: { ...generic(1), callsUser: false }, for_in_next: { ...generic(1), callsUser: false },
  iter_start: generic(1), iter_next: generic(1), not_empty: pure(1),
  iter_close: { ...generic(1), result: false },
  iter_close_throw: { arity: 1, result: false, mayThrow: false, allocates: true, callsUser: true },  // the pending exception wins
  iter_value: generic(1), iter_rest: generic(1),
  require_coercible: { ...generic(1), callsUser: false },  // TypeError for null and undefined
  object_rest: generic(2),  // source, array of keys to leave out → a new object
  object_spread: { ...generic(2), result: false },  // target, source: `{ ...source }` copies its own enumerable properties
  /* the end of the prologue: the entry creates the generator (callee → its prototype), saves
   * the live values and returns it; the resume function starts after it */
  gen_start: { arity: 1, result: false, mayThrow: false, allocates: true, callsUser: true },
  /* pause points: yield hands its operand to next() (resumed by throw(): an exception here);
   * yield_raw hands on yield*'s inner result object as it is */
  yield: { arity: 1, result: true, mayThrow: true, allocates: true, callsUser: true },
  yield_raw: { arity: 1, result: true, mayThrow: false, allocates: true, callsUser: true },
  /* how the last resume came: return() (true), or the mode as a number (yield*) */
  /* async functions: the very start (the prologue runs in the resume function too, so its
   * errors reject the promise); the entry creates the state, runs it to the first await and
   * returns the promise. await pauses until its operand settles (rejected: an exception here) */
  async_start: { arity: 0, result: false, mayThrow: false, allocates: true, callsUser: true },
  await: { arity: 1, result: true, mayThrow: true, allocates: true, callsUser: true },
  /* GetIterator(async) as a record (a sync iterator is wrapped); next() called (its result is
   * awaited); the awaited result's value (EMPTY: done); return() called (EMPTY: none, or the
   * record is done), its awaited result checked to be an object */
  async_iter_start: generic(1), async_iter_next: generic(1), async_iter_value: generic(2),
  async_iter_return: generic(1), async_iter_check: generic(1),
  /* yield* in an async generator: start a step (record, received, mode) → a value to await;
   * settle it with the awaited value → yield* status 0 yield it, 1 done, 2 return it, 3 await it again */
  ays_step: generic(3), ays_settled: generic(2),
  ays_status: { arity: 1, result: true, mayThrow: false, allocates: false, callsUser: false },
  resume_is_return: { arity: 0, result: true, mayThrow: false, allocates: false, callsUser: false },
  resume_mode: { arity: 0, result: true, mayThrow: false, allocates: false, callsUser: false },
  /* yield*: GetIterator; one delegation step (received, mode) → a value; its outcome (0 yield
   * it, 1 done: the value is yield*'s, 2 return it) */
  ys_start: generic(1), ys_step: generic(3),
  ys_status: { arity: 1, result: true, mayThrow: false, allocates: false, callsUser: false },
  get_prop: generic(1), get_elem: generic(2),
  set_prop: { ...generic(2), result: false }, set_elem: { ...generic(3), result: false },
  /* get_elem / set_elem whose key is a Number: C reads and writes a dense array's
     elements inline, anything else as get_elem / set_elem */
  get_index: generic(2), set_index: { ...generic(3), result: false },
  delete_prop: generic(1), delete_elem: generic(2),
  new_object: { ...pure(0), allocates: true },
  define_prop: { arity: 2, result: false, mayThrow: false, allocates: true, callsUser: false },
  define_elem: { arity: 3, result: false, mayThrow: false, allocates: true, callsUser: false },  // the key is already a property key
  /* obj, fn (constant key) or obj, key, fn; `index` 0 = getter, 1 = setter */
  define_accessor: { arity: "any", result: false, mayThrow: false, allocates: true, callsUser: false },
  set_proto: { arity: 2, result: false, mayThrow: false, allocates: true, callsUser: false },
  new_array: { ...pure(0), arity: "any", allocates: true },
  array_append: { arity: 2, result: false, mayThrow: true, allocates: true, callsUser: false },  // array, value (EMPTY: a hole); RangeError past 2^32 - 1
  array_spread: { arity: 2, result: false, mayThrow: true, allocates: true, callsUser: true },   // array, iterable
  call_spread: { ...call, arity: 3 },  // f, this, arguments array
  new_spread: { ...call, arity: 2 },   // f, arguments array
  new: call,
  class_setup: { ...generic(2), callsUser: true },    // ctor, heritage (EMPTY: none) → the prototype; reads heritage.prototype
  set_home: { arity: 2, result: false, mayThrow: false, allocates: false, callsUser: false },  // function, home object
  define_class_member: { arity: "any", result: false, mayThrow: false, allocates: true, callsUser: false },  // target, [key,] fn; index 0 method, 1 get, 2 set
  super_get: { ...generic(2), arity: "any" },         // callee, this, [key]
  super_set: { ...generic(3), arity: "any", result: false },  // callee, this, [key,] value
  super_construct: { ...call },                       // callee, new.target, args…
  super_construct_spread: { ...call, arity: 3 },      // callee, new.target, arguments array
  bind_this: { ...generic(2), callsUser: false },     // current this (EMPTY), result → ReferenceError if already bound
  check_this: { ...generic(1), callsUser: false },    // ReferenceError before super()
  derived_return: { ...generic(2), callsUser: false },  // returned value, this → the constructor's result
  define_field: { arity: "any", result: false, mayThrow: true, allocates: true, callsUser: false },  // obj, [key,] value
  new_private_name: { ...pure(1), allocates: true },   // "#x" → a fresh private name
  private_add: { ...generic(3), result: false, callsUser: false },  // obj, name, value; index 0 field, 1 method, 2 get, 3 set
  private_get: generic(2),                             // obj, name
  private_set: { ...generic(3), result: false },       // obj, name, value
  private_in: { ...generic(2), callsUser: false },     // name, obj
  call_direct: call,
  construct_direct: call,
  same_function: pure(1),
  function_env: pure(1),
  new_instance: { arity: 1, result: true, mayThrow: true, allocates: true, callsUser: false },
  construct_result: pure(2),
  call: call,
  call_runtime: call,
  take_exception: pure(0),
};

export type JSConst = number | string | boolean | null | undefined;

/** A typed unit's export, as a calling module sees it: its typed entry (raw C parameters, no
 *  checks), for arguments of the declared types, and its checked (generic) entry otherwise. */
export interface TypedCall {
  direct: string;
  generic: string;
  params: { type: Type; repr: Repr }[];
  returns: Type;
  returnRepr: Repr;
}

/** Whether a direct call of a typed function ("use visaljs") may take its typed entry: each
 *  declared parameter's argument proven of its type (`type`: the types; inference passes the ones
 *  it is inferring). Otherwise the call goes through the checked entry, whose untyped copy takes
 *  any arguments: tsc lets typed code pass a number to an `int`. */
export function declaredCallFits(i: Instr, callee: FunctionIR, type: (v: Instr) => Type = (v) => v.type): boolean {
  const declared = callee.meta?.declared;
  if (!declared) return true;
  return declared.every((t, k) => {
    if (t === undefined) return true;
    const o = i.operands[k];
    const a = o ? type(o) & ~T.Empty : T.Undefined;
    return a !== T.None && isSubtype(a, t);
  });
}

/** Whether a typed export's call takes its typed entry: as many arguments as it declares, each
 *  proven of its declared type (inference, unboxing and C emission all ask this). */
export function typedCallFits(i: Instr): boolean {
  const tc = i.typedCall;
  if (!tc || i.operands.length - 2 !== tc.params.length) return false;
  return i.operands.slice(2).every((o, k) => {
    const t = o.type & ~T.Empty;
    return t !== T.None && isSubtype(t, tc.params[k]!.type);
  });
}

/** A constant property key, as ToPropertyKey makes it: an array index or a string (an atom). */
export type PropKey = { index: number } | { name: string };

/** The key for `o.name` or `{ 1: v }`: canonical array indices (0 … 2^32 - 2) become index keys. */
export function propKey(v: string | number): PropKey {
  const s = String(v);
  if (/^(0|[1-9][0-9]*)$/.test(s) && Number(s) <= 4294967294) return { index: Number(s) };
  return { name: s };
}

export interface Instr {
  id: number;
  op: Op;
  operands: Instr[];
  type: Type;
  repr: Repr;
  /** From OPS; an optimization that proves it can't throw clears it. */
  mayThrow: boolean;
  /** A generic operator whose C tries the inline Number path first: its operands
   *  can be Numbers, and it runs in a loop. */
  numberFirst?: boolean;
  /** A one-argument call of a built-in whose C does its work inline when the callee is that
   *  built-in: `js_call_<builtin>`, e.g. math_sqrt, char_code_at. */
  builtin?: string;
  block: Block;
  loc: Loc | null;
  /** The JS variable this value was written to, for readable dumps and C names. */
  name?: string;
  /** const */
  lit?: { value: JSConst };
  /** param: index; load_global / store_global: slot */
  index?: number;
  /** global_name: the name; call_direct, construct_direct: the callee function's name;
   *  call_runtime: the runtime function; call / new: the callee's source text, for "x is not a function" */
  target?: string;
  /** construct_direct: the callee's source text, for "x is not a constructor" */
  text?: string;
  /** set_prop: `this.key = v` copied from a constructor's body (inlining): most likely an addition */
  addsProp?: boolean;
  /** get_elem, set_elem: the key is most likely the same at every run (a module binding stored
   *  once): the site caches the key it sees, and is a named access while the key stays it */
  keyedSite?: boolean;
  /** new of a typed array only indexed (the typed-arrays pass), and its accesses: the element type
   *  of its view, taken once after `new` */
  taView?: "i8" | "u8" | "i32" | "f64";
  /** call of a typed unit's export (a "visaljs:host" import the typed unit defines) */
  typedCall?: TypedCall;
  /** call, construct_direct: the fallback of an inlined site (its guard failed): not inlined again */
  slowPath?: boolean;
  /** *_prop, define_prop */
  key?: PropKey;
  /** env_load / env_store: the variable's slot (`index` is the depth) */
  slot?: number;
  /** make_arguments of a mapped arguments object: each parameter's environment slot (-1: none) */
  table?: number[];
  /** template_object: the site's cooked (null: undefined) and raw strings */
  template?: { cooked: (string | null)[]; raw: string[] };
  /** regexp: the literal's pattern and flags */
  regexp?: { pattern: string; flags: string };
  /** bigint: the literal's value, in decimal */
  bigint?: string;
  /** switch_string: the cases' strings, in order */
  cases?: string[];
  /** phi: one incoming value per predecessor */
  incoming?: { block: Block; value: Instr }[];
}

export type Terminator = { loc: Loc | null } & (
  | { kind: "jump"; target: Block }
  | { kind: "branch"; cond: Instr; then: Block; else: Block }
  | { kind: "return"; value: Instr }
  | { kind: "throw"; value: Instr }  // to the block's handler, or out of the function
  | { kind: "unreachable" }
);

export interface Block {
  id: number;
  fn: FunctionIR;
  phis: Instr[];
  instrs: Instr[];
  term: Terminator | null;
  /** Where exceptions raised in this block go; null: out of the function (return JS_EXCEPTION). */
  handler: Block | null;
  /** Normal and exceptional predecessors. */
  preds: Block[];
}

/** What a function object is made from (in C, the static JSFunctionInfo). */
export interface FunctionMeta {
  /** `name` and `length` of its function objects. */
  jsName: string;
  length: number;
  /** function*: emitted as an entry (the prologue, up to gen_start) and a resume
   *  function (the body, a state machine over its pause points). */
  generator: boolean;
  /** async function: the same split, at async_start; the entry returns a promise. */
  async: boolean;
  /** Has [[Construct]] (declarations, function expressions, class constructors; not methods or arrows). */
  constructor: boolean;
  /** A class constructor: can't be called without `new`; a derived one doesn't create `this`. */
  classCtor: "base" | "derived" | null;
  arrow: boolean;
  /** The last parameter is a rest array: the generic entry collects argv beyond the others. */
  hasRest: boolean;
  /** A "use visaljs" file's function: its parameters' declared types, trusted (as fn.params, the
   *  hidden ones undefined). Typed callers were checked by tsc; every other call comes through
   *  the generic entry, which checks them. */
  declared?: (Type | undefined)[];
  /** The declared parameters that are typed arrays: their element types (as `declared`). */
  declaredViews?: (Instr["taView"] | undefined)[];
  /** Called from outside the module (a typed unit's entries): its parameters can't be inferred
   *  from its call sites. */
  external?: boolean;
  /** A typed function's untyped copy (its name): what its generic entry runs when the arguments
   *  aren't the declared types, so the call behaves as the plain JS would. */
  untyped?: string;
  /** The direct entry's hidden leading parameters: the environment it
   *  closes over, the function object (a named expression reading its own name),
   *  and `this` (only when used). */
  takesEnv: boolean;
  takesCallee: boolean;
  /** Also a hidden parameter, after `this`: every actual argument as an array (for `arguments`). */
  takesArguments: boolean;
  takesThis: boolean;
  /** `new.target` (undefined for a call). */
  takesNewTarget: boolean;
  /** Its slice of the module's source (Function.prototype.toString), or null. */
  source: { start: number; end: number } | null;
}

export interface FunctionIR {
  /** Unique within the module: C names derive from it. */
  name: string;
  /** Absent for the script's top-level code. */
  meta?: FunctionMeta;
  params: Instr[];
  /** How the direct entry returns its result: absent, boxed. A function returning
   *  a double or a bool signals a throw by the pending exception alone. */
  returnRepr?: Repr;
  blocks: Block[];  // blocks[0] is the entry
  strict: boolean;
  loc: Loc | null;
}

export interface GlobalSlot {
  name: string;
  slot: number;
}

export interface ModuleIR {
  functions: FunctionIR[];
  /** The script's top-level code. */
  main: FunctionIR;
  /** mod_globals[]: top-level bindings. */
  globals: GlobalSlot[];
  /** The script's text: functions' toString slices it. */
  source: string;
}

// ---- CFG helpers -----------------------------------------------------------

/** The instruction that raises this block's exceptions to its handler, if any. */
export function throwingInstr(b: Block): Instr | null {
  const last = b.instrs.at(-1);
  return last && last.mayThrow ? last : null;
}

export function normalSuccessors(b: Block): Block[] {
  const t = b.term;
  if (!t) return [];
  if (t.kind === "jump") return [t.target];
  if (t.kind === "branch") return t.then === t.else ? [t.then] : [t.then, t.else];
  return [];
}

/** Normal successors, then the handler when an exception can leave this block. */
export function successors(b: Block): Block[] {
  const out = normalSuccessors(b);
  if (b.handler && (throwingInstr(b) || b.term?.kind === "throw") && !out.includes(b.handler)) out.push(b.handler);
  return out;
}

/** Whether the edge from→to is only exceptional (the values before the throwing instruction flow along it). */
export function isExceptionalEdge(from: Block, to: Block): boolean {
  return from.handler === to && !normalSuccessors(from).includes(to);
}
