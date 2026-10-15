// node:fs/promises: node:fs's synchronous calls, their outcome as a promise.
// The I/O happens when the function is called, not on libuv's thread pool as in Node.
import {
  constants, accessSync, chmodSync, chownSync, closeSync, copyFileSync, fsyncSync, lchownSync, linkSync, lstatSync, lutimesSync, mkdirSync,
  mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync,
  truncateSync, unlinkSync, utimesSync, writeFileSync, writeSync, statfsSync,
} from "./fs.js";
import { codeError } from "./internal/errors.js";
import { features, lazyFunction } from "./internal/features.js";
import { getOptions, validateStringAfterArrayBufferView } from "./internal/fs_utils.js";
import { AbortError } from "./internal/streams/errors.js";
import { validateAbortSignal, validateBoolean } from "./internal/streams/validators.js";
import { resolve } from "./path.js";

const promised = (fn) => async (...args) => fn(...args);

function checkAborted(signal) {
  if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });
}

/* with a signal, a turn of the event loop before the I/O, as Node's opens on its thread pool: an
 * abort the program queues meanwhile stops it */
async function abortable(signal) {
  checkAborted(signal);
  if (signal) {
    await new Promise((resolve) => setImmediate(resolve));
    checkAborted(signal);
  }
}

/* a FileHandle given as the path: its own method (fs_filehandle.js) */
const isFileHandle = (path) => features.FileHandle !== undefined && path instanceof features.FileHandle;

export async function readFile(path, options) {
  options = getOptions(options, { flag: "r" });
  validateAbortSignal(options.signal, "options.signal");
  if (isFileHandle(path)) return path.readFile(options);
  await abortable(options.signal);
  return readFileSync(path, options);
}

const isIterable = (data) =>
  data != null && typeof data === "object" && (typeof data[Symbol.asyncIterator] === "function" || typeof data[Symbol.iterator] === "function");

/** The data written: a string, bytes, or an iterable or stream of them. */
export async function writeFile(path, data, options) {
  options = getOptions(options, { encoding: "utf8", mode: 0o666, flag: "w", flush: false });
  validateBoolean(options.flush ?? false, "options.flush");
  const iterable = !ArrayBuffer.isView(data) && isIterable(data);
  if (!ArrayBuffer.isView(data) && !iterable) {
    validateStringAfterArrayBufferView(data, "data");
    data = Buffer.from(data, options.encoding || "utf8");
  }
  validateAbortSignal(options.signal, "options.signal");
  if (isFileHandle(path)) return path.writeFile(data, options);
  await abortable(options.signal);
  if (!iterable) return writeFileSync(path, data, options);
  const fd = openSync(path, options.flag || "w", options.mode);
  try {
    for await (const chunk of data) {
      checkAborted(options.signal);
      const bytes = ArrayBuffer.isView(chunk) ? chunk : Buffer.from(chunk, options.encoding || "utf8");
      for (let off = 0; off < bytes.byteLength;) off += writeSync(fd, bytes, off, bytes.byteLength - off, null);
    }
    if (options.flush) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function appendFile(path, data, options) {
  options = { ...getOptions(options, { encoding: "utf8", mode: 0o666, flag: "a" }) };
  options.flag ||= "a";
  return writeFile(path, data, options);
}
export const stat = promised(statSync);
export const lstat = promised(lstatSync);
export const readdir = promised(readdirSync);
export const unlink = promised(unlinkSync);
export const realpath = promised(realpathSync);
export const mkdir = promised(mkdirSync);
export const utimes = promised(utimesSync);

export const access = promised(accessSync);
export const rename = promised(renameSync);
export const copyFile = promised(copyFileSync);
export const link = promised(linkSync);
export const symlink = promised(symlinkSync);
export const readlink = promised(readlinkSync);
export const chmod = promised(chmodSync);
export const chown = promised(chownSync);
export const lchown = promised(lchownSync);
export const lutimes = promised(lutimesSync);
export const truncate = promised(truncateSync);
export const mkdtemp = promised(mkdtempSync);

/** mkdtemp's directory with a way to remove it, and what it holds: remove(), or an `await using`
 *  declaration (Symbol.asyncDispose). */
export async function mkdtempDisposable(prefix, options) {
  const path = mkdtempSync(prefix, options);
  const fullPath = resolve(process.cwd(), `${path}`);
  const remove = async () => rmSync(fullPath, { recursive: true, force: true });
  return { path, remove, [Symbol.asyncDispose]() { return remove(); } };
}
export const rmdir = promised(rmdirSync);
export const rm = promised(rmSync);

/* read when called: fs.js and this module import each other, and fs.js's consts may not be set yet */
export const statfs = async (...args) => statfsSync(...args);
export { constants };

/* lchmod: macOS's only, as Node's */
export async function lchmod() {
  throw codeError(Error, "ERR_METHOD_NOT_IMPLEMENTED", "The lchmod() method is not implemented");
}

/* their own modules, linked when the program names them (internal/features.js) */
export const open = lazyFunction("promisesOpen", 3);
export const opendir = lazyFunction("opendirPromise", 2);
export const cp = lazyFunction("cpPromise", 3);
export const glob = lazyFunction("globPromise", 2);
export const watch = lazyFunction("watchPromise", 2);

export default {
  readFile, writeFile, appendFile, stat, lstat, readdir, unlink, realpath, mkdir, utimes, access, rename, copyFile, link, symlink, readlink,
  chmod, chown, lchown, lutimes, truncate, mkdtemp, mkdtempDisposable, rmdir, rm, statfs, lchmod, open, opendir, cp, glob, watch,
  get constants() {
    return constants;
  },
};
