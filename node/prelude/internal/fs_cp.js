// fs.cp, cpSync and fs/promises' cp, as Node's: cp is lib/internal/fs/cp/cp.js on node:fs/promises'
// calls, cpSync lib/internal/fs/cp/cp-sync.js, with its C++ helpers (src/node_file.cc's
// CpSyncCheckPaths, CpSyncOverrideFile and CpSyncCopyDir) here in JS, their checks and errors
// kept: cp's errors are SystemErrors, cpSync's the C++ helpers' plain ones. Linked into programs
// that name them (internal/features.js).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { errnoMessage, errnoName, fsRealpath, fsStat } from "visaljs:host";
import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync, utimesSync,
} from "../fs.js";
import promises from "../fs_promises.js";
import { dirname, isAbsolute, join, parse, resolve, sep } from "../path.js";
import { isPromise } from "../util_types.js";
import { codeError } from "./errors.js";
import { features } from "./features.js";
import { getValidatedPath, getValidMode, validateCpOptions } from "./fs_utils.js";
import { fsSystemError } from "./streams/errors.js";
import { validateFunction } from "./streams/validators.js";

/* the errno numbers of Node's cp errors: the same on Linux, macOS and Windows */
const EEXIST = 17, EINVAL = 22, EISDIR = 21, ENOTDIR = 20;

/* Node's SystemError of cp.js: "<prefix>: cp returned <code> (<message>) <path>" */
const PREFIXES = {
  ERR_FS_CP_DIR_TO_NON_DIR: "Cannot overwrite non-directory with directory",
  ERR_FS_CP_EEXIST: "Target already exists",
  ERR_FS_CP_EINVAL: "Invalid src or dest",
  ERR_FS_CP_FIFO_PIPE: "Cannot copy a FIFO pipe",
  ERR_FS_CP_NON_DIR_TO_DIR: "Cannot overwrite directory with non-directory",
  ERR_FS_CP_SOCKET: "Cannot copy a socket file",
  ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY: "Cannot overwrite symlink in subdirectory of self",
  ERR_FS_CP_UNKNOWN: "Cannot copy an unknown file type",
  ERR_FS_EISDIR: "Path is a directory",
};
const cpError = (key, context) => fsSystemError(key, PREFIXES[key], context);

/* ---- cp: lib/internal/fs/cp/cp.js ------------------------------------------------------- */

const { chmod, copyFile, lstat, mkdir, readlink, stat, symlink, unlink, utimes } = promises;

async function cpFn(src, dest, opts) {
  // Warn about using preserveTimestamps on 32-bit node
  if (opts.preserveTimestamps && process.arch === "ia32") {
    process.emitWarning("Using the preserveTimestamps option in 32-bit node is not recommended", "TimestampPrecisionWarning");
  }
  const stats = await checkPaths(src, dest, opts);
  const { srcStat, destStat, skipped } = stats;
  if (skipped) return;
  await checkParentPaths(src, srcStat, dest);
  return checkParentDir(destStat, src, dest, opts);
}

async function checkPaths(src, dest, opts) {
  if (opts.filter && !(await opts.filter(src, dest))) {
    return { __proto__: null, skipped: true };
  }
  const { 0: srcStat, 1: destStat } = await getStats(src, dest, opts);
  if (destStat) {
    if (areIdentical(srcStat, destStat)) {
      throw cpError("ERR_FS_CP_EINVAL", { message: "src and dest cannot be the same", path: dest, syscall: "cp", errno: EINVAL, code: "EINVAL" });
    }
    if (srcStat.isDirectory() && !destStat.isDirectory()) {
      throw cpError("ERR_FS_CP_DIR_TO_NON_DIR", {
        message: `cannot overwrite non-directory ${dest} with directory ${src}`, path: dest, syscall: "cp", errno: EISDIR, code: "EISDIR",
      });
    }
    if (!srcStat.isDirectory() && destStat.isDirectory()) {
      throw cpError("ERR_FS_CP_NON_DIR_TO_DIR", {
        message: `cannot overwrite directory ${dest} with non-directory ${src}`, path: dest, syscall: "cp", errno: ENOTDIR, code: "ENOTDIR",
      });
    }
  }

  if (srcStat.isDirectory() && isSrcSubdir(src, dest)) {
    throw cpError("ERR_FS_CP_EINVAL", {
      message: `cannot copy ${src} to a subdirectory of self ${dest}`, path: dest, syscall: "cp", errno: EINVAL, code: "EINVAL",
    });
  }
  return { __proto__: null, srcStat, destStat, skipped: false };
}

function areIdentical(srcStat, destStat) {
  return destStat.ino && destStat.dev && destStat.ino === srcStat.ino && destStat.dev === srcStat.dev;
}

/* (Node's take bigint stats: an inode number past 2^53 is rare, and BigIntStats links BigInt) */
function getStats(src, dest, opts) {
  const statFunc = opts.dereference ? (file) => stat(file) : (file) => lstat(file);
  return Promise.all([
    statFunc(src),
    statFunc(dest).then(undefined, (err) => {
      if (err.code === "ENOENT") return null;
      throw err;
    }),
  ]);
}

async function checkParentDir(destStat, src, dest, opts) {
  const destParent = dirname(dest);
  const dirExists = await pathExists(destParent);
  if (dirExists) return getStatsForCopy(destStat, src, dest, opts);
  await mkdir(destParent, { recursive: true });
  return getStatsForCopy(destStat, src, dest, opts);
}

function pathExists(dest) {
  return stat(dest).then(() => true, (err) => (err.code === "ENOENT" ? false : Promise.reject(err)));
}

// Recursively check if dest parent is a subdirectory of src.
// It works for all file types including symlinks since it
// checks the src and dest inodes. It starts from the deepest
// parent and stops once it reaches the src parent or the root path.
async function checkParentPaths(src, srcStat, dest) {
  const srcParent = resolve(dirname(src));
  const destParent = resolve(dirname(dest));
  if (destParent === srcParent || destParent === parse(destParent).root) {
    return;
  }
  let destStat;
  try {
    destStat = await stat(destParent);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  if (areIdentical(srcStat, destStat)) {
    throw cpError("ERR_FS_CP_EINVAL", {
      message: `cannot copy ${src} to a subdirectory of self ${dest}`, path: dest, syscall: "cp", errno: EINVAL, code: "EINVAL",
    });
  }
  return checkParentPaths(src, srcStat, destParent);
}

const normalizePathToArray = (path) => resolve(path).split(sep).filter(Boolean);

// Return true if dest is a subdir of src, otherwise false.
// It only checks the path strings.
function isSrcSubdir(src, dest) {
  const srcArr = normalizePathToArray(src);
  const destArr = normalizePathToArray(dest);
  return srcArr.every((cur, i) => destArr[i] === cur);
}

async function getStatsForCopy(destStat, src, dest, opts) {
  const statFn = opts.dereference ? stat : lstat;
  const srcStat = await statFn(src);
  if (srcStat.isDirectory() && opts.recursive) {
    return onDir(srcStat, destStat, src, dest, opts);
  } else if (srcStat.isDirectory()) {
    throw cpError("ERR_FS_EISDIR", { message: `${src} is a directory (not copied)`, path: src, syscall: "cp", errno: EISDIR, code: "EISDIR" });
  } else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) {
    return onFile(srcStat, destStat, src, dest, opts);
  } else if (srcStat.isSymbolicLink()) {
    return onLink(destStat, src, dest, opts);
  } else if (srcStat.isSocket()) {
    throw cpError("ERR_FS_CP_SOCKET", { message: `cannot copy a socket file: ${dest}`, path: dest, syscall: "cp", errno: EINVAL, code: "EINVAL" });
  } else if (srcStat.isFIFO()) {
    throw cpError("ERR_FS_CP_FIFO_PIPE", { message: `cannot copy a FIFO pipe: ${dest}`, path: dest, syscall: "cp", errno: EINVAL, code: "EINVAL" });
  }
  throw cpError("ERR_FS_CP_UNKNOWN", {
    message: `cannot copy an unknown file type: ${dest}`, path: dest, syscall: "cp", errno: EINVAL, code: "EINVAL",
  });
}

function onFile(srcStat, destStat, src, dest, opts) {
  if (!destStat) return _copyFile(srcStat, src, dest, opts);
  return mayCopyFile(srcStat, src, dest, opts);
}

async function mayCopyFile(srcStat, src, dest, opts) {
  if (opts.force) {
    await unlink(dest);
    return _copyFile(srcStat, src, dest, opts);
  } else if (opts.errorOnExist) {
    throw cpError("ERR_FS_CP_EEXIST", { message: `${dest} already exists`, path: dest, syscall: "cp", errno: EEXIST, code: "EEXIST" });
  }
}

async function _copyFile(srcStat, src, dest, opts) {
  await copyFile(src, dest, opts.mode);
  if (opts.preserveTimestamps) {
    return handleTimestampsAndMode(srcStat.mode, src, dest);
  }
  return setDestMode(dest, srcStat.mode);
}

async function handleTimestampsAndMode(srcMode, src, dest) {
  // Make sure the file is writable before setting the timestamp
  // otherwise open fails with EPERM when invoked with 'r+'
  // (through utimes call)
  if (fileIsNotWritable(srcMode)) {
    await makeFileWritable(dest, srcMode);
  }
  return setDestTimestampsAndMode(srcMode, src, dest);
}

function fileIsNotWritable(srcMode) {
  return (srcMode & 0o200) === 0;
}

function makeFileWritable(dest, srcMode) {
  return setDestMode(dest, srcMode | 0o200);
}

async function setDestTimestampsAndMode(srcMode, src, dest) {
  await setDestTimestamps(src, dest);
  return setDestMode(dest, srcMode);
}

function setDestMode(dest, srcMode) {
  return chmod(dest, srcMode);
}

async function setDestTimestamps(src, dest) {
  // The initial srcStat.atime cannot be trusted
  // because it is modified by the read(2) system call
  // (See https://nodejs.org/api/fs.html#fs_stat_time_values)
  const updatedSrcStat = await stat(src);
  return utimes(dest, updatedSrcStat.atime, updatedSrcStat.mtime);
}

async function onDir(srcStat, destStat, src, dest, opts) {
  if (!destStat) return mkDirAndCopy(srcStat.mode, src, dest, opts);
  if (opts.errorOnExist && !opts.force) {
    throw cpError("ERR_FS_CP_EEXIST", { message: `${dest} already exists`, path: dest, syscall: "cp", errno: EEXIST, code: "EEXIST" });
  }
  return copyDir(src, dest, opts);
}

async function mkDirAndCopy(srcMode, src, dest, opts) {
  await mkdir(dest);
  await copyDir(src, dest, opts);
  return setDestMode(dest, srcMode);
}

/* (Node's reads the directory with opendir: the same entries, in the same order) */
async function copyDir(src, dest, opts) {
  for (const name of readdirSync(src)) {
    const srcItem = join(src, name);
    const destItem = join(dest, name);
    const { destStat, skipped } = await checkPaths(srcItem, destItem, opts);
    if (!skipped) await getStatsForCopy(destStat, srcItem, destItem, opts);
  }
}

/* binding.internalModuleStat(path) === 1: a directory, links followed */
function isDirectoryPath(path) {
  const st = fsStat(path, true);
  return Array.isArray(st) && (st[0] & 0o170000) === 0o040000;
}

async function onLink(destStat, src, dest, opts) {
  let resolvedSrc = await readlink(src);
  if (!opts.verbatimSymlinks && !isAbsolute(resolvedSrc)) {
    resolvedSrc = resolve(dirname(src), resolvedSrc);
  }
  const srcIsDir = isDirectoryPath(src);
  const symlinkType = srcIsDir ? "dir" : "file";
  if (!destStat) {
    return symlink(resolvedSrc, dest, symlinkType);
  }
  let resolvedDest;
  try {
    resolvedDest = await readlink(dest);
  } catch (err) {
    // Dest exists and is a regular file or directory,
    // Windows may throw UNKNOWN error. If dest already exists,
    // fs throws error anyway, so no need to guard against it here.
    if (err.code === "EINVAL" || err.code === "UNKNOWN") {
      return symlink(resolvedSrc, dest, symlinkType);
    }
    throw err;
  }
  if (!isAbsolute(resolvedDest)) {
    resolvedDest = resolve(dirname(dest), resolvedDest);
  }

  if (srcIsDir && isSrcSubdir(resolvedSrc, resolvedDest)) {
    throw cpError("ERR_FS_CP_EINVAL", {
      message: `cannot copy ${resolvedSrc} to a subdirectory of self ${resolvedDest}`, path: dest, syscall: "cp", errno: EINVAL, code: "EINVAL",
    });
  }
  // Do not copy if src is a subdir of dest since unlinking
  // dest in this case would result in removing src contents
  // and therefore a broken symlink would be created.
  const srcStat = await stat(src);
  if (srcStat.isDirectory() && isSrcSubdir(resolvedDest, resolvedSrc)) {
    throw cpError("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY", {
      message: `cannot overwrite ${resolvedDest} with ${resolvedSrc}`, path: dest, syscall: "cp", errno: EINVAL, code: "EINVAL",
    });
  }
  return copyLink(resolvedSrc, dest, symlinkType);
}

async function copyLink(resolvedSrc, dest, symlinkType) {
  await unlink(dest);
  return symlink(resolvedSrc, dest, symlinkType);
}

/* ---- Node's C++ helpers for cpSync (src/node_file.cc), in JS ------------------------------ */

/* a plain error with a code, as the C++ THROW_ERR_* make */
const cppError = (code, message) => codeError(Error, code, message);

/* ErrnoException (a std::error_code's): "EEXIST, File exists '<path>'", errno positive; from a
 * caught fs error (its errno, libuv's, negative) or a code and its number */
function errnoError(codeOrError, syscall, path, number) {
  const code = typeof codeOrError === "string" ? codeOrError : codeOrError.code;
  const errno = typeof codeOrError === "string" ? number : -codeOrError.errno;
  const text = errnoMessage(-errno);
  const e = new Error(`${code}, ${text.charAt(0).toUpperCase()}${text.slice(1)}${path === undefined ? "" : ` '${path}'`}`);
  e.errno = errno;
  e.code = code;
  if (path !== undefined) e.path = path;
  e.syscall = syscall;
  return e;
}

/* a path's file type, as std::filesystem's status (links followed) or symlink_status */
const S_IFMT = 0o170000;
const TYPES = { 0o100000: "regular", 0o040000: "directory", 0o120000: "symlink", 0o010000: "fifo", 0o140000: "socket", 0o020000: "character", 0o060000: "block" };
function status(path, follow) {
  const st = fsStat(path, follow);
  if (typeof st === "number") return { type: errnoName(st) === "ENOENT" ? "not_found" : "error", errno: st, st: null };
  return { type: TYPES[st[0] & S_IFMT] ?? "unknown", st };
}

/* std::filesystem::equivalent: the same file, links followed; false (an error) when either is missing */
function equivalent(a, b) {
  const sa = fsStat(a, true), sb = fsStat(b, true);
  if (!Array.isArray(sa) || !Array.isArray(sb)) return null;
  return sa[6] === sb[6] && sa[7] === sb[7];  /* ino, dev */
}

/* std::filesystem::path's parent_path ("a" → "", "/a" → "/", "/" → "/") */
function parentPath(p) {
  const i = p.lastIndexOf("/");
  if (i < 0) return "";
  if (i === 0) return "/";
  return p.slice(0, i);
}

function createDirectories(path) {
  if (path === "") return;
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    /* (Node's ignores the error: the copy reports it) */
  }
}

/* CpSyncCheckPaths. As Node's: without dereference src's status follows links and dest's doesn't,
 * and the other way round with it */
function cpSyncCheckPaths(src, dest, dereference, recursive) {
  const srcStatus = status(src, !dereference);
  if (srcStatus.st === null) throw codeErrorOfStat(srcStatus.errno, dereference ? "stat" : "lstat", src);
  const destStatus = status(dest, dereference);
  const destExists = destStatus.st !== null;
  const srcIsDir = srcStatus.type === "directory" || (dereference && srcStatus.type === "symlink");

  if (destExists) {
    if (equivalent(src, dest)) throw cppError("ERR_FS_CP_EINVAL", `src and dest cannot be the same ${dest}`);
    const destIsDir = destStatus.type === "directory";
    if (srcIsDir && !destIsDir) throw cppError("ERR_FS_CP_DIR_TO_NON_DIR", `Cannot overwrite non-directory ${dest} with directory ${src}`);
    if (!srcIsDir && destIsDir) throw cppError("ERR_FS_CP_NON_DIR_TO_DIR", `Cannot overwrite directory ${dest} with non-directory ${src}`);
  }

  const srcWithSep = src.endsWith(sep) ? src : src + sep;
  // Check if dest_path is a subdirectory of src_path.
  if (srcIsDir && dest.startsWith(srcWithSep)) throw cppError("ERR_FS_CP_EINVAL", `Cannot copy ${srcWithSep} to a subdirectory of self ${dest}`);

  // (Node's compares src with dest's parent each time, while the walk lasts)
  let destParent = parentPath(dest);
  while (parentPath(src) !== destParent && parentPath(destParent) !== "" && parentPath(destParent) !== destParent) {
    const same = equivalent(src, parentPath(dest));
    if (same) throw cppError("ERR_FS_CP_EINVAL", `Cannot copy ${srcWithSep} to a subdirectory of self ${dest}`);
    // If equivalent fails, it's highly likely that dest_parent does not exist
    if (same === null) break;
    destParent = parentPath(destParent);
  }

  if (srcIsDir && !recursive) throw cppError("ERR_FS_EISDIR", `Recursive option not enabled, cannot copy a directory: ${srcWithSep}`);

  if (srcStatus.type === "socket") throw cppError("ERR_FS_CP_SOCKET", `Cannot copy a socket file: ${dest}`);
  if (srcStatus.type === "fifo") throw cppError("ERR_FS_CP_FIFO_PIPE", `Cannot copy a FIFO pipe: ${dest}`);
  if (srcStatus.type === "unknown") throw cppError("ERR_FS_CP_UNKNOWN", `Cannot copy an unknown file type: ${dest}`);

  if (!destExists || status(parentPath(dest), true).st === null) createDirectories(parentPath(dest));
}

/* ThrowUVException's: "ENOENT: no such file or directory, lstat '<path>'" */
function codeErrorOfStat(errno, syscall, path) {
  const code = errnoName(errno);
  const e = new Error(`${code}: ${errnoMessage(errno)}, ${syscall} '${path}'`);
  Object.assign(e, { errno, code, syscall, path });
  return e;
}

/* CopyUtimes: src's times on dest */
function copyUtimes(src, dest) {
  const st = statSync(src);
  utimesSync(dest, st.atime, st.mtime);
}

/* CpSyncOverrideFile: dest removed, src copied over it */
function cpSyncOverrideFile(src, dest, mode, preserveTimestamps) {
  mode = getValidMode(mode, "copyFile");
  try {
    unlinkSync(dest);
  } catch (e) {
    throw errnoError(e, "unlink", dest);
  }
  try {
    copyFileSync(src, dest, mode);
  } catch (e) {
    if (mode === 0) throw errnoError(e, "cp", dest);
    throw e.syscall === "copyfile" ? Object.assign(e, { syscall: "cp", message: e.message.replace(", copyfile ", ", cp ") }) : e;
  }
  if (preserveTimestamps) copyUtimes(src, dest);
}

/* std::filesystem::weakly_canonical: the existing part of the path made canonical, the rest
 * normalized onto it */
function weaklyCanonical(path) {
  path = resolve(path);
  const rest = [];
  for (let head = path; ; head = dirname(head)) {
    const real = fsRealpath(head);
    if (typeof real === "string") return rest.length ? join(real, ...rest.reverse()) : real;
    if (dirname(head) === head) return path;
    rest.push(head.slice(dirname(head).length).replace(/^\//, ""));
  }
}

/* isInsideDir: src's parts a prefix of dest's (absolute) */
function isInsideDir(src, dest) {
  const srcArr = normalizePathToArray(src);
  const destArr = normalizePathToArray(dest);
  if (srcArr.length > destArr.length) return false;
  return srcArr.every((cur, i) => destArr[i] === cur);
}

const existsPath = (p) => Array.isArray(fsStat(p, true));
const isSymlinkPath = (p) => status(p, false).type === "symlink";
const isRegularPath = (p) => status(p, true).type === "regular";

/* CpSyncCopyDir: a directory's contents copied, recursively, as std::filesystem copies them */
function cpSyncCopyDir(src, dest, force, dereference, errorOnExist, verbatimSymlinks, preserveTimestamps) {
  try {
    mkdirSync(dest, { recursive: true });
  } catch (e) {
    throw errnoError(e, "cp", dest);
  }
  const copyDirContents = (src, dest) => {
    for (const name of readdirSync(src)) {
      const entryPath = join(src, name);
      const destFilePath = join(dest, name);
      const entry = status(entryPath, false);
      if (entry.type === "symlink") {
        if (verbatimSymlinks) {
          try {
            symlinkSync(readlinkSync(entryPath), destFilePath);
          } catch (e) {
            throw errnoError(e, "cp", dest);
          }
          continue;
        }
        let symlinkTarget;
        try {
          symlinkTarget = readlinkSync(entryPath);
        } catch (e) {
          throw errnoError(e, "cp", dest);
        }
        if (existsPath(destFilePath)) {
          if (isSymlinkPath(destFilePath)) {
            let currentDestSymlinkTarget;
            try {
              currentDestSymlinkTarget = readlinkSync(destFilePath);
            } catch (e) {
              throw errnoError(e, "cp", dest);
            }
            /* (Node's tests the target as written, relative to the working directory) */
            if (!dereference && status(symlinkTarget, true).type === "directory" && isInsideDir(symlinkTarget, currentDestSymlinkTarget)) {
              throw cppError("ERR_FS_CP_EINVAL", `Cannot copy ${symlinkTarget} to a subdirectory of self ${currentDestSymlinkTarget}`);
            }
            // Prevent copy if src is a subdir of dest since unlinking
            // dest in this case would result in removing src contents
            // and therefore a broken symlink would be created.
            if (status(destFilePath, true).type === "directory" && isInsideDir(currentDestSymlinkTarget, symlinkTarget)) {
              throw cppError("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY", `cannot overwrite ${currentDestSymlinkTarget} with ${symlinkTarget}`);
            }
            // symlinks get overridden by cp even if force: false
            try {
              unlinkSync(destFilePath);
            } catch (e) {
              throw errnoError(e, "cp", dest);
            }
          } else if (isRegularPath(destFilePath)) {
            if (!dereference || (!force && errorOnExist)) throw errnoError("EEXIST", "cp", destFilePath, EEXIST);
          }
        }
        const symlinkTargetAbsolute = weaklyCanonical(isAbsolute(symlinkTarget) ? symlinkTarget : join(src, symlinkTarget));
        try {
          symlinkSync(symlinkTargetAbsolute, destFilePath, isDirectoryPath(entryPath) ? "dir" : "file");
        } catch (e) {
          throw errnoError(e, "cp", dest);
        }
      } else if (entry.type === "directory") {
        try {
          mkdirSync(destFilePath);
        } catch {
          /* (std::filesystem::create_directory: an existing one is fine) */
        }
        copyDirContents(entryPath, destFilePath);
      } else if (entry.type === "regular") {
        const exists = existsPath(destFilePath);
        if (exists && !force) {
          if (errorOnExist) {
            throw cppError("ERR_FS_CP_EEXIST", `[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (${destFilePath} already exists)`);
          }
          continue;  /* skip_existing */
        }
        try {
          copyFileSync(entryPath, destFilePath);
        } catch (e) {
          throw errnoError(e, "cp", dest);
        }
        if (preserveTimestamps) copyUtimes(entryPath, destFilePath);
      }
    }
  };
  copyDirContents(src, dest);
}

/* ---- cpSync: lib/internal/fs/cp/cp-sync.js ------------------------------------------------- */

function cpSyncFn(src, dest, opts) {
  // Warn about using preserveTimestamps on 32-bit node
  if (opts.preserveTimestamps && process.arch === "ia32") {
    process.emitWarning("Using the preserveTimestamps option in 32-bit node is not recommended", "TimestampPrecisionWarning");
  }
  if (opts.filter) {
    const shouldCopy = opts.filter(src, dest);
    if (isPromise(shouldCopy)) throw invalidReturnValue(shouldCopy);
    if (!shouldCopy) return;
  }

  cpSyncCheckPaths(src, dest, opts.dereference, opts.recursive);

  return getStatsSync(src, dest, opts);
}

/* ERR_INVALID_RETURN_VALUE, for a filter returning a promise */
const invalidReturnValue = () =>
  codeError(TypeError, "ERR_INVALID_RETURN_VALUE", 'Expected boolean to be returned from the "filter" function but got an instance of Promise.');

function getStatsSync(src, dest, opts) {
  const statSyncFn = opts.dereference ? statSync : lstatSync;
  const srcStat = statSyncFn(src);
  const destStat = statSyncFn(dest, { throwIfNoEntry: false });

  if (srcStat.isDirectory() && opts.recursive) {
    return onDirSync(srcStat, destStat, src, dest, opts);
  } else if (srcStat.isFile() || srcStat.isCharacterDevice() || srcStat.isBlockDevice()) {
    return onFileSync(srcStat, destStat, src, dest, opts);
  } else if (srcStat.isSymbolicLink()) {
    return onLinkSync(destStat, src, dest, opts.verbatimSymlinks);
  }
}

function onFileSync(srcStat, destStat, src, dest, opts) {
  if (!destStat) return copyFileSyncFn(srcStat, src, dest, opts);

  if (opts.force) {
    return cpSyncOverrideFile(src, dest, opts.mode, opts.preserveTimestamps);
  }

  if (opts.errorOnExist) {
    throw cpError("ERR_FS_CP_EEXIST", { message: `${dest} already exists`, path: dest, syscall: "cp", errno: EEXIST, code: "EEXIST" });
  }
}

function copyFileSyncFn(srcStat, src, dest, opts) {
  copyFileSync(src, dest, opts.mode);
  if (opts.preserveTimestamps) handleTimestampsSync(srcStat.mode, src, dest);
  return chmodSync(dest, srcStat.mode);
}

function handleTimestampsSync(srcMode, src, dest) {
  // Make sure the file is writable before setting the timestamp
  // otherwise open fails with EPERM when invoked with 'r+'
  // (through utimes call)
  if (fileIsNotWritable(srcMode)) chmodSync(dest, srcMode | 0o200);
  const updatedSrcStat = statSync(src);
  return utimesSync(dest, updatedSrcStat.atime, updatedSrcStat.mtime);
}

function onDirSync(srcStat, destStat, src, dest, opts) {
  if (!destStat) return copyDirSync(src, dest, opts, true, srcStat.mode);
  return copyDirSync(src, dest, opts);
}

function copyDirSync(src, dest, opts, mkDir, srcMode) {
  if (!opts.filter) {
    // The caller didn't provide a js filter function, in this case
    // we can run the whole function faster in C++
    return cpSyncCopyDir(src, dest, opts.force, opts.dereference, opts.errorOnExist, opts.verbatimSymlinks, opts.preserveTimestamps);
  }

  if (mkDir) {
    mkdirSync(dest);
  }

  try {
    for (const name of readdirSync(src)) {
      const srcItem = join(src, name);
      const destItem = join(dest, name);
      let shouldCopy = true;

      if (opts.filter) {
        shouldCopy = opts.filter(srcItem, destItem);
        if (isPromise(shouldCopy)) throw invalidReturnValue(shouldCopy);
      }

      if (shouldCopy) {
        getStatsSync(srcItem, destItem, opts);
      }
    }
  } finally {
    if (srcMode !== undefined) {
      chmodSync(dest, srcMode);
    }
  }
}

function onLinkSync(destStat, src, dest, verbatimSymlinks) {
  let resolvedSrc = readlinkSync(src);
  if (!verbatimSymlinks && !isAbsolute(resolvedSrc)) {
    resolvedSrc = resolve(dirname(src), resolvedSrc);
  }
  const srcIsDir = isDirectoryPath(src);
  const symlinkType = srcIsDir ? "dir" : "file";
  if (!destStat) {
    return symlinkSync(resolvedSrc, dest, symlinkType);
  }
  let resolvedDest;
  try {
    resolvedDest = readlinkSync(dest);
  } catch (err) {
    // Dest exists and is a regular file or directory,
    // Windows may throw UNKNOWN error. If dest already exists,
    // fs throws error anyway, so no need to guard against it here.
    if (err.code === "EINVAL" || err.code === "UNKNOWN") {
      return symlinkSync(resolvedSrc, dest, symlinkType);
    }
    throw err;
  }
  if (!isAbsolute(resolvedDest)) {
    resolvedDest = resolve(dirname(dest), resolvedDest);
  }

  if (srcIsDir && isSrcSubdir(resolvedSrc, resolvedDest)) {
    throw cpError("ERR_FS_CP_EINVAL", {
      message: `cannot copy ${resolvedSrc} to a subdirectory of self ${resolvedDest}`, path: dest, syscall: "cp", errno: EINVAL, code: "EINVAL",
    });
  }
  // Prevent copy if src is a subdir of dest since unlinking
  // dest in this case would result in removing src contents
  // and therefore a broken symlink would be created.
  if (statSync(dest).isDirectory() && isSrcSubdir(resolvedDest, resolvedSrc)) {
    throw cpError("ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY", {
      message: `cannot overwrite ${resolvedDest} with ${resolvedSrc}`, path: dest, syscall: "cp", errno: EINVAL, code: "EINVAL",
    });
  }
  unlinkSync(dest);
  return symlinkSync(resolvedSrc, dest, symlinkType);
}

/* ---- the entry points: lib/fs.js's and lib/internal/fs/promises.js' ------------------------- */

function cpSync(src, dest, options) {
  options = validateCpOptions(options);
  src = getValidatedPath(src, "src");
  dest = getValidatedPath(dest, "dest");
  cpSyncFn(src, dest, options);
}

/* (callbackify(cpFn), as Node's) */
function cp(src, dest, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  validateFunction(callback, "cb");
  options = validateCpOptions(options);
  src = getValidatedPath(src, "src");
  dest = getValidatedPath(dest, "dest");
  cpFn(src, dest, options).then((value) => process.nextTick(callback, null, value), (err) => process.nextTick(callback, err));
}

async function cpPromise(src, dest, options) {
  options = validateCpOptions(options);
  src = getValidatedPath(src, "src");
  dest = getValidatedPath(dest, "dest");
  return cpFn(src, dest, options);
}

Object.assign(features, { cpSync, cp, cpPromise });
