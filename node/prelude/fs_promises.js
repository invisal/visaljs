// node:fs/promises: node:fs's synchronous calls, their outcome as a promise.
// The I/O happens when the function is called, not on libuv's thread pool as in Node.
import {
  constants, accessSync, appendFileSync, chmodSync, chownSync, copyFileSync, lchownSync, linkSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync,
  readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync,
  utimesSync, writeFileSync, statfsSync,
} from "./fs.js";
import { codeError } from "./internal/errors.js";
import { lazyFunction } from "./internal/features.js";

const promised = (fn) => async (...args) => fn(...args);

export const readFile = promised(readFileSync);
export const writeFile = promised(writeFileSync);
export const appendFile = promised(appendFileSync);
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
  chmod, chown, lchown, lutimes, truncate, mkdtemp, rmdir, rm, statfs, lchmod, open, opendir, cp, glob, watch,
  get constants() {
    return constants;
  },
};
