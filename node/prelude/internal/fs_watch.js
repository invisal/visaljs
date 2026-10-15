// fs.watch (FSWatcher, on libuv's file system events: inotify, kqueue, …), fs.watchFile and
// unwatchFile (StatWatcher, on libuv's stat poller), and fs/promises' watch (an async iterator), as
// Node's. Linked into programs that name them (internal/features.js).
import { fsPollStart, fsWatchClose, fsWatchRef, fsWatchStart } from "visaljs:host";
import { EventEmitter } from "../events.js";
import { statsFrom } from "../fs.js";
import { resolve } from "../path.js";
import { codeError, invalidArgType, systemError } from "./errors.js";
import { features } from "./features.js";
import { getValidatedPath } from "./fs_utils.js";

const UV_RENAME = 1;

/* a path as Node's getValidatedPath checks it (named "path", as Node's watch functions name it) */
const pathOf = (value) => getValidatedPath(value);

/* fsStat's array as Stats */
const statsOf = (a) => statsFrom(a, false);

/* ---- fs.watch ----------------------------------------------------------------------------------- */

export class FSWatcher extends EventEmitter {
  #id = -1;
  #encoding;

  constructor() {
    super();
  }

  _start(filename, persistent, recursive, encoding) {
    this.#encoding = encoding;
    const id = fsWatchStart(filename, recursive, (events, name) => this.#onEvent(events, name));
    if (id < 0) throw systemError(id, "watch", filename);
    this.#id = id;
    if (!persistent) fsWatchRef(id, false);
  }

  #onEvent(events, name) {
    if (events < 0) {
      const err = systemError(events, "watch");
      this.close();
      this.emit("error", err);
      return;
    }
    const filename = name === null ? null : this.#encoding === "buffer" ? Buffer.from(name) : name;
    this.emit("change", events & UV_RENAME ? "rename" : "change", filename);
  }

  close() {
    if (this.#id < 0) return;
    fsWatchClose(this.#id);
    this.#id = -1;
    process.nextTick(() => this.emit("close"));
  }

  ref() {
    if (this.#id >= 0) fsWatchRef(this.#id, true);
    return this;
  }

  unref() {
    if (this.#id >= 0) fsWatchRef(this.#id, false);
    return this;
  }
}

function watchOptions(options) {
  if (typeof options === "string") options = { encoding: options };
  else if (options === undefined || options === null) options = {};
  else if (typeof options !== "object") throw invalidArgType("options", "of type object", options);
  const { persistent = true, recursive = false, encoding = "utf8", signal } = options;
  if (typeof persistent !== "boolean") throw invalidArgType("options.persistent", "of type boolean", persistent);
  if (typeof recursive !== "boolean") throw invalidArgType("options.recursive", "of type boolean", recursive);
  return { persistent, recursive, encoding, signal };
}

/** watch(filename[, options][, listener]): an FSWatcher, its 'change' events (eventType, filename). */
function watch(filename, options, listener) {
  if (typeof options === "function") [options, listener] = [undefined, options];
  const path = pathOf(filename, "filename");
  const { persistent, recursive, encoding, signal } = watchOptions(options);
  const watcher = new FSWatcher();
  watcher._start(path, persistent, recursive, encoding);
  if (listener) watcher.addListener("change", listener);
  if (signal) {
    if (signal.aborted) process.nextTick(() => watcher.close());
    else signal.addEventListener("abort", () => watcher.close(), { once: true });
  }
  return watcher;
}

/* ---- fs.watchFile ------------------------------------------------------------------------------ */

export class StatWatcher extends EventEmitter {
  #id = -1;
  #lastStatus = 0;

  constructor(bigint) {
    super();
    if (bigint) throw codeError(Error, "ERR_VISALJS_UNSUPPORTED", "fs.watchFile's bigint option is not supported by visaljs yet");
  }

  _start(filename, persistent, interval) {
    const id = fsPollStart(filename, interval, (status, current, previous) => {
      /* the file still missing, as before: nothing new (Node's) */
      if (status < 0 && this.#lastStatus < 0) return;
      this.#lastStatus = status;
      this.emit("change", statsOf(current), statsOf(previous));
    });
    if (id < 0) throw systemError(id, "watch", filename);
    this.#id = id;
    if (!persistent) fsWatchRef(id, false);
  }

  stop() {
    if (this.#id < 0) return;
    fsWatchClose(this.#id);
    this.#id = -1;
    process.nextTick(() => this.emit("stop"));
  }

  ref() {
    if (this.#id >= 0) fsWatchRef(this.#id, true);
    return this;
  }

  unref() {
    if (this.#id >= 0) fsWatchRef(this.#id, false);
    return this;
  }
}

/* one StatWatcher per file, as Node's: its listeners are watchFile's */
const statWatchers = new Map();

/** watchFile(filename[, options], listener(current, previous)): Stats polled every interval ms. */
function watchFile(filename, options, listener) {
  if (typeof options === "function") [options, listener] = [undefined, options];
  const path = resolve(pathOf(filename, "filename"));
  options = { interval: 5007, persistent: true, ...options };
  if (typeof listener !== "function") throw invalidArgType("listener", "of type function", listener);
  let watcher = statWatchers.get(path);
  if (watcher === undefined) {
    watcher = new StatWatcher(options.bigint);
    watcher._start(path, options.persistent, options.interval);
    statWatchers.set(path, watcher);
  }
  watcher.addListener("change", listener);
  return watcher;
}

/** unwatchFile(filename[, listener]): that listener, or all; the poller stops with the last. */
function unwatchFile(filename, listener) {
  const path = resolve(pathOf(filename, "filename"));
  const watcher = statWatchers.get(path);
  if (watcher === undefined) return;
  if (typeof listener === "function") watcher.removeListener("change", listener);
  else watcher.removeAllListeners("change");
  if (watcher.listenerCount("change") === 0) {
    watcher.stop();
    statWatchers.delete(path);
  }
}

/* ---- fs/promises' watch -------------------------------------------------------------------- */

/** watch(filename[, options]): the events as an async iterator of { eventType, filename }. */
function watchPromise(filename, options) {
  const opts = watchOptions(options);
  const path = pathOf(filename, "filename");
  const queue = [];
  const waiting = [];
  let done = false, error = null;
  const watcher = new FSWatcher();
  watcher._start(path, opts.persistent, opts.recursive, opts.encoding);
  const settle = () => {
    while (waiting.length && (queue.length || done || error)) {
      const { resolve: res, reject } = waiting.shift();
      if (queue.length) res({ value: queue.shift(), done: false });
      else if (error) reject(error);
      else res({ value: undefined, done: true });
    }
  };
  watcher.on("change", (eventType, name) => {
    queue.push({ eventType, filename: name });
    settle();
  });
  watcher.on("error", (err) => {
    error = err;
    settle();
  });
  const finish = () => {
    if (done) return;
    done = true;
    watcher.close();
    settle();
  };
  if (opts.signal) {
    const abort = () => {
      error = Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: opts.signal.reason });
      finish();
    };
    if (opts.signal.aborted) abort();
    else opts.signal.addEventListener("abort", abort, { once: true });
  }
  return {
    next: () => new Promise((res, reject) => {
      waiting.push({ resolve: res, reject });
      settle();
    }),
    return: () => {
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

Object.assign(features, { watch, watchFile, unwatchFile, watchPromise });
