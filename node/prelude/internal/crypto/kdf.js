// node:crypto's key derivation: pbkdf2, hkdf and scrypt, Node's
// lib/internal/crypto/{pbkdf2,hkdf,scrypt}.js over the runtime's C. The asynchronous forms
// derive at the call and call back from a timer, where Node's thread pool would.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { cryptoHashInfo, cryptoHkdf, cryptoPbkdf2, cryptoScrypt, cryptoScryptCheck } from "visaljs:host";
import { codeError, invalidArgType, outOfRange, validateFunction, validateString } from "../errors.js";
import { KeyObject, prepareSecretKey } from "./keys.js";
import { isAnyArrayBuffer, isArrayBufferView, validateNumber } from "./util.js";

const later = (fn) => setTimeout(fn, 0);
const derivingFailed = () => new Error("Deriving bits failed");
/* PBKDF2 and HKDF over SHAKE: OpenSSL 3.5 refuses an extendable-output function, with this error */
const isXof = (digest) => typeof digest === "string" && /^shake(128|256)$/i.test(digest);
const kdfFailed = (digest) => (isXof(digest) ? new Error("error:1C8000B7:Provider routines::xof digests not allowed") : derivingFailed());
const invalidDigest = (digest) => codeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: " + digest);

function validateIntegerIn(value, name, min, max) {
  validateNumber(value, name);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
}

const validateInt32 = (value, name, min = -2147483648) => validateIntegerIn(value, name, min, 2147483647);
const validateUint32 = (value, name) => validateIntegerIn(value, name, 0, 4294967295);

/** getArrayBufferOrView: a string's UTF-8 bytes, or the buffer or view. */
function bytesOf(value, name) {
  if (isAnyArrayBuffer(value) || isArrayBufferView(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw invalidArgType(name, "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", value);
}

/* ---- PBKDF2 ------------------------------------------------------------------------------------ */

function checkPbkdf2(password, salt, iterations, keylen, digest) {
  validateString(digest, "digest");
  password = bytesOf(password, "password");
  salt = bytesOf(salt, "salt");
  validateInt32(iterations, "iterations", 1);
  validateInt32(keylen, "keylen", 0);
  return { password, salt, iterations, keylen, digest };
}

function runPbkdf2({ password, salt, iterations, keylen, digest }) {
  const result = cryptoPbkdf2(digest, password, salt, iterations, keylen);
  if (result === null) throw invalidDigest(digest);
  if (result === false) throw kdfFailed(digest);
  return result;
}

export function pbkdf2Sync(password, salt, iterations, keylen, digest) {
  return runPbkdf2(checkPbkdf2(password, salt, iterations, keylen, digest));
}

export function pbkdf2(password, salt, iterations, keylen, digest, callback) {
  if (typeof digest === "function") {
    callback = digest;
    digest = undefined;
  }
  const args = checkPbkdf2(password, salt, iterations, keylen, digest);
  validateFunction(callback, "callback");
  const result = cryptoPbkdf2(digest, args.password, args.salt, iterations, keylen);
  if (result === null) throw invalidDigest(digest);
  later(() => (result === false ? callback(kdfFailed(digest)) : callback(null, result)));
}

/* ---- HKDF -------------------------------------------------------------------------------------- */

function byteSource(value, name) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (isAnyArrayBuffer(value) || isArrayBufferView(value)) return value;
  throw invalidArgType(name, "of type string or an instance of ArrayBuffer, TypedArray, DataView, or Buffer", value);
}

function checkHkdf(hash, key, salt, info, length) {
  validateString(hash, "digest");
  if (key instanceof KeyObject) key = prepareSecretKey(key);
  else if (typeof key === "string") key = Buffer.from(key, "utf8");
  else if (!isAnyArrayBuffer(key) && !isArrayBufferView(key)) {
    throw invalidArgType("ikm", "of type string or an instance of SecretKeyObject, ArrayBuffer, TypedArray, DataView, or Buffer", key);
  }
  salt = byteSource(salt, "salt");
  info = byteSource(info, "info");
  validateIntegerIn(length, "length", 0, Number.MAX_SAFE_INTEGER);
  if (info.byteLength > 1024) throw outOfRange("info", "must not contain more than 1024 bytes", info.byteLength);
  return { hash, key, salt, info, length };
}

function runHkdf({ hash, key, salt, info, length }) {
  const size = cryptoHashInfo(hash);
  if (size === -1) throw invalidDigest(hash);
  if (size > 0 && length > 255 * size) throw codeError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length");
  return cryptoHkdf(hash, key, salt, info, length);
}

export function hkdfSync(hash, key, salt, info, length) {
  const result = runHkdf(checkHkdf(hash, key, salt, info, length));
  if (result === false) throw kdfFailed(hash);
  return result;
}

export function hkdf(hash, key, salt, info, length, callback) {
  const args = checkHkdf(hash, key, salt, info, length);
  validateFunction(callback, "callback");
  const result = runHkdf(args);
  later(() => (result === false ? callback(kdfFailed(hash)) : callback(null, result)));
}

/* ---- scrypt ------------------------------------------------------------------------------------ */

const defaults = { N: 16384, r: 8, p: 1, maxmem: 32 << 20 };
/* Node 24: an option given under both its names */
const optionPair = (a, b) => codeError(TypeError, "ERR_INCOMPATIBLE_OPTION_PAIR", `Option "${a}" cannot be used in combination with option "${b}"`);

function checkScrypt(password, salt, keylen, options) {
  password = bytesOf(password, "password");
  salt = bytesOf(salt, "salt");
  validateInt32(keylen, "keylen", 0);
  let { N, r, p, maxmem } = defaults;
  if (options && options !== defaults) {
    const hasN = options.N !== undefined;
    if (hasN) {
      N = options.N;
      validateUint32(N, "N");
    }
    if (options.cost !== undefined) {
      if (hasN) throw optionPair("N", "cost");
      N = options.cost;
      validateUint32(N, "cost");
    }
    const hasR = options.r !== undefined;
    if (hasR) {
      r = options.r;
      validateUint32(r, "r");
    }
    if (options.blockSize !== undefined) {
      if (hasR) throw optionPair("r", "blockSize");
      r = options.blockSize;
      validateUint32(r, "blockSize");
    }
    const hasP = options.p !== undefined;
    if (hasP) {
      p = options.p;
      validateUint32(p, "p");
    }
    if (options.parallelization !== undefined) {
      if (hasP) throw optionPair("p", "parallelization");
      p = options.parallelization;
      validateUint32(p, "parallelization");
    }
    if (options.maxmem !== undefined) {
      maxmem = options.maxmem;
      validateIntegerIn(maxmem, "maxmem", 0, Number.MAX_SAFE_INTEGER);
    }
    if (N === 0) N = defaults.N;
    if (r === 0) r = defaults.r;
    if (p === 0) p = defaults.p;
    if (maxmem === 0) maxmem = defaults.maxmem;
  }
  const check = cryptoScryptCheck(N, r, p, maxmem);
  if (check !== 0) {
    const suffix = check === 2 ? ": error:030000AC:digital envelope routines::memory limit exceeded" : "";
    throw codeError(RangeError, "ERR_CRYPTO_INVALID_SCRYPT_PARAMS", "Invalid scrypt params" + suffix);
  }
  return { password, salt, keylen, N, r, p };
}

function runScrypt({ password, salt, keylen, N, r, p }) {
  return cryptoScrypt(password, salt, N, r, p, keylen);
}

export function scryptSync(password, salt, keylen, options = defaults) {
  const result = runScrypt(checkScrypt(password, salt, keylen, options));
  if (result === false) throw derivingFailed();
  return result;
}

export function scrypt(password, salt, keylen, options, callback = defaults) {
  if (callback === defaults) {
    callback = options;
    options = defaults;
  }
  const args = checkScrypt(password, salt, keylen, options);
  validateFunction(callback, "callback");
  const result = runScrypt(args);
  later(() => (result === false ? callback(derivingFailed()) : callback(null, result)));
}
