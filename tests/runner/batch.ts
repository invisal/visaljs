// Runs compile units in batches.
//
// A batch's units are compiled in-process to C, one file with each unit's
// names prefixed, built at -O0 into one shared library, and run by the test
// host (host.c), which forks a child per unit. Negative parse tests only go
// through the front end and semantic analysis.
//
// The harness files are compiled once, into the host: a unit runs the ones it
// includes as scripts before its own code, so its C is only the test's.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { analyze, CompileError, emitHarnessScript, emitUnit, firstUnsupported, lower, parseModule, parseScript, type HarnessLink, type Program } from "@visaljs/compiler";
import { optimize } from "@visaljs/optimizer";
import { findCompiler, gcCheckFlags, RUNTIME_DIR, runtimeArchives } from "visaljs/cc";
import { compileRegExps, regexpLiterals } from "visaljs/regexp";
import { renderUnit, type CompileUnit, type Mode } from "./units.ts";

function parseUnit(unit: CompileUnit, source: string) {
  return unit.mode === "module" ? parseModule(source, unit.path) : parseScript(source, unit.path);
}

export type Outcome = "pass" | "fail" | "not-run";

/** Why a unit didn't pass, for the summary's breakdown. */
export type Reason = "passed" | "not-run" | "unsupported" | "syntax-error" | "compiler-crash" | "cc-error" | "failed" | "crashed" | "timeout";

export interface Result {
  outcome: Outcome;
  reason: Reason;
  /** What went wrong: the compile error, or the first line of the unit's output. */
  detail?: string;
}

export interface Item {
  unit: CompileUnit;
  source: string;
}

const TIMEOUT_SECONDS = 10;
const INCLUDE = join(RUNTIME_DIR, "include");
/* VISALJS_GC_CHECKS: a checking runtime, and the units compiled to match (its inline allocation) */
const GC_CHECKS = gcCheckFlags();
const pass: Result = { outcome: "pass", reason: "passed" };
const fail = (reason: Reason, detail?: string): Result => ({ outcome: "fail", reason, ...(detail ? { detail } : {}) });

// ---- The harness, compiled once -------------------------------------------------------

const HARNESS_DIR = join(import.meta.dirname, "..", "test262", "harness");
const HARNESS_REGISTER = "t262_harness_register";

interface Harness {
  /** Every harness script's C, and HARNESS_REGISTER. */
  c: string;
  atoms: Map<string, string>;
  /** The compiled scripts' prefixes, by harnessKey. */
  scripts: Map<string, string>;
}

/** A module unit's harness runs as scripts, as test262's INTERPRETING.md has it. */
const harnessKey = (mode: Mode, file: string) => `${mode === "strict" ? "strict" : "sloppy"}:${file}`;

let harness: Harness | null = null;

/** Each harness file as a script, sloppy and strict, compiled to C. A file that doesn't compile,
 *  or that declares a top-level let, const or class (a separate script wouldn't share them), stays
 *  in its units' source. */
function compiledHarness(): Harness {
  if (harness) return harness;
  const atoms = new Map<string, string>();
  const scripts = new Map<string, string>();
  const parts: string[] = [];
  for (const file of readdirSync(HARNESS_DIR).filter((f) => f.endsWith(".js")).sort()) {
    const text = readFileSync(join(HARNESS_DIR, file), "utf8");
    for (const mode of ["sloppy", "strict"] as const) {
      const prefix = `h${scripts.size}_`;
      try {
        const ast = parseScript((mode === "strict" ? '"use strict";\n' : "") + text, file);
        const info = analyze(ast);
        if ([...info.program.scope.bindings.values()].some((b) => b.kind !== "var" && b.kind !== "function")) break;
        if (firstUnsupported(ast)) break;
        const ir = optimize(lower(ast, info));
        const h = emitHarnessScript(ir, prefix, atoms, { embedSource: true, regexps: checkRegExps(ast) });
        for (const [s, name] of h.atoms) atoms.set(s, name);
        parts.push(h.c);
        scripts.set(harnessKey(mode, file), prefix);
      } catch {
        break;
      }
    }
  }
  const prefixes = [...scripts.values()];
  parts.push([
    ...prefixes.map((p) => `void ${p}register(JSRuntime *rt);`),
    `void ${HARNESS_REGISTER}(JSRuntime *rt) {`,
    ...prefixes.map((p) => `    ${p}register(rt);`),
    "}",
    "",
  ].join("\n"));
  return (harness = { c: parts.join("\n"), atoms, scripts });
}

/** The unit's leading harness files that are compiled into the host, and the rest, which stay
 *  in its source (in order: once one isn't compiled, the ones after it aren't run from the host). */
function splitHarness(unit: CompileUnit): { link: HarnessLink; rest: string[] } {
  const h = compiledHarness();
  const scripts: string[] = [];
  for (const file of unit.harness) {
    const prefix = h.scripts.get(harnessKey(unit.mode, file));
    if (!prefix) break;
    scripts.push(prefix);
  }
  return { link: { atoms: h.atoms, register: HARNESS_REGISTER, scripts }, rest: unit.harness.slice(scripts.length) };
}

// ---- The host program ------------------------------------------------------------

let hostPath: string | null = null;

/** Builds (or reuses) the host, linked with an optimized runtime and the compiled harness. */
export function testHost(): string {
  if (hostPath) return hostPath;
  const cc = findCompiler();
  const archives = runtimeArchives({ cc, opt: ["-O2", ...GC_CHECKS] });
  const lib = archives[0]!;     /* libjsrt, whole: the tests' code reaches any of it */
  const rest = archives.slice(1);
  const src = join(import.meta.dirname, "host.c");
  const harnessC = compiledHarness().c;
  const key = createHash("sha256").update(lib).update(readFileSync(lib)).update(rest.join("\n")).update(readFileSync(src)).update(harnessC).digest("hex").slice(0, 16);
  const cache = process.env.VISALJS_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "visaljs");
  const host = join(cache, `test262-host-${key}`);
  if (!existsSync(host)) {
    const tmp = `${host}.${process.pid}.tmp`;
    mkdirSync(cache, { recursive: true });
    writeFileSync(`${tmp}.c`, harnessC);
    try {
      /* the harness at -O1: compiled once, run by every unit, and -O2 takes much longer on it */
      execFileSync(cc, ["-std=c11", "-O1", ...GC_CHECKS, "-w", "-c", `-I${INCLUDE}`, `${tmp}.c`, "-o", `${tmp}.o`], { stdio: ["ignore", "inherit", "inherit"] });
      execFileSync(cc, ["-std=c11", "-O2", "-g", src, `${tmp}.o`, "-rdynamic", "-Wl,--whole-archive", lib, "-Wl,--no-whole-archive", ...rest, "-ldl", "-lm", "-pthread", "-o", tmp], {
        stdio: ["ignore", "inherit", "inherit"],
      });
    } finally {
      rmSync(`${tmp}.c`, { force: true });
      rmSync(`${tmp}.o`, { force: true });
    }
    renameSync(tmp, host);
  }
  return (hostPath = host);
}

// ---- Compiling -----------------------------------------------------------------------

let batchCompiler: string | null = null;

/** The C compiler for batches: $CC, else clang (about twice as fast as gcc at -O0 on
 *  generated code), else whatever the driver finds. */
function testCompiler(): string {
  if (batchCompiler) return batchCompiler;
  if (process.env.CC) return (batchCompiler = process.env.CC);
  try {
    execFileSync("clang", ["--version"], { stdio: "ignore" });
    return (batchCompiler = "clang");
  } catch {
    return (batchCompiler = findCompiler());
  }
}

/** Compiles a unit to C, or says why it can't be. */
function toC(unit: CompileUnit, source: string, prefix: string, harness: HarnessLink): { c: string } | { result: Result } {
  try {
    const ast = parseUnit(unit, source);
    const info = analyze(ast);
    const regexps = checkRegExps(ast);
    const unsupported = firstUnsupported(ast);
    if (unsupported) throw unsupported;
    const ir = optimize(lower(ast, info));  // as the CLI builds: the optimizer verifies its input and output
    return { c: emitUnit(ir, prefix, { embedSource: true, regexps, harness }) };  // conformance: toString shows source
  } catch (e) {
    if (e instanceof CompileError) {
      /* a runtime-negative test expecting SyntaxError can't be compile-time (that's phase parse) */
      return { result: fail(e.kind === "NotSupported" ? "unsupported" : "syntax-error", e.message) };
    }
    return { result: fail("compiler-crash", (e as Error).message) };
  }
}

/** The unit's regex literals compiled, as the driver does: an invalid one is a SyntaxError. */
function checkRegExps(ast: Program): Map<string, Uint8Array> {
  const literals = regexpLiterals(ast);
  return literals.length ? compileRegExps(findCompiler(), literals) : new Map();
}

/** The address space a C compile may use (bytes; 0: no limit). Over it, the compile fails: a batch
 *  is then built one unit per library, and a unit still over it is a cc-error. */
let ccMemory = 0;
export function setCcMemory(bytes: number) {
  ccMemory = bytes;
}

function buildLibrary(cc: string, files: string[], output: string): boolean {
  const args = ["-std=c11", "-O0", ...GC_CHECKS, "-w", "-fPIC", "-shared", `-I${INCLUDE}`, ...files, "-o", output];
  /* ulimit -v is in KiB; where the shell can't set it, the compile runs without */
  const r = ccMemory && process.platform === "linux"
    ? spawnSync("sh", ["-c", `ulimit -v ${Math.floor(ccMemory / 1024)} 2>/dev/null; exec "$0" "$@"`, cc, ...args], { encoding: "utf8" })
    : spawnSync(cc, args, { encoding: "utf8" });
  return r.status === 0;
}

// ---- Running -------------------------------------------------------------------------

interface HostRecord {
  kind: "exit" | "signal" | "missing";
  code: number;
  output: string;
}

function parseRecords(stdout: Buffer): Map<string, HostRecord> {
  const records = new Map<string, HostRecord>();
  let at = 0;
  while (at < stdout.length) {
    const nl = stdout.indexOf(10, at);
    if (nl < 0) break;
    const [prefix, kind, code, len] = stdout.subarray(at, nl).toString("latin1").split(" ");
    const n = Number(len);
    records.set(prefix!, { kind: kind as HostRecord["kind"], code: Number(code), output: stdout.subarray(nl + 1, nl + 1 + n).toString("utf8") });
    at = nl + 1 + n;
  }
  return records;
}

/** What a finished run means for the unit. */
function classify(unit: CompileUnit, r: HostRecord | undefined): Result {
  if (!r || r.kind === "missing") return fail("crashed");
  const detail = r.output.split("\n", 1)[0]!.slice(0, 200);
  if (r.kind === "signal") return fail(r.code === 14 ? "timeout" : "crashed", `signal ${r.code}: ${detail}`);
  const expect = unit.expect;
  switch (expect.kind) {
    case "normal":
      return r.code === 0 ? pass : fail("failed", detail);
    case "async":
      return r.code === 0 && r.output.includes("Test262:AsyncTestComplete") && !r.output.includes("Test262:AsyncTestFailure") ? pass : fail("failed", detail);
    case "runtime-error": {
      const m = /^Uncaught ([A-Za-z_$][\w$]*)/m.exec(r.output);
      return r.code !== 0 && m?.[1] === expect.type ? pass : fail("failed", detail || "no error thrown");
    }
    default:
      return fail("failed");
  }
}

/** Negative parse/resolution tests: the front end and analysis must reject them with a SyntaxError. */
function checkEarlyError(unit: CompileUnit, source: string): Result {
  try {
    const ast = parseUnit(unit, source);
    analyze(ast);
    checkRegExps(ast);
  } catch (e) {
    if (!(e instanceof CompileError)) return fail("compiler-crash");
    /* "not supported yet" proves nothing about the program being invalid */
    return e.kind === "SyntaxError" && unit.expect.kind === "compile-error" && unit.expect.type === "SyntaxError" ? pass : fail("failed");
  }
  return fail("failed");  // accepted an invalid program
}

/** Runs a batch of units; results in the same order. */
export function runBatch(items: Item[], readHarness: (file: string) => string): Result[] {
  const started = performance.now();
  const results: (Result | null)[] = items.map(() => null);
  const compiled: { index: number; prefix: string; c: string }[] = [];
  items.forEach(({ unit, source }, index) => {
    if (unit.expect.kind === "compile-error") return void (results[index] = checkEarlyError(unit, renderUnit(unit, source, readHarness)));
    const { link, rest } = splitHarness(unit);
    const text = renderUnit({ ...unit, harness: rest }, source, readHarness);
    const prefix = `u${index}_`;
    const c = toC(unit, text, prefix, link);
    if ("result" in c) results[index] = c.result;
    else compiled.push({ index, prefix, c: c.c });
  });

  const compiledAt = performance.now();
  let builtAt = compiledAt;
  if (compiled.length) {
    const cc = testCompiler();
    const host = testHost();
    const dir = mkdtempSync(join(tmpdir(), "visaljs-t262-"));
    try {
      /* one library for the batch; if it doesn't build, one per unit to find the culprit */
      let libs: { lib: string; units: typeof compiled }[] = [];
      const all = join(dir, "batch.c");
      writeFileSync(all, compiled.map((u) => u.c).join("\n"));
      const ok = buildLibrary(cc, [all], join(dir, "batch.so"));
      builtAt = performance.now();
      if (ok) {
        libs = [{ lib: join(dir, "batch.so"), units: compiled }];
      } else {
        for (const u of compiled) {
          const file = join(dir, `${u.prefix}.c`);
          writeFileSync(file, u.c);
          if (buildLibrary(cc, [file], join(dir, `${u.prefix}.so`))) libs.push({ lib: join(dir, `${u.prefix}.so`), units: [u] });
          else results[u.index] = fail("cc-error");
        }
      }
      for (const { lib, units } of libs) {
        const run = spawnSync(host, [lib, String(TIMEOUT_SECONDS), ...units.map((u) => u.prefix)], {
          maxBuffer: 256 << 20,
          timeout: (TIMEOUT_SECONDS + 5) * 1000 * units.length,
        });
        const records = parseRecords(run.stdout ?? Buffer.alloc(0));
        for (const u of units) results[u.index] = classify(items[u.index]!.unit, records.get(u.prefix));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  /* VISALJS_T262_SLOW=<seconds>: report slow batches (where a full run spends its time) */
  const slow = Number(process.env.VISALJS_T262_SLOW ?? 0);
  const total = (performance.now() - started) / 1000;
  if (slow && total > slow)
    console.error(`slow batch ${total.toFixed(1)}s (js ${((compiledAt - started) / 1000).toFixed(1)}s, cc ${((builtAt - compiledAt) / 1000).toFixed(1)}s, run ${((performance.now() - builtAt) / 1000).toFixed(1)}s): ${items[0]!.unit.path} … ${items.at(-1)!.unit.path}`);
  return results.map((r) => r!);
}
