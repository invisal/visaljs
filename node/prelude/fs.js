// node:fs: the synchronous file API, over the host primitives, and the callback API over it.
// Arguments are checked as Node's lib/fs.js checks them, in its order, with its errors
// (internal/fs_utils.js): a callback function's errors in its arguments are thrown, as Node's,
// and only the operation's outcome reaches the callback, on a later tick, though the I/O itself
// happened synchronously (so do node:fs/promises'). Contents are Buffers without an encoding,
// else strings in any of Buffer's encodings.
import {
  errnoName, fsCall, fsClose, fsConstants, fsExists, fsMkdir, fsOpen, fsRead, fsReaddir, fsReadFile, fsRealpath, fsStat, fsUnlink, fsUtimes, fsWrite,
} from "visaljs:host";
import { systemError } from "./internal/errors.js";
import { lazyClass, lazyConstructor, lazyFunction } from "./internal/features.js";
import {
  copyObject, emitRecursiveRmdirWarning, getOptions, getValidatedFd, getValidatedPath, getValidMode, kIoMaxLength, kMaxUserId, parseFileMode,
  rmIsDirectory, stringToFlags, toUnixTimestamp, validateBufferArray, validateOffsetLengthRead, validateOffsetLengthWrite, validatePosition,
  validateRmdirOptions, validateRmOptionsShape, validateStringAfterArrayBufferView, warnOnNonPortableTemplate,
} from "./internal/fs_utils.js";
import { AbortError, codes } from "./internal/streams/errors.js";
import {
  kEmptyObject, validateBoolean, validateBuffer, validateFunction, validateInteger, validateObject, validateOneOf,
} from "./internal/streams/validators.js";
import { Stats, statsFrom } from "./internal/fs_stats.js";
import { dirname, resolve } from "./path.js";

const { ERR_FS_FILE_TOO_LARGE, ERR_INVALID_ARG_VALUE } = codes;

/* a file descriptor where a path may be (readFile, writeFile, appendFile) */
const isFd = (path) => path === (path | 0);

function isUtf8(encoding) {
  return encoding === "utf8" || encoding === "utf-8" || encoding === "UTF8" || encoding === "UTF-8";
}

function check(result, syscall, path) {
  if (typeof result === "number") throw systemError(result, syscall, path);
  return result;
}

/* a call that returns a number, an fd or a count, when it succeeds: negative is -errno */
function checkCount(result, syscall, path) {
  if (result < 0) throw systemError(result, syscall, path);
  return result;
}

/* a name as the encoding asks: a string, or a Buffer for "buffer" */
function encoded(name, encoding) {
  return encoding == null || isUtf8(encoding) ? name : encoding === "buffer" ? Buffer.from(name) : Buffer.from(name).toString(encoding);
}

/* ---- the callback API: the arguments checked, then the work, its outcome on a later tick ---- */

function makeCallback(cb) {
  validateFunction(cb, "cb");
  return cb;
}

/* the operation now, its result or error to the callback on a later turn of the event loop, as
 * Node's request completes (timers run between a stream's reads, as in Node) */
function defer(callback, fn, ...args) {
  let result, error = null;
  try {
    result = fn(...args);
  } catch (e) {
    error = e;
  }
  /* a call without a result gives the callback only its error (null), as Node's */
  setImmediate(() => (error ? callback(error) : result === undefined ? callback(null) : callback(null, result)));
}

function checkAborted(signal, callback) {
  if (signal?.aborted) {
    callback(new AbortError(undefined, { cause: signal.reason }));
    return true;
  }
  return false;
}

/* ---- open, close, read, write ------------------------------------------------------------ */

function doOpen(path, flags, mode) {
  return checkCount(fsOpen(path, flags, mode), "open", path);
}

export function openSync(path, flags, mode) {
  return doOpen(getValidatedPath(path), stringToFlags(flags), parseFileMode(mode, "mode", 0o666));
}

export function open(path, flags, mode, callback) {
  path = getValidatedPath(path);
  if (arguments.length < 3) {
    callback = flags;
    flags = "r";
    mode = 0o666;
  } else if (typeof mode === "function") {
    callback = mode;
    mode = 0o666;
  } else {
    mode = parseFileMode(mode, "mode", 0o666);
  }
  const flagsNumber = stringToFlags(flags);
  callback = makeCallback(callback);
  defer(callback, doOpen, path, flagsNumber, mode);
}

function doClose(fd) {
  check(fsClose(fd), "close");
}

export function closeSync(fd) {
  doClose(getValidatedFd(fd));
}

function defaultCloseCallback(err) {
  if (err != null) throw err;
}

export function close(fd, callback = defaultCloseCallback) {
  if (callback !== defaultCloseCallback) callback = makeCallback(callback);
  defer(callback, doClose, getValidatedFd(fd));
}

/* a position as the host takes it: -1 for the current one */
const hostPosition = (position) => (position == null || position === -1 ? -1 : Number(position));

function doRead(fd, buffer, offset, length, position) {
  return checkCount(fsRead(fd, buffer, offset, length, hostPosition(position)), "read");
}

/** readSync(fd, buffer, offset, length, position) or readSync(fd, buffer, { offset, length, position }):
 *  the bytes read, 0 at the end of the file. */
export function readSync(fd, buffer, offsetOrOptions, length, position) {
  fd = getValidatedFd(fd);
  validateBuffer(buffer);
  let offset = offsetOrOptions;
  if (arguments.length <= 3 || typeof offsetOrOptions === "object") {
    if (offsetOrOptions !== undefined && offsetOrOptions !== null) validateObject(offsetOrOptions, "options");
    ({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions ?? kEmptyObject);
  }
  if (offset === undefined) offset = 0;
  else validateInteger(offset, "offset", 0);
  length |= 0;
  if (position == null) position = -1;
  else validatePosition(position, "position", length);
  if (length === 0) return 0;
  if (buffer.byteLength === 0) throw new ERR_INVALID_ARG_VALUE("buffer", buffer, "is empty and cannot be written");
  validateOffsetLengthRead(offset, length, buffer.byteLength);
  return doRead(fd, buffer, offset, length, position);
}

/** read(fd, buffer, offset, length, position, callback), read(fd, buffer, options, callback),
 *  read(fd, options, callback) or read(fd, callback): the callback gets the bytes read and the buffer. */
export function read(fd, buffer, offsetOrOptions, length, position, callback) {
  fd = getValidatedFd(fd);
  let offset = offsetOrOptions;
  let params = null;
  if (arguments.length <= 4) {
    if (arguments.length === 4) {
      if (offsetOrOptions !== null) validateObject(offsetOrOptions, "options");
      callback = length;
      params = offsetOrOptions;
    } else if (arguments.length === 3) {
      if (!ArrayBuffer.isView(buffer)) {
        params = buffer;
        ({ buffer = Buffer.alloc(16384) } = params ?? kEmptyObject);
      }
      callback = offsetOrOptions;
    } else {
      callback = buffer;
      buffer = Buffer.alloc(16384);
    }
    if (params !== undefined && params !== null) validateObject(params, "options");
    ({ offset = 0, length = buffer?.byteLength - offset, position = null } = params ?? kEmptyObject);
  }
  validateBuffer(buffer);
  validateFunction(callback, "cb");
  if (offset == null) offset = 0;
  else validateInteger(offset, "offset", 0);
  length |= 0;
  if (position == null) position = -1;
  else validatePosition(position, "position", length);
  if (length === 0) return process.nextTick(() => callback(null, 0, buffer));
  if (buffer.byteLength === 0) throw new ERR_INVALID_ARG_VALUE("buffer", buffer, "is empty and cannot be written");
  validateOffsetLengthRead(offset, length, buffer.byteLength);
  defer((err, bytesRead) => callback(err, bytesRead || 0, buffer), doRead, fd, buffer, offset, length, position);
}

function doWrite(fd, buffer, offset, length, position) {
  return checkCount(fsWrite(fd, buffer, offset, length, typeof position === "number" ? position : -1), "write");
}

/* Node's validateEncoding: hex takes whole bytes */
function validateEncoding(data, encoding) {
  if (typeof encoding === "string" && encoding.toLowerCase() === "hex" && data.length % 2 !== 0) {
    throw new ERR_INVALID_ARG_VALUE("encoding", encoding, `is invalid for data of length ${data.length}`);
  }
}

/* a string's bytes in an encoding (an unknown one is UTF-8, as Node's binding takes it) */
const stringBytes = (string, encoding) => Buffer.from(string, typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8");

/** writeSync(fd, buffer, offset?, length?, position?) or writeSync(fd, string, position?, encoding?):
 *  the bytes written. A position that isn't a number writes at the current offset. */
export function writeSync(fd, buffer, offsetOrOptions, length, position) {
  fd = getValidatedFd(fd);
  let offset = offsetOrOptions;
  if (ArrayBuffer.isView(buffer)) {
    if (typeof offset === "object") {
      ({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions ?? kEmptyObject);
    }
    if (position === undefined) position = null;
    if (offset == null) offset = 0;
    else validateInteger(offset, "offset", 0);
    if (typeof length !== "number") length = buffer.byteLength - offset;
    validateOffsetLengthWrite(offset, length, buffer.byteLength);
    return doWrite(fd, buffer, offset, length, position);
  }
  validateStringAfterArrayBufferView(buffer, "buffer");
  validateEncoding(buffer, length);
  const bytes = stringBytes(buffer, length);
  return doWrite(fd, bytes, 0, bytes.length, offset);
}

/** write(fd, buffer, offset?, length?, position?, callback) or write(fd, string, position?,
 *  encoding?, callback): the callback gets the bytes written and the data. */
export function write(fd, buffer, offsetOrOptions, length, position, callback) {
  const wrapper = (err, written) => callback(err, written || 0, buffer);
  fd = getValidatedFd(fd);
  let offset = offsetOrOptions;
  if (ArrayBuffer.isView(buffer)) {
    callback ||= position || length || offset;
    validateFunction(callback, "cb");
    if (typeof offset === "object") {
      ({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions ?? kEmptyObject);
    }
    if (offset == null || typeof offset === "function") offset = 0;
    else validateInteger(offset, "offset", 0);
    if (typeof length !== "number") length = buffer.byteLength - offset;
    if (typeof position !== "number") position = null;
    validateOffsetLengthWrite(offset, length, buffer.byteLength);
    return defer(wrapper, doWrite, fd, buffer, offset, length, position);
  }
  validateStringAfterArrayBufferView(buffer, "buffer");
  if (typeof position !== "function") {
    if (typeof offset === "function") {
      position = offset;
      offset = null;
    } else {
      position = length;
    }
    length = "utf8";
  }
  validateEncoding(buffer, length);
  callback = position;
  validateFunction(callback, "cb");
  const bytes = stringBytes(buffer, length);
  defer(wrapper, doWrite, fd, bytes, 0, bytes.length, offset);
}

/* the buffers, in turn, from a position (or the current offset): the bytes moved */
function vectored(fn, syscall, fd, buffers, position) {
  let total = 0;
  let at = typeof position === "number" ? position : -1;
  for (const buffer of buffers) {
    const n = checkCount(fn(fd, buffer, 0, buffer.byteLength, at), syscall);
    total += n;
    if (at >= 0) at += n;
    if (n < buffer.byteLength) break;  /* the end of the file */
  }
  return total;
}

/** readvSync(fd, buffers[, position]): the bytes read into the buffers, in turn. */
export function readvSync(fd, buffers, position) {
  fd = getValidatedFd(fd);
  validateBufferArray(buffers);
  return vectored(fsRead, "read", fd, buffers, position);
}

/** writevSync(fd, buffers[, position]): the bytes written from the buffers, in turn. */
export function writevSync(fd, buffers, position) {
  fd = getValidatedFd(fd);
  validateBufferArray(buffers);
  if (buffers.length === 0) return 0;
  return vectored(fsWrite, "write", fd, buffers, position);
}

export function readv(fd, buffers, position, callback) {
  fd = getValidatedFd(fd);
  validateBufferArray(buffers);
  callback ||= position;
  validateFunction(callback, "cb");
  defer((err, n) => callback(err, n || 0, buffers), vectored, fsRead, "read", fd, buffers, position);
}

export function writev(fd, buffers, position, callback) {
  fd = getValidatedFd(fd);
  validateBufferArray(buffers);
  callback ||= position;
  validateFunction(callback, "cb");
  if (buffers.length === 0) return process.nextTick(callback, null, 0, buffers);
  defer((err, n) => callback(err, n || 0, buffers), vectored, fsWrite, "write", fd, buffers, position);
}

/* ---- whole files ----------------------------------------------------------------------- */

/* a file's contents from an open descriptor: the size fstat gives (0 for what isn't a regular file:
 * read to the end) */
function readAll(fd) {
  const st = fsCall(FS_FSTAT, fd);
  const size = Array.isArray(st) && (st[0] & S_IFMT) === S_IFREG ? st[1] : 0;
  if (size > kIoMaxLength) throw new ERR_FS_FILE_TOO_LARGE(size);
  if (size !== 0) {
    const buffer = Buffer.allocUnsafe(size);
    let pos = 0, n;
    do {
      n = doRead(fd, buffer, pos, size - pos, -1);
      pos += n;
    } while (n !== 0 && pos < size);
    return pos < size ? buffer.subarray(0, pos) : buffer;
  }
  const chunks = [];
  let n;
  do {
    const chunk = Buffer.allocUnsafe(8192);
    n = doRead(fd, chunk, 0, 8192, -1);
    if (n !== 0) chunks.push(chunk.subarray(0, n));
  } while (n !== 0);
  return Buffer.concat(chunks);
}

/* readFile's work, its options checked: a path read with the host's readFile when opened for reading
 * (the common case), else opened and read, or an fd read from where it is */
function doReadFile(path, options) {
  const encoding = options.encoding;
  let contents;
  if (!isFd(path) && stringToFlags(options.flag) === O_RDONLY) {
    const asText = encoding != null && isUtf8(encoding);
    const result = fsReadFile(path, !asText);
    if (typeof result === "number") {
      const code = errnoName(result);
      /* opening a directory succeeds; reading it fails: Node reports that read, without a path */
      if (code === "EISDIR") throw systemError(result, "read");
      if (code === "EFBIG") throw new ERR_FS_FILE_TOO_LARGE(statSync(path).size);
    }
    contents = check(result, "open", path);
    if (asText) return contents;
  } else if (isFd(path)) {
    contents = readAll(path);
  } else {
    const fd = doOpen(path, stringToFlags(options.flag), 0o666);
    try {
      contents = readAll(fd);
    } finally {
      doClose(fd);
    }
  }
  return encoding == null || encoding === "buffer" ? contents : contents.toString(encoding);
}

export function readFileSync(path, options) {
  options = getOptions(options, { flag: "r" });
  if (!isFd(path)) path = getValidatedPath(path);
  return doReadFile(path, options);
}

export function readFile(path, options, callback) {
  callback ||= options;
  validateFunction(callback, "cb");
  options = getOptions(options, { flag: "r" });
  if (!isFd(path)) {
    if (checkAborted(options.signal, callback)) return;
    stringToFlags(options.flag, "options.flag");
    path = getValidatedPath(path);
  }
  /* on a later turn of the event loop, as Node's opens and reads on its thread pool: an abort before
   * then stops it */
  setImmediate(() => {
    if (checkAborted(options.signal, callback)) return;
    defer(callback, doReadFile, path, options);
  });
}

/* writeFile's work, its data as bytes or a string and its options checked. With `flush`, the file is
 * synced through fs.fsyncSync (a program may replace it, as Node's calls it); `keepOpen` leaves the
 * descriptor open and unsynced, returned for the callback API's fs.fsync. */
function doWriteFile(path, data, options, keepOpen = false) {
  const flag = options.flag || "w";
  const flush = options.flush ?? false;
  /* opened, written and closed: an error names the call that failed, as Node's */
  if (typeof data === "string") data = Buffer.from(data, options.encoding || "utf8");
  const userFd = isFd(path);
  const fd = userFd ? path : doOpen(path, stringToFlags(flag), parseFileMode(options.mode, "mode", 0o666));
  try {
    let offset = 0, length = data.byteLength;
    while (length > 0) {
      const written = doWrite(fd, data, offset, length, null);
      offset += written;
      length -= written;
    }
    if (keepOpen) return fd;
    if (flush) fs.fsyncSync(fd);
  } catch (e) {
    keepOpen = false;
    throw e;
  } finally {
    if (!userFd && !keepOpen) doClose(fd);
  }
}

const writeFileDefaults = { encoding: "utf8", mode: 0o666, flag: "w", flush: false };

export function writeFileSync(path, data, options) {
  options = getOptions(options, writeFileDefaults);
  validateBoolean(options.flush ?? false, "options.flush");
  if (!(typeof data === "string" && isUtf8(options.encoding))) {
    if (!ArrayBuffer.isView(data)) {
      validateStringAfterArrayBufferView(data, "data");
      data = Buffer.from(data, options.encoding || "utf8");
    }
  }
  if (!isFd(path)) path = getValidatedPath(path);
  doWriteFile(path, data, options);
}

export function writeFile(path, data, options, callback) {
  callback ||= options;
  validateFunction(callback, "cb");
  options = getOptions(options, writeFileDefaults);
  validateBoolean(options.flush ?? false, "options.flush");
  if (!ArrayBuffer.isView(data)) {
    validateStringAfterArrayBufferView(data, "data");
    data = Buffer.from(data, options.encoding || "utf8");
  }
  if (!isFd(path)) {
    if (checkAborted(options.signal, callback)) return;
    path = getValidatedPath(path);
  }
  /* on a later turn of the event loop, as Node's opens and writes on its thread pool: an abort before
   * then stops it */
  setImmediate(() => {
    if (checkAborted(options.signal, callback)) return;
    if (!options.flush) return defer(callback, doWriteFile, path, data, options);
    /* the flush through fs.fsync, then the close, as Node's writeAll */
    let fd;
    try {
      fd = doWriteFile(path, data, options, true);
    } catch (e) {
      return process.nextTick(callback, e);
    }
    fs.fsync(fd, (err) => {
      if (!isFd(path)) {
        try {
          doClose(fd);
        } catch (e) {
          err ??= e;
        }
      }
      callback(err ?? null);
    });
  });
}

function appendOptions(path, options) {
  options = copyObject(getOptions(options, { encoding: "utf8", mode: 0o666, flag: "a" }));
  if (!options.flag || isFd(path)) options.flag = "a";
  return options;
}

export function appendFileSync(path, data, options) {
  writeFileSync(path, data, appendOptions(path, options));
}

export function appendFile(path, data, options, callback) {
  callback ||= options;
  validateFunction(callback, "cb");
  writeFile(path, data, appendOptions(path, options), callback);
}

let showExistsDeprecation = true;
export function existsSync(path) {
  try {
    path = getValidatedPath(path);
  } catch (err) {
    /* Node 24: a type no path can be, deprecated (DEP0187), warning once */
    if (showExistsDeprecation && err?.code === "ERR_INVALID_ARG_TYPE") {
      process.emitWarning("Passing invalid argument types to fs.existsSync is deprecated", "DeprecationWarning", "DEP0187");
      showExistsDeprecation = false;
    }
    return false;
  }
  return fsExists(path);
}

/** Deprecated in Node: the callback gets only whether the path exists. */
export function exists(path, callback) {
  validateFunction(callback, "cb");
  let result;
  try {
    result = fsCall(FS_ACCESS, getValidatedPath(path), F_OK) === undefined;
  } catch {
    return callback(false);
  }
  process.nextTick(() => callback(result));
}

/* ---- stat ------------------------------------------------------------------------- */

const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000;

export { Stats };

function doStat(path, follow, syscall, bigint, throwIfNoEntry) {
  const r = fsStat(path, follow);
  if (typeof r === "number") {
    if (throwIfNoEntry === false && errnoName(r) === "ENOENT") return undefined;
    throw systemError(r, syscall, path);
  }
  return statsFrom(r, bigint);
}

function doFstat(fd, bigint) {
  return statsFrom(check(fsCall(FS_FSTAT, fd), "fstat"), bigint);
}

export function statSync(path, options = { bigint: false, throwIfNoEntry: true }) {
  return doStat(getValidatedPath(path), true, "stat", options.bigint, options.throwIfNoEntry);
}

export function lstatSync(path, options = { bigint: false, throwIfNoEntry: true }) {
  return doStat(getValidatedPath(path), false, "lstat", options.bigint, options.throwIfNoEntry);
}

export function fstatSync(fd, options = { bigint: false }) {
  return doFstat(getValidatedFd(fd), options.bigint);
}

export function stat(path, options = { bigint: false, throwIfNoEntry: true }, callback) {
  if (typeof options === "function") {
    callback = options;
    options = kEmptyObject;
  } else if (options === null || typeof options !== "object") {
    options = kEmptyObject;
  } else {
    options = getOptions(options, { bigint: false });
  }
  callback = makeCallback(callback);
  path = getValidatedPath(path);
  if (checkAborted(options.signal, callback)) return;
  defer(callback, doStat, path, true, "stat", options.bigint, options.throwIfNoEntry);
}

export function lstat(path, options = { bigint: false }, callback) {
  if (typeof options === "function") {
    callback = options;
    options = kEmptyObject;
  }
  callback = makeCallback(callback);
  defer(callback, doStat, getValidatedPath(path), false, "lstat", options.bigint, true);
}

export function fstat(fd, options = { bigint: false }, callback) {
  if (typeof options === "function") {
    callback = options;
    options = kEmptyObject;
  }
  callback = makeCallback(callback);
  defer(callback, doFstat, getValidatedFd(fd), options.bigint);
}

/* ---- readdir ---------------------------------------------------------------------- */

/* libuv's uv_dirent_type_t */
const UV_DIRENT_FILE = 1, UV_DIRENT_DIR = 2, UV_DIRENT_LINK = 3, UV_DIRENT_FIFO = 4, UV_DIRENT_SOCKET = 5, UV_DIRENT_CHAR = 6,
  UV_DIRENT_BLOCK = 7;
const kType = Symbol("type");

export class Dirent {
  constructor(name, type, path) {
    this.name = name;
    this.parentPath = path;
    this[kType] = type;
  }

  isFile() { return this[kType] === UV_DIRENT_FILE; }
  isDirectory() { return this[kType] === UV_DIRENT_DIR; }
  isSymbolicLink() { return this[kType] === UV_DIRENT_LINK; }
  isFIFO() { return this[kType] === UV_DIRENT_FIFO; }
  isSocket() { return this[kType] === UV_DIRENT_SOCKET; }
  isCharacterDevice() { return this[kType] === UV_DIRENT_CHAR; }
  isBlockDevice() { return this[kType] === UV_DIRENT_BLOCK; }
}

function doReaddir(path, options) {
  const encoding = options.encoding;
  /* in libuv's order, as Node's (it lists them through libuv too) */
  const list = (dir) => {
    const r = check(fsReaddir(dir), "scandir", dir);
    const entries = [];
    for (let i = 0; i < r.length; i += 2) entries.push([r[i], r[i + 1]]);
    return entries;
  };
  if (!options.recursive) {
    if (options.withFileTypes) return list(path).map(([name, type]) => new Dirent(encoded(name, encoding), type, path));
    return list(path).map(([name]) => encoded(name, encoding));
  }
  /* Node's readdirSyncRecursive: each directory's entries, then the directories found, in turn;
   * names relative to path. It goes into what stat (following links) says is a directory */
  const results = [];
  const queue = [[path, ""]];
  for (let i = 0; i < queue.length; i++) {
    const [dir, relative] = queue[i];
    for (const [name, type] of list(dir)) {
      const full = dir.endsWith("/") ? dir + name : dir + "/" + name;
      const rel = relative ? relative + "/" + name : name;
      results.push(options.withFileTypes ? new Dirent(encoded(name, encoding), type, dir) : encoded(rel, encoding));
      const st = type === UV_DIRENT_DIR ? null : type === UV_DIRENT_LINK || type === 0 ? fsStat(full, true) : undefined;
      if (st === null || (Array.isArray(st) && (st[0] & S_IFMT) === S_IFDIR)) queue.push([full, rel]);
    }
  }
  return results;
}

function readdirOptions(options) {
  options = getOptions(options);
  if (options.recursive != null) validateBoolean(options.recursive, "options.recursive");
  return options;
}

export function readdirSync(path, options) {
  options = readdirOptions(options);
  return doReaddir(getValidatedPath(path), options);
}

export function readdir(path, options, callback) {
  callback = makeCallback(typeof options === "function" ? options : callback);
  options = readdirOptions(options);
  defer(callback, doReaddir, getValidatedPath(path), options);
}

/* ---- realpath, mkdir, mkdtemp ------------------------------------------------------- */

/** The canonical path. Node's own realpathSync walks the path with lstat, so its errors name the
 *  lstat of the first missing part, absolute; realpathSync.native's name the realpath call. */
function doRealpath(path, encoding) {
  const r = fsRealpath(path);
  if (typeof r === "number") {
    const parts = resolve(path).split("/");
    for (let i = 2; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const st = fsStat(prefix, false);
      if (typeof st === "number") throw systemError(st, "lstat", prefix);
    }
    throw systemError(r, "realpath", path);
  }
  return encoded(r, encoding);
}

function doRealpathNative(path, encoding) {
  return encoded(check(fsRealpath(path), "realpath", path), encoding);
}

export function realpathSync(path, options) {
  options = getOptions(options);
  return doRealpath(getValidatedPath(path), options.encoding);
}

realpathSync.native = function realpathSync(path, options) {
  options = getOptions(options);
  return doRealpathNative(getValidatedPath(path), options.encoding);
};

export function realpath(path, options, callback) {
  if (typeof options === "function") callback = options;
  else validateFunction(callback, "cb");
  options = getOptions(options);
  defer(callback, doRealpath, getValidatedPath(path), options.encoding);
}

realpath.native = function realpath(path, options, callback) {
  callback = makeCallback(typeof options === "function" ? options : callback);
  options = getOptions(options);
  defer(callback, doRealpathNative, getValidatedPath(path), options.encoding);
};

/** Creates the directory; with `recursive`, its missing parents too, returning the first one
 *  created (undefined if it all existed). */
function doMkdir(path, mode, recursive) {
  if (!recursive) {
    check(fsMkdir(path, mode), "mkdir", path);
    return undefined;
  }
  const missing = [];
  for (let p = path; ; p = dirname(p)) {
    const st = fsStat(p, true);
    if (typeof st !== "number") {
      /* a file where a directory goes: the OS's error (EEXIST for the path itself, else ENOTDIR) */
      if ((st[0] & S_IFMT) !== S_IFDIR) throw systemError(fsMkdir(path, mode), "mkdir", path);
      break;
    }
    missing.push(p);
    if (dirname(p) === p) break;
  }
  for (let i = missing.length - 1; i >= 0; i--) {
    const r = fsMkdir(missing[i], mode);
    if (typeof r === "number" && errnoName(r) !== "EEXIST") throw systemError(r, "mkdir", path);
  }
  return missing.length ? missing[missing.length - 1] : undefined;
}

/* mkdir's options: [mode, recursive] */
function mkdirOptions(options) {
  let mode = 0o777;
  let recursive = false;
  if (typeof options === "number" || typeof options === "string") {
    mode = parseFileMode(options, "mode");
  } else if (options) {
    if (options.recursive !== undefined) {
      recursive = options.recursive;
      validateBoolean(recursive, "options.recursive");
    }
    if (options.mode !== undefined) mode = parseFileMode(options.mode, "options.mode");
  }
  return [mode, recursive];
}

export function mkdirSync(path, options) {
  const [mode, recursive] = mkdirOptions(options);
  return doMkdir(getValidatedPath(path), mode, recursive);
}

export function mkdir(path, options, callback) {
  const [mode, recursive] = typeof options === "function" ? [0o777, false] : mkdirOptions(options);
  if (typeof options === "function") callback = options;
  callback = makeCallback(callback);
  defer(callback, doMkdir, getValidatedPath(path), mode, recursive);
}

/** A new directory named `prefix` and six random characters: its path. */
function doMkdtemp(prefix, encoding) {
  const template = prefix + "XXXXXX";
  return encoded(check(fsCall(FS_MKDTEMP, template), "mkdtemp", template), encoding);
}

export function mkdtempSync(prefix, options) {
  options = getOptions(options);
  prefix = getValidatedPath(prefix, "prefix");
  warnOnNonPortableTemplate(prefix);
  return doMkdtemp(prefix, options.encoding);
}

export function mkdtemp(prefix, options, callback) {
  callback = makeCallback(typeof options === "function" ? options : callback);
  options = getOptions(options);
  prefix = getValidatedPath(prefix, "prefix");
  warnOnNonPortableTemplate(prefix);
  defer(callback, doMkdtemp, prefix, options.encoding);
}

/** mkdtempSync's directory with a way to remove it, and what it holds: remove(), or a `using`
 *  declaration (Symbol.dispose). */
export function mkdtempDisposableSync(prefix, options) {
  const path = mkdtempSync(prefix, options);
  const fullPath = resolve(process.cwd(), `${path}`);
  const remove = () => removeTree(fullPath, true);
  return { path, remove, [Symbol.dispose]() { remove(); } };
}

/* ---- utimes ------------------------------------------------------------------------- */

function doUtimes(path, atime, mtime) {
  check(fsUtimes(path, atime, mtime), "utime", path);
}

function doFutimes(fd, atime, mtime) {
  check(fsCall(FS_FUTIME, fd, atime, mtime), "futime");
}

function doLutimes(path, atime, mtime) {
  check(fsCall(FS_LUTIME, path, atime, mtime), "lutime", path);
}

export function utimesSync(path, atime, mtime) {
  doUtimes(getValidatedPath(path), toUnixTimestamp(atime), toUnixTimestamp(mtime));
}

export function utimes(path, atime, mtime, callback) {
  callback = makeCallback(callback);
  path = getValidatedPath(path);
  defer(callback, doUtimes, path, toUnixTimestamp(atime), toUnixTimestamp(mtime));
}

export function futimesSync(fd, atime, mtime) {
  doFutimes(getValidatedFd(fd), toUnixTimestamp(atime, "atime"), toUnixTimestamp(mtime, "mtime"));
}

export function futimes(fd, atime, mtime, callback) {
  atime = toUnixTimestamp(atime, "atime");
  mtime = toUnixTimestamp(mtime, "mtime");
  callback = makeCallback(callback);
  defer(callback, doFutimes, getValidatedFd(fd), atime, mtime);
}

export function lutimesSync(path, atime, mtime) {
  doLutimes(getValidatedPath(path), toUnixTimestamp(atime), toUnixTimestamp(mtime));
}

export function lutimes(path, atime, mtime, callback) {
  callback = makeCallback(callback);
  path = getValidatedPath(path);
  defer(callback, doLutimes, path, toUnixTimestamp(atime), toUnixTimestamp(mtime));
}

/* ---- the other system calls, through fsCall ------------------------------------------ */

/* fsCall's operations (host_fs.c) */
const FS_RENAME = 0, FS_LINK = 1, FS_SYMLINK = 2, FS_READLINK = 3, FS_RMDIR = 4, FS_CHMOD = 5, FS_FCHMOD = 6, FS_CHOWN = 7,
  FS_FCHOWN = 8, FS_LCHOWN = 9, FS_FSYNC = 10, FS_FDATASYNC = 11, FS_FTRUNCATE = 12, FS_FUTIME = 13, FS_LUTIME = 14,
  FS_COPYFILE = 15, FS_MKDTEMP = 16, FS_ACCESS = 17, FS_FSTAT = 18;

/* a call naming a path (`chmod 'a'`), or a descriptor, its error naming the call alone */
function pathCall(op, syscall, path, a, b) {
  check(fsCall(op, path, a, b), syscall, path);
}

function fdCall(op, syscall, fd, a, b) {
  check(fsCall(op, fd, a, b), syscall);
}

/* a call naming two paths: its error names both (`rename 'a' -> 'b'`) */
function twoPaths(op, syscall, from, to, extra) {
  const r = fsCall(op, from, to, extra);
  if (typeof r === "number") throw systemError(r, syscall, from, to);
}

export function renameSync(oldPath, newPath) {
  twoPaths(FS_RENAME, "rename", getValidatedPath(oldPath, "oldPath"), getValidatedPath(newPath, "newPath"));
}

export function rename(oldPath, newPath, callback) {
  callback = makeCallback(callback);
  defer(callback, twoPaths, FS_RENAME, "rename", getValidatedPath(oldPath, "oldPath"), getValidatedPath(newPath, "newPath"));
}

export function linkSync(existingPath, newPath) {
  twoPaths(FS_LINK, "link", getValidatedPath(existingPath, "existingPath"), getValidatedPath(newPath, "newPath"));
}

export function link(existingPath, newPath, callback) {
  callback = makeCallback(callback);
  defer(callback, twoPaths, FS_LINK, "link", getValidatedPath(existingPath, "existingPath"), getValidatedPath(newPath, "newPath"));
}

/* type "dir" or "junction" matters on Windows only, as in Node */
const symlinkType = (type) => (type === "dir" ? 1 : type === "junction" ? 2 : 0);

export function symlinkSync(target, path, type) {
  validateOneOf(type, "type", ["dir", "file", "junction", null, undefined]);
  twoPaths(FS_SYMLINK, "symlink", getValidatedPath(target, "target"), getValidatedPath(path), symlinkType(type));
}

export function symlink(target, path, type, callback) {
  if (callback === undefined) {
    callback = makeCallback(type);
    type = undefined;
  } else {
    validateOneOf(type, "type", ["dir", "file", "junction", null, undefined]);
  }
  defer(callback, twoPaths, FS_SYMLINK, "symlink", getValidatedPath(target, "target"), getValidatedPath(path), symlinkType(type));
}

function doReadlink(path, encoding) {
  return encoded(check(fsCall(FS_READLINK, path), "readlink", path), encoding);
}

export function readlinkSync(path, options) {
  options = getOptions(options);
  return doReadlink(getValidatedPath(path), options.encoding);
}

export function readlink(path, options, callback) {
  callback = makeCallback(typeof options === "function" ? options : callback);
  options = getOptions(options);
  defer(callback, doReadlink, getValidatedPath(path), options.encoding);
}

export function unlinkSync(path) {
  path = getValidatedPath(path);
  check(fsUnlink(path), "unlink", path);
}

export function unlink(path, callback) {
  callback = makeCallback(callback);
  defer(callback, unlinkSync, getValidatedPath(path));
}

export function copyFileSync(src, dest, mode) {
  twoPaths(FS_COPYFILE, "copyfile", getValidatedPath(src, "src"), getValidatedPath(dest, "dest"), getValidMode(mode, "copyFile"));
}

export function copyFile(src, dest, mode, callback) {
  if (typeof mode === "function") {
    callback = mode;
    mode = 0;
  }
  src = getValidatedPath(src, "src");
  dest = getValidatedPath(dest, "dest");
  callback = makeCallback(callback);
  defer(callback, twoPaths, FS_COPYFILE, "copyfile", src, dest, getValidMode(mode, "copyFile"));
}

const F_OK = 0;

export function accessSync(path, mode) {
  pathCall(FS_ACCESS, "access", getValidatedPath(path), getValidMode(mode, "access"));
}

export function access(path, mode, callback) {
  if (typeof mode === "function") {
    callback = mode;
    mode = F_OK;
  }
  path = getValidatedPath(path);
  callback = makeCallback(callback);
  defer(callback, pathCall, FS_ACCESS, "access", path, getValidMode(mode, "access"));
}

export function chmodSync(path, mode) {
  pathCall(FS_CHMOD, "chmod", getValidatedPath(path), parseFileMode(mode, "mode"));
}

export function chmod(path, mode, callback) {
  path = getValidatedPath(path);
  mode = parseFileMode(mode, "mode");
  callback = makeCallback(callback);
  defer(callback, pathCall, FS_CHMOD, "chmod", path, mode);
}

export function fchmodSync(fd, mode) {
  fdCall(FS_FCHMOD, "fchmod", getValidatedFd(fd), parseFileMode(mode, "mode"));
}

export function fchmod(fd, mode, callback) {
  mode = parseFileMode(mode, "mode");
  callback = makeCallback(callback);
  defer(callback, fdCall, FS_FCHMOD, "fchmod", getValidatedFd(fd), mode);
}

function validateIds(uid, gid) {
  validateInteger(uid, "uid", -1, kMaxUserId);
  validateInteger(gid, "gid", -1, kMaxUserId);
}

export function chownSync(path, uid, gid) {
  path = getValidatedPath(path);
  validateIds(uid, gid);
  pathCall(FS_CHOWN, "chown", path, uid, gid);
}

export function chown(path, uid, gid, callback) {
  callback = makeCallback(callback);
  path = getValidatedPath(path);
  validateIds(uid, gid);
  defer(callback, pathCall, FS_CHOWN, "chown", path, uid, gid);
}

export function lchownSync(path, uid, gid) {
  path = getValidatedPath(path);
  validateIds(uid, gid);
  pathCall(FS_LCHOWN, "lchown", path, uid, gid);
}

export function lchown(path, uid, gid, callback) {
  callback = makeCallback(callback);
  path = getValidatedPath(path);
  validateIds(uid, gid);
  defer(callback, pathCall, FS_LCHOWN, "lchown", path, uid, gid);
}

export function fchownSync(fd, uid, gid) {
  validateIds(uid, gid);
  fdCall(FS_FCHOWN, "fchown", getValidatedFd(fd), uid, gid);
}

export function fchown(fd, uid, gid, callback) {
  validateIds(uid, gid);
  callback = makeCallback(callback);
  defer(callback, fdCall, FS_FCHOWN, "fchown", getValidatedFd(fd), uid, gid);
}

export function fsyncSync(fd) {
  fdCall(FS_FSYNC, "fsync", getValidatedFd(fd));
}

export function fsync(fd, callback) {
  callback = makeCallback(callback);
  defer(callback, fdCall, FS_FSYNC, "fsync", getValidatedFd(fd));
}

export function fdatasyncSync(fd) {
  fdCall(FS_FDATASYNC, "fdatasync", getValidatedFd(fd));
}

export function fdatasync(fd, callback) {
  callback = makeCallback(callback);
  defer(callback, fdCall, FS_FDATASYNC, "fdatasync", getValidatedFd(fd));
}

export function ftruncateSync(fd, len = 0) {
  validateInteger(len, "len");
  fdCall(FS_FTRUNCATE, "ftruncate", getValidatedFd(fd), len < 0 ? 0 : len);
}

export function ftruncate(fd, len = 0, callback) {
  if (typeof len === "function") {
    callback = len;
    len = 0;
  }
  validateInteger(len, "len");
  len = Math.max(0, len);
  callback = makeCallback(callback);
  defer(callback, fdCall, FS_FTRUNCATE, "ftruncate", getValidatedFd(fd), len);
}

/** As Node's: the file opened for writing, truncated, closed. */
function doTruncate(path, len) {
  const fd = doOpen(path, O_RDWR, 0o666);
  try {
    fdCall(FS_FTRUNCATE, "ftruncate", fd, len);
  } finally {
    doClose(fd);
  }
}

export function truncateSync(path, len) {
  if (len === undefined) len = 0;
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, len);
  } finally {
    closeSync(fd);
  }
}

export function truncate(path, len, callback) {
  if (typeof len === "function") {
    callback = len;
    len = 0;
  } else if (len === undefined) {
    len = 0;
  }
  validateInteger(len, "len");
  len = Math.max(0, len);
  validateFunction(callback, "cb");
  defer(callback, doTruncate, getValidatedPath(path), len);
}

/* ---- rmdir, rm ------------------------------------------------------------------------- */

function removeTree(path, force) {
  const st = fsStat(path, false);
  if (typeof st === "number") {
    if (force && errnoName(st) === "ENOENT") return;
    throw systemError(st, "lstat", path);
  }
  if ((st[0] & S_IFMT) === S_IFDIR) {
    const entries = check(fsReaddir(path), "scandir", path);
    for (let i = 0; i < entries.length; i += 2) removeTree(path + "/" + entries[i], false);
    check(fsCall(FS_RMDIR, path), "rmdir", path);
  } else {
    check(fsUnlink(path), "rm", path);
  }
}

/* rm's work, its options checked: a file, or with `recursive` a directory and what it holds;
 * `force` ignores a missing path. A directory without `recursive` is ERR_FS_EISDIR, as in Node. */
function doRm(path, options) {
  const st = fsStat(path, false);
  if (typeof st === "number") {
    if (options.force && errnoName(st) === "ENOENT") return;
    throw systemError(st, "lstat", path);
  }
  if ((st[0] & S_IFMT) === S_IFDIR) {
    if (!options.recursive) throw rmIsDirectory(path);
    return removeTree(path, options.force);
  }
  check(fsUnlink(path), "rm", path);
}

/* rmdir's work: with `recursive` (deprecated), a directory removed as rm removes it; what isn't a
 * directory left to rmdir's ENOTDIR, as Node's */
function doRmdir(path, recursive) {
  if (recursive) {
    const st = check(fsStat(path, false), "lstat", path);
    if ((st[0] & S_IFMT) === S_IFDIR) return removeTree(path, false);
  }
  check(fsCall(FS_RMDIR, path), "rmdir", path);
}

export function rmdirSync(path, options) {
  path = getValidatedPath(path);
  if (options?.recursive) {
    emitRecursiveRmdirWarning();
    validateRmOptionsShape({ ...options, force: false });
  } else {
    validateRmdirOptions(options);
  }
  doRmdir(path, !!options?.recursive);
}

export function rmdir(path, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  callback = makeCallback(callback);
  path = getValidatedPath(path);
  if (options?.recursive) {
    emitRecursiveRmdirWarning();
    validateRmOptionsShape({ ...options, force: false });
  } else {
    validateRmdirOptions(options);
  }
  defer(callback, doRmdir, path, !!options?.recursive);
}

export function rmSync(path, options) {
  path = getValidatedPath(path);
  doRm(path, validateRmOptionsShape(options));
}

export function rm(path, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  path = getValidatedPath(path);
  options = validateRmOptionsShape(options);
  validateFunction(callback, "cb");
  defer(callback, doRm, path, options);
}

/* ---- streams: Node's, in a module of their own (internal/fs_streams.js) ------------------- */

export const ReadStream = lazyConstructor("ReadStream", 2);
export const WriteStream = lazyConstructor("WriteStream", 2);

export function createReadStream(path, options) {
  return new ReadStream(path, options);
}

export function createWriteStream(path, options) {
  return new WriteStream(path, options);
}

/* node:fs/promises, which imports this module: read when used, not while the modules load */
export { default as promises } from "./fs_promises.js";
import promises from "./fs_promises.js";

/* ---- util.promisify's results ------------------------------------------------------------ */

/* the callback's values as an object's (node:util's symbol); exists' promise, of a boolean */
const kCustomPromisifyArgs = Symbol.for("visaljs.util.customPromisifyArgs");
Object.defineProperty(read, kCustomPromisifyArgs, { value: ["bytesRead", "buffer"], enumerable: false });
Object.defineProperty(write, kCustomPromisifyArgs, { value: ["bytesWritten", "buffer"], enumerable: false });
Object.defineProperty(readv, kCustomPromisifyArgs, { value: ["bytesRead", "buffers"], enumerable: false });
Object.defineProperty(writev, kCustomPromisifyArgs, { value: ["bytesWritten", "buffers"], enumerable: false });
Object.defineProperty(exists, Symbol.for("nodejs.util.promisify.custom"), {
  value: function exists(path) {
    return new Promise((resolve) => fs.exists(path, resolve));
  },
  enumerable: false,
});

/* ---- the features in modules of their own ------------------------------------------------- */

/* their own modules, linked when the program names them (internal/features.js) */
export const statfsSync = lazyFunction("statfsSync", 2);
export const statfs = lazyFunction("statfs", 3);
export const Dir = lazyClass("Dir");
export const opendirSync = lazyFunction("opendirSync", 2);
export const opendir = lazyFunction("opendir", 3);
export const cpSync = lazyFunction("cpSync", 3);
export const cp = lazyFunction("cp", 4);
export const globSync = lazyFunction("globSync", 2);
export const glob = lazyFunction("glob", 3);
export const watch = lazyFunction("watch", 3);
export const watchFile = lazyFunction("watchFile", 3);
export const unwatchFile = lazyFunction("unwatchFile", 2);
export const openAsBlob = lazyFunction("openAsBlob", 2);

/* lchmod: macOS's only (O_SYMLINK), as Node's */
export const lchmod = undefined;
export const lchmodSync = undefined;

/* the names Node keeps for its streams */
export const FileReadStream = ReadStream;
export const FileWriteStream = WriteStream;

/* the platform's (libuv's, then the C library's), in Node's order */
export const constants = { __proto__: null };
{
  const flat = fsConstants();
  for (let i = 0; i < flat.length; i += 2) constants[flat[i]] = flat[i + 1];
}
const { O_RDONLY, O_RDWR } = constants;

const fs = {
  constants, readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, statSync, lstatSync, readdirSync, readFile, writeFile,
  unlink, stat, lstat, readdir, createReadStream, ReadStream, Stats, Dirent, realpathSync, realpath, mkdirSync, mkdir, utimesSync,
  utimes, openSync, open, closeSync, close, writeSync, readSync, read, write, appendFile, exists, createWriteStream, WriteStream,
  renameSync, rename, linkSync, link, symlinkSync, symlink, readlinkSync, readlink, copyFileSync, copyFile, accessSync, access,
  chmodSync, chmod, fchmodSync, fchmod, lchmod, lchmodSync, chownSync, chown, lchownSync, lchown, fchownSync, fchown, fstatSync, fstat,
  fsyncSync, fsync, fdatasyncSync, fdatasync, ftruncateSync, ftruncate, truncateSync, truncate, futimesSync, futimes, lutimesSync,
  lutimes, mkdtempSync, mkdtemp, mkdtempDisposableSync, rmdirSync, rmdir, rmSync, rm, readvSync, readv, writevSync, writev, statfsSync,
  statfs, Dir, opendirSync, opendir, cpSync, cp, globSync, glob, watch, watchFile, unwatchFile, openAsBlob, FileReadStream,
  FileWriteStream, _toUnixTimestamp: toUnixTimestamp,
  get promises() {
    return promises;
  },
};

/* access()'s modes on fs itself: hidden, deprecated getters in Node 24 (DEP0176), warning once,
 * without a setter */
let warnedModes = false;
for (const [name, value] of [["F_OK", 0], ["R_OK", 4], ["W_OK", 2], ["X_OK", 1]]) {
  Object.defineProperty(fs, name, {
    enumerable: false,
    configurable: true,
    get() {
      if (!warnedModes) {
        warnedModes = true;
        process.emitWarning(`fs.${name} is deprecated, use fs.constants.${name} instead`, "DeprecationWarning", "DEP0176");
      }
      return value;
    },
  });
}

export default fs;
