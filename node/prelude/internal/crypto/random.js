// node:crypto's random numbers: Node's lib/internal/crypto/random.js over the
// runtime's CSPRNG (an HMAC_DRBG seeded from the system). The asynchronous forms fill at the
// call and call back from a timer, where Node's thread pool would.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { cryptoHostRandomUUID, cryptoRandomFill } from "visaljs:host";
import { invalidArgType, outOfRange, validateFunction } from "../errors.js";
import { isAnyArrayBuffer, isArrayBufferView, validateBoolean, validateNumber, validateObject } from "./util.js";

const kMaxPossibleLength = 2147483647;
const later = (fn) => setTimeout(fn, 0);

function assertOffset(offset, elementSize, length) {
  validateNumber(offset, "offset");
  offset *= elementSize;
  const maxLength = Math.min(length, kMaxPossibleLength);
  if (Number.isNaN(offset) || offset > maxLength || offset < 0) throw outOfRange("offset", `>= 0 && <= ${maxLength}`, offset);
  return offset >>> 0;
}

function assertSize(size, elementSize, offset, length) {
  validateNumber(size, "size");
  size *= elementSize;
  if (Number.isNaN(size) || size > kMaxPossibleLength || size < 0) throw outOfRange("size", `>= 0 && <= ${kMaxPossibleLength}`, size);
  if (size + offset > length) throw outOfRange("size + offset", `<= ${length}`, size + offset);
  return size >>> 0;
}

function validateBuf(buf) {
  if (!isAnyArrayBuffer(buf) && !isArrayBufferView(buf)) throw invalidArgType("buf", "an instance of ArrayBuffer or ArrayBufferView", buf);
}

export function randomBytes(size, callback) {
  size = assertSize(size, 1, 0, Infinity);
  if (callback !== undefined) validateFunction(callback, "callback");
  const buf = Buffer.alloc(size);
  cryptoRandomFill(buf, 0, size);
  if (callback === undefined) return buf;
  later(() => callback(null, buf));
}

export function randomFillSync(buf, offset = 0, size) {
  validateBuf(buf);
  const elementSize = buf.BYTES_PER_ELEMENT || 1;
  offset = assertOffset(offset, elementSize, buf.byteLength);
  if (size === undefined) size = buf.byteLength - offset;
  else size = assertSize(size, elementSize, offset, buf.byteLength);
  if (size === 0) return buf;
  cryptoRandomFill(buf, offset, size);
  return buf;
}

export function randomFill(buf, offset, size, callback) {
  validateBuf(buf);
  const elementSize = buf.BYTES_PER_ELEMENT || 1;
  if (typeof offset === "function") {
    callback = offset;
    offset = 0;
    size = buf.byteLength;
  } else if (typeof size === "function") {
    validateNumber(offset, "offset");
    offset *= elementSize;
    callback = size;
    size = buf.byteLength - offset;
  } else {
    validateFunction(callback, "callback");
  }
  offset = assertOffset(offset, 1, buf.byteLength);
  if (size === undefined) size = buf.byteLength - offset;
  else size = assertSize(size, elementSize, offset, buf.byteLength);
  if (size === 0) {
    callback(null, buf);
    return;
  }
  cryptoRandomFill(buf, offset, size);
  later(() => callback(null, buf));
}

/* randomInt: 6 random bytes per attempt, from a cache, as Node draws them */
const RAND_MAX = 0xffffffffffff;
const randomCache = Buffer.alloc(6 * 1024);
let randomCacheOffset = randomCache.length;

export function randomInt(min, max, callback) {
  const minNotSpecified = typeof max === "undefined" || typeof max === "function";
  if (minNotSpecified) {
    callback = max;
    max = min;
    min = 0;
  }
  const isSync = typeof callback === "undefined";
  if (!isSync) validateFunction(callback, "callback");
  if (!Number.isSafeInteger(min)) throw invalidArgType("min", "a safe integer", min);
  if (!Number.isSafeInteger(max)) throw invalidArgType("max", "a safe integer", max);
  if (max <= min) throw outOfRange("max", `greater than the value of "min" (${min})`, max);
  const range = max - min;
  if (!(range <= RAND_MAX)) throw outOfRange(`max${minNotSpecified ? "" : " - min"}`, `<= ${RAND_MAX}`, range);
  const randLimit = RAND_MAX - (RAND_MAX % range);
  for (;;) {
    if (randomCacheOffset === randomCache.length) {
      cryptoRandomFill(randomCache, 0, randomCache.length);
      randomCacheOffset = 0;
    }
    const x = randomCache.readUIntBE(randomCacheOffset, 6);
    randomCacheOffset += 6;
    if (x < randLimit) {
      const n = (x % range) + min;
      if (isSync) return n;
      process.nextTick(callback, undefined, n);
      return;
    }
  }
}

export function randomUUID(options) {
  if (options !== undefined) validateObject(options, "options");
  const { disableEntropyCache = false } = options || {};
  validateBoolean(disableEntropyCache, "options.disableEntropyCache");
  return cryptoHostRandomUUID();
}
