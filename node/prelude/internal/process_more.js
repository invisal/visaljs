// process's members beyond the runtime's process object, as Node's: the working directory and
// file mode mask, uptime, CPU, resource and memory figures, the parent pid, the title, user and
// group ids (POSIX), abort, reallyExit and execve; loadEnvFile and getBuiltinModule; the uncaught
// exception capture callback; finalization; report; ref and unref; and the settings and lists a
// compiled program has as constants (release, config, allowedNodeEnvironmentFlags, …). Linked
// into programs that name them (implicitModules in node/index.ts); some link libuv.
import {
  fsReadFile, fsWriteFile, procAbort, procChdir, procCpuUsage, procExecve, procGetGroups, procGroupId, procInitGroups, procMemory, procPpid,
  procReallyExit, procResourceUsage, procSetGroups, procSetId, procUmask, procUptime, procUserId, procUserName, errnoMessage, errnoName,
} from "visaljs:host";
import { isBuiltin, REQUIRE_TABLE } from "../module.js";
import { parseDotenv } from "./dotenv.js";
import { codeError, invalidArgType, invalidArgValue, notSupported, outOfRange, systemError } from "./errors.js";
import "./process_events.js";

const p = globalThis.process;
const posix = p.platform !== "win32";

const define = (name, value) => Object.defineProperty(p, name, { value, writable: true, enumerable: true, configurable: true });
const accessor = (name, get, set) => Object.defineProperty(p, name, { get, set, enumerable: true, configurable: true });

function validateString(value, name) {
  if (typeof value !== "string") throw invalidArgType(name, "of type string", value);
}

/* Node's ErrnoException from C++: `EPERM, Operation not permitted`, errno positive */
function errnoException(err, syscall) {
  const message = errnoMessage(err);
  const e = new Error(`${errnoName(err)}, ${message.charAt(0).toUpperCase()}${message.slice(1)}`);
  e.errno = -err;
  e.code = errnoName(err);
  e.syscall = syscall;
  return e;
}

/* ---- the working directory, the mask, time and resources ------------------------------------- */

define("chdir", function chdir(directory) {
  validateString(directory, "directory");
  const err = procChdir(directory);
  if (err < 0) throw systemError(err, "chdir", p.cwd(), directory);
});

define("umask", function umask(mask) {
  if (mask === undefined) return procUmask(-1);
  if (typeof mask === "string") {
    let octal = mask.length > 0;
    for (const c of mask) octal &&= c >= "0" && c <= "7";
    if (!octal) {
      throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'mask' must be a 32-bit unsigned integer or an octal string. Received '${mask}'`);
    }
    mask = parseInt(mask, 8);
  } else if (typeof mask !== "number") {
    throw invalidArgType("mask", "of type number", mask);
  } else if (!Number.isInteger(mask) || mask < 0 || mask > 4294967295) {
    throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "mask" is out of range. It must be >= 0 && <= 4294967295. Received ${mask}`);
  }
  return procUmask(mask);
});

define("uptime", function uptime() {
  return procUptime();
});

/* the user and system CPU time (µs), or what it's been since prevValue */
function cpuUsageOf(thread, prevValue) {
  const usage = procCpuUsage(thread);
  const [user, system] = typeof usage === "number" ? [0, 0] : usage;
  if (!prevValue) return { user, system };  /* as Node's: any falsy prevValue */
  for (const key of ["user", "system"]) {
    const value = prevValue[key];
    if (typeof value === "number" && value >= 0 && Number.isFinite(value)) continue;
    if (key === "user" && (typeof prevValue !== "object" || Array.isArray(prevValue))) throw invalidArgType("prevValue", "of type object", prevValue);
    if (typeof value !== "number") throw invalidArgType(`prevValue.${key}`, "of type number", value);
    throw codeError(RangeError, "ERR_INVALID_ARG_VALUE", `The property 'prevValue.${key}' is invalid. Received ${value}`);
  }
  return { user: user - prevValue.user, system: system - prevValue.system };
}

define("cpuUsage", function cpuUsage(prevValue) {
  return cpuUsageOf(false, prevValue);
});

define("threadCpuUsage", function threadCpuUsage(prevValue) {
  return cpuUsageOf(true, prevValue);
});

const resourceNames = ["userCPUTime", "systemCPUTime", "maxRSS", "sharedMemorySize", "unsharedDataSize", "unsharedStackSize",
  "minorPageFault", "majorPageFault", "swappedOut", "fsRead", "fsWrite", "ipcSent", "ipcReceived", "signalsCount",
  "voluntaryContextSwitches", "involuntaryContextSwitches"];

define("resourceUsage", function resourceUsage() {
  const values = procResourceUsage();
  const usage = {};
  resourceNames.forEach((name, i) => (usage[name] = typeof values === "number" ? 0 : values[i]));
  return usage;
});

define("availableMemory", function availableMemory() {
  return procMemory()[0];
});

define("constrainedMemory", function constrainedMemory() {
  return procMemory()[1];
});

accessor("ppid", () => procPpid());

/* the title: the program's name until set (ps shows the process as it was started) */
let title;
const argv0 = p.argv0 ?? "";
accessor("title", () => title ?? argv0.slice(Math.max(argv0.lastIndexOf("/"), argv0.lastIndexOf("\\")) + 1), (value) => {
  title = `${value}`;
});

/* ---- user and group ids (POSIX) ----------------------------------------------------------------- */

/* an id, or a name looked up: ERR_UNKNOWN_CREDENTIAL for one that doesn't exist */
function idOf(id, kind) {
  if (typeof id === "number") return id;
  if (typeof id !== "string") throw invalidArgType("id", "one of type number or string", id);
  const found = kind === "User" ? procUserId(id) : procGroupId(id);
  if (found === -1) throw codeError(Error, "ERR_UNKNOWN_CREDENTIAL", `${kind} identifier does not exist: ${id}`);
  return found;
}

if (posix) {
  for (const [name, kind, which] of [["setuid", "User", 0], ["setgid", "Group", 1], ["seteuid", "User", 2], ["setegid", "Group", 3]]) {
    define(name, {
      [name](id) {
        const err = procSetId(which, idOf(id, kind));
        if (err < 0) throw errnoException(err, name);
      },
    }[name]);
  }

  define("getgroups", function getgroups() {
    const groups = procGetGroups();
    if (typeof groups === "number") throw errnoException(groups, "getgroups");
    return groups;
  });

  /* Node's validateId: a uint32 or a name; all checked before any is looked up */
  const validateId = (id, name) => {
    if (typeof id === "number") {
      if (!Number.isInteger(id)) throw outOfRange(name, "an integer", id);
      if (id < 0 || id > 4294967295) throw outOfRange(name, ">= 0 && <= 4294967295", id);
    } else if (typeof id !== "string") {
      throw invalidArgType(name, "one of type number or string", id);
    }
  };

  define("setgroups", function setgroups(groups) {
    if (!Array.isArray(groups)) throw invalidArgType("groups", "an instance of Array", groups);
    groups.forEach((group, i) => validateId(group, `groups[${i}]`));
    const ids = groups.map((group) => idOf(group, "Group"));
    const err = procSetGroups(ids);
    if (err < 0) throw errnoException(err, "setgroups");
  });

  define("initgroups", function initgroups(user, extraGroup) {
    validateId(user, "user");
    validateId(extraGroup, "extraGroup");
    const group = idOf(extraGroup, "Group");  /* as Node's: an unknown group is reported before an unknown user */
    let name = user;
    if (typeof user === "number") {
      name = procUserName(user);
      if (name === null) throw codeError(Error, "ERR_UNKNOWN_CREDENTIAL", `User identifier does not exist: ${user}`);
    } else if (procUserId(user) === -1) {
      throw codeError(Error, "ERR_UNKNOWN_CREDENTIAL", `User identifier does not exist: ${user}`);
    }
    const err = procInitGroups(name, group);
    if (err < 0) throw errnoException(err, "initgroups");
  });
}

/* ---- ending, replacing ---------------------------------------------------------------------------- */

define("abort", function abort() {
  procAbort();
});

/** Exits at once, without 'exit'. */
define("reallyExit", function reallyExit(code) {
  procReallyExit(code | 0);
});

/** Replaces the program with another (POSIX execve): returns only by failing, which, as in Node,
 *  ends the process. */
define("execve", function execve(execPath, args = [], env = p.env) {
  if (!posix) throw codeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", `process.execve is not available on ${p.platform}`);
  validateString(execPath, "execPath");
  if (!Array.isArray(args)) throw invalidArgType("args", "an instance of Array", args);
  args.forEach((arg, i) => {
    if (typeof arg !== "string" || arg.includes("\u0000")) throw invalidArgValue(`args[${i}]`, "must be a string without null bytes", arg);
  });
  if (env === null || typeof env !== "object" || Array.isArray(env)) throw invalidArgType("env", "of type object", env);
  const pairs = Object.entries(env).map(([key, value]) => {
    if (typeof value !== "string" || key.includes("\u0000") || value.includes("\u0000")) {
      throw invalidArgValue("env", "must be an object with string keys and values without null bytes", env);
    }
    return `${key}=${value}`;
  });
  const err = procExecve(execPath, args, pairs);
  p.stderr.write(`process.execve failed with error code ${errnoName(err)}\n`);
  procAbort();
});

/* ---- modules and environment files ------------------------------------------------------------ */

/** A built-in module, without importing it: one the program names with a literal string is
 *  bundled (the driver puts it in the require table); undefined for a name that isn't one. */
define("getBuiltinModule", function getBuiltinModule(id) {
  validateString(id, "id");
  if (!isBuiltin(id)) return undefined;
  const name = id.startsWith("node:") ? id.slice(5) : id;
  const table = globalThis[REQUIRE_TABLE];
  const load = table?.get(id) ?? table?.get(name) ?? table?.get(`node:${name}`);
  if (load === undefined) throw notSupported(`process.getBuiltinModule(${JSON.stringify(id)}) of a module named only at run time`);
  return load();
});

/** A .env file's variables into process.env, those already set kept. */
define("loadEnvFile", function loadEnvFile(path = ".env") {
  if (typeof path !== "string" && !(path instanceof URL) && !(path instanceof Uint8Array)) throw invalidArgType("path", "of type string or an instance of Buffer or URL", path);
  const file = path instanceof URL ? decodeURIComponent(path.pathname) : `${path}`;
  const text = fsReadFile(file, false);
  if (typeof text === "number") throw systemError(text, "open", file);
  for (const [key, value] of Object.entries(parseDotenv(text))) {
    if (p.env[key] === undefined) p.env[key] = value;
  }
});

/* ---- the uncaught exception capture callback ------------------------------------------------- */

let captureCallback = null;
const baseEmit = p.emit;

define("hasUncaughtExceptionCaptureCallback", function hasUncaughtExceptionCaptureCallback() {
  return captureCallback !== null;
});

/** fn takes the uncaught errors instead of 'uncaughtException' (the runtime emits through process.emit). */
define("setUncaughtExceptionCaptureCallback", function setUncaughtExceptionCaptureCallback(fn) {
  if (fn === null) {
    captureCallback = null;
    return;
  }
  if (typeof fn !== "function") throw invalidArgType("fn", "of type function or null", fn);
  if (captureCallback !== null) {
    throw codeError(Error, "ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET",
      "`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active");
  }
  captureCallback = fn;
});

p.emit = function emit(type, ...args) {
  if (type === "uncaughtException" && captureCallback !== null) {
    captureCallback(args[0]);
    return true;
  }
  return typeof baseEmit === "function" ? baseEmit.call(this, type, ...args) : false;
};

/* ---- finalization: callbacks at exit for the objects still alive ------------------------------ */

const finalizers = { exit: [], beforeExit: [] };
const runFinalizers = (event) => {
  for (const { ref, callback } of finalizers[event].splice(0)) {
    const obj = ref.deref();
    if (obj !== undefined) callback(obj, event);
  }
};

/* Node's: an ExperimentalWarning the first time each is used; the listeners from the first register */
const warned = new Set();
let listening = false;
function experimental(name) {
  if (!warned.has(name)) {
    warned.add(name);
    p.emitWarning(`process.finalization.${name} is an experimental feature and might change at any time`, "ExperimentalWarning");
  }
  if (!listening) {
    listening = true;
    p.on("exit", () => runFinalizers("exit"));
    p.on("beforeExit", () => runFinalizers("beforeExit"));
  }
}

function validateFinalization(obj, callback) {
  if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) throw invalidArgType("obj", "of type object", obj);
  if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
}

define("finalization", {
  register(obj, callback) {
    experimental("register");
    validateFinalization(obj, callback);
    finalizers.exit.push({ ref: new WeakRef(obj), callback });
  },
  registerBeforeExit(obj, callback) {
    experimental("registerBeforeExit");
    validateFinalization(obj, callback);
    finalizers.beforeExit.push({ ref: new WeakRef(obj), callback });
  },
  unregister(obj) {
    experimental("unregister");
    for (const list of Object.values(finalizers)) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].ref.deref() === obj) list.splice(i, 1);
    }
  },
});

/* ---- ref, unref, openStdin ------------------------------------------------------------------- */

const kRef = Symbol.for("nodejs.ref");
const kUnref = Symbol.for("nodejs.unref");

define("ref", function ref(maybeRefable) {
  const fn = maybeRefable?.[kRef] || maybeRefable?.ref;
  if (typeof fn === "function") fn.call(maybeRefable);
});

define("unref", function unref(maybeRefable) {
  const fn = maybeRefable?.[kUnref] || maybeRefable?.unref;
  if (typeof fn === "function") fn.call(maybeRefable);
});

define("openStdin", function openStdin() {
  p.stdin.resume();
  return p.stdin;
});

/* ---- what a compiled program has as constants -------------------------------------------------- */

const version = p.version;
define("release", {
  name: "node",
  ...(version.startsWith("v24.") ? { lts: "Krypton" } : {}),
  sourceUrl: `https://nodejs.org/download/release/${version}/node-${version}.tar.gz`,
  headersUrl: `https://nodejs.org/download/release/${version}/node-${version}-headers.tar.gz`,
});
define("config", Object.freeze({ variables: Object.freeze({ host_arch: p.arch, target_arch: p.arch }), target_defaults: Object.freeze({}) }));

/* the flags NODE_OPTIONS may give: a compiled program reads none */
class NodeEnvironmentFlagsSet extends Set {
  add() {
    return this;
  }
  delete() {
    return false;
  }
  clear() {}
}
define("allowedNodeEnvironmentFlags", new NodeEnvironmentFlagsSet());
define("debugPort", 9229);
define("moduleLoadList", []);
define("domain", null);

let sourceMaps = false;
accessor("sourceMapsEnabled", () => sourceMaps);
define("setSourceMapsEnabled", function setSourceMapsEnabled(enabled) {
  if (typeof enabled !== "boolean") throw invalidArgType("enabled", "of type boolean", enabled);
  sourceMaps = enabled;
});

/** The handles keeping the program alive, by type: not tracked by visaljs (an empty list). */
define("getActiveResourcesInfo", function getActiveResourcesInfo() {
  return [];
});

let assertWarned = false;
define("assert", function assert(value, message) {
  if (!assertWarned && p.noDeprecation !== true) {
    assertWarned = true;
    p.emitWarning("process.assert() is deprecated. Please use the `assert` module instead.", "DeprecationWarning", "DEP0100");
  }
  if (!value) throw codeError(Error, "ERR_ASSERTION", message || "assertion error");
});

define("binding", function binding() {
  throw notSupported("process.binding (Node's internal bindings)");
});

define("dlopen", function dlopen() {
  throw notSupported("process.dlopen (native addons)");
});

/* ---- report: what Node's diagnostic report says that a compiled program knows ------------------ */

function getReport(err) {
  const usage = p.resourceUsage();
  return {
    header: {
      reportVersion: 3, event: "JavaScript API", trigger: "GetReport", filename: null, dumpEventTime: new Date().toISOString(),
      processId: p.pid, cwd: p.cwd(), commandLine: p.argv, nodejsVersion: p.version, arch: p.arch, platform: p.platform,
      componentVersions: p.versions, release: p.release,
    },
    javascriptStack: { message: err ? String(err.message ?? err) : "No stack.", stack: [] },
    resourceUsage: { userCpuSeconds: usage.userCPUTime / 1e6, kernelCpuSeconds: usage.systemCPUTime / 1e6, maxRss: usage.maxRSS * 1024 },
    environmentVariables: { ...p.env },
    sharedObjects: [],
  };
}

define("report", {
  directory: "",
  filename: "",
  compact: false,
  excludeNetwork: false,
  signal: "SIGUSR2",
  reportOnFatalError: false,
  reportOnSignal: false,
  reportOnUncaughtException: false,
  excludeEnv: false,
  getReport,
  /* the report as JSON to a file: the name given, or Node's report.<date>.<time>.<pid>.0.001.json */
  writeReport(file, err) {
    if (typeof file === "object" && file !== null) [file, err] = [undefined, file];
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    file ??= `report.${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}` +
      `${pad(now.getSeconds())}.${p.pid}.0.001.json`;
    const path = this.directory ? `${this.directory}/${file}` : file;
    const r = fsWriteFile(path, JSON.stringify(getReport(err), null, this.compact ? 0 : 2), false);
    if (typeof r === "number" && r < 0) throw systemError(r, "open", path);
    return file;
  },
});
