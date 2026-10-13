// node:crypto's asymmetric operations: Sign and Verify (Writable streams, as Node's),
// sign and verify, publicEncrypt, privateDecrypt, privateEncrypt and publicDecrypt, ECDH,
// diffieHellman and getCurves: Node's lib/internal/crypto/{sig,cipher,diffiehellman}.js over the
// runtime's C (crypto_asym.c), which signs digests: the hashing is the Hash primitives'.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import {
  cryptoDigestFinal, cryptoDigestUpdate, cryptoEcdh, cryptoEcPoint, cryptoEcPrivate, cryptoHashNew, cryptoKeyGenerate, cryptoKeyParts,
  cryptoRsaCrypt, cryptoSign, cryptoSignMessage, cryptoVerify, cryptoVerifyMessage,
} from "visaljs:host";
import { Writable } from "../../stream.js";
import { codeError, invalidArgType, invalidArgValue, validateFunction, validateString } from "../errors.js";
import { dhStateless } from "./diffiehellman.js";
import { asymmetricKeyTypeOf, KeyObject, preparePrivateKey, preparePublicOrPrivateKey, pssParamsOf } from "./keys.js";
import { isAnyArrayBuffer, isArrayBufferView, kHandle, stringBytes, validateEncoding, validateObject } from "./util.js";

const later = (fn) => setTimeout(fn, 0);

/* the runtime's error codes (JS_ASYM_ERR_*), as Node reports each */
function asymError(code, digest) {
  switch (code) {
    case 1: return codeError(Error, "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "error:03000096:digital envelope routines::operation not supported for this keytype");
    case 2: return codeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", digest === undefined ? "Invalid digest" : "Invalid digest: " + digest);
    case 4: return codeError(Error, "ERR_OSSL_INVALID_SALT_LENGTH", "error:1C800070:Provider routines::invalid salt length");
    case 5: return codeError(Error, "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE", "error:0200006E:rsa routines::data too large for key size");
    case 6: return codeError(Error, "ERR_OSSL_RSA_DATA_TOO_SMALL_FOR_KEY_SIZE", "error:0200007A:rsa routines::data too small for key size");
    case 7: return codeError(Error, "ERR_OSSL_RSA_OAEP_DECODING_ERROR", "error:02000079:rsa routines::oaep decoding error");
    case 8: return codeError(Error, "ERR_OSSL_RSA_PADDING_CHECK_FAILED", "error:02000072:rsa routines::padding check failed");
    case 9: return codeError(Error, "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", "Public key is not valid for specified curve");
    case 10: return codeError(TypeError, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
    case 11: return codeError(Error, "ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation");
    default: return new Error("Crypto operation failed");
  }
}

/** getArrayBufferOrView: a string in `encoding`, or the buffer or view. */
function bytesOf(value, name, encoding) {
  if (isAnyArrayBuffer(value) || isArrayBufferView(value)) return value;
  if (typeof value === "string") return Buffer.from(value, encoding === undefined || encoding === "buffer" ? "utf8" : encoding);
  throw invalidArgType(name, "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", value);
}

const encode = (buffer, encoding) => (encoding && encoding !== "buffer" ? buffer.toString(encoding) : buffer);

/* ---- signing options --------------------------------------------------------------------------- */

function getIntOption(name, options) {
  const value = options[name];
  if (value !== undefined) {
    if (value === value >> 0) return value;
    throw invalidArgValue(`options.${name}`, "is invalid", value);
  }
  return undefined;
}

function getDSASignatureEncoding(options) {
  if (typeof options === "object") {
    const { dsaEncoding = "der" } = options;
    if (dsaEncoding === "der") return false;
    if (dsaEncoding === "ieee-p1363") return true;
    throw invalidArgValue("options.dsaEncoding", "is invalid", dsaEncoding);
  }
  return false;
}

/* Ed25519 signs the message (no digest: naming one is OpenSSL's error) */
const signsMessages = (handle) => asymmetricKeyTypeOf(handle) === "ed25519";
const invalidDigest = () => codeError(Error, "ERR_OSSL_INVALID_DIGEST", "error:1C80007A:Provider routines::invalid digest");

function signMessage(handle, algorithm, data) {
  if (algorithm != null) throw invalidDigest();
  const sig = cryptoSignMessage(handle, data);
  if (typeof sig === "number") throw asymError(sig);
  return sig;
}

function verifyMessage(handle, algorithm, data, signature) {
  if (algorithm != null) throw invalidDigest();
  const ok = cryptoVerifyMessage(handle, data, signature);
  if (typeof ok === "number") throw asymError(ok);
  return ok;
}

/* The hash a signature uses: the one named, else the key's default (its PSS parameters', or SHA-256) */
function hashFor(algorithm, handle) {
  if (algorithm != null) return algorithm;
  const pss = pssParamsOf(handle);
  return pss ? pss[0] : "sha256";
}

function digestOf(hash, data) {
  const h = cryptoHashNew(hash, undefined);
  if (h === null) return null;
  cryptoDigestUpdate(h, data);
  return cryptoDigestFinal(h);
}

function signDigest(handle, hash, digest, options) {
  const sig = cryptoSign(handle, hash, digest, getIntOption("padding", options), getIntOption("saltLength", options), getDSASignatureEncoding(options));
  if (typeof sig === "number") throw asymError(sig, hash);
  return sig;
}

function verifyDigest(handle, hash, digest, signature, options) {
  const ok = cryptoVerify(handle, hash, digest, signature, getIntOption("padding", options), getIntOption("saltLength", options),
    getDSASignatureEncoding(options));
  if (typeof ok === "number") throw asymError(ok, hash);
  return ok;
}

/* ---- Sign and Verify --------------------------------------------------------------------------- */

const notInitialised = () => codeError(Error, "ERR_CRYPTO_INVALID_STATE", "Not initialised");

function initDigest(self, algorithm, options) {
  validateString(algorithm, "algorithm");
  const handle = cryptoHashNew(algorithm, undefined);
  if (handle === null) throw codeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", "Invalid digest");
  self[kHandle] = { hash: handle, algorithm };
  Writable.call(self, options);
}

function update(data, encoding) {
  if (typeof data === "string") validateEncoding(data, encoding);
  else if (!isArrayBufferView(data)) throw invalidArgType("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
  if (this[kHandle].hash === null) throw notInitialised();
  cryptoDigestUpdate(this[kHandle].hash, typeof data === "string" ? stringBytes(data, encoding) : data);
  return this;
}

function _write(chunk, encoding, callback) {
  this.update(chunk, encoding);
  callback();
}

/* the accumulated digest, once */
function takeDigest(self) {
  const state = self[kHandle];
  if (state.hash === null) throw notInitialised();
  const digest = cryptoDigestFinal(state.hash);
  state.hash = null;
  return digest;
}

export function Sign(algorithm, options) {
  if (!(this instanceof Sign)) return new Sign(algorithm, options);
  initDigest(this, algorithm, options);
}
Object.setPrototypeOf(Sign.prototype, Writable.prototype);
Object.setPrototypeOf(Sign, Writable);
Sign.prototype._write = _write;
Sign.prototype.update = update;
Sign.prototype.sign = function sign(options, encoding) {
  if (!options) throw codeError(Error, "ERR_CRYPTO_SIGN_KEY_REQUIRED", "No key provided to sign");
  const handle = preparePrivateKey(options);
  const ret = signDigest(handle, this[kHandle].algorithm, takeDigest(this), options);
  return encode(ret, encoding);
};

export function Verify(algorithm, options) {
  if (!(this instanceof Verify)) return new Verify(algorithm, options);
  initDigest(this, algorithm, options);
}
Object.setPrototypeOf(Verify.prototype, Writable.prototype);
Object.setPrototypeOf(Verify, Writable);
Verify.prototype._write = _write;
Verify.prototype.update = update;
Verify.prototype.verify = function verify(options, signature, sigEncoding) {
  const handle = preparePublicOrPrivateKey(options);
  signature = bytesOf(signature, "signature", sigEncoding);
  return verifyDigest(handle, this[kHandle].algorithm, takeDigest(this), signature, options);
};

export function createSign(algorithm, options) {
  return new Sign(algorithm, options);
}

export function createVerify(algorithm, options) {
  return new Verify(algorithm, options);
}

export function sign(algorithm, data, key, callback) {
  if (algorithm != null) validateString(algorithm, "algorithm");
  if (callback !== undefined) validateFunction(callback, "callback");
  data = bytesOf(data, "data");
  if (!key) throw codeError(Error, "ERR_CRYPTO_SIGN_KEY_REQUIRED", "No key provided to sign");
  getIntOption("padding", key);
  getIntOption("saltLength", key);
  getDSASignatureEncoding(key);
  const handle = preparePrivateKey(key);
  const run = signsMessages(handle) ? () => signMessage(handle, algorithm, data) : () => {
    const hash = hashFor(algorithm, handle);
    const digest = digestOf(hash, data);
    if (digest === null) throw asymError(2, hash);
    return signDigest(handle, hash, digest, key);
  };
  if (callback === undefined) return run();
  let result;
  try {
    result = run();
  } catch (e) {
    later(() => callback(e));
    return;
  }
  later(() => callback(null, result));
}

export function verify(algorithm, data, key, signature, callback) {
  if (algorithm != null) validateString(algorithm, "algorithm");
  if (callback !== undefined) validateFunction(callback, "callback");
  data = bytesOf(data, "data");
  if (!isArrayBufferView(data)) throw invalidArgType("data", "an instance of Buffer, TypedArray, or DataView", data);
  getIntOption("padding", key);
  getIntOption("saltLength", key);
  getDSASignatureEncoding(key);
  if (!isArrayBufferView(signature)) throw invalidArgType("signature", "an instance of Buffer, TypedArray, or DataView", signature);
  const handle = preparePublicOrPrivateKey(key);
  const run = signsMessages(handle) ? () => verifyMessage(handle, algorithm, data, signature) : () => {
    const hash = hashFor(algorithm, handle);
    const digest = digestOf(hash, data);
    if (digest === null) throw asymError(2, hash);
    return verifyDigest(handle, hash, digest, signature, key);
  };
  if (callback === undefined) return run();
  let result;
  try {
    result = run();
  } catch (e) {
    later(() => callback(e));
    return;
  }
  later(() => callback(null, result));
}

/* ---- RSA encryption ---------------------------------------------------------------------------- */

const OAEP = 4, PKCS1 = 1;

function rsaFunctionFor(op, defaultPadding, wantPrivate) {
  return (options, buffer) => {
    const handle = wantPrivate ? preparePrivateKey(options) : preparePublicOrPrivateKey(options);
    const padding = options.padding || defaultPadding;
    const { oaepHash, encoding } = options;
    let { oaepLabel } = options;
    if (oaepHash !== undefined) validateString(oaepHash, "key.oaepHash");
    if (oaepLabel !== undefined) oaepLabel = bytesOf(oaepLabel, "key.oaepLabel", encoding);
    buffer = bytesOf(buffer, "buffer", encoding);
    const ret = cryptoRsaCrypt(handle, op, buffer, padding, oaepHash, oaepLabel);
    if (typeof ret === "number") throw asymError(ret, oaepHash);
    return ret;
  };
}

export const publicEncrypt = rsaFunctionFor(0, OAEP, false);
export const privateDecrypt = rsaFunctionFor(1, OAEP, true);
export const privateEncrypt = rsaFunctionFor(2, PKCS1, true);
export const publicDecrypt = rsaFunctionFor(3, PKCS1, false);

/* ---- ECDH -------------------------------------------------------------------------------------- */

const CURVES = ["prime256v1", "secp384r1", "secp521r1"];

export function getCurves() {
  return CURVES.slice();
}

function getFormat(format) {
  if (format) {
    if (format === "compressed") return 2;
    if (format === "hybrid") return 6;
    if (format !== "uncompressed") throw codeError(TypeError, "ERR_CRYPTO_ECDH_INVALID_FORMAT", "Invalid ECDH format: " + format);
  }
  return 4;
}

export function ECDH(curve) {
  if (!(this instanceof ECDH)) return new ECDH(curve);
  validateString(curve, "curve");
  if (!CURVES.includes(curve)) throw asymError(10);
  this[kHandle] = { curve, key: null, publicPoint: null };
}

ECDH.prototype.generateKeys = function generateKeys(encoding, format) {
  this[kHandle].key = cryptoKeyGenerate("ec", this[kHandle].curve);
  this[kHandle].publicPoint = null;
  return this.getPublicKey(encoding, format);
};

ECDH.prototype.getPublicKey = function getPublicKey(encoding, format) {
  const f = getFormat(format);
  const state = this[kHandle];
  const point = state.key !== null ? cryptoKeyParts(state.key)[0] : state.publicPoint;
  if (point == null) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Failed to get ECDH public key");
  return encode(cryptoEcPoint(state.curve, point, f), encoding);
};

ECDH.prototype.getPrivateKey = function getPrivateKey(encoding) {
  const state = this[kHandle];
  if (state.key === null) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Failed to get ECDH private key");
  return encode(cryptoKeyParts(state.key)[1], encoding);
};

ECDH.prototype.setPrivateKey = function setPrivateKey(key, encoding) {
  key = bytesOf(key, "key", encoding);
  const handle = cryptoEcPrivate(this[kHandle].curve, key);
  if (typeof handle === "number") throw codeError(Error, "ERR_CRYPTO_INVALID_KEYTYPE", "Private key is not valid for specified curve.");
  this[kHandle].key = handle;
  this[kHandle].publicPoint = null;
  return this;
};

ECDH.prototype.setPublicKey = function setPublicKey(key, encoding) {
  key = bytesOf(key, "key", encoding);
  const point = cryptoEcPoint(this[kHandle].curve, key, 4);
  if (typeof point === "number") throw asymError(9);
  this[kHandle].publicPoint = point;
  return this;
};

ECDH.prototype.computeSecret = function computeSecret(key, inEnc, outEnc) {
  key = bytesOf(key, "key", inEnc);
  if (this[kHandle].key === null) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Failed to compute ECDH key");
  const ret = cryptoEcdh(this[kHandle].key, key);
  if (typeof ret === "number") throw asymError(9);
  return encode(ret, outEnc);
};

ECDH.convertKey = function convertKey(key, curve, inEnc, outEnc, format) {
  validateString(curve, "curve");
  key = bytesOf(key, "key", inEnc);
  const f = getFormat(format);
  const ret = cryptoEcPoint(curve, key, f);
  if (typeof ret === "number") throw asymError(ret === 10 ? 10 : 9);
  return encode(ret, outEnc);
};

export function createECDH(curve) {
  return new ECDH(curve);
}

/* ---- diffieHellman ----------------------------------------------------------------------------- */

const keyObjectType = (actual, expected) =>
  codeError(TypeError, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", `Invalid key object type ${actual}, expected ${expected}.`);

export function diffieHellman(options) {
  validateObject(options, "options");
  const { privateKey, publicKey } = options;
  if (!(privateKey instanceof KeyObject)) throw invalidArgValue("options.privateKey", "is invalid", privateKey);
  if (!(publicKey instanceof KeyObject)) throw invalidArgValue("options.publicKey", "is invalid", publicKey);
  if (privateKey.type !== "private") throw keyObjectType(privateKey.type, "private");
  if (publicKey.type !== "public" && publicKey.type !== "private") throw keyObjectType(publicKey.type, "private or public");
  const privateType = asymmetricKeyTypeOf(privateKey[kHandle]);
  const publicType = asymmetricKeyTypeOf(publicKey[kHandle]);
  if (privateType !== publicType || (privateType !== "ec" && privateType !== "x25519" && privateType !== "dh")) {
    throw codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY", `Incompatible key types for Diffie-Hellman: ${privateType} and ${publicType}`);
  }
  if (privateType === "dh") return dhStateless(cryptoKeyParts(privateKey[kHandle]), cryptoKeyParts(publicKey[kHandle]));
  const ret = cryptoEcdh(privateKey[kHandle], publicKey[kHandle]);
  if (typeof ret === "number") throw asymError(9);
  return ret;
}
