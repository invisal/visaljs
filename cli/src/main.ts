// The `visaljs` command line.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  analyze, type CFile, COMPONENTS, CompileError, emitProgramFiles, firstUnsupported, lower, namedCore, parseModule, parseScript, programNames,
  reachableComponents, SourceMap,
} from "@visaljs/compiler";
import { printModule } from "@visaljs/ir";
import { formatReport, optimize, type PassReport } from "@visaljs/optimizer";

import { BundleError, bundle } from "./bundle.ts";
import { compileJobs, compileProgram, describeCompiler, findCompilers, gcCheckFlags, programArchives, scratchDir } from "./cc.ts";
import { evalCalls, evalWarning } from "./eval.ts";
import { licensesText } from "./licenses.ts";
import { DEFAULT_HOSTS, hostPrimitives } from "./hosts.ts";
import { detectFramework, type Framework, FrameworkError, FRAMEWORKS } from "./frameworks/index.ts";
import { compileRegExps, regexpLiterals } from "./regexp.ts";
import { count, lineCount, Report, type ReportStyle, size, sizeQuip } from "./report.ts";

export const VERSION = "0.0.7";

/** A program's C splits into files of about this many IR instructions. */
const PART_SIZE = 20_000;

const USAGE = `usage: visaljs build [entry.js | project directory] [options]
       visaljs licenses   print the licenses to ship with a binary you distribute

A project (the current directory when none is given) builds its framework's production server: a
vinext app is built with its own \`vite build\` first, then its server is compiled.

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
  /* a project directory: its framework's production server (frameworks/), built below */
  let framework: { fw: Framework; root: string } | undefined;
  let source = "";
  if (statSync(entry, { throwIfNoEntry: false })?.isDirectory()) {
    const root = resolve(entry);
    const fw = detectFramework(root);
    if (!fw) {
      io.stderr(`visaljs: ${entry === "." ? "the current directory" : entry} isn't a project of a framework visaljs knows ` +
        `(${FRAMEWORKS.map((f) => f.name).join(", ")}): give an entry file\n`);
      return 1;
    }
    framework = { fw, root };
    entry = join(root, "visaljs-entry.js");  /* generated: its imports resolve from the project */
  } else {
    try {
      source = readFileSync(entry, "utf8");
    } catch (e) {
      io.stderr(`visaljs: cannot read ${entry}: ${(e as Error).message}\n`);
      return 1;
    }
  }
  const dump = options["dump-ast"] === true || options["dump-ir"] === true;
  const style = options.quiet || dump ? undefined : io.report;  /* none: no report, but warnings and errors */
  const report = new Report(io.stderr, style);
  const binary = !dump && !options["emit-c"];
  const hosts = DEFAULT_HOSTS;
  const primitives = hostPrimitives(hosts);
  let frameworkExtras = {};
  /* a production build, as bundlers make for a server (--node-env= leaves it to the environment) */
  const nodeEnv = options["node-env"] === "" ? undefined : options["node-env"] ?? "production";
  if (framework) {
    const { fw, root } = framework;
    if (style) report.note(` 🧭 A ${fw.name} app: compiling its production server`);
    try {
      if (fw.build && options["no-framework-build"] !== true) await report.step("🏗️ ", `Building the ${fw.name} app`, () => fw.build!(root), (what) => what);
      source = fw.entry(root);
    } catch (e) {
      if (!(e instanceof FrameworkError)) throw e;
      io.stderr(`visaljs: ${e.message}\n`);
      return 1;
    }
    frameworkExtras = { source, plugins: fw.plugins?.(root) ?? [], requires: fw.requires?.(root) ?? [] };
  }

  /* a binary needs a C compiler: find them before the work that needs one */
  let compilers: string[] | undefined;
  if (binary) {
    try {
      compilers = await report.step("🔍", "Detecting C compilers", findCompilers, detected);
    } catch (e) {
      io.stderr(`visaljs: ${(e as Error).message}\n`);
      return 1;
    }
  }

  /* the bundler makes the program one ES module; classic scripts never go through it */
  const script = options.script === true;
  const bundled = !script && options["no-bundle"] !== true;
  let map: SourceMap | undefined;
  if (bundled) {
    try {
      const b = await report.step("📦", "Rolling the modules into a single file", () => bundle(entry, hosts, (message, where) => report.warn(message, where),
        { ...frameworkExtras, nodeEnv, allFeatures: options["all-features"] === true }),
        (b) => `Rolled ${count(b.modules, "module")} into a single file (${size(Buffer.byteLength(b.code))})` +
          (b.required.length ? `; for a require() at run time: ${b.required.join(", ")}` : ""));
      source = b.code;
      /* a program with no side effects bundles to nothing, and rolldown gives no map */
      if (b.map) map = new SourceMap(b.map, displayPath);
    } catch (e) {
      if (!(e instanceof BundleError)) throw e;
      io.stderr(`${e.message}\n`);
      return 1;
    }
  }
  const jobs = options.jobs === undefined ? compileJobs() : Number(options.jobs);
  if (!Number.isInteger(jobs) || jobs < 1) {
    io.stderr(`visaljs: --jobs takes a positive whole number, not '${options.jobs}'\n`);
    return 2;
  }
  let files: CFile[];
  try {
    /* bundled: locations point at the original files (where the bundler generated code, at bundle.js) */
    const ast = await report.step("🌳", "Parsing the JavaScript",
      () => (script ? parseScript(source, entry) : parseModule(source, map ? "bundle.js" : entry, map, resolve(entry), primitives)),
      () => `Parsed ${count(lineCount(source), "line")} of JavaScript`);
    if (options["dump-ast"]) {
      io.stdout(JSON.stringify(ast, null, 2) + "\n");
      return 0;
    }
    const info = analyze(ast);  /* syntax errors first: they matter even in code we can't compile yet */
    const evalWarn = evalWarning(evalCalls(ast, info), options.verbose === true);
    if (evalWarn) report.warn(evalWarn);
    const literals = regexpLiterals(ast);  /* a literal's errors are early errors */
    const regexps = literals.length
      ? await report.step("🧩", "Compiling the regular expressions", () => withCompiler(compilers ??= findCompilers(), report, (cc) => compileRegExps(cc, literals)),
        () => `Compiled ${count(literals.length, "regular expression")}`)
      : new Map<string, Uint8Array>();
    const unsupported = firstUnsupported(ast);
    if (unsupported) throw unsupported;
    const passes: PassReport[] = [];
    const ir = await report.step("🔧", "Converting to IR and optimizing", () => optimize(lower(ast, info), options["no-optimize"] ? [] : undefined, passes),  /* the optimizer verifies its input and output */
      (ir) => [`Converted ${count(ir.functions.length + 1, "function")} to IR and optimized them`,
        ...formatReport(passes).map((line) => `      • ${line}`)].join("\n"));
    if (options["dump-ir"]) {
      io.stdout(printModule(ir));
      return 0;
    }
    /* built-ins: those the program names, or all of them */
    const names = programNames(ast);
    const all = options["all-builtins"] === true;
    files = await report.step("📝", "Emitting C code", () => emitProgramFiles(ir, {
      embedSource: options["embed-source"] === true,
      components: (all ? COMPONENTS : reachableComponents(names)).map((c) => c.symbol),
      core: all ? undefined : namedCore(names),
      regexps,
      hostPrimitives: primitives,
      partSize: Number(process.env.VISALJS_PART_SIZE) || PART_SIZE,  /* another: tests that split small programs */
    }), (files) => `Emitted ${count(files.reduce((n, f) => n + lineCount(f.text), 0), "line")} of C code ` +
      `(${size(files.reduce((n, f) => n + Buffer.byteLength(f.text), 0))}${files.length > 1 ? `, in ${files.length} files` : ""})`);
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    io.stderr(`${e.message}\n`);
    return 1;
  }

  if (options["emit-c"]) {
    mkdirSync(options["emit-c"], { recursive: true });
    for (const f of files) writeFileSync(join(options["emit-c"], f.name), f.text);
    if (bundled) writeFileSync(join(options["emit-c"], "bundle.js"), source);  /* what was compiled */
    report.finish("📂", (time) => `Wrote ${files.length > 1 ? `${files.length} files to ${displayPath(resolve(options["emit-c"]!))}` : displayPath(resolve(options["emit-c"]!, "program.c"))} in ${time}`);
    return 0;
  }
  let output = options.output ?? (framework ? join(framework.root, basename(framework.root)) : basename(entry).replace(/\.[cm]?js$/, ""));
  if (process.platform === "win32" && !extname(output)) output += ".exe";  /* the linker would add it anyway */
  const opt = [...(options.debug ? ["-O0"] : ["-O2"]), ...gcCheckFlags()];
  const dir = scratchDir();
  try {
    for (const f of files) writeFileSync(join(dir, f.name), f.text);
    const cFiles = files.filter((f) => f.name.endsWith(".c")).map((f) => join(dir, f.name));
    /* the libraries and the program with one compiler: a failure in either moves both to the next */
    await withCompiler(compilers!, report, async (cc) => {
      const tc = { cc, opt, strip: !options.debug && !options.symbols };
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const bytes = statSync(output).size;
  report.finish("🎉", (time) => `Built ${displayPath(resolve(output))} in ${time}: ${size(bytes)}, ${sizeQuip(bytes)}`);
  if (framework?.fw.notes && style) for (const note of framework.fw.notes(framework.root)) report.note(`    • ${note}`);
  return 0;
}

/** "Detected GCC 13.3.0", else the compilers numbered in the order they're tried, under the
 *  step's line (indented to its text). */
function detected(compilers: readonly string[]): string {
  const names = compilers.map(describeCompiler);
  if (names.length === 1) return `Detected ${names[0]}${process.env.CC ? " (from $CC)" : ""}`;
  return [`Detected ${count(names.length, "C compiler")} (tried in this order, falling back to the next if one fails):`,
    ...names.map((name, i) => `      ${i + 1}. ${name}`)].join("\n");
}

/** Runs `run` with each compiler in turn until one succeeds. A failure that isn't the
 *  program's (not a CompileError) is noted and moves on to the next; the compilers that failed
 *  are dropped, so later steps start with the one that worked. The last failure is rethrown. */
async function withCompiler<T>(compilers: string[], report: Report, run: (cc: string) => T | Promise<T>): Promise<T> {
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

/** How diagnostics and #line name an original file: relative to the working directory when
 *  it's inside it, else absolute. Code the bundler generated keeps its own name. */
function displayPath(source: string): string {
  if (source.startsWith("\0")) return source.slice(1);
  const rel = relative(process.cwd(), source);
  return rel.startsWith("..") || isAbsolute(rel) ? normalize(source) : rel;  /* normalize: the bundler's / as \ on Windows */
}
