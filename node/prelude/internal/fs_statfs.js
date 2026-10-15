// fs.statfs and statfsSync: a file system's figures, statfs(2), as a StatFs. Linked into programs that
// name them (internal/features.js).
import { fsCall } from "visaljs:host";
import { systemError, validateFunction } from "./errors.js";
import { features } from "./features.js";
import { getValidatedPath } from "./fs_utils.js";

const FS_STATFS = 19;  /* fsCall's (host_fs.c) */

/** A file system's figures: statfs(2). */
class StatFs {
  constructor(type, bsize, frsize, blocks, bfree, bavail, files, ffree) {
    Object.assign(this, { type, bsize, frsize, blocks, bfree, bavail, files, ffree });  /* Node 24's fields */
  }
}

function doStatfs(path, options) {
  const values = fsCall(FS_STATFS, path);
  if (typeof values === "number") throw systemError(values, "statfs", path);
  return new StatFs(...(options?.bigint ? values.map((v) => BigInt(v)) : values));
}

function statfsSync(path, options) {
  return doStatfs(getValidatedPath(path), options);
}

/** statfs(path[, options], callback): its arguments checked now, as Node's; the outcome on a
 *  later tick, as fs's callbacks. */
function statfs(path, options, callback) {
  if (typeof options === "function") [options, callback] = [undefined, options];
  validateFunction(callback, "cb");
  path = getValidatedPath(path);
  let result, error = null;
  try {
    result = doStatfs(path, options);
  } catch (e) {
    error = e;
  }
  process.nextTick(() => (error ? callback(error) : callback(null, result)));
}

Object.assign(features, { statfsSync, statfs });
