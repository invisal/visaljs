// fs.watch, fs.watchFile and unwatchFile, and fs/promises' watch, as Node's
// lib/internal/fs/watchers.js and lib/fs.js: FSWatcher on libuv's file system events (inotify,
// kqueue, …), StatWatcher on its stat poller, and the `ignore` option (glob patterns, regular
// expressions, functions). A recursive watch on Linux is Node's lib/internal/fs/recursive_watch.js
// (libuv can't watch a tree there): a watcher for each file and directory. Linked into programs
// that name them (internal/features.js).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { errnoMessage, errnoName, fsPollStart, fsWatchClose, fsWatchRef, fsWatchStart } from "visaljs:host";
import { EventEmitter } from "../events.js";
import { readdirSync, statSync } from "../fs.js";
import { basename, join, relative, resolve, sep } from "../path.js";
import { isRegExp } from "../util_types.js";
import { feature, features } from "./features.js";
import { copyObject, getOptions, getValidatedPath } from "./fs_utils.js";
import { statsFrom } from "./fs_stats.js";
import { AbortError, codes } from "./streams/errors.js";
import {
  kEmptyObject, validateAbortSignal, validateBoolean, validateFunction, validateInteger, validateObject, validateOneOf, validateUint32,
} from "./streams/validators.js";

const { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE } = codes;
const isWindows = process.platform === "win32";
const isMacOS = process.platform === "darwin";
const UV_RENAME = 1;

/* UVException's: "ENOENT: no such file or directory, watch '<path>'", with `filename` too */
function watchError(errno, path, message = "") {
  const code = errnoName(errno);
  const text = message || errnoMessage(errno);
  const error = new Error(`${code}: ${text}, watch${path == null ? "" : ` '${path}'`}`);
  Object.assign(error, { errno, code, syscall: "watch" });
  if (path != null) error.path = path;
  error.filename = path;
  return error;
}

const ERR_FS_WATCH_QUEUE_OVERFLOW = (max) =>
  Object.assign(new Error(`fs.watch() queued more than ${max} events`), { code: "ERR_FS_WATCH_QUEUE_OVERFLOW" });

/* ---- the ignore option ----------------------------------------------------------------------- */

function validateIgnoreOptionElement(value, name) {
  if (typeof value === "string") {
    if (value.length === 0) throw new ERR_INVALID_ARG_VALUE(name, value, "must be a non-empty string");
    return;
  }
  if (isRegExp(value)) return;
  if (typeof value === "function") return;
  throw new ERR_INVALID_ARG_TYPE(name, ["string", "RegExp", "Function"], value);
}

function validateIgnoreOption(value, name) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) validateIgnoreOptionElement(value[i], `${name}[${i}]`);
    return;
  }
  validateIgnoreOptionElement(value, name);
}

/* a glob pattern's matcher, as Node's minimatch options: matchBase (a pattern without a slash is
 * matched against the basename), case-insensitive on Windows and macOS */
function globMatcher(pattern) {
  const nocase = isWindows || isMacOS;
  const p = nocase ? pattern.toLowerCase() : pattern;
  const matchBase = !p.includes("/");
  return (filename) => {
    let f = nocase ? filename.toLowerCase() : filename;
    if (matchBase) f = basename(f);
    return feature("matchesGlob")(f, p);  /* fs_glob.js, linked for a watch with ignore */
  };
}

/** A function telling whether a filename is ignored, or null without the option. */
export function createIgnoreMatcher(ignore) {
  if (ignore == null) return null;
  const matchers = Array.isArray(ignore) ? ignore : [ignore];
  const compiled = [];
  for (const matcher of matchers) {
    if (typeof matcher === "string") compiled.push(globMatcher(matcher));
    else if (isRegExp(matcher)) compiled.push((filename) => matcher.exec(filename) !== null);
    else compiled.push(matcher);
  }
  return (filename) => {
    for (let i = 0; i < compiled.length; i++) {
      if (compiled[i](filename)) return true;
    }
    return false;
  };
}

/* a name from the host (UTF-8) in the watcher's encoding, as Node's binding encodes it */
function encodeName(name, encoding) {
  if (name == null) return name;
  if (encoding === "buffer") return Buffer.from(name);
  if (!encoding || encoding === "utf8" || encoding === "utf-8") return name;
  return Buffer.from(name).toString(encoding);
}

/* ---- FSWatcher -------------------------------------------------------------------------------- */

const kFSWatchStart = Symbol("kFSWatchStart");
const kHandle = Symbol("kHandle");  /* the host's watcher id: null closed, -1 not started */

export class FSWatcher extends EventEmitter {
  [kHandle] = -1;
  _ignoreMatcher = null;
  #encoding;

  #onchange(status, filename) {
    if (status < 0) {
      if (this[kHandle] !== null) {
        // We don't use this.close() here to avoid firing the close event.
        if (this[kHandle] >= 0) fsWatchClose(this[kHandle]);
        this[kHandle] = null;
      }
      this.emit("error", watchError(status, filename));
      return;
    }
    filename = encodeName(filename, this.#encoding);
    // Filter events if ignore matcher is set and filename is available
    if (filename != null && this._ignoreMatcher?.(filename)) return;
    this.emit("change", status & UV_RENAME ? "rename" : "change", filename);
  }

  [kFSWatchStart](filename, persistent, recursive, encoding, ignore, throwIfNoEntry = true) {
    if (this[kHandle] === null) return;  // closed
    if (this[kHandle] >= 0) return;  // already started
    filename = getValidatedPath(filename, "filename");
    // Validate and create the ignore matcher
    validateIgnoreOption(ignore, "options.ignore");
    this._ignoreMatcher = createIgnoreMatcher(ignore);
    this.#encoding = encoding;
    const id = fsWatchStart(filename, recursive, (status, name) => this.#onchange(status, name));
    if (id < 0) {
      if (!throwIfNoEntry && errnoName(id) === "ENOENT") return;
      throw watchError(id, filename, errnoName(id) === "ENOSPC" ? "System limit for number of file watchers reached" : "");
    }
    this[kHandle] = id;
    if (!persistent) fsWatchRef(id, false);
  }

  // A no-op, as Node's (backward compatibility).
  start() {}

  close() {
    if (this[kHandle] === null) return;  // closed
    if (this[kHandle] < 0) return;  // not started
    fsWatchClose(this[kHandle]);
    this[kHandle] = null;
    process.nextTick(() => this.emit("close"));
  }

  ref() {
    if (this[kHandle] >= 0) fsWatchRef(this[kHandle], true);
    return this;
  }

  unref() {
    if (this[kHandle] >= 0) fsWatchRef(this[kHandle], false);
    return this;
  }
}

/* ---- the recursive watcher on Linux: lib/internal/fs/recursive_watch.js ------------------------- */

class RecursiveFSWatcher extends EventEmitter {
  #options = null;
  #closed = false;
  #files = new Map();
  #watchers = new Map();
  #symbolicFiles = new Set();
  #rootPath = resolve();
  #watchingFile = false;
  #ignoreMatcher = null;

  constructor(options = kEmptyObject) {
    super();
    const { persistent, recursive, signal, encoding, ignore } = options;
    let { throwIfNoEntry } = options;
    if (recursive != null) validateBoolean(recursive, "options.recursive");
    if (persistent != null) validateBoolean(persistent, "options.persistent");
    if (signal != null) validateAbortSignal(signal, "options.signal");
    if (throwIfNoEntry != null) validateBoolean(throwIfNoEntry, "options.throwIfNoEntry");
    else throwIfNoEntry = true;
    if (encoding != null && typeof encoding !== "string") throw new ERR_INVALID_ARG_VALUE("options.encoding", encoding);
    validateIgnoreOption(ignore, "options.ignore");
    this.#ignoreMatcher = createIgnoreMatcher(ignore);
    this.#options = { persistent, recursive, signal, encoding, throwIfNoEntry };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const file of this.#files.keys()) {
      this.#watchers.get(file)?.close();
      this.#watchers.delete(file);
    }
    this.#files.clear();
    this.#symbolicFiles.clear();
    this.emit("close");
  }

  #unwatchFiles(file) {
    this.#symbolicFiles.delete(file);
    const childPrefix = file + sep;
    for (const filename of this.#files.keys()) {
      if (filename === file || filename.startsWith(childPrefix)) {
        this.#files.delete(filename);
        this.#watchers.get(filename)?.close();
        this.#watchers.delete(filename);
      }
    }
  }

  #watchFolder(folder) {
    try {
      const files = readdirSync(folder, { withFileTypes: true });
      for (const file of files) {
        if (this.#closed) break;
        const f = join(folder, file.name);
        const relativePath = relative(this.#rootPath, f);
        if (this.#ignoreMatcher?.(relativePath)) continue;
        if (!this.#files.has(f)) {
          this.emit("change", "rename", relativePath);
          if (file.isSymbolicLink()) this.#symbolicFiles.add(f);
          try {
            this.#watchFile(f);
            if (file.isDirectory() && !file.isSymbolicLink()) this.#watchFolder(f);
          } catch (err) {
            if (err.code !== "ENOENT") throw err;
          }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.emit("error", error);
    }
  }

  #watchFile(file) {
    if (this.#closed) return;
    if (this.#files.has(file)) return;
    this.#files.set(file, statSync(file));
    const watcher = watch(file, { persistent: this.#options.persistent }, () => {
      const existingStat = this.#files.get(file);
      let currentStats;
      try {
        currentStats = statSync(file);
        this.#files.set(file, currentStats);
      } catch {
        // (the file is gone)
      }
      if (currentStats === undefined || (currentStats.birthtimeMs === 0 && existingStat.birthtimeMs !== 0)) {
        this.#files.delete(file);
        this.#watchers.delete(file);
        watcher.close();
        this.emit("change", "rename", relative(this.#rootPath, file));
        this.#unwatchFiles(file);
      } else if (file === this.#rootPath && this.#watchingFile) {
        this.emit("change", "change", basename(file));
      } else if (this.#symbolicFiles.has(file)) {
        this.emit("change", "rename", relative(this.#rootPath, file));
      } else if (currentStats.isDirectory()) {
        this.#watchFolder(file);
      } else {
        this.emit("change", "change", relative(this.#rootPath, file));
      }
    });
    this.#watchers.set(file, watcher);
  }

  [kFSWatchStart](filename) {
    filename = resolve(getValidatedPath(filename));
    try {
      const file = statSync(filename);
      this.#rootPath = filename;
      this.#closed = false;
      this.#watchingFile = file.isFile();
      this.#watchFile(filename);
      if (file.isDirectory()) this.#watchFolder(filename);
    } catch (error) {
      if (!this.#options.throwIfNoEntry && error.code === "ENOENT") {
        error.filename = filename;
        throw error;
      }
    }
  }

  /* (Node's: its files' stats, not watchers, so these change nothing) */
  ref() {}
  unref() {}

  [Symbol.asyncIterator]() {
    const { signal } = this.#options;
    const promiseExecutor = signal == null ?
      (res) => {
        this.once("change", (eventType, filename) => res({ __proto__: null, value: { eventType, filename } }));
      } :
      (res, reject) => {
        const onAbort = () => {
          this.close();
          reject(new AbortError(undefined, { cause: signal.reason }));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        this.once("change", (eventType, filename) => {
          signal.removeEventListener("abort", onAbort);
          res({ __proto__: null, value: { eventType, filename } });
        });
      };
    return {
      next: () => (this.#closed ? { __proto__: null, done: true } : new Promise(promiseExecutor)),
      return: () => {
        this.close();
        return { __proto__: null, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

/* ---- fs.watch ---------------------------------------------------------------------------------- */

/** watch(filename[, options][, listener]): an FSWatcher, its 'change' events (eventType, filename). */
function watch(filename, options, listener) {
  if (typeof options === "function") listener = options;
  options = getOptions(options);
  // Don't make changes directly on options object
  options = copyObject(options);
  if (options.persistent === undefined) options.persistent = true;
  if (options.recursive === undefined) options.recursive = false;
  if (options.throwIfNoEntry === undefined) options.throwIfNoEntry = true;

  let watcher;
  const path = getValidatedPath(filename);
  if (options.recursive && !isMacOS && !isWindows) {
    watcher = new RecursiveFSWatcher(options);
    watcher[kFSWatchStart](path);
  } else {
    watcher = new FSWatcher();
    watcher[kFSWatchStart](path, options.persistent, options.recursive, options.encoding, options.ignore, options.throwIfNoEntry);
  }

  if (listener) watcher.addListener("change", listener);
  if (options.signal) {
    if (options.signal.aborted) {
      process.nextTick(() => watcher.close());
    } else {
      const onAbort = () => watcher.close();
      options.signal.addEventListener("abort", onAbort, { once: true });
      watcher.once("close", () => options.signal.removeEventListener("abort", onAbort));
    }
  }
  return watcher;
}

/* ---- fs.watchFile ------------------------------------------------------------------------------ */

const kOldStatus = Symbol("kOldStatus");
const kUseBigint = Symbol("kUseBigint");
const kFSStatWatcherStart = Symbol("kFSStatWatcherStart");
const KFSStatWatcherRefCount = Symbol("KFSStatWatcherRefCount");
const KFSStatWatcherMaxRefCount = Symbol("KFSStatWatcherMaxRefCount");
const kFSStatWatcherAddOrCleanRef = Symbol("kFSStatWatcherAddOrCleanRef");
const NLINK = 8;  /* fsStat's array: nlink's index */

export function StatWatcher(bigint) {
  EventEmitter.call(this);
  this._handle = null;
  this[kOldStatus] = -1;
  this[kUseBigint] = bigint;
  this[KFSStatWatcherRefCount] = 1;
  this[KFSStatWatcherMaxRefCount] = 1;
}
Object.setPrototypeOf(StatWatcher.prototype, EventEmitter.prototype);
Object.setPrototypeOf(StatWatcher, EventEmitter);

/* the host's callback: the status (0, or -errno while the file is missing) and both stats */
function onchange(self, newStatus, current, previous) {
  if (self[kOldStatus] === -1 && newStatus === -1 && current[NLINK] === previous[NLINK]) return;
  self[kOldStatus] = newStatus;
  self.emit("change", statsFrom(current, self[kUseBigint]), statsFrom(previous, self[kUseBigint]));
}

StatWatcher.prototype[kFSStatWatcherStart] = function (filename, persistent, interval) {
  if (this._handle !== null) return;
  // (the poll is started below, once the arguments are checked)
  this[kOldStatus] = -1;
  filename = getValidatedPath(filename, "filename");
  validateUint32(interval, "interval");
  // Coerce -0 to +0.
  interval += 0;
  const id = fsPollStart(filename, interval, (status, current, previous) => onchange(this, status, current, previous));
  if (id < 0) {
    const error = watchError(id, filename);
    error.filename = filename;
    throw error;
  }
  this._handle = id;
  if (!persistent) this.unref();
};

// A no-op, as Node's (backward compatibility).
StatWatcher.prototype.start = () => {};

StatWatcher.prototype.stop = function () {
  if (this._handle === null) return;
  process.nextTick(() => this.emit("stop"));
  fsWatchClose(this._handle);
  this._handle = null;
};

StatWatcher.prototype[kFSStatWatcherAddOrCleanRef] = function (operate) {
  if (operate === "add") {
    this[KFSStatWatcherRefCount]++;
    this[KFSStatWatcherMaxRefCount]++;
  } else if (operate === "clean") {
    this[KFSStatWatcherMaxRefCount]--;
    this.unref();
  } else if (operate === "cleanAll") {
    this[KFSStatWatcherMaxRefCount] = 0;
    this[KFSStatWatcherRefCount] = 0;
    if (this._handle !== null) fsWatchRef(this._handle, false);
  }
};

StatWatcher.prototype.ref = function () {
  // Avoid refCount calling ref multiple times causing unref to have no effect.
  if (this[KFSStatWatcherRefCount] === this[KFSStatWatcherMaxRefCount]) return this;
  if (this._handle !== null && this[KFSStatWatcherRefCount]++ === 0) fsWatchRef(this._handle, true);
  return this;
};

StatWatcher.prototype.unref = function () {
  // Avoid refCount calling unref multiple times causing ref to have no effect.
  if (this[KFSStatWatcherRefCount] === 0) return this;
  if (this._handle !== null && --this[KFSStatWatcherRefCount] === 0) fsWatchRef(this._handle, false);
  return this;
};

/* one StatWatcher per file, as Node's: its listeners are watchFile's */
const statWatchers = new Map();

/** watchFile(filename[, options], listener(current, previous)): Stats polled every interval ms. */
function watchFile(filename, options, listener) {
  filename = getValidatedPath(filename);
  filename = resolve(filename);
  if (options === null || typeof options !== "object") {
    listener = options;
    options = null;
  }
  options = {
    // Poll interval in milliseconds. 5007 is what libev used to use.
    interval: 5007,
    persistent: true,
    ...options,
  };
  validateFunction(listener, "listener");
  let stat = statWatchers.get(filename);
  if (stat === undefined) {
    stat = new StatWatcher(options.bigint);
    stat[kFSStatWatcherStart](filename, options.persistent, options.interval);
    statWatchers.set(filename, stat);
  } else {
    stat[kFSStatWatcherAddOrCleanRef]("add");
  }
  stat.addListener("change", listener);
  return stat;
}

/** unwatchFile(filename[, listener]): that listener, or all; the poller stops with the last. */
function unwatchFile(filename, listener) {
  filename = getValidatedPath(filename);
  filename = resolve(filename);
  const stat = statWatchers.get(filename);
  if (stat === undefined) return;
  if (typeof listener === "function") {
    const beforeListenerCount = stat.listenerCount("change");
    stat.removeListener("change", listener);
    if (stat.listenerCount("change") < beforeListenerCount) stat[kFSStatWatcherAddOrCleanRef]("clean");
  } else {
    stat.removeAllListeners("change");
    stat[kFSStatWatcherAddOrCleanRef]("cleanAll");
  }
  if (stat.listenerCount("change") === 0) {
    stat.stop();
    statWatchers.delete(filename);
  }
}

/* ---- fs/promises' watch -------------------------------------------------------------------- */

async function* watchNative(filename, options = kEmptyObject) {
  const path = getValidatedPath(filename);
  validateObject(options, "options");
  const { persistent = true, recursive = false, encoding = "utf8", maxQueue = 2048, overflow = "ignore", signal, ignore } = options;
  validateBoolean(persistent, "options.persistent");
  validateBoolean(recursive, "options.recursive");
  validateInteger(maxQueue, "options.maxQueue");
  validateOneOf(overflow, "options.overflow", ["ignore", "error"]);
  validateAbortSignal(signal, "options.signal");
  validateIgnoreOption(ignore, "options.ignore");
  if (encoding && !Buffer.isEncoding(encoding)) throw new ERR_INVALID_ARG_VALUE("encoding", encoding, "is invalid encoding");
  if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });

  let id = -1;
  const close = () => {
    if (id >= 0) fsWatchClose(id);
    id = -1;
  };
  const ignoreMatcher = createIgnoreMatcher(ignore);
  let { promise, resolve: wake } = Promise.withResolvers();
  const queue = [];
  const oncancel = () => {
    close();
    wake();
  };

  try {
    if (signal) signal.addEventListener("abort", oncancel, { once: true });
    id = fsWatchStart(path, recursive, (status, name) => {
      if (status < 0) {
        close();
        queue.push(watchError(status, name));
        wake();
        return;
      }
      const filename = encodeName(name, encoding);
      // Filter events if ignore matcher is set and filename is available
      if (filename != null && ignoreMatcher?.(filename)) return;
      const eventType = status & UV_RENAME ? "rename" : "change";
      if (queue.length < maxQueue) {
        queue.push({ __proto__: null, eventType, filename });
        wake();
      } else if (overflow === "error") {
        queue.length = 0;
        queue.push(ERR_FS_WATCH_QUEUE_OVERFLOW(maxQueue));
        wake();
      } else {
        process.emitWarning("fs.watch maxQueue exceeded");
      }
    });
    if (id < 0) {
      const error = watchError(id, filename, errnoName(id) === "ENOSPC" ? "System limit for number of file watchers reached" : "");
      id = -1;
      throw error;
    }
    if (!persistent) fsWatchRef(id, false);

    while (!signal?.aborted) {
      await promise;
      while (queue.length) {
        const item = queue.shift();
        if (item instanceof Error) throw item;
        yield item;
      }
      ({ promise, resolve: wake } = Promise.withResolvers());
    }
    if (signal?.aborted) throw new AbortError(undefined, { cause: signal?.reason });
  } finally {
    close();
    signal?.removeEventListener("abort", oncancel);
  }
}

/* lib/internal/fs/promises.js' watch: a recursive one on Linux is the recursive watcher's */
async function* watchPromise(filename, options = kEmptyObject) {
  const { recursive = false } = options;
  if (recursive && !isMacOS && !isWindows) {
    const watcher = new RecursiveFSWatcher(options);
    watcher[kFSWatchStart](filename);
    yield* watcher;
    return;
  }
  yield* watchNative(filename, options);
}

Object.assign(features, { watch, watchFile, unwatchFile, watchPromise });
