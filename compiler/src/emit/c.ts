// C emission: IR → C that includes js_runtime.h: one file, or for a big program
// several that compile in parallel.
//
// - Every used SSA value is a C local declared at the top of its function;
//   constants are inlined (static strings live in .rodata).
// - Out of SSA: phi copies are emitted on each edge, inline, as parallel
//   copies through temporaries; critical edges need no block splitting.
// - After an instruction that may throw: `if (js_is_exception(v))` goes to
//   the block's handler (after that edge's phi copies) or returns JS_EXCEPTION.
// - #line directives map back to the JS source (gdb, error locations).
import type { Loc } from "../frontend/ast.ts";
import type { Block, FunctionIR, Instr, JSConst, ModuleIR, Op, PropKey, Repr } from "@visaljs/ir";
import type { HostPrimitives } from "../frontend/host.ts";
import { isSubtype, OPS, successors, T } from "@visaljs/ir";
import { liveAfterPauses } from "@visaljs/ir";
import type { CoreEntry } from "./core.ts";
import { ATOMS } from "./atoms.ts";
import { jsStringHash } from "./strhash.ts";
import { flagBits, regexpKey } from "./regexp.ts";

/** The runtime's predefined atoms by content: referenced, never re-emitted. */
const RUNTIME_ATOMS = new Map(ATOMS.map(([id, s]) => [s, id]));

/** Operators that are plain runtime calls: C function and whether it takes ctx. */
const CALLS: Partial<Record<Op, [string, boolean]>> = {
  add: ["js_add", true], sub: ["js_sub", true], mul: ["js_mul", true], div: ["js_div", true],
  mod: ["js_mod", true], exp: ["js_exp", true], shl: ["js_shl", true], sar: ["js_sar", true],
  shr: ["js_shr", true], bitand: ["js_bitand", true], bitor: ["js_bitor", true], bitxor: ["js_bitxor", true],
  eq: ["js_eq", true], ne: ["js_ne", true], strict_eq: ["js_strict_eq", true], strict_ne: ["js_strict_ne", true],
  lt: ["js_lt", true], le: ["js_le", true], gt: ["js_gt", true], ge: ["js_ge", true],
  neg: ["js_neg", true], bitnot: ["js_bitnot", true], to_number: ["js_to_number_value", true],
  to_numeric: ["js_to_numeric", true], inc: ["js_inc", true], dec: ["js_dec", true],
  typeof: ["js_typeof", true], not: ["js_not", false], to_boolean: ["js_to_boolean", false],
  is_nullish: ["js_is_nullish_value", false], take_exception: ["js_take_exception", true],
  in: ["js_in", true], instanceof: ["js_instanceof", true], to_property_key: ["js_to_property_key", true],
  for_in_start: ["js_for_in_start", true], for_in_next: ["js_for_in_next", true],
  iter_start: ["js_iter_start", true], iter_next: ["js_iter_next", true], not_empty: ["js_not_empty", false],
  iter_value: ["js_iter_value", true], iter_rest: ["js_iter_rest", true],
  ys_start: ["js_yield_star_start", true], ys_status: ["js_yield_star_status", false],
  async_iter_start: ["js_async_iter_start", true], async_iter_next: ["js_async_iter_next", true],
  async_iter_value: ["js_async_iter_value", true], async_iter_return: ["js_async_iter_return", true],
  async_iter_check: ["js_async_iter_check", true], ays_step: ["js_async_yield_star_step", true],
  ays_settled: ["js_async_yield_star_settled", true], ays_status: ["js_async_yield_star_status", false],
  require_coercible: ["js_require_coercible", true], object_rest: ["js_object_rest", true],
  to_string: ["js_to_string", true],
  num_add: ["js_num_add", false], num_sub: ["js_num_sub", false], num_mul: ["js_num_mul", false],
  num_div: ["js_num_div", false], num_mod: ["js_num_mod", false], num_neg: ["js_num_neg", false],
  num_inc: ["js_num_inc", false], num_dec: ["js_num_dec", false], num_lt: ["js_num_lt", false],
  num_le: ["js_num_le", false], num_gt: ["js_num_gt", false], num_ge: ["js_num_ge", false],
  num_eq: ["js_num_eq", false], num_ne: ["js_num_ne", false], num_bitand: ["js_num_bitand", false],
  num_bitor: ["js_num_bitor", false], num_bitxor: ["js_num_bitxor", false], num_bitnot: ["js_num_bitnot", false],
  num_shl: ["js_num_shl", false], num_sar: ["js_num_sar", false], num_shr: ["js_num_shr", false],
};

/** Runtime functions `call_runtime` can name. */
const RUNTIME: Record<string, (args: string[]) => string> = {
  print: (args) => `js_print(ctx, JS_UNDEFINED, JS_UNDEFINED, ${args.length}, ${argArray(args)}, JS_UNDEFINED)`,
  throw_const_assign: () => "js_throw_const_assign(ctx)",
};

function argArray(args: string[]): string {
  return args.length ? `(const JSValue[]){ ${args.join(", ")} }` : "NULL";
}

function ident(name: string): string {
  let out = "";
  for (const ch of name) out += /[A-Za-z0-9_]/.test(ch) ? ch : `_u${ch.codePointAt(0)!.toString(16)}_`;
  return out;
}

/** A C string literal: UTF-8, printable ASCII as is, everything else as octal escapes. */
export function cString(s: string | Uint8Array): string {
  const bytes = typeof s === "string" ? new TextEncoder().encode(s) : s;
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += "\\\\";
    else if (b === 0x3f) out += "\\?";  // no trigraphs
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\${b.toString(8).padStart(3, "0")}`;
  }
  return out + '"';
}

/** An exact C99 hex-float literal for a finite double: no decimal re-rounding. */
export function hexFloat(d: number): string {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, d);
  const bits = buf.getBigUint64(0);
  const sign = bits >> 63n ? "-" : "";
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = (bits & 0xfffffffffffffn).toString(16).padStart(13, "0").replace(/0+$/, "");
  if (exponent === 0 && mantissa === "") return `${sign}0.0`;
  const frac = mantissa ? `.${mantissa}` : "";
  return exponent === 0 ? `${sign}0x0${frac}p-1022` : `${sign}0x1${frac}p${exponent - 1023}`;
}

// ---- Static strings -------------------------------------------------------------

/** A file-level datum: its definition (`static` in a single file) and, for a split program,
 *  the declaration the other files see it by. */
interface Decl {
  define(storage: string): string;
  declare: string;
}

function datum(type: string, name: string, init: string): Decl {
  return { define: (storage) => `${storage}const ${type} ${name} = ${init};`, declare: `extern const ${type} ${name};` };
}

/** One datum or the other, by the limb size the C file is compiled with. */
function byLimbBits(d64: Decl, d32: Decl): Decl {
  return {
    define: (storage) => `#if JS_LIMB_BITS == 64\n${d64.define(storage)}\n#else\n${d32.define(storage)}\n#endif`,
    declare: `#if JS_LIMB_BITS == 64\n${d64.declare}\n#else\n${d32.declare}\n#endif`,
  };
}

/** String literals and property names: static atoms, registered at startup,
 *  so a literal is also a property key with no interning at runtime. */
class Strings {
  readonly decls: Decl[] = [];
  /** Prefixes every file-level C name: several modules can share one C file (the test262 batches). */
  readonly prefix: string;

  /** Compiled literals, by regexpKey (from the regexp-compile tool); the others compile at run time. */
  private readonly bytecode: ReadonlyMap<string, Uint8Array>;

  /** Static atoms another C file defines and registers (the test262 harness): string → its C
   *  symbol. These are referred to, not defined: the runtime rejects a duplicate static atom. */
  private readonly external: ReadonlyMap<string, string>;
  private readonly declared = new Set<string>();
  /** The external atoms are defined earlier in this C file (the harness's own): no declaration. */
  externalInFile = false;

  constructor(prefix: string, bytecode: ReadonlyMap<string, Uint8Array> = new Map(), external: ReadonlyMap<string, string> = new Map()) {
    this.prefix = prefix;
    this.bytecode = bytecode;
    this.external = external;
  }

  /** The atoms this file defines, by string: what a file emitted after it can refer to. */
  get atoms(): ReadonlyMap<string, string> {
    return this.names;
  }

  private readonly regexps = new Map<string, string>();
  private readonly bigints = new Map<string, string>();

  /** A BigInt literal as a static cell: its limbs for both limb sizes, chosen when
   *  the C file is compiled. */
  bigint(value: string): string {
    let name = this.bigints.get(value);
    if (!name) {
      name = `${this.prefix}jsb_${this.bigints.size}`;
      this.bigints.set(value, name);
      const decl = (bits: number, suffix: string) => {
        const limbs = bigintLimbs(BigInt(value), bits).map((l) => `0x${l.toString(16)}${suffix}`);
        return datum(`JS_STATIC_BIGINT_TYPE(${limbs.length})`, name!, `JS_STATIC_BIGINT_INIT(${limbs.length}, { ${limbs.join(", ")} })`);
      };
      this.decls.push(byLimbBits(decl(64, "ull"), decl(32, "u")));
    }
    return `JS_STATIC_BIGINT(${name})`;
  }

  /** A `const JSRegExpLiteral *` for a regex literal: its bytecode, source and flags. */
  regexp(pattern: string, flags: string): string {
    const key = regexpKey(pattern, flags);
    let name = this.regexps.get(key);
    if (!name) {
      name = `${this.prefix}jsrl_${this.regexps.size}`;
      this.regexps.set(key, name);
      const bc = this.bytecode.get(key);
      let code = "NULL";
      if (bc) {
        code = `${this.prefix}jsr_${this.regexps.size - 1}`;
        this.decls.push(datum("uint8_t", `${code}[]`, `{ ${[...bc].join(", ")} }`));
      }
      this.decls.push(datum("JSRegExpLiteral", name, `{ ${code}, ${this.cellPointer(pattern)}, ${flagBits(flags) ?? 0} }`));
    }
    return `&${name}`;
  }

  private readonly names = new Map<string, string>();

  private readonly plain = new Map<string, string>();

  private readonly switches = new Map<string, string>();

  /** A switch's case strings (js_switch_string): a static array of `const JSString *`, shared by
   *  the switches with the same cases. */
  switchCases(cases: readonly string[]): string {
    const key = JSON.stringify(cases);
    let name = this.switches.get(key);
    if (!name) {
      name = `${this.prefix}jsw_${this.switches.size}`;
      this.switches.set(key, name);
      this.decls.push(datum("JSString *const", `${name}[]`, `{ ${cases.map((s) => this.cellPointer(s)).join(", ")} }`));
    }
    return name;
  }

  /** The cells to register with js_register_static_atoms. */
  get cells(): string[] {
    return [...this.names.values()];
  }

  /** A `const JSString *` constant for `s`, for static initializers (a function's name). */
  cellPointer(s: string): string {
    if (s.length === 0) return "NULL";  /* the empty name */
    const runtime = RUNTIME_ATOMS.get(s);
    if (runtime) return `(const JSString *)&js_atom_${runtime}`;
    if (s.length === 1 && s.charCodeAt(0) <= 0xff) {
      /* not an atom: the one-unit atoms are the runtime's, and a name needn't be an atom */
      let name = this.plain.get(s);
      if (!name) {
        name = `${this.prefix}jsn_${this.plain.size}`;
        this.plain.set(s, name);
        this.decls.push(datum("JS_STATIC_LATIN1_TYPE(1)", name, `JS_STATIC_LATIN1_INIT(1, 0, ${cString(Uint8Array.of(s.charCodeAt(0)))})`));
      }
      return `(const JSString *)&${name}`;
    }
    const ref = this.ref(s);  // JS_STATIC_STR(jss_n)
    return `(const JSString *)&${/JS_STATIC_STR\((\w+)\)/.exec(ref)![1]}`;
  }

  ref(s: string): string {
    if (s.length === 0) return "js_empty_string()";
    if (s.length === 1 && s.charCodeAt(0) <= 0xff) return `js_char_string(${s.charCodeAt(0)})`;  // static atoms
    const runtime = RUNTIME_ATOMS.get(s);
    if (runtime) return `JS_ATOM(${runtime})`;
    const external = this.external.get(s);
    if (external) {
      if (!this.externalInFile && !this.declared.has(external)) {
        /* as a bare cell: only its address is taken, and every unit of a batch file declares it the same */
        this.declared.add(external);
        const declare = `extern const JSCell ${external};`;
        this.decls.push({ define: () => declare, declare });
      }
      return `JS_STATIC_STR(${external})`;
    }
    let name = this.names.get(s);
    if (!name) {
      name = `${this.prefix}jss_${this.names.size}`;
      this.names.set(s, name);
      const hash = `0x${jsStringHash(s).toString(16).padStart(8, "0")}u`;
      const units = [...Array(s.length).keys()].map((i) => s.charCodeAt(i));
      if (units.every((u) => u <= 0xff)) {
        this.decls.push(datum(`JS_STATIC_LATIN1_TYPE(${s.length})`, name, `JS_STATIC_ATOM_INIT(${s.length}, ${hash}, ${cString(Uint8Array.from(units))})`));
      } else {
        this.decls.push(datum(`JS_STATIC_UTF16_TYPE(${s.length})`, name, `JS_STATIC_UTF16_ATOM_INIT(${s.length}, ${hash}, { ${units.map((u) => `0x${u.toString(16)}`).join(", ")} })`));
      }
    }
    return `JS_STATIC_STR(${name})`;
  }
}

/** A BigInt's limbs as the runtime holds them (js_bigint.h): two's complement, least significant
 *  first, the fewest that keep the sign. */
export function bigintLimbs(v: bigint, bits: number): bigint[] {
  const b = BigInt(bits), mask = (1n << b) - 1n, limbs: bigint[] = [];
  for (;;) {
    const limb = v & mask;
    limbs.push(limb);
    v >>= b;
    const negative = (limb >> (b - 1n)) === 1n;
    if ((v === 0n && !negative) || (v === -1n && negative)) return limbs;
  }
}

/** A property key as a JSValue: an index key (int32 below 2^31, else a double) or an atom. */
function keyValue(k: PropKey, strings: Strings): string {
  if ("index" in k) return k.index < 2147483647 ? `js_int32(${k.index})` : `js_double(${k.index}.0)`;
  return strings.ref(k.name);
}

/** C types and initial values of the IR's representations. */
const C_TYPE: Record<Repr, string> = { boxed: "JSValue", f64: "double", i32: "int32_t", bool: "bool" };
const C_ZERO: Record<Repr, string> = { boxed: "JS_UNDEFINED", f64: "0", i32: "0", bool: "false" };
/** What a direct entry returns after a throw: unboxed, any value, the pending
 *  exception is the signal. */
const C_FAIL: Record<Repr, string> = { boxed: "JS_EXCEPTION", f64: "0", i32: "0", bool: "false" };

/** A C expression of repr `from` as repr `to`, when the type allows it (an int32_t only ever
 *  holds int32s, so converting to one can't lose anything). */
function convert(expr: string, from: Repr, to: Repr): string {
  if (from === to) return expr;
  if (from === "i32") return to === "boxed" ? `js_int32(${expr})` : `(double)(${expr})`;
  if (to === "boxed") return from === "bool" ? `js_bool(${expr})` : `js_number(${expr})`;
  if (to === "i32") return from === "f64" ? `(int32_t)(${expr})` : `js_as_int32_value(${expr})`;
  return to === "bool" ? `js_as_bool(${expr})` : `js_as_number(${expr})`;
}

/** Number comparisons: a C bool from doubles or int32s. */
const BOOL_OPS = new Set<Op>(["num_lt", "num_le", "num_gt", "num_ge", "num_eq", "num_ne"]);

function cDouble(d: number): string {
  if (Number.isNaN(d)) return "NAN";
  if (d === Infinity) return "INFINITY";
  if (d === -Infinity) return "-INFINITY";
  if (Object.is(d, -0)) return "-0.0";
  if (Number.isSafeInteger(d)) return `${d}.0`;
  return hexFloat(d);
}

/** Inline caches: one per *_prop site with a named key, in mod_ics[]. */
class Caches {
  count = 0;
}

function constant(v: JSConst, strings: Strings): string {
  if (v === undefined) return "JS_UNDEFINED";
  if (v === null) return "JS_NULL";
  if (v === true) return "JS_TRUE";
  if (v === false) return "JS_FALSE";
  if (typeof v === "string") return strings.ref(v);
  if (Number.isNaN(v)) return "js_double(NAN)";
  if (v === Infinity) return "js_double(INFINITY)";
  if (v === -Infinity) return "js_double(-INFINITY)";
  if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 && !Object.is(v, -0)) return `js_int32(${v === -2147483648 ? "INT32_MIN" : v})`;
  return `js_double(${hexFloat(v)})`;
}

// ---- Functions ------------------------------------------------------------------

export function cFunctionName(fn: FunctionIR, isMain: boolean, prefix = ""): string {
  return isMain ? `${prefix}js_script` : `${prefix}jsf_${ident(fn.name)}`;
}

function infoName(fnName: string, prefix: string): string {
  return `${prefix}jsfi_${ident(fnName)}`;
}

/** A function's `this` parameter in its direct entry (after the environment and the
 *  function object), when it takes one. */
function thisParam(fn: FunctionIR): Instr | null {
  const m = fn.meta;
  return m?.takesThis ? fn.params[Number(m.takesEnv) + Number(m.takesCallee)] ?? null : null;
}

/** `this.key = v` in a constructor: most likely adding the property. */
function addsToThis(fn: FunctionIR, i: Instr): boolean {
  return i.op === "set_prop" && !!fn.meta?.constructor && !fn.meta.arrow && "name" in i.key! && i.operands[0] === thisParam(fn);
}

/** The inline slots of the objects `new F` makes: one per property F's constructor
 *  adds to `this` (up to 16), or JS_DEFAULT_INLINE_SLOTS (4) when it adds none it names. */
function instanceSlots(fn: FunctionIR): number {
  const keys = new Set<string>();
  for (const b of fn.blocks)
    for (const i of b.instrs)
      if (addsToThis(fn, i)) keys.add((i.key as { name: string }).name);
  return keys.size ? Math.min(keys.size, 16) : 4;
}

/** The generic entry: unpacks argv into the direct entry's parameters. */
function genericEntry(fn: FunctionIR, prefix: string): string {
  const meta = fn.meta!;
  const direct = cFunctionName(fn, false, prefix);
  const declared = fn.params.length - Number(meta.takesEnv) - Number(meta.takesCallee) - Number(meta.takesThis)
    - Number(meta.takesNewTarget) - Number(meta.takesArguments) - Number(meta.hasRest);
  const args = [
    ...(meta.takesEnv ? ["js_function_env(callee)"] : []),
    ...(meta.takesCallee ? ["callee"] : []),
    ...(meta.takesThis ? ["this_val"] : []),
    ...(meta.takesNewTarget ? ["new_target"] : []),
    ...(meta.takesArguments ? ["js_new_array_from(ctx, argv, argc)"] : []),
    /* a parameter the optimizer unboxed: the function is closed, this entry unused */
    ...Array.from({ length: declared }, (_, i) => `argc > ${i} ? argv[${i}] : JS_UNDEFINED`),
    /* the rest parameter: the arguments after the declared ones */
    ...(meta.hasRest ? [`js_new_array_from(ctx, argc > ${declared} ? argv + ${declared} : NULL, argc > ${declared} ? argc - ${declared} : 0)`] : []),
  ];
  const usesArgv = declared > 0 || meta.hasRest || meta.takesArguments;
  const unused = ["callee", "this_val", "argc", "argv", "new_target"].filter(
    (p) => !(p === "callee" && (meta.takesCallee || meta.takesEnv)) && !(p === "this_val" && meta.takesThis) && !((p === "argc" || p === "argv") && usesArgv)
      && !(p === "new_target" && meta.takesNewTarget),
  );
  const call = `${direct}(${["ctx", ...args.map((a, k) => convert(a, "boxed", fn.params[k]!.repr))].join(", ")})`;
  const ret = fn.returnRepr ?? "boxed";
  return [
    `static JSValue ${direct}__generic(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {`,
    ...(unused.length ? [`    ${unused.map((u) => `(void)${u};`).join(" ")}`] : []),
    ...(ret === "boxed"
      ? [`    return ${call};`]
      : [`    ${C_TYPE[ret]} r = ${call};`, `    return js_has_exception(ctx) ? JS_EXCEPTION : ${convert("r", ret, "boxed")};`]),
    "}",
  ].join("\n");
}

/** The module's source text (--embed-source): one plain static string (not an atom), sliced by toString. */
function sourceCell(text: string, prefix: string): Decl {
  const name = `${prefix}mod_source`;
  const units = [...Array(text.length).keys()].map((i) => text.charCodeAt(i));
  if (units.every((u) => u <= 0xff))
    return datum(`JS_STATIC_LATIN1_TYPE(${text.length})`, name, `JS_STATIC_LATIN1_INIT(${text.length}, 0, ${cString(Uint8Array.from(units))})`);
  return datum(`JS_STATIC_UTF16_TYPE(${text.length})`, name, `JS_STATIC_UTF16_INIT(${text.length}, 0, { ${units.map((u) => `0x${u.toString(16)}`).join(", ")} })`);
}

/** The function's static JSFunctionInfo: what js_new_function builds objects from. `shared`:
 *  another file of a split program makes the function, so the info isn't static. */
function functionInfo(fn: FunctionIR, strings: Strings, embedSource: boolean, shared = false): string {
  const meta = fn.meta!;
  const flags = [
    ...(fn.strict ? ["JS_FN_STRICT"] : []),
    ...(meta.constructor ? ["JS_FN_CONSTRUCTOR"] : []),
    /* an ordinary [[Construct]] creates `this`; a derived constructor gets it from super() */
    ...(meta.constructor && meta.classCtor !== "derived" ? ["JS_FN_ORDINARY"] : []),
    ...(meta.classCtor ? ["JS_FN_CLASS_CTOR"] : []),
    ...(meta.classCtor === "derived" ? ["JS_FN_DERIVED"] : []),
    ...(meta.arrow ? ["JS_FN_ARROW"] : []),
    ...(meta.generator ? ["JS_FN_GENERATOR"] : []),
    ...(meta.async ? ["JS_FN_ASYNC"] : []),
  ];
  const file = fn.loc ? cString(fn.loc.file) : "NULL";
  const direct = cFunctionName(fn, false, strings.prefix);
  const src = embedSource ? meta.source : null;
  const source = src ? `(const JSString *)&${strings.prefix}mod_source, ${file}, ${src.start}, ${src.end - src.start}` : `NULL, ${file}, 0, 0`;
  return `${shared ? "" : "static JS_MAYBE_UNUSED "}const JSFunctionInfo ${infoName(fn.name, strings.prefix)} = { ${direct}__generic, ${strings.cellPointer(meta.jsName)}, ${meta.length}, ${flags.join(" | ") || "0"}, ${source} };`;
}

/** A generator's split: the entry runs the prologue up to gen_start; the resume
 *  function runs the rest as a state machine. Each value live across a pause has a slot in
 *  the generator's frame. An async function splits the same way at async_start. */
interface GeneratorPlan {
  start: Instr;         // gen_start or async_start
  startBlock: Block;    // where the body begins (state 0)
  resume: Set<Block>;   // the blocks of the resume function
  live: Map<Instr, Instr[]>;
  slots: Map<Instr, number>;
  states: Map<Instr, number>;  // yield → its state number (1, 2, …)
  resumeName: string;
}

/* The host primitives a program uses: generated code declares each one, since they
 * live in host packages, not in js_runtime.h. */
class Hosts {
  readonly table: HostPrimitives;
  readonly used = new Set<string>();
  constructor(table: HostPrimitives) {
    this.table = table;
  }
  get(name: string) {
    const host = this.table[name];
    if (!host) throw new Error(`no host primitive ${name}`);
    this.used.add(host.c);
    return host;
  }
  decls(): string[] {
    return [...this.used].sort().map((c) => `JSValue ${c}(JSContext *, JSValue, JSValue, uint32_t, const JSValue *, JSValue);  /* host primitive */`);
  }
}

class FunctionEmitter {
  private readonly fn: FunctionIR;
  private readonly gen: GeneratorPlan | null = null;
  private readonly strings: Strings;
  private readonly caches: Caches;
  private readonly hosts: Hosts;
  private readonly cname: string;
  /** The module's functions by name: a direct call passes and returns in its callee's reprs. */
  private readonly callees: Map<string, FunctionIR>;
  /** Another file of a split program calls the function, so it isn't static. */
  shared = false;
  /** Values something needs: instructions and terminators, and the phis feeding them. */
  private readonly used = new Set<Instr>();
  private readonly labels = new Set<Block>();
  private readonly lines: string[] = [];
  private lastLoc: Loc | null = null;

  constructor(fn: FunctionIR, cname: string, strings: Strings, caches: Caches, hosts: Hosts, callees: Map<string, FunctionIR>) {
    this.hosts = hosts;
    this.callees = callees;
    this.fn = fn;
    this.cname = cname;
    this.strings = strings;
    this.caches = caches;
    /* dead phis (e.g. an expression result nobody reads) would be C variables set but never used */
    const work: Instr[] = [];
    const use = (v: Instr) => {
      if (this.used.has(v)) return;
      this.used.add(v);
      if (v.op === "phi") work.push(v);
    };
    for (const b of fn.blocks) {
      for (const ins of b.instrs) ins.operands.forEach(use);
      const t = b.term;
      if (t?.kind === "branch") use(t.cond);
      if (t?.kind === "return" || t?.kind === "throw") use(t.value);
    }
    while (work.length) for (const i of work.pop()!.incoming!) use(i.value);
    /* a module with top-level await: its body (main) is an async function's too */
    if (fn.meta?.generator || fn.meta?.async || fn.blocks.some((b) => b.instrs.some((i) => i.op === "async_start")))
      this.gen = this.planGenerator();
  }

  private planGenerator(): GeneratorPlan {
    const fn = this.fn;
    const start = fn.blocks.flatMap((b) => b.instrs).find((i) => i.op === "gen_start" || i.op === "async_start")!;
    const t = start.block.term!;
    if (t.kind !== "jump") throw new Error(`${start.op} must end its block`);
    const resume = new Set<Block>();
    const work = [t.target];
    while (work.length) {
      const b = work.pop()!;
      if (resume.has(b)) continue;
      resume.add(b);
      work.push(...successors(b));
    }
    const isPause = (i: Instr) => i === start || i.op === "yield" || i.op === "yield_raw" || i.op === "await";
    const live = liveAfterPauses(fn, isPause);
    const slots = new Map<Instr, number>();
    const states = new Map<Instr, number>();
    for (const [pause, values] of live) {
      const saved = values.filter((v) => this.hasVar(v) || v.op === "param");
      live.set(pause, saved);
      for (const v of saved) if (!slots.has(v)) slots.set(v, slots.size);
      if (pause !== start) states.set(pause, states.size + 1);
    }
    return { start, startBlock: t.target, resume, live, slots, states, resumeName: `${this.cname}__resume` };
  }

  /** Saving the values live after `pause` into the generator's frame (`g`: a JSGenerator *). */
  private saves(pause: Instr, g: string): string[] {
    const gen = this.gen!;
    return gen.live.get(pause)!.map((v) => `    js_generator_save(ctx, ${g}, ${gen.slots.get(v)}, ${this.v(v)});`);
  }

  private reloads(pause: Instr): string {
    const gen = this.gen!;
    return gen.live.get(pause)!.map((v) => `${this.name(v)} = js_generator_load(g, ${gen.slots.get(v)});`).join(" ");
  }

  /** A value as a boxed C expression: constants inline, everything else its variable (boxed
   *  if the variable is a double or a bool). */
  private v(i: Instr): string {
    return this.as(i, "boxed");
  }

  private name(i: Instr): string {
    return `v${i.id}${i.name ? `_${ident(i.name)}` : ""}`;
  }

  /** A value as a C expression in representation `repr` (the optimizer's unbox pass
   *  proved the type, so unboxing can't fail). */
  private as(i: Instr, repr: Repr): string {
    if (i.op === "const") {
      const value = i.lit!.value;
      if (repr === "f64") return cDouble(value as number);
      if (repr === "i32") return value === -2147483648 ? "INT32_MIN" : `${value as number}`;
      if (repr === "bool") return value ? "true" : "false";
      return constant(value, this.strings);
    }
    if (i.op === "empty") return "JS_EMPTY";
    const n = this.name(i);
    return convert(n, i.repr, repr);
  }

  /** A num_* operator on unboxed operands: plain C. Doubles; int32s where both operands are
   *  (an int32 result is one inference proved can't overflow); bitwise ones through ToInt32. */
  private unboxed(i: Instr): string {
    const isInt = (o: Instr) => isSubtype(o.type, T.Int32);
    if (i.operands.every(isInt) && (i.repr === "i32" || BOOL_OPS.has(i.op))) {
      const [x, y] = i.operands.map((o) => this.as(o, "i32"));
      switch (i.op) {
        case "num_add": return `${x} + ${y}`;
        case "num_sub": return `${x} - ${y}`;
        case "num_inc": return `${x} + 1`;
        case "num_dec": return `${x} - 1`;
        case "num_lt": return `${x} < ${y}`;
        case "num_le": return `${x} <= ${y}`;
        case "num_gt": return `${x} > ${y}`;
        case "num_ge": return `${x} >= ${y}`;
        case "num_eq": return `${x} == ${y}`;
        case "num_ne": return `${x} != ${y}`;
      }
    }
    const [a, b] = i.operands.map((o) => this.as(o, "f64"));
    /* ToInt32: an int32 operand as it is */
    const [ia, ib] = i.operands.map((o) => (isInt(o) ? this.as(o, "i32") : `js_f64_to_int32(${this.as(o, "f64")})`));
    const bits = (expr: string) => (i.repr === "i32" ? expr : `(double)(${expr})`);
    switch (i.op) {
      case "num_add": return `${a} + ${b}`;
      case "num_sub": return `${a} - ${b}`;
      case "num_mul": return `${a} * ${b}`;
      case "num_div": return `${a} / ${b}`;
      case "num_mod": return `js_f64_mod(${a}, ${b})`;
      case "num_neg": return `-(${a})`;
      case "num_inc": return `${a} + 1`;
      case "num_dec": return `${a} - 1`;
      case "num_lt": return `${a} < ${b}`;
      case "num_le": return `${a} <= ${b}`;
      case "num_gt": return `${a} > ${b}`;
      case "num_ge": return `${a} >= ${b}`;
      case "num_eq": return `${a} == ${b}`;
      case "num_ne": return `${a} != ${b}`;
      case "num_bitand": return bits(`${ia} & ${ib}`);
      case "num_bitor": return bits(`${ia} | ${ib}`);
      case "num_bitxor": return bits(`${ia} ^ ${ib}`);
      case "num_bitnot": return bits(`~${ia}`);
      case "num_shl": return bits(`(int32_t)((uint32_t)${ia} << (${ib} & 31))`);
      case "num_sar": return bits(`${ia} >> (${ib} & 31)`);
      case "num_shr": return `(double)((uint32_t)${ia} >> (${ib} & 31))`;
      default: throw new Error(`${i.op} has no unboxed form`);
    }
  }

  /** Each object literal's (new_object's) define_prop count, counted once per function. */
  private literalSizes(): Map<Instr, number> {
    if (!this.sizes) {
      this.sizes = new Map();
      for (const b of this.fn.blocks)
        for (const u of b.instrs) if (u.op === "define_prop") this.sizes.set(u.operands[0]!, (this.sizes.get(u.operands[0]!) ?? 0) + 1);
    }
    return this.sizes;
  }
  private sizes: Map<Instr, number> | null = null;

  private hasVar(i: Instr): boolean {
    return i.op !== "const" && i.op !== "empty" && i.op !== "param" && OPS[i.op].result && this.used.has(i);
  }

  private emitLoc(loc: Loc | null) {
    if (!loc || (this.lastLoc && this.lastLoc.line === loc.line && this.lastLoc.file === loc.file)) return;
    this.lastLoc = loc;
    this.lines.push(`#line ${loc.line} ${cString(loc.file)}`);
  }

  /** Phi copies for the edge from → to, as parallel copies. */
  private copies(from: Block, to: Block): string[] {
    const phis = to.phis.filter((p) => this.hasVar(p));
    const moves = phis.map((p) => [this.name(p), this.as(p.incoming!.find((i) => i.block === from)!.value, p.repr), p.repr] as const).filter(([d, s]) => d !== s);
    if (moves.length <= 1) return moves.map(([d, s]) => `${d} = ${s};`);
    return [`{ ${moves.map(([, s, r], k) => `${C_TYPE[r]} t${k} = ${s};`).join(" ")} ${moves.map(([d], k) => `${d} = t${k};`).join(" ")} }`];
  }

  private goto(from: Block, to: Block): string {
    this.labels.add(to);
    return [...this.copies(from, to), `goto bb${to.id};`].join(" ");
  }

  /** `new F(…)` of a constructor of this module. When F's value is that
   *  function (made in this realm), `this` comes from js_new_instance and the constructor's direct
   *  entry runs; an object it returns wins, as in [[Construct]] (§10.2.2). Anything else, through
   *  js_construct. */
  private constructDirect(i: Instr, args: string[]) {
    const callee = this.callees.get(i.target!)!;
    const meta = callee.meta!;
    const out = this.hasVar(i) ? this.name(i) : null;
    const fail = this.onException(i.block);
    const hidden = [
      ...(meta.takesEnv ? ["js_function_env(c)"] : []),
      ...(meta.takesCallee ? ["c"] : []),
      ...(meta.takesThis ? ["t"] : []),
      ...(meta.takesNewTarget ? ["c"] : []),
    ];
    const passed = i.operands.slice(1).map((o, k) => this.as(o, callee.params[hidden.length + k]?.repr ?? "boxed"));
    const call = `${this.strings.prefix}jsf_${ident(callee.name)}(ctx${[...hidden, ...passed].map((a) => `, ${a}`).join("")})`;
    const ret = callee.returnRepr ?? "boxed";
    const result = out ? `${out} = ` : "";
    this.lines.push(
      `    { JSValue c = ${args[0]};`,
      `    if (JS_LIKELY(js_is_function(c) && js_as_function(c)->info == &${infoName(callee.name, this.strings.prefix)} && js_as_function(c)->realm == ctx)) {`,
      `        JSValue t = js_new_instance(ctx, c, ${instanceSlots(callee)}, ${this.cache()});`,
      `        if (JS_UNLIKELY(js_is_exception(t))) { ${fail} }`,
      ...(ret === "boxed"
        ? [`        JSValue r = ${call};`, "        JS_NO_TAIL_CALL();", `        if (JS_UNLIKELY(js_is_exception(r))) { ${fail} }`, ...(out ? [`        ${result}js_is_object(r) ? r : t;`] : [])]
        : [`        (void)${call};`, "        JS_NO_TAIL_CALL();", `        if (JS_UNLIKELY(js_has_exception(ctx))) { ${fail} }`, ...(out ? [`        ${result}t;`] : [])]),
      "    } else {",
      `        JSValue r = js_construct(ctx, c, ${args.length - 1}, ${argArray(args.slice(1))}, JS_UNDEFINED, ${cString(i.text ?? "")});`,
      `        if (JS_UNLIKELY(js_is_exception(r))) { ${fail} }`,
      ...(out ? [`        ${result}r;`] : ["        js_discard(r);"]),
      "    } }",
    );
  }

  /** The values this function calls, or checks as an inlined call's callee. */
  private calledValues: Set<Instr> | null = null;
  private called(): Set<Instr> {
    if (!this.calledValues) {
      this.calledValues = new Set();
      for (const b of this.fn.blocks)
        for (const i of b.instrs) if (i.op === "call" || i.op === "same_function") this.calledValues.add(i.operands[0]!);
    }
    return this.calledValues;
  }

  private onException(b: Block): string {
    return b.handler ? this.goto(b, b.handler) : `return ${C_FAIL[this.fn.returnRepr ?? "boxed"]};`;
  }

  private key(i: Instr): string {
    return keyValue(i.key!, this.strings);
  }

  private cache(): string {
    return `&${this.strings.prefix}mod_ics[${this.caches.count++}]`;
  }

  private instr(i: Instr) {
    const args = i.operands.map((o) => this.v(o));
    const strict = this.fn.strict ? "true" : "false";
    let expr: string;
    /* status results (int: < 0 on exception) and plain statements */
    let status: string | null = null;
    switch (i.op) {
      case "param":
      case "const":
      case "empty":
      case "phi":
        return;
      case "load_global":
        expr = `${this.strings.prefix}mod_globals[${i.index}]`;
        break;
      case "gen_start": {
        const gen = this.gen!;
        this.lines.push(
          `    { JSValue gen = ${this.fn.meta!.async ? "js_async_generator_new" : "js_generator_new"}(ctx, ${args[0]}, ${gen.resumeName}, ${gen.slots.size});`,
          "      if (JS_UNLIKELY(js_is_exception(gen))) return JS_EXCEPTION;",
          "      JSGenerator *gp = js_as_generator(gen);",
          ...this.saves(i, "gp").map((l) => `  ${l}`),
          "      return gen; }",
        );
        return;
      }
      case "async_start": {
        const gen = this.gen!;
        this.lines.push(
          `    { JSValue gen = js_async_new(ctx, ${gen.resumeName}, ${gen.slots.size});`,
          "      JSGenerator *gp = js_as_generator(gen);",
          ...this.saves(i, "gp").map((l) => `  ${l}`),
          "      return js_async_start(ctx, gp); }  /* runs to the first await; the promise */",
        );
        return;
      }
      case "await": {
        const k = this.gen!.states.get(i)!;
        this.lines.push(
          ...this.saves(i, "g"),
          `    g->state = ${k};`,
          `    if (JS_LIKELY(js_await(ctx, g, ${args[0]}) == 0)) return JS_UNDEFINED;  /* paused: a microtask resumes it */`,
          "    sent = js_take_exception(ctx); mode = JS_RESUME_THROW;  /* PromiseResolve threw: at the await */",
          `res_${k}:;`,
        );
        /* the awaited promise was rejected: an exception right here */
        expr = "mode == JS_RESUME_THROW ? js_throw(ctx, sent) : sent";
        break;
      }
      case "yield":
      case "yield_raw": {
        const k = this.gen!.states.get(i)!;
        this.lines.push(
          ...this.saves(i, "g"),
          `    g->state = ${k}; g->status = JS_GEN_SUSPENDED;${i.op === "yield_raw" ? " g->raw = 1;" : ""} return ${args[0]};`,
          `res_${k}:;`,
        );
        /* resumed by throw(): an exception right here */
        expr = i.op === "yield" ? "mode == JS_RESUME_THROW ? js_throw(ctx, sent) : sent" : "sent";
        break;
      }
      case "resume_is_return":
        expr = "js_bool(mode == JS_RESUME_RETURN)";
        break;
      case "resume_mode":
        expr = "js_int32(mode)";
        break;
      case "ys_step":
        expr = `js_yield_star_step(ctx, ${args[0]}, ${args[1]}, ${args[2]})`;
        break;
      case "store_global":
        this.lines.push(`    ${this.strings.prefix}mod_globals[${i.index}] = ${args[0]};`);
        return;
      case "global_name":
        expr = `js_global_get(ctx, ${keyValue({ name: i.target! }, this.strings)}, ${cString(i.target!)})`;
        break;
      case "global_typeof_name":
        expr = `js_global_typeof_name(ctx, ${cString(i.target!)})`;
        break;
      case "declare_global":
        status = i.index === 1 ? `js_declare_global_function(ctx, ${this.key(i)}, ${args[0]})` : `js_declare_global_var(ctx, ${this.key(i)})`;
        break;
      case "set_global_name":
        status = `js_set_global_name(ctx, ${this.key(i)}, ${args[0]}, ${this.fn.strict ? "true" : "false"})`;
        break;
      case "global_this":
        expr = "ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT]";
        break;
      case "sloppy_this":
        expr = `js_sloppy_this(ctx, ${args[0]})`;
        break;
      case "make_arguments": {
        if (!i.table) {
          expr = `js_new_arguments(ctx, ${args[0]}, JS_UNDEFINED, JS_UNDEFINED, NULL, 0)`;
          break;
        }
        /* the parameter → environment slot map: static, one per function */
        const table = `${this.strings.prefix}jsam_${ident(this.fn.name)}`;
        const entries = i.table.length ? i.table.map((t) => (t < 0 ? "UINT32_MAX" : String(t))) : ["UINT32_MAX"];
        this.strings.decls.push(datum("uint32_t", `${table}[]`, `{ ${entries.join(", ")} }`));
        expr = `js_new_arguments(ctx, ${args[0]}, ${args[1]}, ${args[2]}, ${table}, ${i.table.length})`;
        break;
      }
      case "make_function":
        expr = args.length
          ? `js_new_closure(ctx, &${infoName(i.target!, this.strings.prefix)}, ${args[0]})`
          : `js_new_function(ctx, &${infoName(i.target!, this.strings.prefix)})`;
        break;
      case "bigint":
        expr = this.strings.bigint(i.bigint!);
        break;
      case "regexp":
        expr = `js_regexp_literal(ctx, ${this.strings.regexp(i.regexp!.pattern, i.regexp!.flags)})`;
        break;
      case "switch_string":
        expr = `js_int32(js_switch_string(ctx, ${args[0]}, ${this.strings.switchCases(i.cases!)}, ${i.cases!.length}))`;
        break;
      case "template_object": {
        const t = i.template!;
        const cooked = t.cooked.map((s) => (s === null ? "JS_UNDEFINED" : this.strings.ref(s)));
        const raw = t.raw.map((s) => this.strings.ref(s));
        expr = `js_template_object(ctx, &${this.strings.prefix}mod_globals[${i.index}], ${t.raw.length}, (const JSValue[]){ ${cooked.join(", ")} }, (const JSValue[]){ ${raw.join(", ")} })`;
        break;
      }
      case "import_meta":
        expr = `js_import_meta(ctx, &${this.strings.prefix}mod_globals[${i.index}], ${cString(i.target!)}, ${i.slot === 1 ? "true" : "false"})`;
        break;
      case "dynamic_import":
        expr = `js_dynamic_import(ctx, ${args[0]}, ${args[1]}, ${cString(i.target!)})`;
        break;
      case "host_function": {
        const host = this.hosts.get(i.target!);
        expr = `js_new_native(ctx, ${host.c}, ${this.strings.ref(i.target!)}, ${host.length}, JS_FN_STRICT)`;
        break;
      }
      case "env_new":
        expr = `js_new_env(ctx, ${args[0]}, ${i.index})`;
        break;
      case "env_copy":
        expr = `js_env_copy(ctx, ${args[0]})`;
        break;
      case "env_load":
        expr = `js_env_get(${args[0]}, ${i.index}, ${i.slot})`;
        break;
      case "env_store":
        this.lines.push(`    js_env_set(ctx, ${args[0]}, ${i.index}, ${i.slot}, ${args[1]});`);
        return;
      case "get_prop": {
        const length = "name" in i.key! && i.key.name === "length";
        const str = i.operands[0]!.type !== T.None && isSubtype(i.operands[0]!.type, T.String);
        if (str && length) {
          expr = `js_int32((int32_t)js_string_length(${args[0]}))`;
          break;
        }
        /* a string's other named properties are String.prototype's; an array's length inline; a
         * method's prototype hit inline */
        const get = str ? "js_get_string_prop" : length ? "js_get_length" : this.called().has(i) ? "js_get_method" : "js_get_prop";
        expr = "name" in i.key! ? `${get}(ctx, ${args[0]}, ${this.key(i)}, ${this.cache()})` : `js_get_value(ctx, ${args[0]}, ${this.key(i)})`;
        break;
      }
      case "get_elem":
        expr = `js_get_elem(ctx, ${args[0]}, ${args[1]})`;
        break;
      case "get_index":  /* a double key: the variant that takes it unboxed */
        expr = i.operands[1]!.repr === "f64"
          ? `js_get_index_f64(ctx, ${args[0]}, ${this.as(i.operands[1]!, "f64")})`
          : `js_get_index(ctx, ${args[0]}, ${args[1]})`;
        break;
      case "set_prop":
        status = "name" in i.key!
          ? `${i.addsProp || addsToThis(this.fn, i) ? "js_set_prop_add" : "js_set_prop"}(ctx, ${args[0]}, ${this.key(i)}, ${args[1]}, ${strict}, ${this.cache()})`
          : `js_set_value(ctx, ${args[0]}, ${this.key(i)}, ${args[1]}, ${strict})`;
        break;
      case "set_elem":
        status = `js_set_elem(ctx, ${args[0]}, ${args[1]}, ${args[2]}, ${strict})`;
        break;
      case "set_index":
        status = i.operands[1]!.repr === "f64"
          ? `js_set_index_f64(ctx, ${args[0]}, ${this.as(i.operands[1]!, "f64")}, ${args[2]}, ${strict})`
          : `js_set_index(ctx, ${args[0]}, ${args[1]}, ${args[2]}, ${strict})`;
        break;
      case "delete_prop":
        expr = `js_delete_value(ctx, ${args[0]}, ${this.key(i)}, ${strict})`;
        break;
      case "delete_elem":
        expr = `js_delete_elem(ctx, ${args[0]}, ${args[1]}, ${strict})`;
        break;
      case "new_object": {
        /* an object literal: inline slots for the properties it defines (more than the default
           4), so that each of them is an inline cache's inline hit */
        const defined = this.literalSizes().get(i) ?? 0;
        expr = defined > 4
          ? `js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], ${Math.min(defined, 64)})`
          : "js_new_object(ctx)";
        break;
      }
      case "define_prop":
        this.lines.push(`    js_define_data(ctx, js_as_object(${args[0]}), ${this.key(i)}, ${args[1]}, JS_PROP_DEFAULT);`);
        return;
      case "define_elem":
        this.lines.push(`    js_define_data(ctx, js_as_object(${args[0]}), ${args[1]}, ${args[2]}, JS_PROP_DEFAULT);`);
        return;
      case "define_accessor": {
        /* the other half of the pair is left alone: JS_EMPTY */
        const key = args.length === 3 ? args[1] : this.key(i);
        const fn = args.at(-1)!;
        const [get, set] = i.index === 0 ? [fn, "JS_EMPTY"] : ["JS_EMPTY", fn];
        this.lines.push(`    js_define_accessor(ctx, js_as_object(${args[0]}), ${key}, ${get}, ${set});`);
        return;
      }
      case "class_setup":
        expr = `js_class_setup(ctx, ${args[0]}, ${args[1]})`;
        break;
      case "set_home":
        this.lines.push(`    js_set_home_object(ctx, ${args[0]}, ${args[1]});`);
        return;
      case "define_class_member": {
        const key = args.length === 3 ? args[1] : this.key(i);
        this.lines.push(`    js_define_class_member(ctx, js_as_object(${args[0]}), ${key}, ${i.index}, ${args.at(-1)});`);
        return;
      }
      case "super_get":
        expr = `js_super_get(ctx, ${args[0]}, ${args.length === 3 ? args[2] : this.key(i)}, ${args[1]})`;
        break;
      case "super_set":
        status = `js_super_set(ctx, ${args[0]}, ${args.length === 4 ? args[2] : this.key(i)}, ${args.at(-1)}, ${args[1]})`;
        break;
      case "super_construct":
        expr = `js_super_construct(ctx, ${args[0]}, ${args[1]}, ${args.length - 2}, ${argArray(args.slice(2))})`;
        break;
      case "super_construct_spread":
        expr = `js_super_construct_spread(ctx, ${args[0]}, ${args[1]}, ${args[2]})`;
        break;
      case "bind_this":
        expr = `js_bind_this(ctx, ${args[0]}, ${args[1]})`;
        break;
      case "check_this":
        expr = `js_check_this(ctx, ${args[0]})`;
        break;
      case "derived_return":
        expr = `js_derived_return(ctx, ${args[0]}, ${args[1]})`;
        break;
      case "define_field":
        status = `js_define_field(ctx, ${args[0]}, ${args.length === 3 ? args[1] : this.key(i)}, ${args.at(-1)})`;
        break;
      case "new_private_name":
        expr = `js_new_private_name(ctx, ${args[0]})`;
        break;
      case "private_add":
        status = `js_private_add(ctx, ${args[0]}, ${args[1]}, ${args[2]}, ${i.index})`;
        break;
      case "private_get":
        expr = `js_private_get(ctx, ${args[0]}, ${args[1]})`;
        break;
      case "private_set":
        status = `js_private_set(ctx, ${args[0]}, ${args[1]}, ${args[2]})`;
        break;
      case "private_in":
        expr = `js_private_in(ctx, ${args[0]}, ${args[1]})`;
        break;
      case "set_proto":
        this.lines.push(`    js_literal_set_proto(ctx, ${args[0]}, ${args[1]});`);
        return;
      case "new_array":
        expr = `js_new_array_from(ctx, ${argArray(args)}, ${args.length})`;
        break;
      case "array_append":
        status = `js_array_append(ctx, ${args[0]}, ${args[1]})`;
        break;
      case "array_spread":
        status = `js_array_spread(ctx, ${args[0]}, ${args[1]})`;
        break;
      case "object_spread":
        status = `js_object_spread(ctx, ${args[0]}, ${args[1]})`;
        break;
      case "iter_close":
        status = `js_iter_close(ctx, ${args[0]})`;
        break;
      case "iter_close_throw":
        this.lines.push(`    js_iter_close_throw(ctx, ${args[0]});`);
        return;
      case "call_spread":
        expr = `js_call_spread(ctx, ${args[0]}, ${args[1]}, ${args[2]}, ${cString(i.target!)})`;
        break;
      case "new_spread":
        expr = `js_construct_spread(ctx, ${args[0]}, ${args[1]}, ${cString(i.target!)})`;
        break;
      case "call":
        if (i.builtin) {
          expr = `js_call_${i.builtin}(ctx, ${args[0]}, ${args[1]}, ${args[2]}, ${cString(i.target!)})`;
          break;
        }
        expr = `js_call_site(ctx, ${args[0]}, ${args[1]}, ${args.length - 2}, ${argArray(args.slice(2))}, ${cString(i.target!)})`;
        break;
      case "new":
        expr = `js_construct(ctx, ${args[0]}, ${args.length - 1}, ${argArray(args.slice(1))}, JS_UNDEFINED, ${cString(i.target!)})`;
        break;
      case "check_tdz":
        expr = `js_check_tdz(ctx, ${args[0]}, ${cString(i.name ?? "variable")})`;
        break;
      case "construct_direct": {
        this.constructDirect(i, args);
        return;
      }
      case "same_function": {
        const cond = `js_is_function(${args[0]}) && js_as_function(${args[0]})->info == &${infoName(i.target!, this.strings.prefix)} && js_as_function(${args[0]})->realm == ctx`;
        expr = i.repr === "bool" ? `(${cond})` : `js_bool(${cond})`;
        break;
      }
      case "function_env":
        expr = `js_function_env(${args[0]})`;
        break;
      case "new_instance":
        expr = `js_new_instance(ctx, ${args[0]}, ${i.index}, ${this.cache()})`;
        break;
      case "construct_result":
        expr = `(js_is_object(${args[0]}) ? ${args[0]} : ${args[1]})`;
        break;
      case "call_direct": {
        const callee = this.callees.get(i.target!);
        const passed = i.operands.map((o, k) => this.as(o, callee?.params[k]?.repr ?? "boxed"));
        const call = `${this.strings.prefix}jsf_${ident(i.target!)}(ctx${passed.map((a) => `, ${a}`).join("")})`;
        const ret = callee?.returnRepr ?? "boxed";
        /* JS_NO_TAIL_CALL: unbounded recursion must reach the stack check */
        if (ret === "boxed") {
          const result = this.hasVar(i) ? this.name(i) : "r";
          this.lines.push(this.hasVar(i) ? `    ${result} = ${call};` : `    { JSValue r = ${call};`, "    JS_NO_TAIL_CALL();");
          if (i.mayThrow) this.lines.push(`    if (JS_UNLIKELY(js_is_exception(${result}))) { ${this.onException(i.block)} }`);
          if (!this.hasVar(i)) this.lines.push("    js_discard(r); }");
          return;
        }
        /* an unboxed result: a throw shows as the pending exception */
        this.lines.push(this.hasVar(i) ? `    ${this.name(i)} = ${convert(call, ret, i.repr)};` : `    (void)${call};`, "    JS_NO_TAIL_CALL();");
        if (i.mayThrow) this.lines.push(`    if (JS_UNLIKELY(js_has_exception(ctx))) { ${this.onException(i.block)} }`);
        return;
      }
      case "call_runtime": {
        const r = RUNTIME[i.target!];
        if (!r) throw new Error(`unknown runtime function ${i.target}`);
        expr = r(args);
        break;
      }
      default: {
        if (i.repr !== "boxed") {
          expr = this.unboxed(i);
          break;
        }
        const [fn, withCtx] = CALLS[i.op]!;
        expr = `${fn}${i.numberFirst ? "_fast" : ""}(${[...(withCtx ? ["ctx"] : []), ...args].join(", ")})`;  /* _fast: Numbers inline */
      }
    }
    if (status !== null) {
      this.lines.push(`    if (JS_UNLIKELY(${status} < 0)) { ${this.onException(i.block)} }`);
      return;
    }
    expr = expr!;
    if (this.hasVar(i)) {
      this.lines.push(`    ${this.name(i)} = ${expr};`);
      if (i.mayThrow) this.lines.push(`    if (JS_UNLIKELY(js_is_exception(${this.name(i)}))) { ${this.onException(i.block)} }`);
    } else if (i.mayThrow) {
      this.lines.push(`    if (JS_UNLIKELY(js_is_exception(${expr}))) { ${this.onException(i.block)} }`);
    } else if (i.op === "take_exception" || !OPS[i.op].result || OPS[i.op].callsUser) {
      this.lines.push(`    js_discard(${expr});`);  /* take_exception clears the pending exception */
    }
    /* unused results of pure operations: nothing to emit */
  }

  private terminator(b: Block) {
    const t = b.term!;
    this.emitLoc(t.loc);
    switch (t.kind) {
      case "jump":
        this.lines.push(`    ${this.goto(b, t.target)}`);
        return;
      case "branch":
        this.lines.push(`    if (${t.cond.repr === "bool" ? this.as(t.cond, "bool") : `js_truthy(${this.v(t.cond)})`}) { ${this.goto(b, t.then)} } else { ${this.goto(b, t.else)} }`);
        return;
      case "return":
        this.lines.push(`    return ${this.as(t.value, this.fn.returnRepr ?? "boxed")};`);
        return;
      case "throw":
        this.lines.push(`    js_discard(js_throw(ctx, ${this.v(t.value)}));`);
        this.lines.push(`    ${this.onException(b)}`);
        return;
      case "unreachable":
        this.lines.push("    abort();");
        return;
    }
  }

  /** The C statements of `blocks`; `stopAt` (gen_start) ends its block early. */
  private emitBlocks(blocks: Block[], stopAt: Instr | null): string[] {
    const bodyStart = this.lines.length;
    for (const b of blocks) {
      this.lines.push(`@label ${b.id}`);
      this.lastLoc = null;
      let stopped = false;
      for (const i of b.instrs) {
        this.emitLoc(i.loc);
        this.instr(i);
        if (i === stopAt) {
          stopped = true;
          break;
        }
      }
      if (!stopped) this.terminator(b);
    }
    return this.lines.splice(bodyStart).filter((l) => {
      const m = /^@label (\d+)$/.exec(l);
      return !m || this.labels.has(this.fn.blocks.find((b) => b.id === Number(m[1]))!);
    }).map((l) => l.replace(/^@label (\d+)$/, "bb$1:;"));
  }

  /** A generator or async function: its entry (the prologue; for async, just the state) and
   *  its resume function. */
  private emitGenerator(): string {
    const fn = this.fn, gen = this.gen!;
    this.labels.add(gen.startBlock);  // the dispatch jumps there
    const entryBody = this.emitBlocks(fn.blocks.filter((b) => !gen.resume.has(b)), gen.start);
    const resumeBody = this.emitBlocks(fn.blocks.filter((b) => gen.resume.has(b)), null);
    /* dispatch on the saved state: reload what is live there and jump to it */
    const dispatch = [
      "    switch (g->state) {",
      `    case 0: ${this.reloads(gen.start)} goto bb${gen.startBlock.id};`,
      ...[...gen.states].map(([y, k]) => `    case ${k}: ${this.reloads(y)} goto res_${k};`),
      "    }",
      "    return JS_UNDEFINED;  /* not reached */",
    ];
    /* each function declares the values it mentions */
    const candidates = [...fn.params, ...fn.blocks.flatMap((b) => [...b.phis, ...b.instrs]).filter((i) => this.hasVar(i))];
    const localsFor = (body: string[], skip: Set<Instr>) => {
      const text = body.join("\n");
      return candidates.filter((v) => !skip.has(v) && new RegExp(`\\b${this.name(v)}\\b`).test(text)).map((v) => `    JSValue ${this.name(v)} = JS_UNDEFINED;`);
    };
    const params = fn.params.map((p) => `JSValue ${this.name(p)}`);
    const entryUnused = fn.params.filter((p) => !new RegExp(`\\b${this.name(p)}\\b`).test(entryBody.join("\n"))).map((p) => `    (void)${this.name(p)};`);
    const entry = [
      `${this.linkage()}JSValue ${this.cname}(JSContext *ctx${params.map((p) => `, ${p}`).join("")}) {`,
      ...localsFor(entryBody, new Set(fn.params)),
      ...entryUnused,
      "    JS_CHECK_STACK(ctx);",
      ...entryBody,
      "}",
    ];
    const resume = [
      `static JSValue ${gen.resumeName}(JSContext *ctx, JSGenerator *g, JSValue sent, int mode) {`,
      ...localsFor([...dispatch, ...resumeBody], new Set()),
      "    (void)sent; (void)mode;",
      "    JS_CHECK_STACK(ctx);",
      ...dispatch,
      ...resumeBody,
      "}",
    ];
    return [...entry, "", ...resume].join("\n");
  }

  emit(): string {
    const fn = this.fn;
    if (this.gen) return this.emitGenerator();
    const signature = this.prototype().slice(0, -1);

    /* the body first: it decides which labels are jump targets */
    const body = this.emitBlocks(fn.blocks, null);

    const locals: string[] = [];
    for (const b of fn.blocks)
      for (const i of [...b.phis, ...b.instrs])
        if (this.hasVar(i)) locals.push(`    ${C_TYPE[i.repr]} ${this.name(i)} = ${C_ZERO[i.repr]};`);
    const unusedParams = fn.params.filter((p) => !this.used.has(p)).map((p) => `    (void)${this.name(p)};`);
    /* non-leaf: anything that can run JS code again (calls, getters, valueOf) checks the stack */
    const calls = fn.blocks.some((b) => b.instrs.some((i) => OPS[i.op].callsUser));
    /* a body that only touches its environment never needs the context */
    const usesCtx = calls || body.some((l) => /\bctx\b/.test(l));
    const ret = fn.returnRepr ?? "boxed";
    return [
      `${signature} {`,
      ...locals,
      ...(usesCtx ? [] : ["    (void)ctx;"]),
      ...unusedParams,
      ...(calls ? [ret === "boxed" ? "    JS_CHECK_STACK(ctx);" : `    JS_CHECK_STACK_OR(ctx, ${C_FAIL[ret]});`] : []),
      ...body,
      "}",
    ].join("\n");
  }

  private linkage(): string {
    return this.shared ? "JS_MAYBE_UNUSED " : "static JS_MAYBE_UNUSED ";
  }

  /** The entry's prototype: in program.h when it's shared, else in the function's own file. */
  prototype(): string {
    const ret = C_TYPE[this.fn.returnRepr ?? "boxed"];
    return `${this.linkage()}${ret} ${this.cname}(JSContext *ctx${this.fn.params.map((p) => `, ${C_TYPE[p.repr]} ${this.name(p)}`).join("")});`;
  }

  /** A generator's resume function: always static, called only by its entry. */
  resumePrototype(): string[] {
    return this.gen ? [`static JSValue ${this.gen.resumeName}(JSContext *ctx, JSGenerator *g, JSValue sent, int mode);`] : [];
  }
}

// ---- The program ----------------------------------------------------------------

export interface EmitOptions {
  /** Embed the program's source text: Function.prototype.toString returns each function's
   *  text. Off by default: binaries then carry no source, and every function prints as
   *  `function name() { [native code] }`. */
  embedSource?: boolean;
  /** The optional built-ins the program reaches: their JSComponent symbols. */
  components?: readonly string[];
  /** The core methods the program names: js_core.def lines. All of them when absent. */
  core?: readonly CoreEntry[] | undefined;
  /** The regex literals' bytecode, by regexpKey (the driver's compileRegExps). A literal
   *  without it compiles when the program runs. */
  regexps?: ReadonlyMap<string, Uint8Array>;
  /** What "visaljs:host" imports name: the host packages' primitives. */
  hostPrimitives?: HostPrimitives;
  /** emitProgramFiles: split a program into C files of about this many IR instructions each.
   *  Absent: one file. */
  partSize?: number;
  /** A test262 unit (emitUnit) run after harness scripts compiled once into the test host
   *  (emitHarnessScript). */
  harness?: HarnessLink;
}

/** What a test262 unit links to in the harness compiled into the test host. */
export interface HarnessLink {
  /** The harness's static atoms, by string (HarnessScript.atoms, all of them). */
  atoms: ReadonlyMap<string, string>;
  /** `void register(JSRuntime *)`: every harness script's tables, before the realm is made. */
  register: string;
  /** The harness scripts run before the unit's, in order: their prefixes. */
  scripts: readonly string[];
}

/** A harness file compiled once (test262): its C, and the atoms it defines. */
export interface HarnessScript {
  c: string;
  atoms: ReadonlyMap<string, string>;
}

/** One of a program's C files: program.c, and for a split program program.h and program_N.c. */
export interface CFile {
  name: string;
  text: string;
}

/** program.c: the whole script as one C file with a main() (script mode). */
export function emitProgram(m: ModuleIR, options: EmitOptions = {}): string {
  return emitModule(m, "", null, options);
}

/** One test262 compile unit for a batch: every file-level name starts with
 *  `prefix`, and `int <prefix>run(void)` replaces main: it runs the script in a fresh
 *  runtime and returns the exit status (1 after an uncaught error). */
export function emitUnit(m: ModuleIR, prefix: string, options: EmitOptions = {}): string {
  return emitModule(m, prefix, `${prefix}run`, options);
}

/** A test262 harness file, compiled once and linked into the test host: its tables
 *  and `<prefix>js_script` are exported, `<prefix>register(rt)` registers the tables, and the
 *  units run the script. `atoms`: the atoms the harness files before it in the same C file define. */
export function emitHarnessScript(m: ModuleIR, prefix: string, atoms: ReadonlyMap<string, string>, options: EmitOptions = {}): HarnessScript {
  const e = prepare(m, prefix, { ...options, harness: { atoms, register: "", scripts: [] } });
  e.strings.externalInFile = true;  /* the harness files are one C file, in order */
  e.main.shared = true;
  const emitters = [...e.functions, e.main];
  const bodies = emitters.map((f) => f.emit());
  const infos = m.functions.map((fn) => functionInfo(fn, e.strings, e.embedSource));
  const nGlobals = Math.max(1, m.globals.length);
  const cells = e.strings.cells;
  const c = [
    GENERATED,
    "#include <stdlib.h>",
    '#include "js_runtime.h"',
    "",
    ...(e.hosts.used.size ? [...e.hosts.decls(), ""] : []),
    ...dataLines(m, prefix, `${prefix}register`, options, e, ""),
    "",
    ...emitters.flatMap((f) => [f.prototype(), ...f.resumePrototype()]),
    ...m.functions.map((fn) => genericPrototype(fn, prefix)),
    "",
    ...infos,
    ...(infos.length ? [""] : []),
    ...bodies.flatMap((b) => [b, ""]),
    ...m.functions.flatMap((fn) => [genericEntry(fn, prefix), ""]),
    `void ${prefix}register(JSRuntime *rt) {`,
    ...(cells.length ? [`    js_register_static_atoms(rt, ${prefix}mod_atoms, ${cells.length});`] : []),
    ...(e.caches.count ? [`    js_register_prop_caches(rt, ${prefix}mod_ics, ${e.caches.count});`] : []),
    `    for (size_t i = 0; i < ${nGlobals}; i++) ${prefix}mod_globals[i] = JS_UNDEFINED;`,
    `    js_register_roots(rt, ${prefix}mod_globals, ${nGlobals});`,
    "}",
    "",
  ].join("\n");
  return { c, atoms: e.strings.atoms };
}

/** A module's emitters, and the tables they fill as they emit. */
interface Emission {
  strings: Strings;
  caches: Caches;
  hosts: Hosts;
  /** m.functions', in order */
  functions: FunctionEmitter[];
  main: FunctionEmitter;
  embedSource: boolean;
}

function prepare(m: ModuleIR, p: string, options: EmitOptions): Emission {
  const strings = new Strings(p, options.regexps, options.harness?.atoms);
  const caches = new Caches();
  const hosts = new Hosts(options.hostPrimitives ?? {});
  const callees = new Map(m.functions.map((fn) => [fn.name, fn]));
  return {
    strings, caches, hosts,
    functions: m.functions.map((fn) => new FunctionEmitter(fn, cFunctionName(fn, false, p), strings, caches, hosts, callees)),
    main: new FunctionEmitter(m.main, cFunctionName(m.main, true, p), strings, caches, hosts, callees),
    embedSource: options.embedSource === true && m.functions.some((fn) => fn.meta!.source),
  };
}

function genericPrototype(fn: FunctionIR, p: string): string {
  return `static JSValue ${cFunctionName(fn, false, p)}__generic(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);`;
}

/** The module's data, once every function is emitted: globals, literals, caches, tables.
 *  `storage`: "static " in one file; "" in a split program's program.c, which defines them for
 *  the other files. */
function dataLines(m: ModuleIR, p: string, entry: string | null, options: EmitOptions, e: Emission, storage: string): string[] {
  const nGlobals = m.globals.length;
  const atoms = e.strings.cells;
  return [
    nGlobals ? `/* ${m.globals.map((g) => `@${g.slot} ${g.name}`).join(", ")} */` : "",
    `${storage}JSValue ${p}mod_globals[${Math.max(1, nGlobals)}];`,
    "",
    ...e.strings.decls.map((d) => d.define(storage)),
    ...(e.embedSource ? [sourceCell(m.source, p).define(storage)] : []),
    ...(atoms.length ? [`static const JSString *const ${p}mod_atoms[] = { ${atoms.map((a) => `(const JSString *)&${a}`).join(", ")} };`] : []),
    ...(e.caches.count ? [`${storage}JSPropCache ${p}mod_ics[${e.caches.count}];`] : []),
    ...(options.components?.length && !entry ? [`static const JSComponent *const ${p}mod_components[] = { ${options.components.map((c) => `&${c}`).join(", ")} };`] : []),
    ...(options.core && !entry ? [`static const JSCoreEntry ${p}mod_core[] = {`, ...options.core.map((c) => `    ${c.c},`), "};"] : []),
  ];
}

/** main(), or a test262 unit's run(): a runtime, the module's tables, the script, the event loop. */
function mainLines(m: ModuleIR, p: string, entry: string | null, options: EmitOptions, e: Emission): string[] {
  const nGlobals = m.globals.length;
  const atoms = e.strings.cells;
  return [
    ...(entry ? [`int ${entry}(void) {`] : ["int main(int argc, char **argv) {"]),
    "    JSRuntime *rt = js_runtime_new();",
    /* before the realm interns its own names, so they resolve to these cells */
    ...(atoms.length ? [`    js_register_static_atoms(rt, ${p}mod_atoms, ${atoms.length});`] : []),
    ...(e.caches.count ? [`    js_register_prop_caches(rt, ${p}mod_ics, ${e.caches.count});`] : []),
    ...(options.harness?.scripts.length
      ? [`    void ${options.harness.register}(JSRuntime *rt);`, `    ${options.harness.register}(rt);  /* the harness's tables */`]
      : []),
    options.core && !entry
      ? `    js_use_core(rt, ${p}mod_core, ${options.core.length});  /* the core methods it names */`
      : "    js_use_all_core(rt);  /* every core method */",
    "    JSContext *ctx = js_context_new(rt);",
    ...(options.components?.length && !entry ? [`    js_install_components(ctx, ${p}mod_components, ${options.components.length});  /* optional built-ins */`] : []),
    ...(entry ? ["    js_test_host_init(ctx);  /* $262 */"] : ["    if (js_host_init(ctx, argc, argv) < 0) return js_report_uncaught(ctx);  /* console, process */"]),
    ...harnessLines(options.harness),
    `    for (size_t i = 0; i < ${Math.max(1, nGlobals)}; i++) ${p}mod_globals[i] = JS_UNDEFINED;`,
    `    js_register_roots(rt, ${p}mod_globals, ${Math.max(1, nGlobals)});`,
    `    int status = js_run_event_loop(ctx, ${p}js_script(ctx));  /* then the microtasks */`,
    ...(entry ? [] : ["    status = js_host_exit(ctx, status);  /* process's beforeExit and exit, process.exitCode */"]),
    "    js_context_free(ctx);",
    "    js_runtime_free(rt);",
    "    return status;",
    "}",
    "",
  ];
}

/** A test262 unit's harness scripts, run before its own: a harness error is the unit's. */
function harnessLines(harness: HarnessLink | undefined): string[] {
  if (!harness?.scripts.length) return [];
  return [
    ...harness.scripts.map((h) => `    JSValue ${h}js_script(JSContext *ctx);`),
    ...harness.scripts.map((h) => `    if (js_is_exception(${h}js_script(ctx))) return js_report_uncaught(ctx);`),
  ];
}

const GENERATED = "/* Generated by visaljs. Do not edit. */";

function emitModule(m: ModuleIR, p: string, entry: string | null, options: EmitOptions): string {
  const e = prepare(m, p, options);
  const emitters = [...e.functions, e.main];
  const bodies = emitters.map((f) => f.emit());
  const infos = m.functions.map((fn) => functionInfo(fn, e.strings, e.embedSource));
  return [
    GENERATED,
    "#include <stdlib.h>",
    '#include "js_runtime.h"',
    "",
    ...(e.hosts.used.size ? [...e.hosts.decls(), ""] : []),
    ...dataLines(m, p, entry, options, e, "static "),
    "",
    ...emitters.flatMap((f) => [f.prototype(), ...f.resumePrototype()]),
    ...m.functions.map((fn) => genericPrototype(fn, p)),
    "",
    ...infos,
    ...(infos.length ? [""] : []),
    ...bodies.flatMap((b) => [b, ""]),
    ...m.functions.flatMap((fn) => [genericEntry(fn, p), ""]),
    ...mainLines(m, p, entry, options, e),
  ].join("\n");
}

// ---- A split program -------------------------------------------------------

/** What a function's C costs to compile, roughly: its IR instructions. */
function weight(fn: FunctionIR): number {
  let n = 0;
  for (const b of fn.blocks) n += b.instrs.length + b.phis.length + 1;
  return n;
}

/** Each function's file (1, 2, …), for files of about `size` instructions each. Functions
 *  stay in the bundle's order, so a package's functions, which mostly call each other, share
 *  a file. Null for a program that fits one file. */
function partition(fns: readonly FunctionIR[], size: number): Map<FunctionIR, number> | null {
  const weights = fns.map(weight);
  const total = weights.reduce((a, b) => a + b, 0);
  const count = Math.round(total / size);
  if (count <= 1) return null;
  /* a function goes where its middle falls; a big one can leave a file empty: renumber */
  const raw: number[] = [];
  let before = 0;
  weights.forEach((w) => {
    raw.push(Math.min(count - 1, Math.floor(((before + w / 2) * count) / total)));
    before += w;
  });
  const used = [...new Set(raw)];
  if (used.length <= 1) return null;
  return new Map(fns.map((fn, i) => [fn, used.indexOf(raw[i]!) + 1]));
}

/** The program's C files: program.c alone under `options.partSize` instructions, else
 *  program_1.c … program_N.c (the functions, compiled in parallel), program.h and program.c (the
 *  data and main()). Yielded as each is made, so a caller that writes each away never holds a
 *  large program's C (hundreds of megabytes) at once. */
export function* emitProgramFiles(m: ModuleIR, options: EmitOptions = {}): Generator<CFile> {
  const fns = [...m.functions, m.main];
  const parts = options.partSize ? partition(fns, options.partSize) : null;
  if (!parts) {
    yield { name: "program.c", text: emitProgram(m, options) };
    return;
  }

  const e = prepare(m, "", options);
  const emitters = new Map(fns.map((fn, i) => [fn, i < m.functions.length ? e.functions[i]! : e.main]));
  const byName = new Map(m.functions.map((fn) => [fn.name, fn]));
  const sharedInfos = new Set<FunctionIR>();
  e.main.shared = true;  /* main(), in program.c, calls it */
  for (const fn of fns)
    for (const b of fn.blocks)
      for (const i of b.instrs) {
        if (i.op !== "call_direct" && i.op !== "construct_direct" && i.op !== "make_function" && i.op !== "same_function") continue;
        const target = byName.get(i.target!);
        if (!target || parts.get(target) === parts.get(fn)) continue;
        if (i.op === "call_direct" || i.op === "construct_direct") emitters.get(target)!.shared = true;
        if (i.op !== "call_direct") sharedInfos.add(target);  /* construct_direct compares the function's info */
      }
  /* each part's functions, in order: a part is a run of them */
  const byPart = new Map<number, FunctionIR[]>();
  for (const fn of fns) {
    const k = parts.get(fn)!;
    if (!byPart.has(k)) byPart.set(k, []);
    byPart.get(k)!.push(fn);
  }
  for (const [k, own] of byPart) {
    const made = own.filter((fn) => fn !== m.main);
    const bodies = own.map((fn) => emitters.get(fn)!.emit());
    const text = [
      GENERATED,
      '#include "program.h"',
      "",
      ...own.flatMap((fn) => {
        const f = emitters.get(fn)!;
        return [...(f.shared ? [] : [f.prototype()]), ...f.resumePrototype()];
      }),
      ...made.map((fn) => genericPrototype(fn, "")),
      "",
      ...made.map((fn) => functionInfo(fn, e.strings, e.embedSource, sharedInfos.has(fn))),
      ...(made.length ? [""] : []),
      ...bodies.flatMap((body) => [body, ""]),
      ...made.flatMap((fn) => [genericEntry(fn, ""), ""]),
    ];
    yield { name: `program_${k}.c`, text: text.join("\n") };
  }

  /* once every function is emitted: the literals, caches and hosts they use */
  const header = [
    GENERATED,
    "/* What the program's files share: program.c defines the data, program_N.c the functions. */",
    "#include <stdlib.h>",
    '#include "js_runtime.h"',
    "",
    ...(e.hosts.used.size ? [...e.hosts.decls(), ""] : []),
    "#ifndef VISALJS_PROGRAM_DATA  /* program.c has the definitions */",
    `extern JSValue mod_globals[${Math.max(1, m.globals.length)}];`,
    ...(e.caches.count ? [`extern JSPropCache mod_ics[${e.caches.count}];`] : []),
    ...e.strings.decls.map((d) => d.declare),
    ...(e.embedSource ? [sourceCell(m.source, "").declare] : []),
    "#endif",
    "",
    ...fns.filter((fn) => emitters.get(fn)!.shared).map((fn) => emitters.get(fn)!.prototype()),
    ...[...sharedInfos].map((fn) => `extern const JSFunctionInfo ${infoName(fn.name, "")};`),
    "",
  ];
  yield { name: "program.h", text: header.join("\n") };
  const data = [GENERATED, "#define VISALJS_PROGRAM_DATA", '#include "program.h"', "", ...dataLines(m, "", null, options, e, ""), "", ...mainLines(m, "", null, options, e)];
  yield { name: "program.c", text: data.join("\n") };
}
