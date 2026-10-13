// node:crypto's Hash and Hmac, and crypto.hash(): Node's lib/internal/crypto/hash.js
// over the host primitives, which hash in C (BoringSSL, and SHA-3 of our own).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import {
  cryptoDigestFinal, cryptoDigestUpdate, cryptoHashCopy, cryptoHashes, cryptoHashInfo, cryptoHashNew, cryptoHmacNew,
} from "visaljs:host";
import { codeError, invalidArgType, invalidArgValue, outOfRange, validateString } from "../errors.js";
import {
  encodeOutput, isArrayBufferView, kFinalized, kHandle, kState, LazyTransform, stringBytes, validateEncoding, validateNumber,
} from "./util.js";
import { prepareSecretKey } from "./keys.js";

const finalized = () => codeError(Error, "ERR_CRYPTO_HASH_FINALIZED", "Digest already called");

function validateUint32(value, name) {
  validateNumber(value, name);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < 0 || value > 4294967295) throw outOfRange(name, ">= 0 && <= 4294967295", value);
}

/** The output length option: undefined, or a length the algorithm can give. */
function outputLength(algorithm, options) {
  const xofLen = typeof options === "object" && options !== null ? options.outputLength : undefined;
  if (xofLen === undefined) return undefined;
  validateUint32(xofLen, "options.outputLength");
  const info = cryptoHashInfo(algorithm);
  if (info >= 0 && xofLen !== info) {
    throw codeError(Error, "ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH", "error:030000B2:digital envelope routines::not XOF or invalid length");
  }
  return xofLen;
}

export function Hash(algorithm, options) {
  if (!new.target) return new Hash(algorithm, options);
  const copyOf = algorithm !== null && typeof algorithm === "object" && kHandle in algorithm ? algorithm : null;
  if (copyOf) {
    this[kHandle] = cryptoHashCopy(copyOf[kHandle], outputLength(copyOf._algorithm, options));
    this._algorithm = copyOf._algorithm;
  } else {
    validateString(algorithm, "algorithm");
    const handle = cryptoHashNew(algorithm, cryptoHashInfo(algorithm) === -1 ? undefined : outputLength(algorithm, options));
    if (handle === null) throw new Error("Digest method not supported");
    this[kHandle] = handle;
    Object.defineProperty(this, "_algorithm", { value: algorithm, writable: true });  /* not shown, as Node keeps it in C++ */
  }
  this[kState] = { [kFinalized]: false };
  LazyTransform.call(this, options);
}
Object.setPrototypeOf(Hash.prototype, LazyTransform.prototype);
Object.setPrototypeOf(Hash, LazyTransform);

Hash.prototype.copy = function copy(options) {
  if (this[kState][kFinalized]) throw finalized();
  return new Hash(this, options);
};

Hash.prototype._transform = function _transform(chunk, encoding, callback) {
  cryptoDigestUpdate(this[kHandle], typeof chunk === "string" ? stringBytes(chunk, encoding) : chunk);
  callback();
};

Hash.prototype._flush = function _flush(callback) {
  this.push(cryptoDigestFinal(this[kHandle]));
  callback();
};

Hash.prototype.update = function update(data, encoding) {
  if (this[kState][kFinalized]) throw finalized();
  if (typeof data === "string") validateEncoding(data, encoding);
  else if (!isArrayBufferView(data)) throw invalidArgType("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
  cryptoDigestUpdate(this[kHandle], typeof data === "string" ? stringBytes(data, encoding) : data);
  return this;
};

Hash.prototype.digest = function digest(outputEncoding) {
  if (this[kState][kFinalized]) throw finalized();
  const ret = encodeOutput(cryptoDigestFinal(this[kHandle]), outputEncoding && `${outputEncoding}`);
  this[kState][kFinalized] = true;
  return ret;
};

export function Hmac(hmac, key, options) {
  if (!(this instanceof Hmac)) return new Hmac(hmac, key, options);
  validateString(hmac, "hmac");
  const encoding = options !== null && typeof options === "object" ? options.encoding : undefined;
  const handle = cryptoHmacNew(hmac, prepareSecretKey(key, encoding));
  if (handle === null) throw codeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: " + hmac);
  this[kHandle] = handle;
  this[kState] = { [kFinalized]: false };
  LazyTransform.call(this, options);
}
Object.setPrototypeOf(Hmac.prototype, LazyTransform.prototype);
Object.setPrototypeOf(Hmac, LazyTransform);

Hmac.prototype.update = Hash.prototype.update;

Hmac.prototype.digest = function digest(outputEncoding) {
  if (this[kState][kFinalized]) {
    const buf = Buffer.from("");
    return outputEncoding && outputEncoding !== "buffer" ? buf.toString(outputEncoding) : buf;
  }
  const ret = encodeOutput(cryptoDigestFinal(this[kHandle]), outputEncoding && `${outputEncoding}`);
  this[kState][kFinalized] = true;
  return ret;
};

Hmac.prototype._flush = Hash.prototype._flush;
Hmac.prototype._transform = Hash.prototype._transform;

export function createHash(algorithm, options) {
  return new Hash(algorithm, options);
}

export function createHmac(hmac, key, options) {
  return new Hmac(hmac, key, options);
}

/** crypto.hash(algorithm, data, outputEncoding = "hex"): a one-shot digest. */
export function hash(algorithm, input, outputEncoding = "hex") {
  validateString(algorithm, "algorithm");
  if (typeof input !== "string" && !isArrayBufferView(input)) {
    throw invalidArgType("input", "of type string or an instance of Buffer, TypedArray, or DataView", input);
  }
  let encoding = outputEncoding;
  if (outputEncoding !== "hex") {
    validateString(outputEncoding, "outputEncoding");
    if (outputEncoding.toLowerCase() === "buffer") encoding = "buffer";
    else if (!Buffer.isEncoding(outputEncoding)) throw invalidArgValue("outputEncoding", "is invalid", outputEncoding);
  }
  const handle = cryptoHashNew(algorithm, undefined);
  if (handle === null) throw new Error("Digest method " + algorithm + " is not supported");
  cryptoDigestUpdate(handle, input);
  return encodeOutput(cryptoDigestFinal(handle), encoding);
}

export function getHashes() {
  return cryptoHashes();
}
