// fs's BigIntStats: a stat call's figures as BigInts, its times in nanoseconds too (atimeNs, …), for
// the `bigint: true` option, as Node's. A module of its own, linked into programs that name the
// option (implicitModules in node/index.ts): it names BigInt, which links the runtime's BigInt.
import { lazyDateFields, StatsBase } from "./fs_stats.js";
import { features } from "./features.js";

const kNsPerMsBigInt = BigInt(1000000);

/* a time the host gives in milliseconds (fractional) as nanoseconds, the whole part exactly */
function nanoseconds(ms) {
  const whole = Math.floor(ms);
  return BigInt(whole) * kNsPerMsBigInt + BigInt(Math.round((ms - whole) * 1e6));
}

function BigIntStats(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeNs, mtimeNs, ctimeNs, birthtimeNs) {
  StatsBase.call(this, dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks);
  this.atimeMs = atimeNs / kNsPerMsBigInt;
  this.mtimeMs = mtimeNs / kNsPerMsBigInt;
  this.ctimeMs = ctimeNs / kNsPerMsBigInt;
  this.birthtimeMs = birthtimeNs / kNsPerMsBigInt;
  this.atimeNs = atimeNs;
  this.mtimeNs = mtimeNs;
  this.ctimeNs = ctimeNs;
  this.birthtimeNs = birthtimeNs;
}
Object.setPrototypeOf(BigIntStats.prototype, StatsBase.prototype);
Object.setPrototypeOf(BigIntStats, StatsBase);
Object.defineProperties(BigIntStats.prototype, lazyDateFields);

BigIntStats.prototype._checkModeProperty = function (property) {
  if (process.platform === "win32" && (property === 0o010000 || property === 0o060000 || property === 0o140000)) return false;
  return (this.mode & BigInt(0o170000)) === BigInt(property);
};

/* the host's stat array (fs.js's statsFrom) */
features.BigIntStats = function fromHost(r) {
  const [mode, size, mtimeMs, atimeMs, ctimeMs, birthtimeMs, ino, dev, nlink, uid, gid, rdev, blksize, blocks] = r;
  const big = (n) => BigInt(Math.trunc(n));
  return new BigIntStats(big(dev), big(mode), big(nlink), big(uid), big(gid), big(rdev), big(blksize), big(ino), big(size), big(blocks),
    nanoseconds(atimeMs), nanoseconds(mtimeMs), nanoseconds(ctimeMs), nanoseconds(birthtimeMs));
};
