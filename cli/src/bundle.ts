// The bundler step: rolldown turns a multi-file program (ES modules,
// CommonJS, node_modules, JSON) into one ES module, which visaljs compiles.
import { existsSync, readFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, resolve, sep } from "node:path";

import { COMMONJS_DIRECTIVE, HOST_MODULE } from "@visaljs/compiler";
import { type Plugin, rolldown, RolldownMagicString, type RolldownLog } from "rolldown";
import { parseSync } from "rolldown/utils";

import { type HostPackage, hostModules as providedModules } from "./hosts.ts";

export interface Bundle {
  code: string;
  map: string;  // source map v3 (JSON), with absolute `sources`
  modules: number;  // the files rolled in (not rolldown's own virtual modules)
  required: string[];  // packages bundled for a require() made at run time (requiredPackages)
}

/** A bundling failure, already formatted as `file:line:col: Kind: message` lines. */
export class BundleError extends Error {}

export interface BundleExtras {
  /** The entry's source, when it isn't a file: a module generated as if it were `entry`. */
  source?: string;
  /** An integration's plugins, for its code. */
  plugins?: Plugin[];
  /** Packages a require() may ask for at run time beyond those the bundler finds: an integration's. */
  requires?: string[];
  /** `process.env.NODE_ENV`'s value, fixed at build time; undefined: read at run time. */
  nodeEnv?: string | undefined;
  /** Every implicit module, not only those the program's code reaches (--all-features). */
  allFeatures?: boolean;
  /** Modules the program never runs, which its code still requires: an integration's. */
  ignored?: readonly IgnoredModule[];
}

/** A module the program never runs, left out of the bundle: a require() of it gets a stand-in. */
export interface IgnoredModule {
  /** Its file under node_modules ("next/dist/build/swc/index.js"), or a package: each of its files ("sharp"). */
  module: string;
  /** "require" (the default): a module that throws when required, for one required only where the
   *  program never goes; "call": its exports, each throwing when called, for one never called. */
  stub?: "require" | "call";
  /** Why the program never runs it: the stand-in's error says. */
  reason: string;
  /** The "require" stand-in's error code (default MODULE_NOT_FOUND): what the code requiring it
   *  expects of its failure (ERR_DLOPEN_FAILED for a native addon). */
  code?: string;
}

/** Bundles `entry` into one ES module, `node:*` imports resolved to the host packages' modules.
 *  Warnings go to `warn`, with their location ("file:line:col: ", or ""). */
export async function bundle(entry: string, hosts: readonly HostPackage[], warn: (message: string, where: string) => void,
  extras: BundleExtras = {}): Promise<Bundle> {
  const rollup = (implicit: readonly string[], warn: (message: string, where: string) => void, required: readonly string[]) =>
    rollupOnce(entry, hosts, implicit, warn, required, extras);
  const b = await rollup([], warn, []);
  /* bundled again, run first: the implicit modules the code reaches and the packages it may
   * require() at run time (the warnings were given) */
  const program = programCode(b.code, dirname(resolve(entry)), hosts);
  const implicit = hosts.flatMap((h) => h.implicitModules ?? []).filter((m) => extras.allFeatures === true || m.reached(b.code, program)).map((m) => m.file);
  const required = hosts.some((h) => h.requireTable) ? [...requiredPackages(b.code, entry, extras.requires ?? []), ...namedBuiltins(program)] : [];
  if (required.length) implicit.unshift(REQUIRE_TABLE);
  return implicit.length ? rollup(implicit, () => {}, required) : b;
}

/** A bundle's code without its host prelude modules: rolldown marks each module's code with
 *  `//#region <path, relative to cwd>` … `//#endregion` (the runtime's copy of one, with its prefix). */
function programCode(code: string, cwd: string, hosts: readonly HostPackage[]): string {
  const preludes = hosts.map((h) => h.preludeDir + sep);
  return code.replace(/^\/\/#region (.*)\n[^]*?^\/\/#endregion$/gm, (region, path: string) =>
    (preludes.some((dir) => resolve(cwd, path.replace(/^(?:\0|\\0)visaljs-runtime:/, "")).startsWith(dir)) ? "" : region));
}

/** `given`, and the packages a bundle names in ``a(`react-dom`)``, where `a` is a createRequire()
 *  the bundler couldn't follow (Vite's, for the packages it left external). A call that isn't a
 *  require() but names an installed package bundles it needlessly: the build lists them. */
function requiredPackages(code: string, entry: string, given: readonly string[]): string[] {
  if (!/\bcreateRequire\s*\(/.test(code)) return [];
  const require = createRequire(resolve(entry));
  const names = new Set<string>();
  const called = code.matchAll(/(?<![.\w$])[\w$]+\s*\(\s*(["'`])((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.-]+)*)\1\s*\)/g);
  for (const name of [...given, ...Array.from(called, (m) => m[2]!)]) {
    if (names.has(name) || isBuiltin(name)) continue;
    try {
      require.resolve(name);
      names.add(name);
    } catch {
      /* not a package here */
    }
  }
  return [...names].sort();
}

/** The built-in modules the program names in process.getBuiltinModule("…"): bundled, in the require
 *  table, since the program loads them without importing them. */
function namedBuiltins(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/\bgetBuiltinModule\s*\(\s*(["'`])((?:node:)?[\w/]+)\1\s*\)/g)) if (isBuiltin(m[2]!)) names.add(m[2]!);
  return [...names].sort();
}

async function rollupOnce(entry: string, hosts: readonly HostPackage[], implicit: readonly string[], warn: (message: string, where: string) => void,
  required: readonly string[], extras: BundleExtras): Promise<Bundle> {
  try {
    const build = await rolldown({
      input: implicit.length ? IMPLICIT_ENTRY : resolve(entry),
      cwd: dirname(resolve(entry)),     // names in messages and the source map are relative to the entry
      platform: "node",                 // conditions node, import, default; node:* built-ins stay external
      logLevel: "warn",
      /* EVAL: the driver warns about eval itself, only where it can throw (eval.ts); "use static"
       * reaches the bundle only under --no-static, which drops it on purpose */
      onLog: (_level, log) => log.code !== "EVAL" && !(log.code === "MODULE_LEVEL_DIRECTIVE" && log.message.includes('"use static"'))
        && warn(logText(log), logWhere(log)),
      /* a constant NODE_ENV: `if (process.env.NODE_ENV === "production")` folds, and tree-shaking
       * drops the other branch (React's development build, half of the bundle) */
      ...(extras.nodeEnv === undefined ? {} : { transform: { define: { "process.env.NODE_ENV": JSON.stringify(extras.nodeEnv) } } }),
      plugins: [hostModules(hosts), commonJS(), ...ignoredModules(extras.ignored ?? []), missingRequires(warn), depdWrappers(), implicitEntry(entry, implicit), requireTable(hosts, required), ...generatedEntry(entry, extras.source), ...(extras.plugins ?? [])],
    });
    try {
      const { output } = await build.generate({
        format: "esm",
        codeSplitting: false,           // one chunk: dynamic imports are inlined
        minify: false,                  // keeps names and Function.prototype.toString readable
        sourcemap: true,
        sourcemapPathTransform: (source, mapPath) => (source.includes("\0") ? source : resolve(dirname(mapPath), source)),
        comments: { legal: false },
      });
      const chunk = output[0];
      return { code: chunk.code, map: chunk.map?.toString() ?? "", modules: chunk.moduleIds.filter((id) => !id.startsWith("\0")).length, required: [...required] };
    } finally {
      await build.close();
    }
  } catch (e) {
    const errors = (e as { errors?: RolldownLog[] }).errors;
    if (!errors) throw e;
    throw new BundleError(errors.map((log) => formatLog(log, log.code === "PARSE_ERROR" ? "SyntaxError" : "error")).join("\n"));
  }
}

/** `node:fs` (or `fs`) resolves to its host package's prelude module, bundled like the program's
 *  code; only prelude modules may import the host primitives. */
function hostModules(hosts: readonly HostPackage[]): Plugin {
  const modules = providedModules(hosts);
  const preludes = hosts.map((h) => h.preludeDir + sep);
  return {
    name: "visaljs-host",
    resolveId(source, importer, { kind }) {
      if (source === HOST_MODULE) {
        if (importer && (preludes.some((dir) => importer.startsWith(dir)) || importer.startsWith(RUNTIME_COPY))) return { id: source, external: true };
        this.error({ message: `${HOST_MODULE} is internal to the host prelude`, ...(importer ? { id: importer } : {}) });
      }
      if (!source.startsWith("node:") && !isBuiltin(source)) return null;
      const name = source.replace(/^node:/, "");
      const file = Object.hasOwn(modules, name) ? modules[name] : undefined;
      /* rolldown's runtime imports createRequire from node:module, before its helpers are defined:
       * it gets its own copy (node:module's prelude imports nothing) */
      if (file && importer === ROLLDOWN_RUNTIME) return RUNTIME_COPY + file;
      if (file) return kind === "require-call" ? REQUIRED + file : file;
      const provided = Object.keys(modules).sort().map((m) => `node:${m}`).join(", ");
      this.error({ message: `node:${name} is not provided by visaljs (it provides ${provided})`, ...(importer ? { id: importer } : {}) });
    },
    /* require() of a built-in gives its module.exports, as Node does: the prelude's default export
     * with the named exports it lacks (`in`: process.emit is inherited), not the namespace */
    load(id) {
      if (id.startsWith(RUNTIME_COPY)) return readFileSync(id.slice(RUNTIME_COPY.length), "utf8");
      if (!id.startsWith(REQUIRED)) return null;
      return `const ns = require(${JSON.stringify(id.slice(REQUIRED.length))});
const m = ns.default;
for (const k of Object.keys(ns)) if (k !== "default" && !(k in m)) m[k] = ns[k];
module.exports = m;
`;
    },
  };
}

/** CommonJS modules (as Node decides: `.cjs`, or `.js` without module syntax outside a `"type":
 *  "module"` package) run sloppy, though the bundle is strict: each wrapper gets COMMONJS_DIRECTIVE,
 *  and one saying "use strict" (a directive the bundler drops) gets a strict function of its own.
 *  `__filename` and `__dirname` are the file's at build time; ES modules keep them undefined (code
 *  tests `typeof __dirname`). */
function commonJS(): Plugin {
  const types = new Map<string, string | undefined>();  // a directory → its package's "type"
  const packageType = (dir: string): string | undefined => {
    if (types.has(dir)) return types.get(dir);
    const file = resolve(dir, "package.json");
    let type: string | undefined;
    if (existsSync(file)) {
      try {
        type = (JSON.parse(readFileSync(file, "utf8")) as { type?: unknown }).type === "module" ? "module" : "commonjs";
      } catch {
        type = "commonjs";  /* Node fails on it; the bundler reports it */
      }
    } else {
      type = dirname(dir) === dir ? "commonjs" : packageType(dirname(dir));
    }
    types.set(dir, type);
    return type;
  };
  return {
    name: "visaljs-commonjs",
    transform: {
      filter: { id: /\.(?:c?js|cts|jsx|tsx?)$/, code: /\b__(?:file|dir)name\b|use strict/ },
      handler(code, id) {
        if (id.startsWith("\0") || !/\.c[jt]s$/.test(id) && packageType(dirname(id)) === "module") return null;
        const { program, module } = parseSync(id, code);
        if (module.hasModuleSyntax) return null;
        /* the directive prologue, which must stay first, after any hashbang */
        const start = program.body[0]?.start ?? code.length;
        let at = start;
        let strict = false;
        for (const st of program.body) {
          if (st.type !== "ExpressionStatement" || !("directive" in st) || typeof st.directive !== "string") break;
          if (st.directive === "use strict") strict = true;
          at = st.end;
        }
        const paths = /\b__(?:file|dir)name\b/.test(code);
        if (!strict && !paths) return null;
        const s = new RolldownMagicString(code);
        if (paths) s.appendLeft(at, `;var __filename = ${JSON.stringify(id)}, __dirname = ${JSON.stringify(dirname(id))};`);
        /* its directives inside: a top-level return still ends the module */
        if (strict) s.prependLeft(start, "(function () {").append("\n}).call(this);");
        return { code: s.toString(), map: s.generateMap({ hires: true, source: id }).toString() };
      },
    },
    /* the wrappers: `__commonJSMin(((exports, module) => {` */
    renderChunk(code) {
      const s = new RolldownMagicString(code);
      let marked = false;
      for (const m of code.matchAll(COMMONJS_WRAPPER)) {
        s.appendLeft(m.index + m[0].length, `${JSON.stringify(COMMONJS_DIRECTIVE)};`);
        marked = true;
      }
      /* a segment per word, not per character: the chunk's map is chained with the modules', and
       * a large bundle's would have tens of millions of segments */
      return marked ? { code: s.toString(), map: s.generateMap({ hires: "boundary" }).toString() } : null;
    },
  };
}

/** A require() of a missing file or a native addon throws when reached, as in Node, instead of
 *  failing the build: packages require() files their published build leaves out (Next.js's dev
 *  server) and addons they fall back from (sharp, in a try). */
function missingRequires(warn: (message: string, where: string) => void): Plugin {
  return {
    name: "visaljs-missing-requires",
    async resolveId(source, importer, { kind }) {
      if (kind !== "require-call" || !importer || source.startsWith("\0")) return null;
      const relative = /^\.\.?(?:\/|$)/.test(source);
      const resolved = relative || source.endsWith(".node") ? await this.resolve(source, importer, { skipSelf: true }) : null;
      if (resolved && !resolved.id.endsWith(".node")) return null;  /* there: the plugins after this one resolve it */
      if (!relative && !resolved) return null;
      const what = resolved ? "a native addon, which visaljs can't load" : "not there";
      warn(`${source} is ${what}: its require() throws if it's reached`, `${importer}: `);
      return MISSING + JSON.stringify([source, resolved ? "ERR_DLOPEN_FAILED" : "MODULE_NOT_FOUND"]);
    },
    load(id) {
      if (!id.startsWith(MISSING)) return null;
      const [source, code] = JSON.parse(id.slice(MISSING.length)) as [string, string];
      const message = code === "MODULE_NOT_FOUND" ? `Cannot find module '${source}'` : `${source}: visaljs can't load native addons`;
      /* CommonJS: wrapped, so it runs (and throws) only when required */
      return `throw Object.assign(new Error(${JSON.stringify(message)}), { code: ${JSON.stringify(code)} });\n`;
    },
  };
}

const MISSING = "\0visaljs-missing:";

/** Stand-ins for the `ignored` modules. A "call" one whose export names can't be read is bundled
 *  instead. */
function ignoredModules(ignored: readonly IgnoredModule[]): Plugin[] {
  if (!ignored.length) return [];
  const matching = (id: string) => {
    const path = id.replaceAll("\\", "/");
    return ignored.find((m) => (/\.[cm]?js$/.test(m.module) ? path.endsWith(`/node_modules/${m.module}`) : path.includes(`/node_modules/${m.module}/`)));
  };
  return [{
    name: "visaljs-ignored",
    async resolveId(source, importer, { kind }) {
      if (kind !== "require-call" || !importer || source.startsWith("\0")) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      const m = resolved && !resolved.external ? matching(resolved.id) : undefined;
      /* the others resolve as if this weren't here: this.resolve doesn't tell them it's a require() */
      if (!resolved || !m) return null;
      const code = m.stub === "call" ? readFileSync(resolved.id, "utf8") : "";
      const names = m.stub === "call" ? exportNames(code) : [];
      if (m.stub === "call" && !names.length) return null;
      return IGNORED + JSON.stringify({ module: m.module, reason: m.reason, code: m.code ?? "MODULE_NOT_FOUND", names, esModule: code.includes('Object.defineProperty(exports, "__esModule"') });
    },
    load(id) {
      if (!id.startsWith(IGNORED)) return null;
      const { module, reason, code, names, esModule } = JSON.parse(id.slice(IGNORED.length)) as
        { module: string; reason: string; code: string; names: string[]; esModule: boolean };
      if (!names.length) {
        /* CommonJS: wrapped, so it throws only when required */
        const message = code === "MODULE_NOT_FOUND" ? `Cannot find module '${module}' (${reason})` : `${module}: ${reason}`;
        return `throw Object.assign(new Error(${JSON.stringify(message)}), { code: ${JSON.stringify(code)} });\n`;
      }
      const message = JSON.stringify(`${module} isn't in the compiled program (${reason})`);
      return (esModule ? 'Object.defineProperty(exports, "__esModule", { value: true });\n' : "") +
        names.map((n) => `exports.${n} = function () { throw new Error(${message}); };\n`).join("");
    },
  }];
}

const IGNORED = "\0visaljs-ignored:";

/** A CommonJS module's export names, as compilers write them: `exports.a = …`,
 *  `Object.defineProperty(exports, "a", …)`, and TypeScript's and SWC's `_export(exports, { a: …, b: … })`. */
function exportNames(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) names.add(m[1]!);
  for (const m of code.matchAll(/\bObject\.defineProperty\(exports, "([A-Za-z_$][\w$]*)"/g)) names.add(m[1]!);
  const block = /\b_export\(exports, \{\n([\s\S]*?)\n\}\);/.exec(code)?.[1];
  if (block) for (const m of block.matchAll(/^ {4}([A-Za-z_$][\w$]*): function\(\) \{/gm)) names.add(m[1]!);
  names.delete("__esModule");
  return [...names];
}

/** depd (Express 4, body-parser, Next.js's send) wraps deprecated functions with new Function,
 *  which needs eval, for their arity: a closure instead (length 0). Its call is the same wherever
 *  it's bundled or vendored. */
function depdWrappers(): Plugin {
  const call = /\bnew Function\((?=\s*(["'])fn\1\s*,\s*\1log\1\s*,\s*\1deprecate\1\s*,\s*\1message\1\s*,\s*\1site\1\s*,)/g;
  const helper = "function __visaljs_depdWrapper() { return function (fn, log, deprecate, message, site) { " +
    "return function () { log.call(deprecate, message, site); return fn.apply(this, arguments); }; }; }\n";
  return {
    name: "visaljs-depd",
    transform: {
      filter: { code: /new Function\(\s*["']fn["']\s*,\s*["']log["']/ },
      handler(code, id) {
        if (id.startsWith("\0")) return null;
        const s = new RolldownMagicString(code);
        let found = false;
        for (const m of code.matchAll(call)) {
          s.update(m.index, m.index + m[0].length, "__visaljs_depdWrapper(");
          found = true;
        }
        if (!found) return null;
        s.append(`\n${helper}`);  /* a declaration: hoisted, and after any directive prologue */
        return { code: s.toString(), map: s.generateMap({ hires: true, source: id }).toString() };
      },
    },
  };
}

const COMMONJS_WRAPPER = /\b__commonJS(?:Min)?\(\(\((?:[\w$]+(?:, [\w$]+)*)?\) => \{/g;

/** The entry when the program gets implicit modules: they, then the program's entry. */
const IMPLICIT_ENTRY = "\0visaljs-entry";

function implicitEntry(entry: string, implicit: readonly string[]): Plugin {
  return {
    name: "visaljs-implicit",
    resolveId: (source) => (source === IMPLICIT_ENTRY ? source : null),
    load: (id) => (id === IMPLICIT_ENTRY ? [...implicit, resolve(entry)].map((f) => `import ${JSON.stringify(f)};\n`).join("") : null),
  };
}

/** A generated entry: `entry`'s path (its imports resolve from there), `source` its code. */
function generatedEntry(entry: string, source: string | undefined): Plugin[] {
  if (source === undefined) return [];
  const id = resolve(entry);
  return [{
    name: "visaljs-generated-entry",
    resolveId: (s) => (s === id ? id : null),
    load: (i) => (i === id ? source : null),
  }];
}

/** The module that registers the packages a require() made at run time reaches: run first. */
const REQUIRE_TABLE = "\0visaljs-require-table";

function requireTable(hosts: readonly HostPackage[], required: readonly string[]): Plugin {
  const table = hosts.findLast((h) => h.requireTable)?.requireTable;
  return {
    name: "visaljs-require-table",
    resolveId: (source) => (source === REQUIRE_TABLE ? source : null),
    /* on globalThis, not in a module: the bundler's runtime has its own copy of node:module, and
     * a dynamically imported one would wrap a shared module in the runtime's helpers */
    load: (id) => (id === REQUIRE_TABLE && table
      ? `Object.defineProperty(globalThis, Symbol.for(${JSON.stringify(table)}), { value: new Map([\n` +
        required.map((name) => `  [${JSON.stringify(name)}, () => require(${JSON.stringify(name)})],\n`).join("") + "]) });\n"
      : null),
  };
}

/** The prefix of the CommonJS module a require() of a built-in resolves to (hostModules.load). */
const REQUIRED = "\0visaljs-require:";

/** rolldown's runtime helpers, and the prefix of the copy of a host module they import (hostModules). */
const ROLLDOWN_RUNTIME = "\0rolldown/runtime.js";
const RUNTIME_COPY = "\0visaljs-runtime:";

/** rolldown's messages carry ANSI colors and a code frame: keep the first line, without the `[CODE]` tag. */
function formatLog(log: RolldownLog, kind: string): string {
  return `${logWhere(log)}${kind}: ${logText(log)}`;
}

function logText(log: RolldownLog): string {
  // eslint-disable-next-line no-control-regex
  return log.message.replace(/\x1b\[[0-9;]*m/g, "").split("\n")[0]!.replace(/^\[[A-Z_]+\] /, "").trim();
}

/** "file:line:col: ", "file: ", or "". */
function logWhere(log: RolldownLog): string {
  return log.loc ? `${log.loc.file ?? log.id}:${log.loc.line}:${log.loc.column + 1}: ` : log.id ? `${log.id}: ` : "";
}
