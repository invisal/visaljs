// perf_hooks' createHistogram and monitorEventLoopDelay: histograms as Node's, on HdrHistogram's
// buckets (HdrHistogram_c's arithmetic, ported): values kept to `figures` significant digits, min
// and max, mean and stddev from each bucket's median, percentiles as HdrHistogram's iterator gives
// them. Linked into programs that name them (internal/features.js).
// HdrHistogram_c's arithmetic is public domain (CC0), or BSD 2-clause:
// node/third_party/hdrhistogram/LICENSE.
import { codeError, invalidArgType } from "./errors.js";
import { features } from "./features.js";

const INT64_MAX = 2 ** 63;  /* HdrHistogram's INT64_MAX, as a double (Node shows 9223372036854776000) */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/* an integer's bit length, exactly (Math.log2 rounds near powers of two above 2^31) */
function bitLength(x) {
  const high = Math.floor(x / 4294967296);
  return high > 0 ? 64 - Math.clz32(high) : 32 - Math.clz32(x);
}

const outOfRange = (name, range, value) =>
  codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "${name}" is out of range. It must be ${range}. Received ${value}`);

/* HdrHistogram's state: its geometry and counts */
class Hdr {
  constructor(lowest, highest, figures) {
    const largestSingleUnit = 2 * 10 ** figures;
    const subBucketCountMagnitude = Math.ceil(Math.log2(largestSingleUnit));
    this.subBucketHalfCountMagnitude = Math.max(subBucketCountMagnitude, 1) - 1;
    this.unitMagnitude = Math.floor(Math.log2(lowest));
    this.subBucketCount = 2 ** (this.subBucketHalfCountMagnitude + 1);
    this.subBucketHalfCount = this.subBucketCount / 2;
    this.subBucketMask = (this.subBucketCount - 1) * 2 ** this.unitMagnitude;
    let smallestUntrackable = this.subBucketCount * 2 ** this.unitMagnitude;
    let bucketsNeeded = 1;
    while (smallestUntrackable <= highest) {
      if (smallestUntrackable > MAX_SAFE / 2) {
        bucketsNeeded++;
        break;
      }
      smallestUntrackable *= 2;
      bucketsNeeded++;
    }
    this.countsLen = (bucketsNeeded + 1) * this.subBucketHalfCount;
    this.counts = new Float64Array(this.countsLen);
    this.lowest = lowest;
    this.highest = highest;
    this.reset();
  }

  reset() {
    this.counts.fill(0);
    this.totalCount = 0;
    this.minValue = INT64_MAX;
    this.maxValue = 0;
  }

  /* the bucket of a value: its bit length above the sub-buckets' */
  bucketIndex(value) {
    const v = Math.max(value, 0) + 0;
    const withMask = v > this.subBucketMask ? v : this.subBucketMask;  /* v | mask: the mask is all ones below its top */
    const pow2ceiling = bitLength(withMask);
    return pow2ceiling - this.unitMagnitude - (this.subBucketHalfCountMagnitude + 1);
  }

  subBucketIndex(value, bucketIndex) {
    return Math.floor(value / 2 ** (bucketIndex + this.unitMagnitude));
  }

  countsIndex(bucketIndex, subBucketIndex) {
    return (bucketIndex + 1) * 2 ** this.subBucketHalfCountMagnitude + (subBucketIndex - this.subBucketHalfCount);
  }

  indexOf(value) {
    const b = this.bucketIndex(value);
    return this.countsIndex(b, this.subBucketIndex(value, b));
  }

  valueAtIndex(index) {
    let bucketIndex = Math.floor(index / 2 ** this.subBucketHalfCountMagnitude) - 1;
    let subBucketIndex = (index % this.subBucketHalfCount) + this.subBucketHalfCount;
    if (bucketIndex < 0) {
      subBucketIndex -= this.subBucketHalfCount;
      bucketIndex = 0;
    }
    return subBucketIndex * 2 ** (bucketIndex + this.unitMagnitude);
  }

  sizeOfRange(value) {
    const b = this.bucketIndex(value);
    const s = this.subBucketIndex(value, b);
    return 2 ** (this.unitMagnitude + (s >= this.subBucketCount ? b + 1 : b));
  }

  lowestEquivalent(value) {
    const b = this.bucketIndex(value);
    return this.subBucketIndex(value, b) * 2 ** (b + this.unitMagnitude);
  }

  highestEquivalent(value) {
    return this.lowestEquivalent(value) + this.sizeOfRange(value) - 1;
  }

  medianEquivalent(value) {
    return this.lowestEquivalent(value) + Math.floor(this.sizeOfRange(value) / 2);
  }

  /** false when the value is beyond the histogram's range */
  record(value, count = 1) {
    if (value < 0) return false;
    const index = this.indexOf(value);
    if (index < 0 || index >= this.countsLen) return false;
    this.counts[index] += count;
    this.totalCount += count;
    if (value < this.minValue && value !== 0) this.minValue = value;
    if (value > this.maxValue) this.maxValue = value;
    return true;
  }

  min() {
    return this.totalCount === 0 ? INT64_MAX : this.lowestEquivalent(this.minValue);
  }

  max() {
    return this.maxValue === 0 ? 0 : this.highestEquivalent(this.maxValue);
  }

  /* each recorded value's index and count */
  *recorded() {
    for (let i = 0; i < this.countsLen; i++) if (this.counts[i] !== 0) yield [this.valueAtIndex(i), this.counts[i]];
  }

  mean() {
    let total = 0;
    for (const [value, count] of this.recorded()) total += count * this.medianEquivalent(value);
    return total / this.totalCount;
  }

  stddev() {
    const mean = this.mean();
    let total = 0;
    for (const [value, count] of this.recorded()) {
      const dev = this.medianEquivalent(value) - mean;
      total += dev * dev * count;
    }
    return Math.sqrt(total / this.totalCount);
  }

  /* Node 24's skewness and excess kurtosis: the standardized third and fourth moments over each
     bucket's median, 0 below 3 (4) values or with no variance */
  moment(order) {
    if (this.totalCount < order) return 0;
    const mean = this.mean();
    let m2 = 0, mk = 0;
    for (const [value, count] of this.recorded()) {  /* Node's histogram.cc, operation for operation */
      const dev = this.medianEquivalent(value) - mean;
      const d2 = dev * dev;
      m2 += count * d2;
      mk += order === 3 ? count * d2 * dev : count * d2 * d2;
    }
    const n = this.totalCount;
    const variance = m2 / n;
    if (variance === 0) return 0;
    return order === 3 ? (mk / n) / (variance * Math.sqrt(variance)) : (mk / n) / (variance * variance) - 3;
  }

  valueAtPercentile(percentile) {
    const requested = Math.min(percentile, 100);
    let countAtPercentile = Math.trunc((requested / 100) * this.totalCount + 0.5);
    countAtPercentile = Math.max(countAtPercentile, 1);
    let value = 0, seen = 0;
    for (let i = 0; i < this.countsLen; i++) {
      seen += this.counts[i];
      if (seen >= countAtPercentile) {
        value = this.valueAtIndex(i);
        break;
      }
    }
    return percentile === 0 ? this.lowestEquivalent(value) : this.highestEquivalent(value);
  }

  /* HdrHistogram's percentile iterator (one tick per half distance): [percentile, value] */
  percentiles() {
    const out = [];
    let countsIndex = -1, cumulative = 0, count = 0, value = 0;
    let toIterateTo = 0, seenLast = false;
    const hasNext = () => cumulative < this.totalCount;
    const moveNext = () => {
      countsIndex++;
      if (countsIndex >= this.countsLen) return false;
      count = this.counts[countsIndex];
      cumulative += count;
      value = this.valueAtIndex(countsIndex);
      return true;
    };
    const basicNext = () => (hasNext() && countsIndex < this.countsLen ? moveNext() : false);
    for (;;) {
      if (!hasNext()) {
        if (seenLast) break;
        seenLast = true;
        out.push([100, value]);
        continue;
      }
      if (countsIndex === -1 && !basicNext()) break;
      let found = false;
      do {
        const current = (100 * cumulative) / this.totalCount;
        if (count !== 0 && toIterateTo <= current) {
          out.push([toIterateTo, value]);
          const temp = Math.trunc(Math.log(100 / (100 - toIterateTo)) / Math.log(2)) + 1;
          if (!Number.isFinite(temp)) return out;
          toIterateTo += 100 / 2 ** temp;
          found = true;
          break;
        }
      } while (basicNext());
      if (!found && !hasNext()) continue;
    }
    return out;
  }
}

const kHdr = Symbol("kHdr");
const kRecord = Symbol("kRecord");

/** A histogram's figures (Node's Histogram). */
class Histogram {
  /* Node 24's exponentially weighted moving average of what's recorded, when a half-life is set:
     alpha = 1 - 2^(-1/halfLife); with a threshold, the share above it too */
  #ewma = { alpha: 0, threshold: 0, initialized: false, mean: 0, variance: 0, errorRate: 0 };

  constructor(hdr, halfLife = 0, threshold = 0) {
    this[kHdr] = hdr;
    this.exceedsCount = 0;
    if (halfLife > 0) this.#ewma.alpha = 1 - Math.exp(-Math.log(2) / halfLife);
    this.#ewma.threshold = threshold;
  }

  /** Records a value (count times), counting it as exceeding when out of range. */
  [kRecord](value, count = 1) {
    if (!this[kHdr].record(value, count)) {
      this.exceedsCount += count;
      return;
    }
    const e = this.#ewma;
    if (e.alpha <= 0) return;
    if (!e.initialized) {
      e.initialized = true;
      e.mean = value;
      e.variance = 0;
      if (e.threshold > 0) e.errorRate = value > e.threshold ? 1 : 0;
      return;
    }
    const diff = value - e.mean;
    e.mean += e.alpha * diff;
    e.variance = (1 - e.alpha) * (e.variance + e.alpha * diff * diff);
    if (e.threshold > 0) e.errorRate += e.alpha * ((value > e.threshold ? 1 : 0) - e.errorRate);
  }

  get ewmaMean() {
    return this.#ewma.initialized ? this.#ewma.mean : 0;
  }
  get ewmaStddev() {
    return this.#ewma.initialized ? Math.sqrt(this.#ewma.variance) : 0;
  }
  get ewmaErrorRate() {
    return this.#ewma.initialized ? this.#ewma.errorRate : 0;
  }
  get kurtosis() {
    return this[kHdr].moment(4);
  }
  get skewness() {
    return this[kHdr].moment(3);
  }

  get count() {
    return this[kHdr].totalCount;
  }
  get countBigInt() {
    return BigInt(this.count);
  }
  get min() {
    return this[kHdr].min();
  }
  get minBigInt() {
    return this[kHdr].totalCount === 0 ? 9223372036854775807n : BigInt(this.min);
  }
  get max() {
    return this[kHdr].max();
  }
  get maxBigInt() {
    return BigInt(this.max);
  }
  get mean() {
    return this[kHdr].mean();
  }
  get stddev() {
    return this[kHdr].stddev();
  }
  get exceeds() {
    return this.exceedsCount;
  }
  get exceedsBigInt() {
    return BigInt(this.exceedsCount);
  }
  get percentiles() {
    return new Map(this[kHdr].percentiles());
  }
  get percentilesBigInt() {
    return new Map(this[kHdr].percentiles().map(([p, v]) => [p, BigInt(v)]));
  }

  percentile(percentile) {
    if (typeof percentile !== "number") throw invalidArgType("percentile", "of type number", percentile);
    if (!(percentile > 0 && percentile <= 100)) throw outOfRange("percentile", "> 0 && <= 100", percentile);
    return this[kHdr].valueAtPercentile(percentile);
  }

  percentileBigInt(percentile) {
    return BigInt(this.percentile(percentile));
  }

  reset() {
    this[kHdr].reset();
    this.exceedsCount = 0;
    Object.assign(this.#ewma, { initialized: false, mean: 0, variance: 0, errorRate: 0 });
  }

  toJSON() {
    return {
      count: this.count, min: this.min, max: this.max, mean: this.mean, exceeds: this.exceeds, stddev: this.stddev,
      skewness: this.skewness, kurtosis: this.kurtosis, ewmaMean: this.ewmaMean, ewmaStddev: this.ewmaStddev,
      ewmaErrorRate: this.ewmaErrorRate, percentiles: Object.fromEntries(this.percentiles),
    };
  }
}

/** createHistogram's: record values, deltas, other histograms. */
class RecordableHistogram extends Histogram {
  #previous = 0;

  record(val) {
    if (typeof val === "bigint") val = Number(val);
    else if (typeof val !== "number") throw invalidArgType("val", "of type number", val);
    if (!(val >= 1 && val <= MAX_SAFE)) throw outOfRange("val", ">= 1 && <= 9007199254740991", val);
    this[kRecord](val);
  }

  /** The time since the last call (ns): nothing on the first. */
  recordDelta() {
    const [s, ns] = process.hrtime();
    const now = s * 1e9 + ns;
    if (this.#previous !== 0) {
      const delta = now - this.#previous;
      if (delta >= 1) this[kRecord](delta);
    }
    this.#previous = now;
  }

  add(other) {
    if (!(other instanceof Histogram)) throw invalidArgType("other", "an instance of RecordableHistogram", other);
    for (const [value, count] of other[kHdr].recorded()) {
      if (!this[kHdr].record(value, count)) this.exceedsCount += count;
    }
    if (other[kHdr].totalCount > 0) {
      this[kHdr].minValue = Math.min(this[kHdr].minValue, other[kHdr].minValue);
      this[kHdr].maxValue = Math.max(this[kHdr].maxValue, other[kHdr].maxValue);
    }
  }
}

function integerOption(options, name, fallback, min) {
  const value = options[name] ?? fallback;
  if (typeof value !== "number" && typeof value !== "bigint") throw invalidArgType(`options.${name}`, "of type number", value);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > MAX_SAFE) throw outOfRange(`options.${name}`, `>= ${min} && <= 9007199254740991`, value);
  return n;
}

/** createHistogram({ lowest = 1, highest = Number.MAX_SAFE_INTEGER, figures = 3, halfLife = 0, threshold = 0 }). */
function createHistogram(options = {}) {
  if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
  const lowest = integerOption(options, "lowest", 1, 1);
  const highest = integerOption(options, "highest", MAX_SAFE, 2 * lowest);
  const figures = options.figures ?? 3;
  if (typeof figures !== "number") throw invalidArgType("options.figures", "of type number", figures);
  if (!Number.isInteger(figures) || figures < 1 || figures > 5) throw outOfRange("options.figures", ">= 1 && <= 5", figures);
  /* Node 24: the moving average's half-life (in values) and threshold */
  const { halfLife = 0, threshold = 0 } = options;
  if (typeof halfLife !== "number") throw invalidArgType("options.halfLife", "of type number", halfLife);
  if (halfLife < 0) throw outOfRange("options.halfLife", ">= 0", halfLife);
  if (typeof threshold !== "number") throw invalidArgType("options.threshold", "of type number", threshold);
  if (threshold < 0) throw outOfRange("options.threshold", ">= 0", threshold);
  return new RecordableHistogram(new Hdr(lowest, highest, figures), halfLife, threshold);
}

/** monitorEventLoopDelay's: the event loop's delay sampled every resolution ms, in ns. */
class IntervalHistogram extends Histogram {
  #timer = null;
  #resolution;
  #previous = 0;

  constructor(hdr, resolution) {
    super(hdr);
    this.#resolution = resolution;
  }

  enable() {
    if (this.#timer !== null) return false;
    this.#previous = 0;
    this.#timer = globalThis.setInterval(() => {
      const [s, ns] = process.hrtime();
      const now = s * 1e9 + ns;
      if (this.#previous !== 0) this[kRecord](now - this.#previous);
      this.#previous = now;
    }, this.#resolution);
    this.#timer.unref?.();
    return true;
  }

  disable() {
    if (this.#timer === null) return false;
    globalThis.clearInterval(this.#timer);
    this.#timer = null;
    return true;
  }
}

class ELDHistogram extends IntervalHistogram {}

function monitorEventLoopDelay(options = {}) {
  if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
  const resolution = integerOption(options, "resolution", 10, 1);
  return new ELDHistogram(new Hdr(1, MAX_SAFE, 3), resolution);
}

Object.assign(features, { createHistogram, monitorEventLoopDelay });
