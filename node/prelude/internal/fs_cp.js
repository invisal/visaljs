// fs.cp, cpSync and fs/promises' cp: files, directories (recursive) and symlinks copied, as Node's:
// its checks (the same file, a directory into itself, a directory onto a file and back), filter
// (async for cp), force and errorOnExist, dereference, preserveTimestamps, and symlinks made
// absolute unless verbatimSymlinks. Linked into programs that name them (internal/features.js).
import {
  copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync, utimesSync,
} from "../fs.js";
import { dirname, isAbsolute, resolve } from "../path.js";
import { codeError, invalidArgType } from "./errors.js";
import { features } from "./features.js";

function pathOf(value, name) {
  if (typeof value === "string") return value;
  if (value instanceof URL) return decodeURIComponent(value.pathname);
  throw invalidArgType(name, "of type string or an instance of Buffer or URL", value);
}

function optionsOf(options) {
  if (options === undefined) options = {};
  else if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
  const result = {
    dereference: false, errorOnExist: false, filter: undefined, force: true, mode: 0, preserveTimestamps: false, recursive: false,
    verbatimSymlinks: false, ...options,
  };
  for (const key of ["dereference", "errorOnExist", "force", "preserveTimestamps", "recursive", "verbatimSymlinks"]) {
    if (typeof result[key] !== "boolean") throw invalidArgType(`options.${key}`, "of type boolean", result[key]);
  }
  if (result.filter !== undefined && typeof result.filter !== "function") throw invalidArgType("options.filter", "of type function", result.filter);
  return result;
}

/* the destination's lstat, or null when it doesn't exist */
function statOrNull(path) {
  try {
    return lstatSync(path);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

const withSlash = (path) => (path.endsWith("/") ? path : path + "/");

/* Node's checks before copying: the same file, a directory onto a file and back, into itself */
function checkPaths(src, dest, srcStat, destStat, opts) {
  if (destStat && srcStat.ino === destStat.ino && srcStat.dev === destStat.dev) {
    throw codeError(Error, "ERR_FS_CP_EINVAL", `src and dest cannot be the same ${dest}`);
  }
  if (srcStat.isDirectory() && destStat && !destStat.isDirectory()) {
    throw codeError(Error, "ERR_FS_CP_DIR_TO_NON_DIR", `Cannot overwrite non-directory ${dest} with directory ${src}`);
  }
  if (!srcStat.isDirectory() && destStat?.isDirectory()) {
    throw codeError(Error, "ERR_FS_CP_NON_DIR_TO_DIR", `Cannot overwrite directory ${dest} with non-directory ${src}`);
  }
  if (srcStat.isDirectory()) {
    if (!opts.recursive) throw codeError(Error, "ERR_FS_EISDIR", `Recursive option not enabled, cannot copy a directory: ${withSlash(src)}`);
    if (withSlash(resolve(dest)).startsWith(withSlash(resolve(src)))) {
      throw codeError(Error, "ERR_FS_CP_EINVAL", `Cannot copy ${withSlash(src)} to a subdirectory of self ${dest}`);
    }
  }
}

/* Node's SystemError for a target that exists */
function existsError(dest) {
  const e = codeError(Error, "ERR_FS_CP_EEXIST", `Target already exists: cp returned EEXIST (${dest} already exists) ${dest}`);
  e.name = "SystemError";
  e.errno = 17;
  e.syscall = "cp";
  e.path = dest;
  e.info = { message: `${dest} already exists`, path: dest, syscall: "cp", errno: 17, code: "EEXIST" };
  return e;
}

function copyFile(src, dest, srcStat, destStat, opts) {
  if (destStat) {
    if (!opts.force) {
      if (opts.errorOnExist) throw existsError(dest);
      return;
    }
  }
  copyFileSync(src, dest, opts.mode);
  if (opts.preserveTimestamps) utimesSync(dest, srcStat.atime, srcStat.mtime);
}

function copyLink(src, dest, destStat, opts) {
  let target = readlinkSync(src);
  if (!opts.verbatimSymlinks && !isAbsolute(target)) target = resolve(dirname(src), target);
  if (destStat) unlinkSync(dest);
  symlinkSync(target, dest);
}

function special(srcStat, dest) {
  if (srcStat.isFIFO()) return codeError(Error, "ERR_FS_CP_FIFO_PIPE", `Cannot copy a FIFO pipe: ${dest}`);
  if (srcStat.isSocket()) return codeError(Error, "ERR_FS_CP_SOCKET", `Cannot copy a socket file: ${dest}`);
  return codeError(Error, "ERR_FS_CP_UNKNOWN", `Cannot copy an unknown file type: ${dest}`);
}

/* a filter's verdict: a boolean, or for cp a promise of one */
function verdict(filter, src, dest, sync) {
  if (!filter) return true;
  const result = filter(src, dest);
  if (sync && typeof result?.then === "function") {
    throw codeError(TypeError, "ERR_INVALID_RETURN_VALUE", 'Expected boolean to be returned from the "filter" function but got an instance of Promise.');
  }
  return result;
}

/* the copy: entries in a directory by lstat (links copied as links), as Node's */
function copySync(src, dest, srcStat, opts) {
  const destStat = statOrNull(dest);
  if (srcStat.isDirectory()) {
    if (!destStat) mkdirSync(dest, { mode: srcStat.mode & 0o7777 });
    for (const name of readdirSync(src)) {
      const s = `${src}/${name}`, d = `${dest}/${name}`;
      if (!verdict(opts.filter, s, d, true)) continue;
      const entryStat = lstatSync(s);
      checkPaths(s, d, entryStat, statOrNull(d), opts);
      copySync(s, d, entryStat, opts);
    }
  } else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) {
    copyFile(src, dest, srcStat, destStat, opts);
  } else if (srcStat.isSymbolicLink()) {
    copyLink(src, dest, destStat, opts);
  } else {
    throw special(srcStat, dest);
  }
}

async function copyAsync(src, dest, srcStat, opts) {
  const destStat = statOrNull(dest);
  if (srcStat.isDirectory()) {
    if (!destStat) mkdirSync(dest, { mode: srcStat.mode & 0o7777 });
    for (const name of readdirSync(src)) {
      const s = `${src}/${name}`, d = `${dest}/${name}`;
      if (!(await verdict(opts.filter, s, d, false))) continue;
      const entryStat = lstatSync(s);
      checkPaths(s, d, entryStat, statOrNull(d), opts);
      await copyAsync(s, d, entryStat, opts);
    }
  } else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) {
    copyFile(src, dest, srcStat, destStat, opts);
  } else if (srcStat.isSymbolicLink()) {
    copyLink(src, dest, destStat, opts);
  } else {
    throw special(srcStat, dest);
  }
}

/* the top level: dereference applies here, then the checks, then the copy */
function start(src, dest, opts) {
  const srcStat = opts.dereference ? statSync(src) : lstatSync(src);
  const destStat = statOrNull(dest);
  checkPaths(src, dest, srcStat, destStat, opts);
  if (srcStat.isDirectory() && destStat === null) mkdirSync(dirname(resolve(dest)), { recursive: true });
  return srcStat;
}

function cpSync(src, dest, options) {
  src = pathOf(src, "src");
  dest = pathOf(dest, "dest");
  const opts = optionsOf(options);
  if (!verdict(opts.filter, src, dest, true)) return;
  copySync(src, dest, start(src, dest, opts), opts);
}

async function cpPromise(src, dest, options) {
  src = pathOf(src, "src");
  dest = pathOf(dest, "dest");
  const opts = optionsOf(options);
  if (!(await verdict(opts.filter, src, dest, false))) return;
  await copyAsync(src, dest, start(src, dest, opts), opts);
}

function cp(src, dest, options, callback) {
  if (typeof options === "function") [options, callback] = [undefined, options];
  if (typeof callback !== "function") throw invalidArgType("cb", "of type function", callback);
  cpPromise(src, dest, options).then(() => callback(null), (err) => callback(err));
}

Object.assign(features, { cpSync, cp, cpPromise });
