import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { modules } from "@visaljs/node";

import { compileProgram, DiagnosticFilter, libraryArchive, prebuiltArchive, prebuiltKey, toolchainHint } from "../src/cc.ts";
import { EntryError, nodeCommand, projectEntry } from "../src/entry.ts";
import { buildScriptOptions } from "../src/frameworks/vinext.ts";
import { type Io, main, VERSION } from "../src/main.ts";
import { prebuiltLibraries, TARGETS } from "../scripts/prebuilt.ts";

/* by its real path: on macOS tmpdir() is under /var, a symlink to /private/var, and the bundler
 * reports files by their real path */
const tempDir = () => realpathSync.native(mkdtempSync(join(tmpdir(), "visaljs-")));

async function run(...argv: string[]) {
  return runWith({}, ...argv);
}

async function runWith(io: Pick<Io, "report">, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    ...io,
  });
  return { code, stdout, stderr };
}

/* each test runs the CLI, some several times: 5 s, vitest's default, is too short on a busy runner */
describe("visaljs CLI", { timeout: 30_000 }, () => {
  it("prints the version", async () => {
    expect(await run("--version")).toEqual({ code: 0, stdout: `visaljs ${VERSION}\n`, stderr: "" });
  });

  it("compiles in the versions process reports: visaljs's, and the Node API's of node/compat.json", () => {
    const header = readFileSync(join(import.meta.dirname, "..", "..", "runtime", "include", "js_host.h"), "utf8");
    const compat = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "node", "compat.json"), "utf8")) as { node: string };
    expect(/#define JS_VISALJS_VERSION "([^"]+)"/.exec(header)?.[1]).toBe(VERSION);
    expect(`v${/#define JS_NODE_VERSION "([^"]+)"/.exec(header)?.[1]}`).toBe(compat.node);
  });

  it("prints usage with --help", async () => {
    const r = await run("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: visaljs build");
  });

  it("fails with usage when no command is given", async () => {
    expect((await run()).code).toBe(2);
  });

  it("rejects unknown commands and options", async () => {
    expect((await run("frobnicate")).stderr).toContain("unknown command 'frobnicate'");
    expect((await run("build", "a.js", "--bogus")).code).toBe(2);
  });

  it("takes at most one entry file or project directory for build: the current directory by default", async () => {
    expect((await run("build", "a.js", "b.js")).code).toBe(2);
    /* the repository's root: no framework, and its package.json names no entry */
    expect(await run("build")).toMatchObject({
      code: 1,
      stderr: `visaljs: the current directory: no entry file: checked package.json's "bin", "scripts.start" and "main", and index.js: give an entry file\n`,
    });
  });

  it("builds a project from the entry its package.json starts, and says which", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/api", main: "index.js", scripts: { start: "NODE_ENV=production node -r dotenv/config server.js --port 80" } }));
    writeFileSync(join(dir, "server.js"), "print(1);\n");
    const plain = { report: { live: false, color: false } };
    const r = await runWith(plain, "build", dir, "--emit-c", join(dir, "c"));
    expect(r.code).toBe(0);
    expect(r.stderr.split("\n").slice(0, 2)).toEqual([
      ' 📄 Entry: server.js (package.json "scripts.start")',
      "    • its arguments (--port 80) aren't built in: give them when you run the binary",
    ]);
    expect(readFileSync(join(dir, "c", "bundle.js"), "utf8")).toContain("print(1)");
    expect(await run("build", join(dir, "missing"))).toMatchObject({ code: 1, stderr: expect.stringMatching(/cannot read/) });
  });

  it("refuses a binary that would replace its entry file", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "tool", bin: { tool: "tool" } }));
    writeFileSync(join(dir, "tool"), "print(1);\n");
    const r = await run("build", dir);
    expect(r).toMatchObject({ code: 1, stderr: `visaljs: the binary would be ${join(dir, "tool")}, which is the entry file: give another with -o\n` });
    expect(readFileSync(join(dir, "tool"), "utf8")).toBe("print(1);\n");
  });

  it("dumps the AST of a script", async () => {
    const dir = tempDir();
    const file = join(dir, "a.js");
    writeFileSync(file, "let x = 1 + 2;\n");
    const r = await run("build", file, "--script", "--dump-ast");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ type: "Program", body: [{ type: "VariableDeclaration", kind: "let" }] });
  });

  it("reports compile errors with their location", async () => {
    const dir = tempDir();
    const file = join(dir, "bad.js");
    writeFileSync(file, "let ok = 1;\nlet x = ;\n");
    const r = await run("build", file, "--script", "--dump-ast");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`${file}:2:9: SyntaxError: Expression expected.\n`);
    expect((await run("build", join(dir, "missing.js"))).stderr).toMatch(/cannot read/);
    /* bundled (the default): the bundler parses first and reports the same location */
    expect(await run("build", file, "--dump-ast")).toMatchObject({ code: 1, stderr: `${file}:2:9: SyntaxError: Unexpected token\n` });
  });

  it("bundles a multi-file program into one module", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.js"), 'import { add } from "./math.js";\nprint(add(1, 2));\n');
    writeFileSync(join(dir, "math.js"), "export function add(a, b) { return a + b; }\nexport function unused() {}\n");
    const out = join(dir, "c");
    expect(await run("build", join(dir, "app.js"), "--emit-c", out)).toEqual({ code: 0, stdout: "", stderr: "" });
    const bundle = readFileSync(join(out, "bundle.js"), "utf8");
    expect(bundle).toContain("function add(a, b)");
    expect(bundle).not.toContain("unused");  /* tree-shaken */
    expect(existsSync(join(out, "program.c"))).toBe(true);
  });

  it("compiles TypeScript through the bundler, with its tsconfig.json, and names the binary without .ts", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["./lib/*"] } } }));
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "math.ts"), "export enum Op { Add = 1 }\nexport function add(a: number, b: number): number { return a + b; }\n");
    writeFileSync(join(dir, "app.ts"), 'import { add, Op, type Unused } from "@lib/math";\nconst n: number = add(1, 2) satisfies number;\nprint(n, Op.Add);\n');
    const out = join(dir, "c");
    expect(await run("build", join(dir, "app.ts"), "--emit-c", out)).toEqual({ code: 0, stdout: "", stderr: "" });
    const bundle = readFileSync(join(out, "bundle.js"), "utf8");
    expect(bundle).toContain("function add(a, b)");
    expect(bundle).not.toContain(": number");
    /* the parser takes JavaScript only */
    expect(await run("build", join(dir, "app.ts"), "--no-bundle")).toEqual({
      code: 1, stdout: "", stderr: `visaljs: ${join(dir, "app.ts")} is TypeScript: it's compiled through the bundler, without --no-bundle\n`,
    });
  });

  it("reports each step of a build, unless quiet", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.js"), 'import { add } from "./math.js";\nprint(add(1, 2), /a+/.test("aa"));\n');
    writeFileSync(join(dir, "math.js"), "export function add(a, b) { return a + b; }\n");
    const plain = { report: { live: false, color: false } };
    const r = await runWith(plain, "build", join(dir, "app.js"), "--emit-c", join(dir, "c"));
    expect(r.code).toBe(0);
    const all = r.stderr.replace(/\d+(\.\d+)?m?s\b/g, "T").split("\n");
    /* under the IR step, what each optimizer pass did */
    const passes = all.filter((l) => l.startsWith("      • "));
    expect(passes.length).toBeGreaterThan(0);
    for (const l of passes) expect(l).toMatch(/^ {6}• [a-z-]+: [a-z ]+ [\d,]+ /);
    const lines = all.filter((l) => !passes.includes(l));
    expect(lines.slice(0, 5)).toEqual([
      expect.stringMatching(/^ ✓ 📦 Rolled 2 modules into a single file \(\d+ B\) {2}T$/),
      expect.stringMatching(/^ ✓ 🌳 Parsed \d+ lines of JavaScript {2}T$/),
      " ✓ 🧩 Compiled 1 regular expression  T",
      expect.stringMatching(/^ ✓ 🔧 Converted \d+ functions to IR and optimized them {2}T$/),
      expect.stringMatching(/^ ✓ 📝 Emitted [\d,]+ lines of C code \([\d.]+ kB\) {2}T$/),
    ]);
    expect(lines.at(-2)).toMatch(/^ 📂 Wrote .*program\.c in T$/);
    expect(r.stderr).not.toContain("\x1b");  /* no color, no redraws */
    expect(await runWith(plain, "build", join(dir, "app.js"), "--emit-c", join(dir, "c"), "-q")).toEqual({ code: 0, stdout: "", stderr: "" });
    /* a dump's output is the point: no report around it */
    expect((await runWith(plain, "build", join(dir, "app.js"), "--dump-ir")).stderr).toBe("");
  });

  it("reports imports the bundler cannot resolve", async () => {
    const dir = tempDir();
    const file = join(dir, "app.js");
    writeFileSync(file, 'import { x } from "./nowhere.js";\nprint(x);\n');
    expect(await run("build", file, "--dump-ast")).toMatchObject({ code: 1, stderr: `${file}:1:19: error: Could not resolve './nowhere.js' in app.js\n` });
  });

  it("resolves node:fs and node:path to the host prelude, and rejects other host modules", async () => {
    const dir = tempDir();
    const ok = join(dir, "ok.js");
    writeFileSync(ok, 'import { join } from "node:path";\nimport fs from "fs";\nprint(join("a", "b") + fs.existsSync("x"));\n');
    const out = join(dir, "c");
    expect(await run("build", ok, "--emit-c", out)).toEqual({ code: 0, stdout: "", stderr: "" });
    const bundle = readFileSync(join(out, "bundle.js"), "utf8");
    expect(bundle).toContain('from "visaljs:host"');
    expect(bundle).toMatch(/\/\/#region .*node\/prelude\//);  /* the prelude, bundled (an absolute path when tmpdir is on another drive) */
    /* in one of the C files the program splits into */
    const c = readdirSync(out).filter((f) => f.endsWith(".c")).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    expect(c).toContain("js_host_fs_exists");

    const sqlite = join(dir, "sqlite.js");
    writeFileSync(sqlite, 'import { DatabaseSync } from "node:sqlite";\nprint(DatabaseSync);\n');
    const provided = Object.keys(modules).sort().map((m) => `node:${m}`).join(", ");
    expect(await run("build", sqlite)).toMatchObject({ code: 1, stderr: `${sqlite}: error: node:sqlite is not provided by visaljs (it provides ${provided})\n` });
    const host = join(dir, "host.js");
    writeFileSync(host, 'import { cwd } from "visaljs:host";\nprint(cwd());\n');
    expect(await run("build", host)).toMatchObject({ code: 1, stderr: `${host}: error: visaljs:host is internal to the host prelude\n` });
  });

  it("fixes process.env.NODE_ENV at build time, production by default, so the other build isn't bundled", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules", "lib"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "lib", "package.json"), '{ "name": "lib", "main": "index.js" }');
    /* as React's entry chooses its build */
    writeFileSync(join(dir, "node_modules", "lib", "index.js"),
      'if (process.env.NODE_ENV === "production") module.exports = require("./prod.js");\nelse module.exports = require("./dev.js");\n');
    writeFileSync(join(dir, "node_modules", "lib", "prod.js"), 'module.exports = "prod build";\n');
    writeFileSync(join(dir, "node_modules", "lib", "dev.js"), 'module.exports = "dev build";\n');
    writeFileSync(join(dir, "app.js"), 'import lib from "lib";\nprint(lib);\n');
    const bundled = async (...flags: string[]) => {
      const out = join(dir, `c${flags.join("")}`);
      expect(await run("build", join(dir, "app.js"), "--emit-c", out, ...flags)).toEqual({ code: 0, stdout: "", stderr: "" });
      return readFileSync(join(out, "bundle.js"), "utf8");
    };
    let bundle = await bundled();
    expect(bundle).toContain("prod build");
    expect(bundle).not.toContain("dev build");
    bundle = await bundled("--node-env=development");
    expect(bundle).toContain("dev build");
    expect(bundle).not.toContain("prod build");
    /* empty: read at run time, both builds bundled */
    bundle = await bundled("--node-env=");
    expect(bundle).toContain("process.env.NODE_ENV");
    expect(bundle).toContain("prod build");
    expect(bundle).toContain("dev build");
  });

  it("defines rolldown's runtime helpers before a dynamically imported node:module uses them", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.js"), 'const { createRequire } = await import("node:module");\nprint(typeof createRequire);\n');
    expect(await run("build", join(dir, "app.js"), "--emit-c", join(dir, "c"))).toEqual({ code: 0, stdout: "", stderr: "" });
    const bundle = readFileSync(join(dir, "c", "bundle.js"), "utf8");
    expect(bundle.indexOf("var __exportAll =")).toBeGreaterThan(-1);
    expect(bundle.indexOf("var __exportAll =")).toBeLessThan(bundle.indexOf("__exportAll({"));
  });

  it("bundles the packages a createRequire() require may ask for at run time, and registers them", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules", "fakepkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "fakepkg", "package.json"), '{ "name": "fakepkg", "main": "index.js" }');
    writeFileSync(join(dir, "node_modules", "fakepkg", "index.js"), "module.exports = { hi: 42 };\n");
    /* as Vite leaves an external package: a require from createRequire(import.meta.url), renamed */
    writeFileSync(join(dir, "app.js"), 'import { createRequire } from "node:module";\nconst a = createRequire(import.meta.url);\n' +
      'print(a(`fakepkg`).hi);\nconst m = new Map([["fakepkg", 1]]);\nprint(m.get("fakepkg") + notAPackage("other"));\nfunction notAPackage(x) { return x; }\n');
    const r = await runWith({ report: { live: false, color: false } }, "build", join(dir, "app.js"), "--emit-c", join(dir, "c"));
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("for a require() at run time: fakepkg");
    const bundle = readFileSync(join(dir, "c", "bundle.js"), "utf8");
    expect(bundle).toContain('Symbol.for("visaljs.requireTable")');
    expect(bundle).toContain("module.exports = { hi: 42 }");
    expect(bundle).not.toMatch(/\["other"/);  /* resolves to no package */
  });

  it("builds a Next.js project's production server, and says why it can't", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), '{ "dependencies": { "next": "16.4.1", "react": "19.3.1" } }');
    expect(await run("build", dir, "--emit-c", join(dir, "c"))).toMatchObject({ code: 1, stderr: `visaljs: next isn't installed in ${dir}: run npm install first\n` });
    expect(await run("build", dir, "--no-framework-build", "--emit-c", join(dir, "c"))).toMatchObject({
      code: 1,
      stderr: `visaljs: ${dir} has no Next.js build (no .next/required-server-files.json): run \`next build\`, or build without --no-framework-build\n`,
    });
    /* output: "export": static files, no server */
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "index.html"), "<html></html>");
    expect(await run("build", dir, "--no-framework-build", "--emit-c", join(dir, "c"))).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`visaljs: ${dir} is a static export (output: "export" in next.config): it has no server to compile.`),
    });
    /* a build that isn't standalone: its traces leave out start-server's files */
    mkdirSync(join(dir, ".next", "server", "app"), { recursive: true });
    writeFileSync(join(dir, ".next", "required-server-files.json"), '{ "config": {} }');
    expect(await run("build", dir, "--no-framework-build", "--emit-c", join(dir, "c"))).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`visaljs: ${dir}'s .next isn't a standalone build, whose traces visaljs bundles from: build without --no-framework-build`),
    });
    /* a webpack build: no Turbopack runtime among the chunks */
    writeFileSync(join(dir, ".next", "required-server-files.json"), '{ "config": { "output": "standalone" } }');
    expect(await run("build", dir, "--no-framework-build", "--emit-c", join(dir, "c"))).toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`visaljs: ${dir}'s .next was built with webpack (next build --webpack): visaljs compiles Turbopack builds`),
    });
    /* a vinext app depends on next too: it's vinext's */
    writeFileSync(join(dir, "package.json"), '{ "dependencies": { "next": "16.4.1", "vinext": "1.0.1" } }');
    expect((await run("build", dir, "--no-framework-build", "--emit-c", join(dir, "c"))).stderr).toContain("has no vinext build");
  });

  it("builds a project directory through its framework, and says why it can't", async () => {
    const dir = tempDir();
    expect(await run("build", dir)).toMatchObject({ code: 1, stderr: `visaljs: ${dir}: no entry file: checked a package.json and index.js: give an entry file\n` });
    writeFileSync(join(dir, "package.json"), '{ "dependencies": { "vinext": "1.0.1" } }');
    expect(await run("build", dir, "--no-framework-build", "--emit-c", join(dir, "c"))).toMatchObject({
      code: 1,
      stderr: `visaljs: ${dir} has no vinext build (no ${join("dist", "server", "vinext-server.json")}): run \`vite build\`, or build without --no-framework-build\n`,
    });
    expect(await run("build", dir, "--emit-c", join(dir, "c"))).toMatchObject({ code: 1, stderr: `visaljs: vite isn't installed in ${dir}: run npm install first\n` });
    /* a build without a Node server: a Worker (create-vinext-app's default), or another setup */
    mkdirSync(join(dir, "dist", "server"), { recursive: true });
    writeFileSync(join(dir, "dist", "server", "vinext-server.json"), "{}");
    expect(await run("build", dir, "--no-framework-build", "--emit-c", join(dir, "c"))).toMatchObject({
      code: 1,
      stderr: `visaljs: ${dir}'s vinext build has no Node server (dist/server/index.js, dist/server/entry.js): this vinext setup isn't supported yet\n`,
    });
    writeFileSync(join(dir, "cloudflare.config.ts"), "");
    expect(await run("build", dir, "--no-framework-build", "--emit-c", join(dir, "c"))).toMatchObject({
      code: 1,
      stderr: `visaljs: ${dir}'s dist/ is a Cloudflare Workers build, which has no Node server: build without --no-framework-build, and visaljs builds the app for Node\n`,
    });
  });

  it("reads the Vite config and mode a project's build script gives", () => {
    const dir = tempDir();
    const options = (build?: string) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build } }));
      return buildScriptOptions(dir);
    };
    expect(options("vite build")).toEqual({});
    expect(options("vite build -c vite.prod.config.ts --mode staging")).toEqual({ config: "vite.prod.config.ts", mode: "staging" });
    expect(options("vite build --config=other.mjs -m=ci")).toEqual({ config: "other.mjs", mode: "ci" });
    expect(options("tsc && vite build -c")).toEqual({});
    expect(options("webpack -c x.js")).toEqual({});
    expect(options(undefined)).toEqual({});
  });

  it("bundles process's events only into programs that may call its emitter methods", async () => {
    const dir = tempDir();
    const bundled = async (name: string, source: string) => {
      writeFileSync(join(dir, `${name}.js`), source);
      expect(await run("build", join(dir, `${name}.js`), "--emit-c", join(dir, name))).toEqual({ code: 0, stdout: "", stderr: "" });
      return readFileSync(join(dir, name, "bundle.js"), "utf8");
    };
    expect(await bundled("plain", 'process.exitCode = 1;\nconsole.log("x");\n')).not.toContain("process_events");
    const events = await bundled("events", 'console.log("first");\nprocess.on("exit", (code) => console.log(code));\n');
    expect(events).toMatch(/\/\/#region .*node\/prelude\/internal\/process_events\.js[\s\S]*console\.log\("first"\)/);  /* run first */
    expect(events).not.toContain("process_signals");  /* it links libuv */
    expect(await bundled("signals", 'process.on("SIGINT", () => process.exit(130));\n')).toContain("process_signals");
  });

  it("links node:zlib's Brotli and zstd only into programs whose own code names them, not the prelude's", async () => {
    const dir = tempDir();
    const bundled = async (name: string, source: string) => {
      writeFileSync(join(dir, `${name}.js`), source);
      expect(await run("build", join(dir, `${name}.js`), "--emit-c", join(dir, name))).toEqual({ code: 0, stdout: "", stderr: "" });
      return readFileSync(join(dir, name, "bundle.js"), "utf8");
    };
    const gzip = await bundled("gzip", 'import zlib from "node:zlib";\nconsole.log(zlib.gzipSync("x").length);\n');
    expect(gzip).toContain("prelude/zlib.js");
    expect(gzip).not.toContain("zlib_brotli");
    expect(gzip).not.toContain("zlib_zstd");
    const brotli = await bundled("brotli", 'import zlib from "node:zlib";\nzlib.brotliCompressSync("x");\n');
    expect(brotli).toContain("zlib_brotli");
    expect(brotli).not.toContain("zlib_zstd");
    expect(await bundled("zstd", 'import { createZstdCompress } from "node:zlib";\ncreateZstdCompress();\n')).toContain("zlib_zstd");
  }, 30_000);  /* three builds of the whole prelude */

  it("reports locations and emits #line in the original files, through the source map", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "app.js"), '// app\nimport { add, tpl } from "./lib.js";\nprint(add(1, 2) + tpl(3));\n');
    writeFileSync(join(dir, "lib.js"), "export function add(a, b) {\n  return a + b;\n}\nexport const tpl = (v) => { @d class A {} };\n");
    /* -o: should it build after all, the binary lands in the temporary directory */
    expect(await run("build", join(dir, "app.js"), "-o", join(dir, "app"))).toMatchObject({ code: 1, stderr: `${join(dir, "lib.js")}:4:29: not supported yet: decorators\n` });
    /* an invalid regex literal is an early error, at the literal */
    writeFileSync(join(dir, "lib.js"), "export function add(a, b) {\n  return a + b;\n}\nexport const tpl = (v) => /v(/;\n");
    expect(await run("build", join(dir, "app.js"), "-o", join(dir, "app"))).toMatchObject({ code: 1, stderr: `${join(dir, "lib.js")}:4:27: SyntaxError: Invalid regular expression: /v(/: Unterminated group\n` });

    writeFileSync(join(dir, "lib.js"), "export function add(a, b) {\n  return a + b;\n}\nexport const tpl = (v) => 'v=' + v;\n");
    const out = join(dir, "c");
    expect(await run("build", join(dir, "app.js"), "--emit-c", out)).toEqual({ code: 0, stdout: "", stderr: "" });
    const c = readFileSync(join(out, "program.c"), "utf8");
    /* the C string's escapes: Windows paths' \ doubled */
    expect(c).toContain(`#line 2 ${JSON.stringify(join(dir, "lib.js"))}`);  /* return a + b */
    expect(c).toContain(`#line 3 ${JSON.stringify(join(dir, "app.js"))}`);  /* print(…) */
  });

  it("warns once about eval of source text and new Function, and lists them with --verbose", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "node_modules", "fake"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "fake", "package.json"), '{ "name": "fake", "main": "index.js" }\n');
    writeFileSync(join(dir, "node_modules", "fake", "index.js"), 'export function make() {\n  return new Function("return 1");\n}\n');
    writeFileSync(join(dir, "app.js"), [
      'import { make } from "fake";',
      "const intrinsics = { eval };",  /* only named: works */
      "eval(1);",  /* not a string: works */
      "function shadow(Function) { return Function(); }",
      'print(eval("1 + 1"), make, intrinsics, shadow);',
      "",
    ].join("\n"));
    const out = join(dir, "c");
    const r = await run("build", join(dir, "app.js"), "--emit-c", out);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("warning: the program uses eval() of source text in 1 place and new Function() in 1 place (in fake, your code)");
    expect(r.stderr).toContain("(--verbose lists them)");
    expect(r.stderr).not.toContain("strongly discouraged");  /* rolldown's own eval warning */

    const v = await run("build", join(dir, "app.js"), "--emit-c", out, "--verbose");
    /* on a terminal with color, the label is bold yellow */
    const color = await runWith({ report: { live: false, color: true } }, "build", join(dir, "app.js"), "--emit-c", out);
    expect(color.stderr).toContain("\x1b[1;33mwarning:\x1b[0m the program uses");

    const slash = (p: string) => p.replaceAll("\\", "/");  /* source map paths use / on Windows too */
    expect(slash(v.stderr)).toContain(`\n  ${slash(join(dir, "app.js"))}:5:7: eval()`);
    expect(slash(v.stderr)).toContain(`\n  ${slash(join(dir, "node_modules", "fake", "index.js"))}:2:10: new Function()`);
  });
});

describe("compileProgram", () => {
  /* the stand-in compiler is a shell script */
  it.skipIf(process.platform === "win32")("hints at a macOS SDK newer than the linker", async () => {
    const dir = tempDir();
    const cc = join(dir, "cc");
    /* what ld64 prints reading the macOS 27 SDK's .tbd files */
    writeFileSync(cc, "#!/bin/sh\necho \"ld: tapi error: malformed file libSystem.B.tbd:4:20: error: unknown architecture arm64e.x1-macos\" >&2\nexit 1\n", { mode: 0o755 });
    const c = join(dir, "program.c");
    writeFileSync(c, "int main(void) { return 0; }\n");
    await expect(compileProgram({ cc, opt: [] }, [c], join(dir, "out"), [])).rejects.toThrow(/exited with code 1\n {2}hint: the macOS SDK is newer than the linker/);
  });

  it("gives no hint for an ordinary failure", () => {
    expect(toolchainHint("program.c:1:1: error: expected expression")).toBeUndefined();
  });

  it("drops GCC's note about a function too large to track for debug info, and nothing else", () => {
    let out = "";
    const filter = new DiagnosticFilter((text) => (out += text));
    const note = "/tmp/p.mjs: In function ‘js_script’:\n" +
      "/tmp/p.mjs:58:25: note: variable tracking size limit exceeded with ‘-fvar-tracking-assignments’, retrying without\n" +
      "   58 | };\n      |                         ^        \n";
    const warning = "/tmp/p.mjs: In function ‘f’:\n/tmp/p.mjs:3:1: warning: unused variable ‘x’\n    3 | int x;\n      | ^\n";
    /* in uneven chunks, as a pipe gives it */
    const text = note + warning + "ld: error: undefined symbol\n";
    for (let i = 0; i < text.length; i += 7) filter.write(text.slice(i, i + 7));
    filter.end();
    expect(out).toBe(warning + "ld: error: undefined symbol\n");
  });
});

describe("prebuilt libraries", () => {
  /* a library of one source, and a lib directory with its archive under the key */
  function prebuilt() {
    const dir = tempDir();
    const source = join(dir, "a.c");
    writeFileSync(source, "int a(void) { return 1; }\n");
    const lib = { name: "a", sources: [source], headers: [], flags: ["-DA"] };
    const archive = join(dir, `a-${prebuiltKey(lib)}.a`);
    writeFileSync(archive, "");
    return { dir, source, lib, archive };
  }

  function withPrebuilt<T>(value: string, f: () => T): T {
    const saved = process.env.VISALJS_PREBUILT;
    process.env.VISALJS_PREBUILT = value;
    try {
      return f();
    } finally {
      if (saved === undefined) delete process.env.VISALJS_PREBUILT;
      else process.env.VISALJS_PREBUILT = saved;
    }
  }

  it("links a prebuilt archive instead of building the library", () => {
    const { dir, lib, archive } = prebuilt();
    /* a compiler that doesn't exist: building would fail */
    expect(withPrebuilt(dir, () => libraryArchive({ cc: "no-such-cc", opt: ["-O2"] }, lib))).toBe(archive);
  });

  it("builds a --debug or checking build itself, or when VISALJS_PREBUILT is 0", () => {
    const { dir, lib } = prebuilt();
    expect(withPrebuilt(dir, () => prebuiltArchive({ cc: "cc", opt: ["-O0"] }, lib))).toBeUndefined();
    expect(withPrebuilt(dir, () => prebuiltArchive({ cc: "cc", opt: ["-O2", "-DJS_GC_STRESS=1"] }, lib))).toBeUndefined();
    expect(withPrebuilt("0", () => prebuiltArchive({ cc: "cc", opt: ["-O2"] }, lib))).toBeUndefined();
  });

  it("keys an archive by its sources and flags", () => {
    const { source, lib } = prebuilt();
    const key = prebuiltKey(lib);
    expect(prebuiltKey({ ...lib, flags: ["-DB"] })).not.toBe(key);
    writeFileSync(source, "int a(void) { return 2; }\n");
    expect(prebuiltKey(lib)).not.toBe(key);
  });

  it("has every target's libraries, and their licenses", () => {
    for (const target of TARGETS) {
      const libs = prebuiltLibraries(target);
      expect(libs.map((l) => l.name).sort(), target.name).toEqual(["boringssl", "brotli", "uv", "zlib", "zstd"]);
      for (const l of libs) for (const f of [...l.sources, ...l.headers]) expect(existsSync(f), f).toBe(true);
    }
  });
});

describe("project entries", () => {
  const project = (pkg: object | undefined, files: string[]) => {
    const dir = tempDir();
    if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    for (const f of files) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), "");
    }
    return dir;
  };
  const entry = (dir: string) => {
    const e = projectEntry(dir);
    return { ...e, file: e.file.slice(dir.length + 1) };
  };

  it("finds the node command of a start script, past variables and options", () => {
    expect(nodeCommand("node server.js")).toEqual({ file: "server.js", args: [] });
    expect(nodeCommand("NODE_ENV=production node --enable-source-maps -r dotenv/config dist/app.js --port 80"))
      .toEqual({ file: "dist/app.js", args: ["--port", "80"] });
    expect(nodeCommand("npm run build && node dist/server.js")).toEqual({ file: "dist/server.js", args: [] });
    expect(nodeCommand("next start")).toBeUndefined();
    expect(nodeCommand("node")).toBeUndefined();
  });

  it("takes bin first, then scripts.start, then main, then index.js: the first whose file is there", () => {
    const all = { name: "@acme/api", bin: { api: "./cli.js" }, main: "lib.js", scripts: { start: "node server.js" } };
    expect(entry(project(all, ["cli.js", "server.js", "lib.js", "index.js"]))).toEqual({ file: "cli.js", from: 'package.json "bin"', name: "api", ignoredArgs: [] });
    expect(entry(project(all, ["server.js", "lib.js"]))).toEqual({ file: "server.js", from: 'package.json "scripts.start"', name: "api", ignoredArgs: [] });
    expect(entry(project(all, ["lib.js"]))).toEqual({ file: "lib.js", from: 'package.json "main"', name: "api", ignoredArgs: [] });
    /* npm init's "main": "index.js" without the file, and a start script that isn't node's */
    expect(() => projectEntry(project({ name: "web", main: "index.js", scripts: { start: "vite" } }, ["app.js"])))
      .toThrow(`(package.json "main" names index.js, which isn't there)`);
    expect(entry(project(undefined, ["index.js"]))).toMatchObject({ file: "index.js", from: "index.js" });
  });

  it("names the binary after the command, the package without its scope, else the directory", () => {
    expect(entry(project({ bin: "./run.js", name: "@scope/thing" }, ["run.js"])).name).toBe("thing");
    const dir = project({}, ["index.js"]);
    expect(projectEntry(dir).name).toBe(dir.split(/[\\/]/).at(-1));
  });

  it("resolves a file as node does: server for server.js", () => {
    expect(entry(project({ scripts: { start: "node server" } }, ["server.js"])).file).toBe("server.js");
    expect(entry(project({ main: "lib/main" }, ["lib/main.cjs"])).file).toBe("lib/main.cjs");
  });

  it("asks for one of several commands, and says what it checked when nothing is there", () => {
    const several = project({ bin: { a: "a.js", b: "b.js" } }, ["a.js", "b.js"]);
    expect(() => projectEntry(several)).toThrow(EntryError);
    expect(() => projectEntry(several)).toThrow(/package\.json "bin" names 2 commands: build one of them, visaljs build .*a\.js -o a, or visaljs build .*b\.js -o b/);
    expect(() => projectEntry(project({ main: "dist/index.js", scripts: { start: "node dist/server.js" } }, []))).toThrow(
      `no entry file: checked package.json's "bin", "scripts.start" and "main", and index.js ` +
      `(package.json "scripts.start" names dist/server.js, which isn't there; package.json "main" names dist/index.js, which isn't there)`);
    expect(() => projectEntry(project(undefined, []))).toThrow("no entry file: checked a package.json and index.js");
    expect(() => projectEntry(project(undefined, ["package.json"]))).toThrow(/cannot read .*package\.json/);
  });
});
