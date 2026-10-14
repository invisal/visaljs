// node:fs: the synchronous file API, over the host primitives, and the
// callback API, stat's and readdir's, and read streams over it. Contents are Buffers without an
// encoding, else strings in any of Buffer's encodings. A callback runs on a later tick, as
// Node's, though the I/O itself happened synchronously (so do node:fs/promises').
import {
  errnoName, fsCall, fsClose, fsConstants, fsExists, fsMkdir, fsOpen, fsRead, fsReadAt, fsReaddir, fsReadFile, fsRealpath, fsStat, fsUnlink, fsUtimes, fsWrite,
  fsWriteFile,
} from "visaljs:host";
import { codeError, invalidArgType, invalidArgValue, notSupported, outOfRange, systemError, validateFunction } from "./internal/errors.js";
import { lazyClass, lazyFunction } from "./internal/features.js";
import { dirname, resolve } from "./path.js";
import { constants as osConstants } from "./os.js";
import { Readable, Writable } from "./stream.js";

function validatePath(path) {
  if (typeof path !== "string") {
    if (typeof path === "number") throw notSupported("A file descriptor as a path");
    if (typeof URL === "function" && path instanceof URL) throw notSupported("A file: URL as a path");
    throw invalidArgType("path", "of type string or an instance of Buffer or URL", path);
  }
  if (path.indexOf("\u0000") !== -1) throw invalidArgValue("path", "must be a string without null bytes", path);
}

function encodingOf(options) {
  if (options == null) return undefined;
  if (typeof options === "string") return options;
  if (typeof options === "object") return options.encoding ?? undefined;
  throw invalidArgType("options", "one of type string or an instance of Object", options);
}

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

function validateEncodingName(encoding) {
  if (encoding !== undefined && encoding !== "buffer" && !Buffer.isEncoding(encoding)) {
    throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'encoding' is invalid encoding. Received '" + encoding + "'");
  }
}

export function readFileSync(path, options) {
  validatePath(path);
  const encoding = encodingOf(options);
  validateEncodingName(encoding);
  const asText = encoding !== undefined && isUtf8(encoding);
  const result = fsReadFile(path, !asText);
  /* opening a directory succeeds; reading it fails: Node reports that read, without a path */
  if (typeof result === "number" && errnoName(result) === "EISDIR") throw systemError(result, "read");
  const contents = check(result, "open", path);
  return asText || encoding === undefined || encoding === "buffer" ? contents : contents.toString(encoding);
}

function writeWhole(path, data, options, append) {
  validatePath(path);
  if (typeof data !== "string" && !ArrayBuffer.isView(data)) {
    throw invalidArgType("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
  }
  const encoding = encodingOf(options);
  validateEncodingName(encoding);
  if (typeof data === "string" && encoding !== undefined && encoding !== "buffer" && !isUtf8(encoding)) data = Buffer.from(data, encoding);
  const flag = options != null && typeof options === "object" ? options.flag : undefined;
  check(fsWriteFile(path, data, append || flag === "a"), "open", path);
}

export function writeFileSync(path, data, options) {
  writeWhole(path, data, options, false);
}

export function appendFileSync(path, data, options) {
  writeWhole(path, data, options, true);
}

let warnedExists = false;
export function existsSync(path) {
  if (typeof path !== "string") {
    /* Node 24: a type no path can be, deprecated (DEP0187), warning once */
    const valid = path instanceof Uint8Array || (typeof URL === "function" && path instanceof URL);  /* a Buffer, a URL */
    if (!valid && !warnedExists) {
      warnedExists = true;
      process.emitWarning("Passing invalid argument types to fs.existsSync is deprecated", "DeprecationWarning", "DEP0187");
    }
    return false;
  }
  if (path.indexOf("\u0000") !== -1) return false;
  return fsExists(path);
}

export function unlinkSync(path) {
  validatePath(path);
  check(fsUnlink(path), "unlink", path);
}

/* ---- stat ------------------------------------------------------------------------- */

const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000, S_IFLNK = 0o120000, S_IFIFO = 0o010000,
  S_IFSOCK = 0o140000, S_IFCHR = 0o020000, S_IFBLK = 0o060000;

export class Stats {
  constructor(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs) {
    Object.assign(this, { dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs });
    this.atime = new Date(atimeMs);
    this.mtime = new Date(mtimeMs);
    this.ctime = new Date(ctimeMs);
    this.birthtime = new Date(birthtimeMs);
  }

  isFile() { return (this.mode & S_IFMT) === S_IFREG; }
  isDirectory() { return (this.mode & S_IFMT) === S_IFDIR; }
  isSymbolicLink() { return (this.mode & S_IFMT) === S_IFLNK; }
  isFIFO() { return (this.mode & S_IFMT) === S_IFIFO; }
  isSocket() { return (this.mode & S_IFMT) === S_IFSOCK; }
  isCharacterDevice() { return (this.mode & S_IFMT) === S_IFCHR; }
  isBlockDevice() { return (this.mode & S_IFMT) === S_IFBLK; }
}

function statOf(path, options, follow, syscall) {
  validatePath(path);
  const r = fsStat(path, follow);
  if (typeof r === "number") {
    if (options?.throwIfNoEntry === false && errnoName(r) === "ENOENT") return undefined;
    throw systemError(r, syscall, path);
  }
  const [mode, size, mtimeMs, atimeMs, ctimeMs, birthtimeMs, ino, dev, nlink, uid, gid, rdev, blksize, blocks] = r;
  return new Stats(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs);
}

export function statSync(path, options) {
  return statOf(path, options, true, "stat");
}

export function lstatSync(path, options) {
  return statOf(path, options, false, "lstat");
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
    this.path = path;
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

export function readdirSync(path, options) {
  validatePath(path);
  const encoding = encodingOf(options);
  validateEncodingName(encoding);
  /* in libuv's order, as Node's (it lists them through libuv too) */
  const named = (name) => (encoding === undefined || isUtf8(encoding) ? name : encoding === "buffer" ? Buffer.from(name) : Buffer.from(name).toString(encoding));
  const list = (dir) => {
    const r = check(fsReaddir(dir), "scandir", dir);
    const entries = [];
    for (let i = 0; i < r.length; i += 2) entries.push([r[i], r[i + 1]]);
    return entries;
  };
  if (!options?.recursive) {
    if (options?.withFileTypes) return list(path).map(([name, type]) => new Dirent(named(name), type, path));
    return list(path).map(([name]) => named(name));
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
      results.push(options.withFileTypes ? new Dirent(named(name), type, dir) : named(rel));
      const st = type === UV_DIRENT_DIR ? null : type === UV_DIRENT_LINK || type === 0 ? fsStat(full, true) : undefined;
      if (st === null || (Array.isArray(st) && (st[0] & 0o170000) === 0o040000)) queue.push([full, rel]);
    }
  }
  return results;
}

/* ---- realpath, mkdir, utimes ----------------------------------------------------- */

function encoded(name, encoding) {
  return encoding === undefined || isUtf8(encoding) ? name : encoding === "buffer" ? Buffer.from(name) : Buffer.from(name).toString(encoding);
}

/** The canonical path. Node's own realpathSync walks the path with lstat, so its errors name the
 *  lstat of the first missing part, absolute; realpathSync.native's name the realpath call. */
export function realpathSync(path, options) {
  validatePath(path);
  const encoding = encodingOf(options);
  validateEncodingName(encoding);
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

realpathSync.native = function realpathSync(path, options) {
  validatePath(path);
  const encoding = encodingOf(options);
  validateEncodingName(encoding);
  return encoded(check(fsRealpath(path), "realpath", path), encoding);
};

function modeOf(mode, fallback) {
  if (mode === undefined) return fallback;
  if (typeof mode === "string") {
    if (!/^[0-7]+$/.test(mode)) throw invalidArgValue("mode", "must be a 32-bit unsigned integer or an octal string", mode);
    return parseInt(mode, 8);
  }
  if (typeof mode !== "number") throw invalidArgType("mode", "of type number", mode);
  return mode;
}

/** Creates the directory; with `recursive`, its missing parents too, returning the first one
 *  created (undefined if it all existed). */
export function mkdirSync(path, options) {
  validatePath(path);
  const recursive = typeof options === "object" && options !== null && options.recursive === true;
  const mode = modeOf(typeof options === "object" && options !== null ? options.mode : options, 0o777);
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

/** A time as seconds since the epoch: a number, a numeric string or a Date. */
function toUnixTime(time, name) {
  if (typeof time === "number") return Number.isFinite(time) ? time : Date.now() / 1000;
  if (typeof time === "string" && time.trim() !== "" && Number.isFinite(+time)) return +time;
  if (time instanceof Date) return time.getTime() / 1000;
  throw invalidArgType(name, "of type number or an instance of Date", time);
}

export function utimesSync(path, atime, mtime) {
  validatePath(path);
  check(fsUtimes(path, toUnixTime(atime, "atime"), toUnixTime(mtime, "mtime")), "utime", path);
}

/* ---- the other system calls, through fsCall ------------------------------------------ */

/* fsCall's operations (host_fs.c) */
const FS_RENAME = 0, FS_LINK = 1, FS_SYMLINK = 2, FS_READLINK = 3, FS_RMDIR = 4, FS_CHMOD = 5, FS_FCHMOD = 6, FS_CHOWN = 7,
  FS_FCHOWN = 8, FS_LCHOWN = 9, FS_FSYNC = 10, FS_FDATASYNC = 11, FS_FTRUNCATE = 12, FS_FUTIME = 13, FS_LUTIME = 14,
  FS_COPYFILE = 15, FS_MKDTEMP = 16, FS_ACCESS = 17, FS_FSTAT = 18;

/* a call naming two paths: its error names both (`rename 'a' -> 'b'`) */
function twoPaths(op, syscall, from, to, extra) {
  validatePath(from);
  validatePath(to);
  const r = fsCall(op, from, to, extra);
  if (typeof r === "number") throw systemError(r, syscall, from, to);
}

export function renameSync(oldPath, newPath) {
  twoPaths(FS_RENAME, "rename", oldPath, newPath);
}

export function linkSync(existingPath, newPath) {
  twoPaths(FS_LINK, "link", existingPath, newPath);
}

/** type "dir" or "junction" matters on Windows only, as in Node. */
export function symlinkSync(target, path, type) {
  if (type != null && type !== "dir" && type !== "file" && type !== "junction") {  /* Node 24's validateOneOf */
    throw invalidArgValue("type", "must be one of: 'dir', 'file', 'junction', null, undefined", type);
  }
  twoPaths(FS_SYMLINK, "symlink", target, path, type === "dir" ? 1 : type === "junction" ? 2 : 0);
}

export function readlinkSync(path, options) {
  validatePath(path);
  return encoded(check(fsCall(FS_READLINK, path), "readlink", path), encodingOf(options));
}

export function copyFileSync(src, dest, mode) {
  twoPaths(FS_COPYFILE, "copyfile", src, dest, mode ?? 0);
}

export function accessSync(path, mode) {
  validatePath(path);
  check(fsCall(FS_ACCESS, path, mode ?? 0), "access", path);
}

export function chmodSync(path, mode) {
  validatePath(path);
  check(fsCall(FS_CHMOD, path, modeOf(mode)), "chmod", path);
}

export function fchmodSync(fd, mode) {
  validateFd(fd);
  check(fsCall(FS_FCHMOD, fd, modeOf(mode)), "fchmod");
}

function validateId(id, name) {
  if (typeof id !== "number") throw invalidArgType(name, "of type number", id);
  if (!Number.isInteger(id) || id < -1 || id > 4294967295) throw outOfRange(name, ">= -1 && <= 4294967295", id);
}

export function chownSync(path, uid, gid) {
  validatePath(path);
  validateId(uid, "uid");
  validateId(gid, "gid");
  check(fsCall(FS_CHOWN, path, uid, gid), "chown", path);
}

export function lchownSync(path, uid, gid) {
  validatePath(path);
  validateId(uid, "uid");
  validateId(gid, "gid");
  check(fsCall(FS_LCHOWN, path, uid, gid), "lchown", path);
}

export function fchownSync(fd, uid, gid) {
  validateFd(fd);
  validateId(uid, "uid");
  validateId(gid, "gid");
  check(fsCall(FS_FCHOWN, fd, uid, gid), "fchown");
}

export function fstatSync(fd) {
  validateFd(fd);
  const [mode, size, mtimeMs, atimeMs, ctimeMs, birthtimeMs, ino, dev, nlink, uid, gid, rdev, blksize, blocks] =
    check(fsCall(FS_FSTAT, fd), "fstat");
  return new Stats(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs);
}

export function fsyncSync(fd) {
  validateFd(fd);
  check(fsCall(FS_FSYNC, fd), "fsync");
}

export function fdatasyncSync(fd) {
  validateFd(fd);
  check(fsCall(FS_FDATASYNC, fd), "fdatasync");
}

export function ftruncateSync(fd, len) {
  validateFd(fd);
  check(fsCall(FS_FTRUNCATE, fd, Math.max(0, len ?? 0)), "ftruncate");
}

/** As Node's: the file opened for writing, truncated, closed. */
export function truncateSync(path, len) {
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, len);
  } finally {
    closeSync(fd);
  }
}

export function futimesSync(fd, atime, mtime) {
  validateFd(fd);
  check(fsCall(FS_FUTIME, fd, toUnixTime(atime, "atime"), toUnixTime(mtime, "mtime")), "futime");
}

export function lutimesSync(path, atime, mtime) {
  validatePath(path);
  check(fsCall(FS_LUTIME, path, toUnixTime(atime, "atime"), toUnixTime(mtime, "mtime")), "lutime", path);
}

/** A new directory named `prefix` and six random characters: its path. */
export function mkdtempSync(prefix, options) {
  validatePath(prefix);
  const template = prefix + "XXXXXX";
  return encoded(check(fsCall(FS_MKDTEMP, template), "mkdtemp", template), encodingOf(options));
}

/** With `recursive` (deprecated in Node), as rmSync({ recursive: true }). */
export function rmdirSync(path, options) {
  validatePath(path);
  if (options?.recursive) return removeTree(path);
  check(fsCall(FS_RMDIR, path), "rmdir", path);
}

/** Removes a file, or with `recursive` a directory and what it holds; `force` ignores a missing
 *  path. A directory without `recursive` is ERR_FS_EISDIR, as in Node. */
export function rmSync(path, options) {
  validatePath(path);
  const st = fsStat(path, false);
  if (typeof st === "number") {
    if (options?.force && errnoName(st) === "ENOENT") return;
    throw systemError(st, "lstat", path);
  }
  if ((st[0] & S_IFMT) === S_IFDIR) {
    if (!options?.recursive) throw isADirectory(path);
    return removeTree(path);
  }
  check(fsUnlink(path), "rm", path);
}

function isADirectory(path) {
  const error = new Error("Path is a directory: rm returned EISDIR (is a directory) " + path);
  const errno = osConstants.errno.EISDIR;  /* positive here, as Node's SystemError has it */
  Object.defineProperty(error, "name", { value: "SystemError", writable: true, configurable: true });
  Object.assign(error, { code: "ERR_FS_EISDIR", info: { code: "EISDIR", message: "is a directory", path, syscall: "rm", errno }, errno, syscall: "rm", path });
  return error;
}

function removeTree(path) {
  const st = fsStat(path, false);
  if (typeof st === "number") throw systemError(st, "lstat", path);
  if ((st[0] & S_IFMT) === S_IFDIR) {
    const entries = check(fsReaddir(path), "scandir", path);
    for (let i = 0; i < entries.length; i += 2) removeTree(path + "/" + entries[i]);
    check(fsCall(FS_RMDIR, path), "rmdir", path);
  } else {
    check(fsUnlink(path), "rm", path);
  }
}

/* ---- file descriptors ------------------------------------------------------------- */

const FLAGS = new Set(["r", "rs", "sr", "r+", "rs+", "sr+", "w", "wx", "xw", "w+", "wx+", "xw+", "a", "ax", "xa", "as", "sa", "a+",
  "ax+", "xa+", "as+", "sa+"]);

function validateFd(fd) {
  if (typeof fd !== "number") throw invalidArgType("fd", "of type number", fd);
  if (!Number.isInteger(fd) || fd < 0 || fd > 2147483647) throw outOfRange("fd", ">= 0 && <= 2147483647", fd);
}

export function openSync(path, flags, mode) {
  validatePath(path);
  flags ??= "r";
  if (typeof flags !== "number" && !FLAGS.has(flags)) throw invalidArgValue("flags", "is invalid", flags);
  return checkCount(fsOpen(path, flags, modeOf(mode, 0o666)), "open", path);
}

export function closeSync(fd) {
  validateFd(fd);
  check(fsClose(fd), "close");
}

/** writeSync(fd, buffer, offset?, length?, position?) or writeSync(fd, string, position?, encoding?):
 *  the bytes written. A position that isn't a number writes at the current offset. */
export function writeSync(fd, data, offsetOrPosition, lengthOrEncoding, position) {
  validateFd(fd);
  let bytes, offset = 0, length, at;
  if (ArrayBuffer.isView(data)) {
    bytes = data;
    offset = offsetOrPosition ?? 0;
    length = lengthOrEncoding ?? bytes.byteLength - offset;
    at = position;
  } else if (typeof data === "string") {
    bytes = Buffer.from(data, lengthOrEncoding ?? "utf8");
    length = bytes.length;
    at = offsetOrPosition;
  } else {
    throw invalidArgType("buffer", "of type string or an instance of Buffer, TypedArray, or DataView", data);
  }
  return checkCount(fsWrite(fd, bytes, offset, length, typeof at === "number" ? at : -1), "write");
}

/** readSync(fd, buffer, offset, length, position) or readSync(fd, buffer, { offset, length, position }):
 *  the bytes read, 0 at the end of the file. */
export function readSync(fd, buffer, offset, length, position) {
  validateFd(fd);
  if (!ArrayBuffer.isView(buffer)) throw invalidArgType("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
  if (offset !== null && typeof offset === "object") ({ offset, length, position } = offset);
  offset ??= 0;
  length ??= buffer.byteLength - offset;
  return checkCount(fsRead(fd, buffer, offset, length, typeof position === "number" ? position : -1), "read");
}

/* ---- the callback API: the synchronous call, its outcome on a later tick ------------ */

function later(fn, args, callback) {
  validateFunction(callback, "cb");
  let result, error = null;
  try {
    result = fn(...args);
  } catch (e) {
    error = e;
  }
  process.nextTick(() => (error ? callback(error) : callback(null, result)));
}

const withCallback = (fn) => (path, options, callback) => {
  if (typeof options === "function") later(fn, [path], options);
  else later(fn, [path, options], callback);
};

export const readFile = withCallback(readFileSync);
export const stat = withCallback(statSync);
export const lstat = withCallback(lstatSync);
export const readdir = withCallback(readdirSync);

export function writeFile(path, data, options, callback) {
  if (typeof options === "function") later(writeFileSync, [path, data], options);
  else later(writeFileSync, [path, data, options], callback);
}

export function unlink(path, callback) {
  later(unlinkSync, [path], callback);
}

export const realpath = withCallback(realpathSync);
realpath.native = withCallback(realpathSync.native);
export const mkdir = withCallback(mkdirSync);
export const open = (path, flags, mode, callback) => {
  if (typeof flags === "function") later(openSync, [path], flags);
  else if (typeof mode === "function") later(openSync, [path, flags], mode);
  else later(openSync, [path, flags, mode], callback);
};
export const close = (fd, callback = () => {}) => later(closeSync, [fd], callback);
export const utimes = (path, atime, mtime, callback) => later(utimesSync, [path, atime, mtime], callback);

/* the callback last, after the arguments given (optional ones may be left out) */
const callbackLast = (fn) => (...args) => {
  const callback = args.pop();
  later(fn, args, callback);
};

export const appendFile = callbackLast(appendFileSync);
export const rename = callbackLast(renameSync);
export const link = callbackLast(linkSync);
export const symlink = callbackLast(symlinkSync);
export const readlink = callbackLast(readlinkSync);
export const copyFile = callbackLast(copyFileSync);
export const access = callbackLast(accessSync);
export const chmod = callbackLast(chmodSync);
export const fchmod = callbackLast(fchmodSync);
export const chown = callbackLast(chownSync);
export const lchown = callbackLast(lchownSync);
export const fchown = callbackLast(fchownSync);
export const fstat = callbackLast(fstatSync);
export const fsync = callbackLast(fsyncSync);
export const fdatasync = callbackLast(fdatasyncSync);
export const ftruncate = callbackLast(ftruncateSync);
export const truncate = callbackLast(truncateSync);
export const futimes = callbackLast(futimesSync);
export const lutimes = callbackLast(lutimesSync);
export const mkdtemp = callbackLast(mkdtempSync);
export const rmdir = callbackLast(rmdirSync);
export const rm = callbackLast(rmSync);

/** Deprecated in Node: the callback gets only whether the path exists. */
export function exists(path, callback) {
  validateFunction(callback, "cb");
  const result = existsSync(path);
  process.nextTick(() => callback(result));
}

/** read(fd, buffer, offset, length, position, callback), or read(fd, buffer, options, callback):
 *  the callback gets the bytes read and the buffer. */
export function read(fd, buffer, ...rest) {
  const callback = rest.pop();
  validateFunction(callback, "cb");
  let bytesRead, error = null;
  try {
    bytesRead = readSync(fd, buffer, ...rest);
  } catch (e) {
    error = e;
  }
  process.nextTick(() => (error ? callback(error) : callback(null, bytesRead, buffer)));
}

/** write(fd, buffer, offset?, length?, position?, callback) or write(fd, string, position?,
 *  encoding?, callback): the callback gets the bytes written and the data. */
export function write(fd, data, ...rest) {
  const callback = rest.pop();
  validateFunction(callback, "cb");
  let written, error = null;
  try {
    written = writeSync(fd, data, ...rest);
  } catch (e) {
    error = e;
  }
  process.nextTick(() => (error ? callback(error) : callback(null, written, data)));
}

/* ---- read streams --------------------------------------------------------------- */

/** A file read a chunk at a time, from `start` to `end` (inclusive), as Node's; or with `fd`, an
 *  open descriptor's, from its current position unless `start` says (process.stdin's, for a file).
 *  A function, as Node's is: callable without new, and graceful-fs calls it on its own instances
 *  (apply). */
export function ReadStream(path, options) {
  if (!(this instanceof ReadStream)) return new ReadStream(path, options);
  if (typeof options === "string") options = { encoding: options };
  options = { ...options };
  this.autoClose = options.autoClose ?? true;
  Readable.call(this, { highWaterMark: options.highWaterMark ?? 64 * 1024, encoding: options.encoding, emitClose: options.emitClose ?? true, autoDestroy: this.autoClose });
  this.fd = options.fd ?? null;
  if (this.fd === null) validatePath(path);
  else validateFd(this.fd);
  this.path = path;
  this.start = options.start;
  this.end = options.end ?? Infinity;
  this.pos = options.start ?? (this.fd === null ? 0 : undefined);
  this.bytesRead = 0;
  this.pending = this.fd === null;
  /* opened on the next tick, as Node's: a missing file is an error even if nothing reads */
  if (this.pending) {
    process.nextTick(() => {
      const r = fsStat(path, true);
      if (typeof r === "number") return this.destroy(systemError(r, "open", path));
      this.pending = false;
      this.emit("open");
      this.emit("ready");
    });
  }
}
Object.setPrototypeOf(ReadStream.prototype, Readable.prototype);
Object.setPrototypeOf(ReadStream, Readable);

/* a chunk on a later tick, as Node's read (on libuv's thread pool) delivers it: each read a chunk */
ReadStream.prototype._read = function _read() {
  /* a descriptor read from where it is counts its bytes from there */
  const want = Math.min(this.readableHighWaterMark, this.end + 1 - (this.pos ?? this.bytesRead));
  if (want <= 0) return this.push(null);
  let chunk;
  if (this.fd === null) chunk = fsReadAt(this.path, this.pos, want);
  else {
    const buffer = Buffer.allocUnsafe(want);
    const n = fsRead(this.fd, buffer, 0, want, this.pos ?? -1);
    chunk = n < 0 ? n : buffer.subarray(0, n);
  }
  process.nextTick(() => {
    if (typeof chunk === "number") return this.destroy(systemError(chunk, "read", this.path));
    if (chunk.length === 0) return this.push(null);
    if (this.pos !== undefined) this.pos += chunk.length;
    this.bytesRead += chunk.length;
    this.push(chunk);
  });
};

/* a descriptor it was given is closed with it, unless autoClose is false */
ReadStream.prototype._destroy = function _destroy(err, cb) {
  if (this.fd !== null && this.autoClose) {
    const r = fsClose(this.fd);
    this.fd = null;
    if (typeof r === "number" && r < 0 && !err) err = systemError(r, "close");
  }
  cb(err);
};

export function createReadStream(path, options) {
  return new ReadStream(path, options);
}

/* node:fs/promises, which imports this module: read when used, not while the modules load */
export { default as promises } from "./fs_promises.js";
import promises from "./fs_promises.js";

/* ---- write streams -------------------------------------------------------------- */

/** A file written chunk by chunk, from `start` (else from the beginning, or the end with flags
 *  "a"). A function, as Node's is (graceful-fs calls it with apply). The file is opened when the
 *  stream is made; "open" and "ready", or the open's error, come on the next tick, as Node's. */
export function WriteStream(path, options) {
  if (!(this instanceof WriteStream)) return new WriteStream(path, options);
  if (typeof options === "string") options = { encoding: options };
  options = { ...options };
  Writable.call(this, {
    highWaterMark: options.highWaterMark, defaultEncoding: options.encoding ?? "utf8", decodeStrings: true,
    emitClose: options.emitClose ?? true, autoDestroy: options.autoClose ?? true,
  });
  this.fd = null;
  this.flags = options.flags ?? "w";
  this.mode = options.mode ?? 0o666;
  this.start = options.start;
  this.pos = options.start;
  this.bytesWritten = 0;
  this.pending = true;
  if (typeof options.fd === "number") {
    this.path = undefined;
    this.fd = options.fd;
    this.pending = false;
    return;
  }
  validatePath(path);
  this.path = path;
  const fd = fsOpen(path, this.flags, modeOf(this.mode, 0o666));
  process.nextTick(() => {
    if (fd < 0) return this.destroy(systemError(fd, "open", path));
    this.fd = fd;
    this.pending = false;
    this.emit("open", fd);
    this.emit("ready");
  });
}
Object.setPrototypeOf(WriteStream.prototype, Writable.prototype);
Object.setPrototypeOf(WriteStream, Writable);

WriteStream.prototype._write = function _write(chunk, encoding, callback) {
  if (this.fd === null) return this.once("open", () => this._write(chunk, encoding, callback));
  const n = fsWrite(this.fd, chunk, 0, chunk.length, this.pos ?? -1);
  if (n < 0) return process.nextTick(callback, systemError(n, "write"));
  this.bytesWritten += n;
  if (this.pos !== undefined) this.pos += n;
  process.nextTick(callback);
};

WriteStream.prototype._destroy = function _destroy(error, callback) {
  if (this.fd === null || this.fd < 0) return callback(error);
  const r = fsClose(this.fd);
  this.fd = null;
  callback(error ?? (typeof r === "number" ? systemError(r, "close") : null));
};

/** Ends the stream, then the callback once it has closed. */
WriteStream.prototype.close = function close(callback) {
  if (callback) {
    if (this.closed) process.nextTick(callback);
    else this.once("close", callback);
  }
  if (!this.writableEnded) this.end();
  else if (!this.destroyed) this.destroy();
};
WriteStream.prototype.destroySoon = WriteStream.prototype.end;

export function createWriteStream(path, options) {
  return new WriteStream(path, options);
}

/* ---- readv, writev, statfs, and the features in modules of their own ------------------- */

/* the buffers, in turn, from a position (or the current offset): the bytes moved */
function vectored(fn, syscall, fd, buffers, position) {
  validateFd(fd);
  if (!Array.isArray(buffers)) throw invalidArgType("buffers", "an instance of ArrayBufferView[]", buffers);
  let total = 0;
  let at = typeof position === "number" ? position : -1;
  for (const buffer of buffers) {
    if (!ArrayBuffer.isView(buffer)) throw invalidArgType("buffers", "an instance of ArrayBufferView[]", buffers);
    const n = checkCount(fn(fd, buffer, 0, buffer.byteLength, at), syscall);
    total += n;
    if (at >= 0) at += n;
    if (n < buffer.byteLength) break;  /* the end of the file */
  }
  return total;
}

/** readvSync(fd, buffers[, position]): the bytes read into the buffers, in turn. */
export function readvSync(fd, buffers, position) {
  return vectored(fsRead, "read", fd, buffers, position);
}

/** writevSync(fd, buffers[, position]): the bytes written from the buffers, in turn. */
export function writevSync(fd, buffers, position) {
  return vectored(fsWrite, "write", fd, buffers, position);
}

export function readv(fd, buffers, position, cb) {
  if (typeof position === "function") [position, cb] = [undefined, position];
  validateFunction(cb, "cb");
  later(() => readvSync(fd, buffers, position), [], (err, n) => cb(err, n, buffers));
}

export function writev(fd, buffers, position, cb) {
  if (typeof position === "function") [position, cb] = [undefined, position];
  validateFunction(cb, "cb");
  later(() => writevSync(fd, buffers, position), [], (err, n) => cb(err, n, buffers));
}

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

/* the names Node keeps for its streams */
export const FileReadStream = ReadStream;
export const FileWriteStream = WriteStream;

/* the platform's (libuv's, then the C library's), in Node's order */
export const constants = { __proto__: null };
{
  const flat = fsConstants();
  for (let i = 0; i < flat.length; i += 2) constants[flat[i]] = flat[i + 1];
}

const fs = {
  constants, readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, statSync, lstatSync, readdirSync, readFile, writeFile,
  unlink, stat, lstat, readdir, createReadStream, ReadStream, Stats, Dirent, realpathSync, realpath, mkdirSync, mkdir, utimesSync,
  utimes, openSync, open, closeSync, close, writeSync, readSync, read, write, appendFile, exists, createWriteStream, WriteStream,
  renameSync, rename, linkSync, link, symlinkSync, symlink, readlinkSync, readlink, copyFileSync, copyFile, accessSync, access,
  chmodSync, chmod, fchmodSync, fchmod, chownSync, chown, lchownSync, lchown, fchownSync, fchown, fstatSync, fstat, fsyncSync, fsync,
  fdatasyncSync, fdatasync, ftruncateSync, ftruncate, truncateSync, truncate, futimesSync, futimes, lutimesSync, lutimes,
  mkdtempSync, mkdtemp, rmdirSync, rmdir, rmSync, rm, readvSync, readv, writevSync, writev, statfsSync, statfs, Dir, opendirSync,
  opendir, cpSync, cp, globSync, glob, watch, watchFile, unwatchFile, openAsBlob, FileReadStream, FileWriteStream,
  get promises() {
    return promises;
  },
};

/* access()'s modes on fs itself: hidden, deprecated getters in Node 24 (DEP0176), warning once */
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
    set(v) {
      Object.defineProperty(fs, name, { value: v, writable: true, enumerable: true, configurable: true });
    },
  });
}

export default fs;
