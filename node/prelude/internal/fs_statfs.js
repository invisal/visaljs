// fs.statfs and statfsSync: a file system's figures, statfs(2), as a StatFs. Linked into programs that
// name them (internal/features.js).
import { fsCall } from "visaljs:host";
import { invalidArgType, systemError, validateFunction } from "./errors.js";
import { features } from "./features.js";

const FS_STATFS = 19;  /* fsCall's (host_fs.c) */

function validatePath(path) {
  if (typeof path !== "string") throw invalidArgType("path", "of type string or an instance of Buffer or URL", path);
}

/** A file system's figures: statfs(2). */
class StatFs {
  constructor(type, bsize, blocks, bfree, bavail, files, ffree) {
    Object.assign(this, { type, bsize, blocks, bfree, bavail, files, ffree });
  }
}

function statfsSync(path, options) {
  validatePath(path);
  const values = fsCall(FS_STATFS, path);
  if (typeof values === "number") throw systemError(values, "statfs", path);
  return new StatFs(...(options?.bigint ? values.map((v) => BigInt(v)) : values));
}

/** statfs(path[, options], callback): on a later tick, as fs's callbacks. */
function statfs(path, options, callback) {
  if (typeof options === "function") [options, callback] = [undefined, options];
  validateFunction(callback, "cb");
  let result, error = null;
  try {
    result = statfsSync(path, options);
  } catch (e) {
    error = e;
  }
  process.nextTick(() => (error ? callback(error) : callback(null, result)));
}

Object.assign(features, { statfsSync, statfs });
