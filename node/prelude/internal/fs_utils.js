// node:fs's argument validation, as Node's lib/internal/fs/utils.js: paths (a string, a Buffer or
// a file: URL, without null bytes), file descriptors, flags, modes, offsets and lengths,
// positions, options, timestamps, and rm's and rmdir's options, with Node's errors. A validated
// path is given as the string the host primitives take.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { fsConstants } from "visaljs:host";
import { codeError } from "./errors.js";
import { codes, fsSystemError } from "./streams/errors.js";
import {
  kEmptyObject, validateAbortSignal, validateBoolean, validateBuffer, validateFunction, validateInt32, validateInteger, validateObject,
  validateUint32,
} from "./streams/validators.js";

const { ERR_INCOMPATIBLE_OPTION_PAIR, ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE } = codes;

/* the platform's fs constants, as the host gives them */
const C = (() => {
  const out = { __proto__: null };
  const flat = fsConstants();
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
})();
const F_OK = C.F_OK ?? 0, W_OK = C.W_OK ?? 0, R_OK = C.R_OK ?? 0, X_OK = C.X_OK ?? 0;
const { COPYFILE_EXCL = 1, COPYFILE_FICLONE = 2, COPYFILE_FICLONE_FORCE = 4, O_APPEND, O_CREAT, O_EXCL, O_RDONLY, O_RDWR, O_SYNC, O_TRUNC,
  O_WRONLY } = C;

export const kMinimumAccessMode = Math.min(F_OK, W_OK, R_OK, X_OK);
export const kMaximumAccessMode = F_OK | W_OK | R_OK | X_OK;
const kDefaultCopyMode = 0;
const kMinimumCopyMode = Math.min(kDefaultCopyMode, COPYFILE_EXCL, COPYFILE_FICLONE, COPYFILE_FICLONE_FORCE);
const kMaximumCopyMode = COPYFILE_EXCL | COPYFILE_FICLONE | COPYFILE_FICLONE_FORCE;

/* most platforms don't read or write 2 GiB or more at once */
export const kIoMaxLength = 2 ** 31 - 1;
export const kMaxUserId = 2 ** 32 - 1;

const isUint8Array = (value) => value instanceof Uint8Array;
const isWindows = process.platform === "win32";

export function assertEncoding(encoding) {
  if (encoding && !Buffer.isEncoding(encoding)) throw new ERR_INVALID_ARG_VALUE("encoding", encoding, "is invalid encoding");
}

export function copyObject(source) {
  const target = {};
  for (const key in source) target[key] = source[key];
  return target;
}

export function getOptions(options, defaultOptions = kEmptyObject) {
  if (options == null || typeof options === "function") return defaultOptions;
  if (typeof options === "string") {
    defaultOptions = { ...defaultOptions };
    defaultOptions.encoding = options;
    options = defaultOptions;
  } else if (typeof options !== "object") {
    throw new ERR_INVALID_ARG_TYPE("options", ["string", "Object"], options);
  }
  if (options.encoding !== "buffer") assertEncoding(options.encoding);
  if (options.signal !== undefined) validateAbortSignal(options.signal, "options.signal");
  return options;
}

export function stringToFlags(flags, name = "flags") {
  if (typeof flags === "number") {
    validateInt32(flags, name);
    return flags + 0;  /* -0 is +0 */
  }
  if (flags == null) return O_RDONLY;
  switch (flags) {
    case "r": return O_RDONLY;
    case "rs":
    case "sr": return O_RDONLY | O_SYNC;
    case "r+": return O_RDWR;
    case "rs+":
    case "sr+": return O_RDWR | O_SYNC;
    case "w": return O_TRUNC | O_CREAT | O_WRONLY;
    case "wx":
    case "xw": return O_TRUNC | O_CREAT | O_WRONLY | O_EXCL;
    case "w+": return O_TRUNC | O_CREAT | O_RDWR;
    case "wx+":
    case "xw+": return O_TRUNC | O_CREAT | O_RDWR | O_EXCL;
    case "a": return O_APPEND | O_CREAT | O_WRONLY;
    case "ax":
    case "xa": return O_APPEND | O_CREAT | O_WRONLY | O_EXCL;
    case "as":
    case "sa": return O_APPEND | O_CREAT | O_WRONLY | O_SYNC;
    case "a+": return O_APPEND | O_CREAT | O_RDWR;
    case "ax+":
    case "xa+": return O_APPEND | O_CREAT | O_RDWR | O_EXCL;
    case "as+":
    case "sa+": return O_APPEND | O_CREAT | O_RDWR | O_SYNC;
  }
  throw new ERR_INVALID_ARG_VALUE("flags", flags);
}

/** a Date or a number (seconds), or a string of one, as a fractional UNIX timestamp */
export function toUnixTimestamp(time, name = "time") {
  if (typeof time === "string" && +time == time) return +time;
  if (Number.isFinite(time)) {
    if (time < 0) return Date.now() / 1000;
    return time;
  }
  if (time instanceof Date) return time.getTime() / 1000;
  throw new ERR_INVALID_ARG_TYPE(name, ["Date", "Time in seconds"], time);
}

export function validateOffsetLengthRead(offset, length, bufferLength) {
  if (offset < 0) throw new ERR_OUT_OF_RANGE("offset", ">= 0", offset);
  if (length < 0) throw new ERR_OUT_OF_RANGE("length", ">= 0", length);
  if (offset + length > bufferLength) throw new ERR_OUT_OF_RANGE("length", `<= ${bufferLength - offset}`, length);
}

export function validateOffsetLengthWrite(offset, length, byteLength) {
  if (offset > byteLength) throw new ERR_OUT_OF_RANGE("offset", `<= ${byteLength}`, offset);
  if (length > byteLength - offset) throw new ERR_OUT_OF_RANGE("length", `<= ${byteLength - offset}`, length);
  if (length < 0) throw new ERR_OUT_OF_RANGE("length", ">= 0", length);
  validateInt32(length, "length", 0);
}

export function validatePath(path, propName = "path") {
  if (typeof path !== "string" && !isUint8Array(path)) throw new ERR_INVALID_ARG_TYPE(propName, ["string", "Buffer", "URL"], path);
  if (typeof path === "string" ? !path.includes("\u0000") : !path.includes(0)) return;
  throw new ERR_INVALID_ARG_VALUE(propName, path, "must be a string, Uint8Array, or URL without null bytes");
}

/* url's fileURLToPath, for a path given as a file: URL (node:url's, without linking the module): the
 * scheme checked, no host (a UNC server on Windows), no encoded slash, then decoded */
function fileURLToPath(url) {
  if (url.protocol !== "file:") throw codeError(TypeError, "ERR_INVALID_URL_SCHEME", "The URL must be of scheme file");
  let pathname = url.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] !== "%") continue;
    const third = pathname.codePointAt(n + 2) | 0x20;
    if ((pathname[n + 1] === "2" && third === 102) || (isWindows && pathname[n + 1] === "5" && third === 99)) {
      throw codeError(TypeError, "ERR_INVALID_FILE_URL_PATH",
        `File URL path must not include encoded ${isWindows ? "\\ or / characters" : "/ characters"}`);
    }
  }
  if (!isWindows) {
    if (url.hostname !== "") throw codeError(TypeError, "ERR_INVALID_FILE_URL_HOST", `File URL host must be "localhost" or empty on ${process.platform}`);
    return pathname.includes("%") ? decodeURIComponent(pathname) : pathname;
  }
  pathname = pathname.replace(/\//g, "\\");
  if (pathname.includes("%")) pathname = decodeURIComponent(pathname);
  if (url.hostname !== "") return `\\\\${url.hostname}${pathname}`;
  const letter = pathname.charCodeAt(1) | 0x20;
  if (letter < 97 || letter > 122 || pathname.charCodeAt(2) !== 58) throw codeError(TypeError, "ERR_INVALID_FILE_URL_PATH", "File URL path must be absolute");
  return pathname.slice(1);
}

/** url's toPathIfFileURL: a URL as its path, anything else as it is */
export function toPathIfFileURL(fileURLOrPath) {
  const isURL = fileURLOrPath != null && fileURLOrPath.href && fileURLOrPath.protocol && fileURLOrPath.auth === undefined &&
    fileURLOrPath.path === undefined;
  return isURL ? fileURLToPath(fileURLOrPath) : fileURLOrPath;
}

/** Node's getValidatedPath; the path as the host primitives take it: a string (a Buffer's bytes
 *  as UTF-8) */
export function getValidatedPath(fileURLOrPath, propName = "path") {
  const path = toPathIfFileURL(fileURLOrPath);
  validatePath(path, propName);
  return typeof path === "string" ? path : Buffer.from(path.buffer, path.byteOffset, path.byteLength).toString("utf8");
}

export function getValidatedFd(fd, propName = "fd") {
  if (Object.is(fd, -0)) return 0;
  validateInt32(fd, propName, 0);
  return fd;
}

export function validateBufferArray(buffers, propName = "buffers") {
  if (!Array.isArray(buffers)) throw new ERR_INVALID_ARG_TYPE(propName, "ArrayBufferView[]", buffers);
  for (let i = 0; i < buffers.length; i++) {
    if (!ArrayBuffer.isView(buffers[i])) throw new ERR_INVALID_ARG_TYPE(propName, "ArrayBufferView[]", buffers);
  }
  return buffers;
}

let nonPortableTemplateWarn = true;
export function warnOnNonPortableTemplate(template) {
  if (nonPortableTemplateWarn &&
    ((typeof template === "string" && template.endsWith("X")) || (typeof template !== "string" && template.at(-1) === 0x58))) {
    process.emitWarning("mkdtemp() templates ending with X are not portable. For details see: https://nodejs.org/api/fs.html");
    nonPortableTemplateWarn = false;
  }
}

const defaultCpOptions = {
  dereference: false, errorOnExist: false, filter: undefined, force: true, preserveTimestamps: false, recursive: false, verbatimSymlinks: false,
};
export const defaultRmOptions = { recursive: false, force: false, retryDelay: 100, maxRetries: 0 };
const defaultRmdirOptions = { retryDelay: 100, maxRetries: 0, recursive: false };

export function validateCpOptions(options) {
  if (options === undefined) return { ...defaultCpOptions };
  validateObject(options, "options");
  options = { ...defaultCpOptions, ...options };
  validateBoolean(options.dereference, "options.dereference");
  validateBoolean(options.errorOnExist, "options.errorOnExist");
  validateBoolean(options.force, "options.force");
  validateBoolean(options.preserveTimestamps, "options.preserveTimestamps");
  validateBoolean(options.recursive, "options.recursive");
  validateBoolean(options.verbatimSymlinks, "options.verbatimSymlinks");
  options.mode = getValidMode(options.mode, "copyFile");
  if (options.dereference === true && options.verbatimSymlinks === true) throw new ERR_INCOMPATIBLE_OPTION_PAIR("dereference", "verbatimSymlinks");
  if (options.filter !== undefined) validateFunction(options.filter, "options.filter");
  return options;
}

/** rm's EISDIR: a directory without recursive */
export function rmIsDirectory(path) {
  return fsSystemError("ERR_FS_EISDIR", "Path is a directory", { code: "EISDIR", message: "is a directory", path, syscall: "rm", errno: C.EISDIR ?? 21 });
}

export function validateRmdirOptions(options, defaults = defaultRmdirOptions) {
  if (options === undefined) return defaults;
  validateObject(options, "options");
  options = { ...defaults, ...options };
  validateBoolean(options.recursive, "options.recursive");
  validateInt32(options.retryDelay, "options.retryDelay", 0);
  validateUint32(options.maxRetries, "options.maxRetries");
  return options;
}

/** rm's options, checked before its lstat (validateRmOptions's first part) */
export function validateRmOptionsShape(options) {
  options = validateRmdirOptions(options, defaultRmOptions);
  validateBoolean(options.force, "options.force");
  return options;
}

let recursiveRmdirWarned;
export function emitRecursiveRmdirWarning() {
  if (recursiveRmdirWarned === undefined) recursiveRmdirWarned = process.noDeprecation;
  if (!recursiveRmdirWarned) {
    process.emitWarning("In future versions of Node.js, fs.rmdir(path, { recursive: true }) will be removed. Use fs.rm(path, { recursive: true }) instead",
      "DeprecationWarning", "DEP0147");
    recursiveRmdirWarned = true;
  }
}

export function getValidMode(mode, type) {
  let min = kMinimumAccessMode;
  let max = kMaximumAccessMode;
  let def = F_OK;
  if (type === "copyFile") {
    min = kMinimumCopyMode;
    max = kMaximumCopyMode;
    def = mode || kDefaultCopyMode;
  }
  if (mode == null) return def;
  validateInteger(mode, "mode", min, max);
  return mode;
}

export function validateStringAfterArrayBufferView(buffer, name) {
  if (typeof buffer !== "string") throw new ERR_INVALID_ARG_TYPE(name, ["string", "Buffer", "TypedArray", "DataView"], buffer);
}

export function validatePosition(position, name, length) {
  if (typeof position === "number") {
    validateInteger(position, name, -1);
  } else if (typeof position === "bigint") {
    /* BigInt from the value itself: naming it would link BigInt into every program that uses fs */
    const big = position.constructor;
    const maxPosition = big(2) ** big(63) - big(1) - big(length);
    if (!(position >= big(-1) && position <= maxPosition)) throw new ERR_OUT_OF_RANGE(name, `>= -1 && <= ${maxPosition}`, position);
  } else {
    throw new ERR_INVALID_ARG_TYPE(name, ["integer", "bigint"], position);
  }
}

/** a mode: a number, or an octal string (parseFileMode) */
export function parseFileMode(value, name, def) {
  value ??= def;
  if (typeof value === "string") {
    if (!/^[0-7]+$/.test(value)) throw new ERR_INVALID_ARG_VALUE(name, value, "must be a 32-bit unsigned integer or an octal string");
    value = Number.parseInt(value, 8);
  }
  validateUint32(value, name);
  return value;
}

export { isWindows, validateBuffer };
