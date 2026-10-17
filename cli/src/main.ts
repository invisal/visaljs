// The `visaljs` command line.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import {
  analyze, type CFile, COMPONENTS, CompileError, emitProgramFiles, firstUnsupported, type HostPrimitives, lower, namedCore, parseModule, parseScript,
  programNames, reachableComponents, SourceMap,
} from "@visaljs/compiler";
import { type ModuleIR, printModule } from "@visaljs/ir";
import { formatReport, optimize, type PassReport } from "@visaljs/optimizer";

import { BundleError, bundle } from "./bundle.ts";
import { compileJobs, compileProgram, describeCompiler, findCompilers, gcCheckFlags, programArchives, scratchDir } from "./cc.ts";
import { evalCalls, evalWarning } from "./eval.ts";
import { licensesText } from "./licenses.ts";
import { DEFAULT_HOSTS, hostPrimitives } from "./hosts.ts";
import { EntryError } from "./integrations/project.ts";
import { IntegrationError } from "./pipeline/errors.ts";
import { type Pipeline, runPipeline } from "./pipeline/index.ts";
import { compileRegExps, regexpLiterals } from "./regexp.ts";
import { count, lineCount, Report, type ReportStyle, size, sizeQuip } from "./report.ts";

export const VERSION = "0.0.7";

/** A program's C splits into files of about this many IR instructions. */
const PART_SIZE = 20_000;

const TYPESCRIPT = /\.(?:[cm]?ts|tsx)$/;

const USAGE = `usage: visaljs build [entry.js | entry.ts | project directory] [options]
       visaljs licenses   print the licenses to ship with a binary you distribute

A project (the current directory when none is given) builds its framework's production server: a
Next.js app is built with \`next build\` (as a standalone build, next.config unchanged) and a
vinext app with its own \`vite build\` first, then the server is compiled with the app. Any other
project builds the file its package.json starts: its one "bin" command, the file "scripts.start"
runs with node, or "main"; else index.js. The binary is named after the command or the project.

TypeScript (.ts, .mts, .cts, .tsx) is compiled too: its types are stripped, not checked (run tsc
for that), with the nearest tsconfig.json's settings (paths, decorators).

options:
  -o <file>          output binary
  --emit-c <dir>     stop after C emission
  --dump-ast         print the syntax tree and stop
  --dump-ir          print the IR and stop
  --debug            build without optimization (-O0), keeping symbols and debug info
  --symbols          keep symbols and debug info in the optimized build (for profilers such as perf)
  --no-optimize      skip the IR optimizer (to compare, or to rule it out)
  -j, --jobs <n>     compile at most n C files at once (default: one per processor, memory permitting)
  --embed-source     embed the source text: Function.prototype.toString returns it
  --all-builtins     install every built-in, not only those the program names
  --all-features     link every optional part of the Node modules (node:stream's pipeline,
                     FormData, Brotli…), not only those the program's code names
  --node-env <name>  the value of process.env.NODE_ENV, fixed at build time (default: production);
                     empty: read from the environment at run time
  --no-bundle        skip the bundler: the input is one ES module (a bundle)
  --no-framework-build  a project: compile its existing build output, without building it first
  --script           compile as a classic script (sloppy mode, no bundler)
  -q, --quiet        don't report each step of the build
  --verbose          list each place a warning is about
  --version          print the version
  --help             print this help
`;

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Report each step of a build on stderr, in this style; none: no report. */
  report?: ReportStyle | undefined;
}

/** Runs the CLI and returns the process exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        "emit-c": { type: "string" },
        "dump-ast": { type: "boolean" },
        "dump-ir": { type: "boolean" },
        debug: { type: "boolean" },
        symbols: { type: "boolean" },
        "no-optimize": { type: "boolean" },
        jobs: { type: "string", short: "j" },
        "embed-source": { type: "boolean" },
        "all-builtins": { type: "boolean" },
        "all-features": { type: "boolean" },
        "node-env": { type: "string" },
        "no-bundle": { type: "boolean" },
        "no-framework-build": { type: "boolean" },
        script: { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        verbose: { type: "boolean" },
        version: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.stderr(`visaljs: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`visaljs ${VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    io.stdout(USAGE);
    return values.help ? 0 : 2;
  }

  const [command, ...rest] = positionals;
  switch (command) {
    case "build":
      if (rest.length > 1) {
        io.stderr(`visaljs build: expected one entry file or project directory\n${USAGE}`);
        return 2;
      }
      return await build(rest[0] ?? ".", values, io);
    case "licenses":
      if (rest.length) {
        io.stderr(`visaljs licenses: takes no arguments\n${USAGE}`);
        return 2;
      }
      io.stdout(licensesText(DEFAULT_HOSTS, VERSION));
      return 0;
    default:
      io.stderr(`visaljs: unknown command '${command}'\n${USAGE}`);
      return 2;
  }
}

interface BuildOptions {
  output?: string | undefined;
  "emit-c"?: string | undefined;
  "dump-ast"?: boolean | undefined;
  "dump-ir"?: boolean | undefined;
  debug?: boolean | undefined;
  symbols?: boolean | undefined;
  "no-optimize"?: boolean | undefined;
  jobs?: string | undefined;
  "embed-source"?: boolean | undefined;
  "all-builtins"?: boolean | undefined;
  "all-features"?: boolean | undefined;
  "node-env"?: string | undefined;
  "no-bundle"?: boolean | undefined;
  "no-framework-build"?: boolean | undefined;
  script?: boolean | undefined;
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
}

async function build(entry: string, options: BuildOptions, io: Io): Promise<number> {
  const dump = options["dump-ast"] === true || options["dump-ir"] === true;
  const style = options.quiet || dump ? undefined : io.report;  /* none: no report, but warnings and errors */
  const report = new Report(io.stderr, style);
  const binary = !dump && !options["emit-c"];
  const hosts = DEFAULT_HOSTS;
  const primitives = hostPrimitives(hosts);
  /* a production build, as bundlers make for a server (--node-env= leaves it to the environment) */
  const nodeEnv = options["node-env"] === "" ? undefined : options["node-env"] ?? "production";

  /* a project directory: its integrations' pipeline gives the entry */
  let pipeline: Pipeline | undefined;
  if (statSync(entry, { throwIfNoEntry: false })?.isDirectory()) {
    const flags = { skipFrameworkBuild: options["no-framework-build"] === true, nodeEnv, debug: options.debug === true, allFeatures: options["all-features"] === true };
    try {
      pipeline = await runPipeline(resolve(entry), { flags, output: options.output, report });
    } catch (e) {
      if (!(e instanceof IntegrationError)) throw e;
      io.stderr(e instanceof EntryError ? `visaljs: ${entry === "." ? "the current directory" : entry}: ${e.message}: give an entry file\n` : `visaljs: ${e.message}\n`);
      return 1;
    }
    entry = pipeline.entry;
  }
  let source = pipeline?.extras.source;
  if (source === undefined) {
    try {
      source = readFileSync(entry, "utf8");
    } catch (e) {
      io.stderr(`visaljs: cannot read ${entry}: ${(e as Error).message}\n`);
      return 1;
    }
  }
  /* the bundler strips TypeScript's types: the parser takes JavaScript only */
  if ((options.script || options["no-bundle"]) && TYPESCRIPT.test(entry)) {
    io.stderr(`visaljs: ${entry} is TypeScript: it's compiled through the bundler, without ${options.script ? "--script" : "--no-bundle"}\n`);
    return 1;
  }

  /* found first, so a missing compiler fails the build before the slow steps */
  let compilers: string[] | undefined;
  if (binary) {
    try {
      compilers = await report.step("🔍", "Detecting C compilers", findCompilers, detected);
    } catch (e) {
      io.stderr(`visaljs: ${(e as Error).message}\n`);
      return 1;
    }
  }

  const script = options.script === true;
  const bundled = !script && options["no-bundle"] !== true;
  let map: string | undefined;
  if (bundled) {
    try {
      const b = await report.step("📦", "Rolling the modules into a single file", () => bundle(entry, hosts, (message, where) => report.warn(message, where),
        { ...pipeline?.extras, nodeEnv, allFeatures: options["all-features"] === true }),
        (b) => `Rolled ${count(b.modules, "module")} into a single file (${size(Buffer.byteLength(b.code))})` +
          (b.required.length ? `; for a require() at run time: ${b.required.join(", ")}` : ""));
      source = b.code;
      /* a program with no side effects bundles to nothing, and rolldown gives no map */
      if (b.map) map = b.map;
    } catch (e) {
      if (!(e instanceof BundleError)) throw e;
      io.stderr(`${e.message}\n`);
      return 1;
    }
  }
  if (options.jobs !== undefined && (!Number.isInteger(Number(options.jobs)) || Number(options.jobs) < 1)) {
    io.stderr(`visaljs: --jobs takes a positive whole number, not '${options.jobs}'\n`);
    return 2;
  }
  const emitDir = options["emit-c"];
  let output = "";
  if (binary) {
    output = pipeline?.output ?? options.output ?? basename(entry).replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, "");
    if (process.platform === "win32" && !extname(output)) output += ".exe";  /* the linker would add it anyway */
    /* a bin file without an extension, or a directory of the command's name: the binary would replace it */
    if (resolve(output) === resolve(entry) || statSync(output, { throwIfNoEntry: false })?.isDirectory()) {
      io.stderr(`visaljs: the binary would be ${displayPath(resolve(output))}, which is ${resolve(output) === resolve(entry) ? "the entry file" : "a directory"}: give another with -o\n`);
      return 1;
    }
  }
  const dir = emitDir ?? (binary ? scratchDir() : "");
  try {
    const c = await compileInWorker({ source, entry, map, options, primitives, compilers, dir, emitDir }, report);
    if ("compileError" in c) {
      io.stderr(`${c.compileError}\n`);
      return 1;
    }
    compilers = c.compilers;
    if (typeof c.result === "string") {
      io.stdout(c.result);
      return 0;
    }
    const written = c.result;

    if (emitDir) {
      if (bundled) writeFileSync(join(emitDir, "bundle.js"), source);  /* what was compiled */
      report.finish("📂", (time) => `Wrote ${written.length > 1 ? `${written.length} files to ${displayPath(resolve(emitDir))}` : displayPath(resolve(emitDir, "program.c"))} in ${time}`);
      return 0;
    }
    const cFiles = written.filter((name) => name.endsWith(".c")).map((name) => join(dir, name));
    const opt = [...(options.debug ? ["-O0"] : ["-O2"]), ...gcCheckFlags()];
    const strip = !options.debug && !options.symbols;
    /* measured now, with the compiler's worker and its heap gone */
    const jobs = options.jobs === undefined ? compileJobs(strip ? 0.8e9 : 1.5e9) : Number(options.jobs);
    try {
      /* the libraries and the program with one compiler: a failure in either moves both to the next */
      await withCompiler(compilers!, report, async (cc) => {
        const tc = { cc, opt, strip };
        const built: string[] = [];
        const archives = await report.step("📚", "Preparing the runtime libraries", () => programArchives(tc, hosts, (name) => {
          built.push(`lib${name}`);
          report.relabel(`Building lib${name} with ${describeCompiler(cc)} (first build only: it's cached after)`);
        }), () => (built.length ? `Built ${built.join(", ")} (cached for next time)` : "Runtime libraries ready (cached ⚡)"));
        const compiling = `Compiling with ${describeCompiler(cc)}`;
        const parallel = cFiles.length > 1 ? `${cFiles.length} files, ${Math.min(jobs, cFiles.length)} at a time` : "";
        await report.step("🔨", parallel ? `${compiling} (${parallel})` : compiling, () => compileProgram(tc, cFiles, output, archives, {
          jobs,
          compiled: (done, total) => report.relabel(done < total ? `${compiling} (${done}/${total} files, ${Math.min(jobs, total)} at a time)` : `Linking with ${describeCompiler(cc)}`),
        }),
          () => `Compiled the binary with ${describeCompiler(cc)} (${[...opt, ...(parallel ? [parallel] : [])].join(", ")}, ${tc.strip ? "stripped" : "with debug info"})`);
      });
    } catch (e) {
      io.stderr(`visaljs: C compilation failed: ${(e as Error).message}\n`);
      return 1;
    }
  } finally {
    if (binary) rmSync(dir, { recursive: true, force: true });
  }
  const bytes = statSync(output).size;
  report.finish("🎉", (time) => `Built ${displayPath(resolve(output))} in ${time}: ${size(bytes)}, ${sizeQuip(bytes)}`);
  pipeline?.done(resolve(output));
  return 0;
}

/** What the build report's steps need: the Report, or the compiler's worker's stand-in for it. */
type Reporter = Pick<Report, "step" | "relabel" | "note" | "warn">;

/** compileToC's work, as it crosses to the compiler's worker: plain data. */
interface CompileJob {
  source: string;
  entry: string;
  map: string | undefined;  // the bundle's source map (JSON)
  options: BuildOptions;
  primitives: HostPrimitives;
  compilers: string[] | undefined;
  dir: string;  // where the C files go
  emitDir: string | undefined;  // --emit-c's, made when the first file goes there
}

type CompileResult = { result: string[] | string; compilers: string[] | undefined } | { compileError: string };

type WorkerMessage =
  | { kind: "step"; icon: string; label: string } | { kind: "done"; text: string } | { kind: "fail" }
  | { kind: "relabel"; label: string } | { kind: "note"; text: string } | { kind: "warn"; message: string; where: string }
  | { kind: "result"; result: CompileResult } | { kind: "crash"; stack: string };

const WORKER = "visaljs-compile";

/** compileToC in a worker thread, so its heap (gigabytes for a large program) goes back to the
 *  system for the C compilers when it ends. The worker is this module (bundled: cli.js). */
function compileInWorker(job: CompileJob, report: Report): Promise<CompileResult> {
  /* the heap the build would have had itself */
  const heap = Math.floor(getHeapStatistics().heap_size_limit / 2 ** 20);
  const worker = new Worker(new URL(import.meta.url), { workerData: { [WORKER]: job }, resourceLimits: { maxOldGenerationSizeMb: heap } });
  return new Promise((resolve, reject) => {
    let step: { done(text: string): void; fail(): void } | undefined;
    let result: CompileResult | undefined;
    worker.on("message", (m: WorkerMessage) => {
      switch (m.kind) {
        case "step":
          report.step(m.icon, m.label, () => new Promise<string>((done, fail) => (step = { done, fail: () => fail(new Error(m.label)) })), (text) => text)
            .catch(() => {});
          break;
        case "done": step?.done(m.text); break;
        case "fail": step?.fail(); break;
        case "relabel": report.relabel(m.label); break;
        case "note": report.note(m.text); break;
        case "warn": report.warn(m.message, m.where); break;
        case "result":
          result = m.result;
          void worker.terminate();  /* whatever might keep it running: nothing it holds is needed */
          break;
        case "crash": reject(Object.assign(new Error(m.stack.split("\n")[0]), { stack: m.stack })); break;
      }
    });
    worker.on("error", reject);
    worker.on("exit", () => (result ? resolve(result) : reject(new Error("the compiler's worker stopped without a result"))));
  });
}

async function runCompileJob(job: CompileJob) {
  const post = (m: WorkerMessage) => parentPort!.postMessage(m);
  const reporter: Reporter = {
    async step(icon, label, run, done) {
      post({ kind: "step", icon, label });
      try {
        const result = await run();
        post({ kind: "done", text: done(result) });
        return result;
      } catch (e) {
        post({ kind: "fail" });
        throw e;
      }
    },
    relabel: (label) => post({ kind: "relabel", label }),
    note: (text) => post({ kind: "note", text }),
    warn: (message, where = "") => post({ kind: "warn", message, where }),
  };
  let compilers = job.compilers;
  try {
    const map = job.map === undefined ? undefined : new SourceMap(job.map, displayPath);
    const result = await compileToC(job.source, job.entry, map, job.options, reporter, job.primitives, () => (compilers ??= findCompilers()), (f) => {
      if (job.emitDir) mkdirSync(job.emitDir, { recursive: true });
      writeFileSync(join(job.dir, f.name), f.text);
    });
    post({ kind: "result", result: { result, compilers } });
  } catch (e) {
    if (e instanceof CompileError) post({ kind: "result", result: { compileError: e.message } });
    else post({ kind: "crash", stack: (e as Error).stack ?? String(e) });
  }
}

if (!isMainThread && (workerData as Record<string, unknown> | null)?.[WORKER]) await runCompileJob((workerData as Record<string, CompileJob>)[WORKER]!);

/** The program's C files' names, or the text --dump-ast or --dump-ir prints. Its own function, as
 *  is toIR, so the syntax tree and then the IR become garbage: a large program's take gigabytes. */
async function compileToC(source: string, entry: string, map: SourceMap | undefined, options: BuildOptions, report: Reporter,
  primitives: HostPrimitives, compilers: () => string[], write: (file: CFile) => void): Promise<string[] | string> {
  const program = await toIR(source, entry, map, options, report, primitives, compilers);
  if (typeof program === "string") return program;
  const { ir, names, regexps } = program;
  const all = options["all-builtins"] === true;
  const emitted = await report.step("📝", "Emitting C code", () => {
    const files = emitProgramFiles(ir, {
      embedSource: options["embed-source"] === true,
      components: (all ? COMPONENTS : reachableComponents(names)).map((c) => c.symbol),
      core: all ? undefined : namedCore(names),
      regexps,
      hostPrimitives: primitives,
      partSize: Number(process.env.VISALJS_PART_SIZE) || PART_SIZE,  /* another: tests that split small programs */
    });
    /* each file written as it comes: only its name and size are kept */
    const out = { names: [] as string[], lines: 0, bytes: 0 };
    for (const f of files) {
      write(f);
      out.names.push(f.name);
      out.lines += lineCount(f.text);
      out.bytes += Buffer.byteLength(f.text);
    }
    return out;
  }, ({ names, lines, bytes }) => `Emitted ${count(lines, "line")} of C code (${size(bytes)}${names.length > 1 ? `, in ${names.length} files` : ""})`);
  return emitted.names;
}

async function toIR(source: string, entry: string, map: SourceMap | undefined, options: BuildOptions, report: Reporter,
  primitives: HostPrimitives, compilers: () => string[]): Promise<{ ir: ModuleIR; names: ReturnType<typeof programNames>; regexps: Map<string, Uint8Array> } | string> {
  /* bundled: locations point at the original files (where the bundler generated code, at bundle.js) */
  const ast = await report.step("🌳", "Parsing the JavaScript",
    () => (options.script ? parseScript(source, entry) : parseModule(source, map ? "bundle.js" : entry, map, resolve(entry), primitives)),
    () => `Parsed ${count(lineCount(source), "line")} of JavaScript`);
  if (options["dump-ast"]) return JSON.stringify(ast, null, 2) + "\n";
  const info = analyze(ast);  /* syntax errors first: they matter even in code we can't compile yet */
  const evalWarn = evalWarning(evalCalls(ast, info), options.verbose === true);
  if (evalWarn) report.warn(evalWarn);
  const literals = regexpLiterals(ast);  /* a literal's errors are early errors */
  const regexps = literals.length
    ? await report.step("🧩", "Compiling the regular expressions", () => withCompiler(compilers(), report, (cc) => compileRegExps(cc, literals)),
      () => `Compiled ${count(literals.length, "regular expression")}`)
    : new Map<string, Uint8Array>();
  const unsupported = firstUnsupported(ast);
  if (unsupported) throw unsupported;
  const passes: PassReport[] = [];
  const ir = await report.step("🔧", "Converting to IR and optimizing", () => optimize(lower(ast, info), options["no-optimize"] ? [] : undefined, passes),  /* the optimizer verifies its input and output */
    (ir) => [`Converted ${count(ir.functions.length + 1, "function")} to IR and optimized them`,
      ...formatReport(passes).map((line) => `      • ${line}`)].join("\n"));
  if (options["dump-ir"]) return printModule(ir);
  return { ir, names: programNames(ast), regexps };
}

function detected(compilers: readonly string[]): string {
  const names = compilers.map(describeCompiler);
  if (names.length === 1) return `Detected ${names[0]}${process.env.CC ? " (from $CC)" : ""}`;
  return [`Detected ${count(names.length, "C compiler")} (tried in this order, falling back to the next if one fails):`,
    ...names.map((name, i) => `      ${i + 1}. ${name}`)].join("\n");
}

/** Runs `run` with each compiler until one succeeds. A failure that isn't the program's (not a
 *  CompileError) moves on to the next, dropping the failed one from `compilers` for later steps. */
async function withCompiler<T>(compilers: string[], report: Reporter, run: (cc: string) => T | Promise<T>): Promise<T> {
  for (;;) {
    const cc = compilers[0]!;
    try {
      return await run(cc);
    } catch (e) {
      if (e instanceof CompileError || compilers.length === 1) throw e;
      compilers.shift();
      /* the compiler printed why; a failed command's message is just its command line */
      const reason = (e as Error).message.split("\n")[0]!;
      const why = reason.startsWith("Command failed") ? "" : ` (${reason})`;
      report.note(` ⚠ ${describeCompiler(cc)} failed${why}, trying ${describeCompiler(compilers[0]!)}`);
    }
  }
}

/** How diagnostics and #line name an original file. */
function displayPath(source: string): string {
  if (source.startsWith("\0")) return source.slice(1);
  const rel = relative(process.cwd(), source);
  return rel.startsWith("..") || isAbsolute(rel) ? normalize(source) : rel;  /* normalize: the bundler's / as \ on Windows */
}
