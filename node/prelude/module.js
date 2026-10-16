// node:module: createRequire, which the bundler's code uses for a require() it
// couldn't resolve at build time. A compiled program can't load new code: such a require gives
// a package the bundler found the program may ask for and bundled (the require table), else
// throws as Node's does for a module it can't find (as a computed import() rejects). A JSON file
// is data, not code: a path ending in .json is read and parsed when asked for, as Node does
// (yargs's --config, a package.json found at run time).
// builtinModules and isBuiltin list Node's built-in modules.
//
// It imports only the host primitives: the bundler's own runtime imports it, and so runs it before any helper the
// bundler would wrap an imported module in. The bundler's runtime has its own copy, so the table
// isn't this module's: the module the bundler generates puts it on globalThis, under this
// symbol (name → a function giving the module's exports; cli/src/bundle.ts).
import { fsReadFile, fsStat } from "visaljs:host";

export const REQUIRE_TABLE = Symbol.for("visaljs.requireTable");

export const builtinModules = [
  "_http_agent", "_http_client", "_http_common", "_http_incoming", "_http_outgoing", "_http_server", "_stream_duplex",
  "_stream_passthrough", "_stream_readable", "_stream_transform", "_stream_wrap", "_stream_writable", "_tls_common", "_tls_wrap",
  "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram",
  "diagnostics_channel", "dns", "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2", "https", "inspector",
  "inspector/promises", "module", "net", "os", "path", "path/posix", "path/win32", "perf_hooks", "process", "punycode",
  "querystring", "readline", "readline/promises", "repl", "stream", "stream/consumers", "stream/promises", "stream/web",
  "string_decoder", "sys", "timers", "timers/promises", "tls", "trace_events", "tty", "url", "util", "util/types", "v8", "vm",
  "wasi", "worker_threads", "zlib",
];

/* the built-ins only named with the node: scheme (`test` alone is an npm package's name) */
const schemeOnly = ["node:sea", "node:sqlite", "node:test", "node:test/reporters"];

export function isBuiltin(moduleName) {
  const name = String(moduleName);
  return schemeOnly.includes(name) || builtinModules.includes(name.startsWith("node:") ? name.slice(5) : name);
}

function withCode(error, code) {
  Object.defineProperty(error, "code", { value: code, writable: true, enumerable: true, configurable: true });
  return error;
}

function notFound(id) {
  const e = withCode(new Error(`Cannot find module '${id}'`), "MODULE_NOT_FOUND");
  e.requireStack = [];
  return e;
}

/* require.extensions and Module._extensions (deprecated, still read: a hook saves the old one): a
 * compiled program has no files to load, so each loader says so */
const extensions = { __proto__: null };
for (const ext of [".js", ".json", ".node"]) {
  extensions[ext] = function (module, filename) {
    throw withCode(new Error(`Cannot load ${filename}: a compiled program has no files to load at run time`), "ERR_UNKNOWN_FILE_EXTENSION");
  };
}

/* Module._cache: every require's cache, as Node's */
const cache = { __proto__: null };

export function createRequire(filename) {
  if (typeof filename !== "string" && !(typeof URL === "function" && filename instanceof URL)) {
    throw withCode(new TypeError("The argument 'filename' must be a file URL object, file URL string, or absolute path string. Received " +
      String(filename)), "ERR_INVALID_ARG_VALUE");
  }
  const base = pathOf(filename);
  const require = (id) => {
    const load = globalThis[REQUIRE_TABLE]?.get(id);
    if (load !== undefined) return load();
    if (typeof id === "string" && id.endsWith(".json") && (isRelative(id) || isAbsolute(id))) return requireJSON(require.cache, id, base);
    throw notFound(id);
  };
  require.resolve = (id) => {
    throw notFound(id);
  };
  require.resolve.paths = () => null;
  require.cache = cache;
  require.main = undefined;
  require.extensions = extensions;
  return require;
}

/* paths as node:path's default (which this module can't import) has them: on Windows, a root of
 * a drive (C:), a share (\\server\share) or none, and either separator */
const onWindows = () => globalThis.process.platform === "win32";
const isAbsolute = (path) => path.startsWith("/") || (onWindows() && /^(?:\\|[A-Za-z]:[\\/])/.test(path));
const isRelative = (path) => /^\.\.?\//.test(path) || (onWindows() && /^\.\.?\\/.test(path));
const endsWithSep = (path) => path.endsWith("/") || (onWindows() && path.endsWith("\\"));

function pathOf(filename) {
  const s = typeof filename === "string" ? filename : filename.href;
  if (!s.startsWith("file:")) return s;
  const url = new URL(s);
  const path = decodeURIComponent(url.pathname);
  if (!onWindows()) return path;
  const local = path.replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\");
  return url.hostname ? `\\\\${url.hostname}${local}` : local;
}

/* an absolute path without its . and .. segments (node:path's normalize); a root's parent is itself.
 * On Windows, \path is on the working directory's drive. */
const windowsRoot = (path) => /^(?:[A-Za-z]:|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.exec(path)?.[0];
function normalize(path) {
  const windows = onWindows();
  const given = windows ? windowsRoot(path) ?? "" : "";
  const root = windows && !given ? windowsRoot(globalThis.process.cwd()) ?? "" : given;
  const out = [];
  for (const part of path.slice(given.length).split(windows ? /[\\/]/ : "/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return windows ? `${root.replaceAll("/", "\\")}\\${out.join("\\")}` : "/" + out.join("/");
}

/** A JSON file, by a path absolute or relative to the requiring file's directory: parsed once,
 *  then from require.cache, as Node's loader does. */
function requireJSON(cache, id, from) {
  const path = normalize(isAbsolute(id) ? id : `${from}/../${id}`);
  if (path in cache) return cache[path].exports;
  const text = fsReadFile(path, false);
  if (typeof text !== "string") throw notFound(id);
  let exports;
  try {
    exports = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    e.message = `${path}: ${e.message}`;
    throw e;
  }
  cache[path] = { id: path, filename: path, loaded: true, exports };
  return exports;
}

/* internal/errors.js's, here: this module imports nothing */
function notSupported(what) {
  return withCode(new Error(`${what} is not supported by visaljs`), "ERR_VISALJS_UNSUPPORTED");
}

/** Loader hooks: a compiled program loads no code at run time, so has none to hook. */
export function register() {
  throw notSupported("module.register()");
}

export function registerHooks() {
  throw notSupported("module.registerHooks()");
}

export function runMain() {
  throw notSupported("module.runMain() (loading a program)");
}

/** Type stripping needs TypeScript's parser at run time, which a compiled program doesn't carry. */
export function stripTypeScriptTypes() {
  throw notSupported("module.stripTypeScriptTypes()");
}

/** Node's live binding refresh for built-ins' ES module exports: they're always in step here. */
export function syncBuiltinESMExports() {}

/* ---- the compile cache: a compiled program has nothing to compile, so it's disabled ---------------- */

export const constants = Object.freeze({ compileCacheStatus: Object.freeze({ FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 }) });

export function enableCompileCache() {
  return { status: constants.compileCacheStatus.DISABLED, message: "Disabled: a compiled program has no source to compile" };
}

export function getCompileCacheDir() {
  return undefined;
}

export function flushCompileCache() {}

/* ---- source maps -------------------------------------------------------------------------------- */

let sourceMapsSupport = { enabled: false, nodeModules: false, generatedCode: false };

export function getSourceMapsSupport() {
  return { ...sourceMapsSupport };
}

export function setSourceMapsSupport(enabled, options = {}) {
  if (typeof enabled !== "boolean") throw withCode(new TypeError(`The "enabled" argument must be of type boolean.`), "ERR_INVALID_ARG_TYPE");
  sourceMapsSupport = { enabled, nodeModules: Boolean(enabled && options.nodeModules), generatedCode: Boolean(enabled && options.generatedCode) };
}

/** The source map a loaded module carries: none are loaded at run time. */
export function findSourceMap() {
  return undefined;
}

/** SourceMap: internal/source_map.js, linked when the program names it. */
export function SourceMap(payload, options) {
  const Impl = globalThis[Symbol.for("visaljs.SourceMap")];
  if (Impl === undefined) throw notSupported("module.SourceMap (named only at run time)");
  if (!new.target) throw new TypeError("Class constructor SourceMap cannot be invoked without 'new'");
  return Reflect.construct(Impl, [payload, options], new.target === SourceMap ? Impl : new.target);
}

/* ---- findPackageJSON ------------------------------------------------------------------------------- */

const isDir = (path) => {
  const st = fsStat(path, true);
  return typeof st !== "number" && (st[0] & 0o170000) === 0o040000;
};
const exists = (path) => typeof fsStat(path, true) !== "number";
const dirOf = (path) => path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";
const parentOf = (path) => normalize(`${path}/..`);
/* on Windows, Node gives the closest package.json as a namespaced path: \\?\C:\… or \\?\UNC\server\… */
const namespaced = (path) => !onWindows() ? path : path.startsWith("\\\\") ? `\\\\?\\UNC\\${path.slice(2)}` : `\\\\?\\${path}`;

/** findPackageJSON(specifier[, base]): the package.json closest to what the specifier resolves to
 *  (a path or file: URL, relative to base; or a package, from base's node_modules), or undefined. */
export function findPackageJSON(specifier, base) {
  const spec = specifier instanceof URL ? specifier.href : String(specifier);
  const baseText = base instanceof URL ? base.href : base === undefined ? undefined : String(base);
  const unresolved = () => withCode(new TypeError(`Failed to resolve module specifier "${spec}" from "${baseText}": ` +
    "Invalid relative URL or base scheme is not hierarchical."), "ERR_UNSUPPORTED_RESOLVE_REQUEST");
  const basePath = baseText === undefined ? undefined : baseText.startsWith("file:") ? pathOf(baseText) : baseText;
  let target;
  if (spec.startsWith("file:")) target = normalize(pathOf(spec));
  /* a specifier is a URL: C:\… has the scheme c: */
  else if (onWindows() && isAbsolute(spec)) throw withCode(new TypeError("The URL must be of scheme file"), "ERR_INVALID_URL_SCHEME");
  else if (spec.startsWith("/")) target = normalize(spec);
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    if (basePath === undefined) throw unresolved();
    target = normalize(endsWithSep(baseText) ? `${basePath}/${spec}` : `${basePath}/../${spec}`);
  } else {
    /* a package: its directory under the closest node_modules that has it */
    if (basePath === undefined) throw unresolved();
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    for (let dir = endsWithSep(baseText) ? normalize(basePath) : parentOf(basePath); ; dir = parentOf(dir)) {
      const candidate = normalize(`${dir}/node_modules/${name}/package.json`);
      if (exists(candidate)) return candidate;
      if (parentOf(dir) === dir) throw withCode(new Error(`Cannot find package '${name}' imported from ${basePath}`), "ERR_MODULE_NOT_FOUND");
    }
  }
  for (let dir = isDir(target) ? target : parentOf(target); ; dir = parentOf(dir)) {
    const candidate = normalize(`${dir}/package.json`);
    if (exists(candidate)) return namespaced(candidate);
    if (parentOf(dir) === dir) return undefined;
  }
}

/* ---- Module ---------------------------------------------------------------------------------------- */

/** Module: Node's CommonJS module record, with its helpers; the module's default export is it. */
function Module(id = "", parent) {
  this.id = id;
  this.path = id ? dirOf(id) : ".";
  this.exports = {};
  this.filename = null;
  this.loaded = false;
  this.children = [];
  this.paths = [];
  void parent;
}

export const globalPaths = [];
const wrapper = ["(function (exports, require, module, __filename, __dirname) { ", "\n});"];

/* in a pure call, so a program that doesn't use node:module (the bundler's runtime has a copy of it
 * in every program) drops it all */
const ModuleWithHelpers = /* @__PURE__ */ Object.assign(Module, {
  builtinModules, createRequire, isBuiltin, register, registerHooks, runMain, stripTypeScriptTypes, syncBuiltinESMExports, constants,
  enableCompileCache, getCompileCacheDir, flushCompileCache, getSourceMapsSupport, setSourceMapsSupport, findSourceMap, SourceMap,
  findPackageJSON, globalPaths, Module, wrapper,
  wrap: (script) => wrapper[0] + script + wrapper[1],
  _cache: cache,
  _extensions: extensions,
  /* a built-in resolves to itself; a compiled program has no files to resolve to */
  _resolveFilename(request) {
    if (isBuiltin(request)) return request;
    const e = withCode(new Error(`Cannot find module '${request}'`), "MODULE_NOT_FOUND");
    e.requireStack = [];
    throw e;
  },
  _load(request) {
    return createRequire("/")(request);
  },
});

export { ModuleWithHelpers as Module, ModuleWithHelpers as default };
