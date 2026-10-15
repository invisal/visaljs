// fs's Stats, as Node's lib/internal/fs/utils.js has them: StatsBase and Stats as functions, their
// dates made when first read; fs.Stats, the constructor deprecated for programs (DEP0180); and
// the host's stat array as Stats, or as BigIntStats (internal/fs_bigint_stats.js).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { feature } from "./features.js";

const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000, S_IFLNK = 0o120000, S_IFIFO = 0o010000,
  S_IFSOCK = 0o140000, S_IFCHR = 0o020000, S_IFBLK = 0o060000;

/* Node's StatsBase, Stats and BigIntStats (internal/fs_bigint_stats.js): functions, the dates
 * made when first read */
export function StatsBase(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks) {
  this.dev = dev;
  this.mode = mode;
  this.nlink = nlink;
  this.uid = uid;
  this.gid = gid;
  this.rdev = rdev;
  this.blksize = blksize;
  this.ino = ino;
  this.size = size;
  this.blocks = blocks;
}

StatsBase.prototype.isDirectory = function () { return this._checkModeProperty(S_IFDIR); };
StatsBase.prototype.isFile = function () { return this._checkModeProperty(S_IFREG); };
StatsBase.prototype.isBlockDevice = function () { return this._checkModeProperty(S_IFBLK); };
StatsBase.prototype.isCharacterDevice = function () { return this._checkModeProperty(S_IFCHR); };
StatsBase.prototype.isSymbolicLink = function () { return this._checkModeProperty(S_IFLNK); };
StatsBase.prototype.isFIFO = function () { return this._checkModeProperty(S_IFIFO); };
StatsBase.prototype.isSocket = function () { return this._checkModeProperty(S_IFSOCK); };

const setOwnProperty = (obj, key, value) => {
  Object.defineProperty(obj, key, { configurable: true, enumerable: true, value, writable: true });
  return value;
};

/* atime, mtime, ctime and birthtime: Dates of the times in milliseconds, made when first read */
export const lazyDateFields = { __proto__: null };
for (const name of ["atime", "mtime", "ctime", "birthtime"]) {
  lazyDateFields[name] = {
    enumerable: true,
    configurable: true,
    get() {
      return setOwnProperty(this, name, new Date(Math.round(Number(this[name + "Ms"]))));
    },
    set(value) {
      setOwnProperty(this, name, value);
    },
  };
}

function StatsImpl(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs) {
  StatsBase.call(this, dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks);
  this.atimeMs = atimeMs;
  this.mtimeMs = mtimeMs;
  this.ctimeMs = ctimeMs;
  this.birthtimeMs = birthtimeMs;
}
Object.setPrototypeOf(StatsImpl.prototype, StatsBase.prototype);
Object.setPrototypeOf(StatsImpl, StatsBase);
Object.defineProperties(StatsImpl.prototype, lazyDateFields);
Object.defineProperty(StatsImpl, "name", { value: "Stats" });

StatsImpl.prototype._checkModeProperty = function (property) {
  if (process.platform === "win32" && (property === S_IFIFO || property === S_IFBLK || property === S_IFSOCK)) return false;
  return (this.mode & S_IFMT) === property;
};

/* fs.Stats: the constructor, deprecated for programs (DEP0180), warning once */
let warnedStats = false;
export function Stats(...args) {
  if (!warnedStats) {
    warnedStats = true;
    process.emitWarning("fs.Stats constructor is deprecated.", "DeprecationWarning", "DEP0180");
  }
  return new.target ? Reflect.construct(StatsImpl, args, new.target) : Reflect.apply(StatsImpl, this, args);
}
Object.setPrototypeOf(Stats, StatsImpl);
Stats.prototype = StatsImpl.prototype;

/* the host's stat array as Stats, or BigIntStats (a module of its own, linked when the program names
 * the bigint option) */
export function statsFrom(r, bigint) {
  if (bigint) return feature("BigIntStats")(r);
  const [mode, size, mtimeMs, atimeMs, ctimeMs, birthtimeMs, ino, dev, nlink, uid, gid, rdev, blksize, blocks] = r;
  return new StatsImpl(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs, ctimeMs, birthtimeMs);
}

