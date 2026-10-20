// The C compiler and the C libraries, each built once per (compiler, flags, sources) and cached,
// unless it comes prebuilt (prebuiltArchive).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";

import { RUNTIME_DIR, RUNTIME_INCLUDE, runtimeLibraries } from "@visaljs/runtime";

import type { CLibrary, HostPackage } from "./hosts.ts";

export { RUNTIME_DIR, RUNTIME_INCLUDE };

export interface Toolchain {
  cc: string;
  /** Optimization flags: -O2 by default, -O0 for --debug builds. */
  opt: string[];
  /** Strip the program's symbols and debug info at link: the default, off for --debug builds. */
  strip?: boolean;
}

/** VISALJS_GC_CHECKS: the runtime and the program as a
 *  checking build. `verify` checks every pointer the collector follows and every dead cell it
 *  reuses; `stress` also collects at every allocation (every n-th: JS_GC_STRESS_INTERVAL=n when
 *  the program runs). Slow; for tests. */
export function gcCheckFlags(): string[] {
  const mode = process.env.VISALJS_GC_CHECKS;
  if (!mode) return [];
  if (mode === "verify") return ["-DJS_GC_VERIFY=1"];
  if (mode === "stress") return ["-DJS_GC_STRESS=1"];
  throw new Error(`VISALJS_GC_CHECKS=${mode}: expected verify or stress`);
}

/** $CC, else the first of the usual C compilers on the PATH. */
export function findCompiler(): string {
  return findCompilers()[0]!;
}

/** $CC alone, else each usual C compiler on the PATH that runs, in order of preference: a build
 *  falls back to the next. Clang first: it compiles a large program's C in half GCC's time and
 *  memory, and its code ran faster (7% fewer instructions per HTTP request). Zig's clang comes
 *  last: it brings its own libc headers and linker. */
export function findCompilers(): string[] {
  if (process.env.CC) {
    if (!compilerVersion(process.env.CC)) throw new Error(`$CC (${process.env.CC}) doesn't run`);
    return [process.env.CC];
  }
  const found = new Map<string, string>();
  for (const cc of ["clang", "cc", "gcc", "zig cc"]) {
    const path = onPath(compilerCommand(cc)[0]);
    if (path && !found.has(path) && compilerVersion(cc)) found.set(path, cc);
  }
  if (found.size === 0) throw new Error("no C compiler found (set CC)");
  return [...found.values()];
}

/** The program `name` runs from the PATH, links resolved; else undefined. */
function onPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(delimiter) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      try {
        return realpathSync(join(dir, name + ext));
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/* every function and datum in its own section, so the linker drops what nothing reaches */
export const COMMON = ["-std=c11", "-g", "-fno-omit-frame-pointer", "-pthread", "-ffunction-sections", "-fdata-sections"];
const LINK = process.platform === "darwin" ? ["-Wl,-dead_strip"] : ["-Wl,--gc-sections"];
/* ld64 deprecates -s: -S drops debug info, -x local symbols */
const STRIP = process.platform === "darwin" ? ["-Wl,-S,-x"] : ["-s"];
/** The link's flags that write its map to `file`: ld64's, the format size.ts reads. */
export const linkMapFlags = (file: string) => [`-Wl,-map,${file}`];

/** A compiler's command line, split like make splits $(CC): "zig cc", "ccache gcc". */
export function compilerCommand(cc: string): [string, ...string[]] {
  const [program = cc, ...args] = cc.trim().split(/\s+/);
  return [program, ...args];
}

function runCompiler(cc: string, args: string[], options: Parameters<typeof execFileSync>[2]) {
  const [program, ...prefix] = compilerCommand(cc);
  return execFileSync(program, [...prefix, ...args], options);
}

/** Zig compiles C with its clang, and archives with its own ar: a machine without a C
 *  toolchain usually lacks binutils' ar too. */
function isZig(cc: string): boolean {
  return /^zig(\.exe)?$/i.test(basename(compilerCommand(cc)[0]));
}

/** "GCC 13.3.0", "clang 18.1.3", "Zig 0.16.0": the compiler's name and version, else its command. */
export function describeCompiler(cc: string): string {
  if (isZig(cc)) {
    try {
      return `Zig ${execFileSync(compilerCommand(cc)[0], ["version"], { encoding: "utf8" }).trim()}`;
    } catch {
      return cc;
    }
  }
  const text = compilerVersion(cc);
  /* "clang version 18.1.3 (1ubuntu1)", or the first line's last number: "cc (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0" */
  const first = text.split("\n")[0] ?? "";
  const version = (/version (\d+\.\d+(?:\.\d+)?)/.exec(first) ?? /(\d+\.\d+(?:\.\d+)?)\S*\s*$/.exec(first))?.[1];
  if (!version) return cc;
  if (/clang/i.test(text)) return `${/apple/i.test(text) ? "Apple clang" : "clang"} ${version}`;
  if (/gcc|free software foundation/i.test(text)) return `GCC ${version}`;
  return `${cc} ${version}`;
}

function compilerVersion(cc: string): string {
  try {
    return runCompiler(cc, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) as string;
  } catch {
    return "";  /* hashed as empty */
  }
}

/** Builds (or reuses) lib<name>.a for this toolchain; returns its path. `building` hears
 *  about a library that isn't cached, before it's built. */
export function libraryArchive(tc: Toolchain, lib: CLibrary, building?: (name: string) => void): string {
  const prebuilt = prebuiltArchive(tc, lib);
  if (prebuilt) return prebuilt;
  const hash = createHash("sha256");
  hash.update(`${tc.cc}\n${compilerVersion(tc.cc)}\n${[...COMMON, ...CXX, ...tc.opt, ...lib.flags].join(" ")}\n`);
  for (const f of [...lib.sources, ...lib.headers].sort()) hash.update(f).update(readFileSync(f));
  const key = hash.digest("hex").slice(0, 16);

  const root = cacheRoot();
  const dir = join(root, `${lib.name}-${key}`);
  const archive = join(dir, `lib${lib.name}.a`);
  if (existsSync(archive)) return archive;
  building?.(lib.name);

  /* build in a private directory, then rename: concurrent builds don't see half a library */
  const work = join(root, `tmp-${process.pid}-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    buildArchive(tc.cc, lib, join(work, `lib${lib.name}.a`), { flags: tc.opt });
    mkdirSync(root, { recursive: true });
    try {
      renameSync(work, dir);
    } catch {
      /* another build won the race: use it */
    }
  } finally {
    if (existsSync(work)) rmSync(work, { recursive: true, force: true });
  }
  return archive;
}

/** Compiles `lib`'s sources (`common`'s flags, then `flags`, then the library's) in a directory
 *  beside `archive`, and archives them as `archive` (`arFlags` before its operation: Zig's ar
 *  writes the host's format unless told). */
export function buildArchive(cc: string, lib: CLibrary, archive: string,
  { common = COMMON, flags = [], arFlags = [] }: { common?: readonly string[]; flags?: readonly string[]; arFlags?: readonly string[] } = {}) {
  const objects = join(dirname(archive), `${lib.name}-objects`);
  mkdirSync(objects, { recursive: true });
  const outputs = lib.sources.map((_, i) => `${i}.o`);
  compileAll(lib.sources.map((src, i) => [...compileCommand(cc, src, common), ...flags, "-DNDEBUG", ...lib.flags, "-c", src, "-o", join(objects, outputs[i]!)]));
  /* from the objects' directory, by their short names: BoringSSL's 400 full paths can pass
   * Windows' 32K command line */
  const [ar, ...arPrefix] = isZig(cc) ? [compilerCommand(cc)[0], "ar"] : ["ar"];
  execFileSync(ar!, [...arPrefix, ...arFlags, "rcs", resolve(archive), ...outputs], { cwd: objects, stdio: ["ignore", "inherit", "inherit"] });
  rmSync(objects, { recursive: true, force: true });
}

/* C++ sources (BoringSSL's) as C++17 without exceptions, RTTI or the C++ library: through the
 * same compiler, `-x c++` (Zig's C++ driver is `zig c++`) */
const cxx = (common: readonly string[]) => ["-std=c++17", "-fno-exceptions", "-fno-rtti", ...common.filter((f) => !f.startsWith("-std="))];
const CXX = cxx(COMMON);

function compileCommand(cc: string, src: string, common: readonly string[]): string[] {
  if (!src.endsWith(".cc")) return [...compilerCommand(cc), ...common];
  const cmd = compilerCommand(cc);
  if (isZig(cc)) return [...cmd.map((w) => (w === "cc" ? "c++" : w)), ...cxx(common)];
  return [...cmd, "-x", "c++", ...cxx(common)];
}

/** A prebuilt library (cli/scripts/prebuilt.ts, built with Zig): prebuilt/<target>/<name>-<prebuiltKey>.a.
 *  The key leaves out the compiler, so any C compiler for the platform links it. Only for -O2 builds
 *  whose compiler targets this machine; VISALJS_PREBUILT names another directory, or 0 for none. */
export function prebuiltArchive(tc: Toolchain, lib: CLibrary): string | undefined {
  if (tc.opt.join(" ") !== PREBUILT_OPT.join(" ")) return undefined;
  const env = process.env.VISALJS_PREBUILT;
  const dir = env !== undefined ? env.replace(/^0$/, "") : /(?:^|\s)--?target\b/.test(tc.cc) ? "" : installedPrebuilt();
  if (!dir) return undefined;
  const archive = join(dir, `${lib.name}-${prebuiltKey(lib)}.a`);
  return existsSync(archive) ? archive : undefined;
}

/** A prebuilt archive's flags: COMMON's without debug info (it would be most of its size: Zig
 *  emits it unless told -g0), and -O2. */
export const PREBUILT_COMMON = [...COMMON.filter((f) => f !== "-g"), "-g0"];
export const PREBUILT_OPT = ["-O2"];

/** A prebuilt library's key: its files' paths (from runtime/'s parent: the same in this repository
 *  and the package) and contents, and its flags. Changing PREBUILT_COMMON or PREBUILT_OPT bumps
 *  the version, the key's first line. */
export function prebuiltKey(lib: CLibrary): string {
  const root = dirname(RUNTIME_DIR);
  const portable = (s: string) => s.split(root).join("<root>").replaceAll("\\", "/");
  const hash = createHash("sha256").update(`visaljs prebuilt 1\n${lib.name}\n${lib.flags.map(portable).join(" ")}\n`);
  const files = [...lib.sources, ...lib.headers].map((f) => [relative(root, f).replaceAll("\\", "/"), f] as const);
  for (const [name, path] of files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) hash.update(`${name}\n`).update(readFileSync(path));
  return hash.digest("hex").slice(0, 16);
}

/** This machine's prebuilt target: linux-x64, linux-x64-musl, darwin-arm64, win32-x64, … */
export function hostTarget(): string {
  const musl = process.platform === "linux" &&
    !(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
  return `${process.platform}-${process.arch}${musl ? "-musl" : ""}`;
}

/* the published package's prebuilt libraries for this machine, looked up once; "": none (this
 * repository, or a platform without them) */
let installed: string | undefined;

function installedPrebuilt(): string {
  if (installed === undefined) {
    const dir = join(dirname(RUNTIME_DIR), "prebuilt", hostTarget());
    installed = existsSync(dir) ? dir : "";
  }
  return installed;
}

/** Runs the compiler commands, as many at once as there are processors (in a child Node process:
 * the driver's API is synchronous; the commands on its stdin). Throws when one fails, after its output. */
const PARALLEL = `
const { spawn } = require("node:child_process");
const jobs = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
let next = 0, failed = false;
const run = () => {
  if (failed || next >= jobs.length) return;
  const [cmd, ...args] = jobs[next++];
  spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] }).on("close", (code) => {
    if (code !== 0) { failed = true; process.exitCode = 1; } else run();
  });
};
for (let i = 0; i < Number(process.argv[1]); i++) run();
`;

function compileAll(commands: string[][]) {
  execFileSync(process.execPath, ["-e", PARALLEL, String(availableParallelism())], { input: JSON.stringify(commands), stdio: ["pipe", "inherit", "inherit"] });
}

/** The runtime's archives for this toolchain, in link order: libjsrt.a, then libboringssl.a
 *  (the test262 host links them too). */
export function runtimeArchives(tc: Toolchain): string[] {
  return runtimeLibraries().map((l) => libraryArchive(tc, l));
}

function cacheRoot(): string {
  return process.env.VISALJS_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "visaljs");
}

/** Builds (or reuses) the regexp-compile tool: runtime/tools/regexp_compile.c with
 *  the vendored libregexp, cached like the libraries. Returns its path. */
export function regexpCompiler(cc: string): string {
  const regexp = join(RUNTIME_DIR, "third_party", "quickjs-regexp");
  const sources = [join(RUNTIME_DIR, "tools", "regexp_compile.c"), ...["libregexp.c", "libunicode.c", "cutils.c"].map((f) => join(regexp, f))];
  const headers = [join(RUNTIME_DIR, "src", "regexp_message.h"), join(RUNTIME_DIR, "src", "regexp_anchor.h"), ...readdirSync(regexp).filter((f) => f.endsWith(".h")).map((f) => join(regexp, f))];
  const hash = createHash("sha256").update(`${cc}\n`);
  for (const f of [...sources, ...headers]) hash.update(f.slice(RUNTIME_DIR.length)).update(readFileSync(f));
  const tool = join(cacheRoot(), `regexp-compile-${hash.digest("hex").slice(0, 16)}${process.platform === "win32" ? ".exe" : ""}`);
  if (existsSync(tool)) return tool;
  mkdirSync(cacheRoot(), { recursive: true });
  const tmp = `${tool}.${process.pid}.tmp`;
  runCompiler(cc, ["-std=c11", "-O2", `-I${regexp}`, `-I${join(RUNTIME_DIR, "src")}`, ...sources, "-o", tmp], { stdio: ["ignore", "inherit", "inherit"] });
  renameSync(tmp, tool);  /* atomic: a concurrent build sees the whole tool or none */
  return tool;
}

/** A program's archives, in link order: the host packages' libraries, then libjsrt (which they
 *  use), then the system libraries they need (-l…). Each is built the first time; `building`
 *  hears about it. */
export function programLibraries(hosts: readonly HostPackage[]): CLibrary[] {
  return [...hosts.flatMap((h) => h.libraries(RUNTIME_INCLUDE)).filter((l) => l.sources.length), ...runtimeLibraries()];
}

export function programArchives(tc: Toolchain, hosts: readonly HostPackage[], building?: (name: string) => void): string[] {
  const libraries = programLibraries(hosts);
  return [...libraries.map((l) => libraryArchive(tc, l, building)), ...libraries.flatMap((l) => l.link ?? []).map((l) => `-l${l}`)];
}

/** Compiles the program's C files and links them with `archives` (programArchives), stripping at
 *  this link when asked. A split program's files compile `jobs` at once; `compiled` hears as each
 *  is done. `mapFile`: the link writes its map there (linkMapFlags), and each C file's object stays
 *  beside it, for the debug info. Asynchronous, so the build's report keeps drawing. */
export async function compileProgram(tc: Toolchain, cFiles: readonly string[], output: string, archives: readonly string[],
  { extraFlags = [], jobs = compileJobs(), compiled, mapFile }: { extraFlags?: readonly string[]; jobs?: number; compiled?: (done: number, total: number) => void; mapFile?: string | undefined } = {}): Promise<void> {
  /* a stripped binary drops the debug info -g makes, which takes the compilers half their memory and
   * a fifth of their time; it never changes the code */
  const flags = [...COMMON, ...tc.opt, ...(tc.strip ? ["-g0"] : []), ...extraFlags];
  const link = [...archives.map((a) => (a.startsWith("-l") ? a : resolve(a))), "-lm", ...LINK, ...(tc.strip ? STRIP : []),
    ...(mapFile ? linkMapFlags(resolve(mapFile)) : []), "-o", resolve(output)];
  /* from the C's directory, by short names, and each file to an object even when there's one: the
   * scratch directory's name changes every build, and ccache ($CC) only caches a compile (-c) whose
   * input path is the same */
  const cwd = dirname(resolve(cFiles[0]!));
  const sources = cFiles.map((f) => relative(cwd, resolve(f)));
  const objects = sources.map((f) => f.replace(/\.c$/, ".o"));
  /* the biggest first: they take longest, and the small ones fill in around them */
  const order = cFiles.map((_, i) => i).sort((a, b) => statSync(cFiles[b]!).size - statSync(cFiles[a]!).size);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < order.length) {
      const i = order[next++]!;
      try {
        await runCompilerAsync(tc.cc, [...flags, `-I${RUNTIME_INCLUDE}`, "-c", sources[i]!, "-o", objects[i]!], cwd);
      } catch (e) {
        next = order.length;  /* start no more: the others finish, then the build fails */
        throw e;
      }
      compiled?.(++done, cFiles.length);
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(jobs, cFiles.length) }, worker));
  const failure = results.find((r) => r.status === "rejected");
  if (failure) throw failure.reason;
  await runCompilerAsync(tc.cc, [...flags, ...objects, ...link], cwd);
}

/** How many of a split program's files compile at once: one per processor and per `perJob` bytes
 *  of available memory (a cgroup's limit counts). A file needs up to about 1.1 GB at -O2 with
 *  debug info, 0.55 GB without. */
export function compileJobs(perJob = 1.5e9): number {
  return Math.max(1, Math.min(availableParallelism(), Math.floor(process.availableMemory() / perJob)));
}

/** Runs the compiler; its stderr passes through (but for notes the program can't act on), and its
 *  tail is kept to recognize a broken toolchain. Rejects when it fails. */
function runCompilerAsync(cc: string, args: readonly string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let errors = "";
    const [program, ...prefix] = compilerCommand(cc);
    const child = spawn(program!, [...prefix, ...args], { cwd, stdio: ["ignore", "inherit", "pipe"] });
    const filter = new DiagnosticFilter((text) => process.stderr.write(text));
    child.stderr.on("data", (chunk: Buffer) => {
      filter.write(chunk.toString());
      errors = (errors + chunk.toString()).slice(-16384);
    });
    child
      .on("error", reject)
      .on("close", (code) => {
        filter.end();
        if (code === 0) return resolve();
        const hint = toolchainHint(errors);
        reject(new Error(`${cc} exited with code ${code}${hint ? `\n  hint: ${hint}` : ""}`));
      });
  });
}

/** The compiler's stderr, a line at a time, without GCC's note that a function was too large to
 *  track its variables for debug info, which it then builds without (a large program's top level):
 *  the note, the "In function" line before it and the source lines after it. */
export class DiagnosticFilter {
  private partial = "";
  private held: string | undefined;  /* an "In function" line, until the next says what it heads */
  private skipping = false;          /* in the dropped note's source excerpt */
  private readonly out: (text: string) => void;

  constructor(out: (text: string) => void) {
    this.out = out;
  }

  write(text: string) {
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop()!;
    for (const line of lines) this.line(line + "\n");
  }

  end() {
    if (this.partial) this.line(this.partial);
    this.partial = "";
    if (this.held !== undefined) this.out(this.held);
    this.held = undefined;
  }

  private line(line: string) {
    if (this.skipping && /^\s*\d*\s*\|/.test(line)) return;
    this.skipping = false;
    if (/: note: variable tracking size limit exceeded/.test(line)) {
      this.held = undefined;
      this.skipping = true;
      return;
    }
    if (this.held !== undefined) this.out(this.held);
    this.held = undefined;
    if (/: In function [‘'`].*[’'`]:\s*$/.test(line)) this.held = line;
    else this.out(line);
  }
}

/** A hint for a compiler failure that isn't the program's fault, else undefined. */
export function toolchainHint(stderr: string): string | undefined {
  /* ld64 reading an SDK newer than itself: "tapi error: malformed file ... unknown architecture arm64e.x1-macos" */
  if (/tapi error|unknown architecture/.test(stderr))
    return "the macOS SDK is newer than the linker (Command Line Tools and SDK don't match). " +
      "Check `xcode-select -p`, `ld -v` and `xcrun --show-sdk-path`; reinstalling the Command Line Tools " +
      "(`sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install`) or setting SDKROOT to an older SDK fixes it.";
  return undefined;
}

export function scratchDir(): string {
  const dir = join(tmpdir(), `visaljs-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
