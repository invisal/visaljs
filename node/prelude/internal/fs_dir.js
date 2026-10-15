// fs.Dir, opendir and opendirSync: a directory's entries as Dirents, one read at a time (and, with
// recursive, its subdirectories' after them, as Node's). Linked into programs that name them
// (internal/features.js).
import { fsReaddir } from "visaljs:host";
import { Dir as DirWrapper, Dirent } from "../fs.js";
import { codeError, systemError, validateFunction } from "./errors.js";
import { features, provideClass } from "./features.js";
import { getOptions, getValidatedPath } from "./fs_utils.js";
import { codes } from "./streams/errors.js";
import { validateUint32 } from "./streams/validators.js";

const closed = () => codeError(Error, "ERR_DIR_CLOSED", "Directory handle was closed");

/* a directory's entries now: [name, type, …] as Dirents of that directory */
function entriesOf(path) {
  const r = fsReaddir(path);
  if (typeof r === "number") {
    const e = systemError(r, "opendir");  /* Node's message names the call, not the path */
    e.path = path;
    throw e;
  }
  const entries = [];
  for (let i = 0; i < r.length; i += 2) entries.push(new Dirent(r[i], r[i + 1], path));
  return entries;
}

class Dir {
  #path;
  #entries;
  #queue = [];      /* subdirectories to read next (recursive) */
  #recursive;
  #closed = false;
  #busy = false;

  constructor(path, entries, options) {
    /* Node's takes the directory's handle first: a program can't make one */
    if (path == null) throw codeError(TypeError, "ERR_MISSING_ARGS", 'The "handle" argument must be specified');
    this.#path = path;
    this.#entries = entries;
    this.#recursive = Boolean(options?.recursive);
    validateUint32({ bufferSize: 32, ...options }.bufferSize, "options.bufferSize", true);  /* as Node's: a given null too */
  }

  get path() {
    if (!(#path in this)) throw new codes.ERR_INVALID_THIS("Dir");
    return this.#path;
  }

  /** The next entry, or null at the end. */
  readSync() {
    if (this.#closed) throw closed();
    if (this.#busy) throw codeError(Error, "ERR_DIR_CONCURRENT_OPERATION", "Cannot do synchronous work on directory handle with concurrent asynchronous operations");
    return this.#next();
  }

  #next() {
    for (;;) {
      const dirent = this.#entries.shift();
      if (dirent !== undefined) {
        /* links aren't followed, as Node's */
        if (this.#recursive && dirent.isDirectory()) this.#queue.push(`${dirent.parentPath}/${dirent.name}`);
        return dirent;
      }
      if (this.#queue.length === 0) return null;
      this.#entries = entriesOf(this.#queue.shift());
    }
  }

  /** read([callback]): the next entry, or null, as a promise or to the callback. */
  read(callback) {
    if (callback !== undefined) {
      validateFunction(callback, "callback");
      return this.#later(() => this.#next(), callback);
    }
    return this.#promise(() => this.#next());
  }

  closeSync() {
    if (this.#closed) throw closed();
    if (this.#busy) throw codeError(Error, "ERR_DIR_CONCURRENT_OPERATION", "Cannot do synchronous work on directory handle with concurrent asynchronous operations");
    this.#closed = true;
    this.#entries = [];
    this.#queue = [];
  }

  close(callback) {
    if (callback !== undefined) {
      validateFunction(callback, "callback");
      return this.#later(() => this.closeSync(), callback);
    }
    return this.#promise(() => this.closeSync());
  }

  /* an operation on a later tick, as Node's on the thread pool: the handle is busy until then */
  #later(fn, callback) {
    if (this.#closed) {
      process.nextTick(callback, closed());
      return;
    }
    this.#busy = true;
    process.nextTick(() => {
      this.#busy = false;
      let result, error = null;
      try {
        result = fn();
      } catch (e) {
        error = e;
      }
      if (error) callback(error);
      else callback(null, result);
    });
  }

  #promise(fn) {
    return new Promise((resolve, reject) => this.#later(fn, (err, result) => (err ? reject(err) : resolve(result))));
  }

  /** The entries, then the directory closed. */
  async *entries() {
    try {
      for (;;) {
        const dirent = await this.read();
        if (dirent === null) break;
        yield dirent;
      }
    } finally {
      if (!this.#closed) this.closeSync();
    }
  }

  [Symbol.asyncIterator]() {
    return this.entries();
  }

  [Symbol.dispose ?? Symbol.for("nodejs.dispose")]() {
    if (!this.#closed) this.closeSync();
  }

  async [Symbol.asyncDispose ?? Symbol.for("nodejs.asyncDispose")]() {
    if (!this.#closed) this.closeSync();
  }
}

function opendirSync(path, options) {
  path = getValidatedPath(path);
  options = getOptions(options, { encoding: "utf8" });
  return new Dir(path, entriesOf(path), options);
}

/* the arguments checked now, as Node's; the directory opened, then the Dir made, on a later tick */
function opendir(path, options, callback) {
  callback = typeof options === "function" ? options : callback;
  validateFunction(callback, "callback");
  path = getValidatedPath(path);
  options = getOptions(options, { encoding: "utf8" });
  let entries, error = null;
  try {
    entries = entriesOf(path);
  } catch (e) {
    error = e;
  }
  process.nextTick(() => (error ? callback(error) : callback(null, new Dir(path, entries, options))));
}

Object.assign(features, { opendirSync, opendir, opendirPromise: async (path, options) => opendirSync(path, options) });
provideClass(DirWrapper, Dir);
