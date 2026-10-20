// node:crypto's ciphers: Cipheriv and Decipheriv (lazy Transform streams, as Node's),
// getCiphers and getCipherInfo, Node's lib/internal/crypto/cipher.js over the runtime's C cipher
// context. Output encodings go through a StringDecoder, so a multi-byte character or a base64
// group isn't split between update and final.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import {
  cryptoCipherFinal, cryptoCipherGetAuthTag, cryptoCipherInfo, cryptoCipherNew, cryptoCiphers, cryptoCipherSetAAD,
  cryptoCipherSetAuthTag, cryptoCipherSetPadding, cryptoCipherUpdate,
} from "visaljs:host";
import { codeError, invalidArgType, invalidArgValue, outOfRange, validateString } from "../errors.js";
import { StringDecoder } from "../../string_decoder.js";
import { prepareSecretKey } from "./keys.js";
import { isAnyArrayBuffer, isArrayBufferView, kHandle, LazyTransform, sslError, stringBytes, validateEncoding, validateNumber, validateObject } from "./util.js";

/* the C side's error codes (JS_CIPHER_ERR_*), as Node reports each */
function cipherError(code, name, detail) {
  switch (code) {
    case -1: return codeError(Error, "ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
    case 1: return codeError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length");
    case 2: return codeError(TypeError, "ERR_CRYPTO_INVALID_IV", "Invalid initialization vector");
    case 3: return codeError(TypeError, "ERR_CRYPTO_INVALID_AUTH_TAG", "authTagLength required for " + name);
    case 4: return codeError(TypeError, "ERR_CRYPTO_INVALID_AUTH_TAG", "Invalid authentication tag length: " + detail);
    case 5: return new Error("Trying to add data in unsupported state");
    case 6: return codeError(Error, "ERR_CRYPTO_INVALID_STATE", "Invalid state");
    case 7: return sslError(30, 123, "WRONG_FINAL_BLOCK_LENGTH");
    case 8: return sslError(30, 101, "BAD_DECRYPT");
    case 9: return new Error("Unsupported state or unable to authenticate data");
    case 10: return codeError(Error, "ERR_OSSL_TAG_NOT_SET", "error:1C800077:Provider routines::tag not set");
    case 11: return codeError(RangeError, "ERR_CRYPTO_INVALID_MESSAGELEN", "Invalid message length");
    case 12: return codeError(TypeError, "ERR_MISSING_ARGS", "options.plaintextLength required for CCM mode with AAD");
    default: return new Error("Cipher operation failed");
  }
}

const invalidState = (op) => codeError(Error, "ERR_CRYPTO_INVALID_STATE", "Invalid state for operation " + op);

function getUIntOption(options, key) {
  let value;
  if (options && (value = options[key]) != null) {
    if (value >>> 0 !== value) throw invalidArgValue(`options.${key}`, "is invalid", value);
    return value;
  }
  return -1;
}

function getStringOption(options, key) {
  let value;
  if (options && (value = options[key]) != null) validateString(value, `options.${key}`);
  return value;
}

/** getArrayBufferOrView: a string in `encoding` (UTF-8 by default), or the buffer or view. */
function bytesOf(value, name, encoding) {
  if (isAnyArrayBuffer(value) || isArrayBufferView(value)) return value;
  if (typeof value === "string") return Buffer.from(value, encoding === undefined || encoding === "buffer" ? "utf8" : encoding);
  throw invalidArgType(name, "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", value);
}

/* Node 24's: an unknown encoding is ERR_UNKNOWN_ENCODING (StringDecoder's), a different one than
   the first output's ERR_INVALID_ARG_VALUE */
function getDecoder(decoder, encoding) {
  const normalized = new StringDecoder(encoding).encoding;
  decoder ||= new StringDecoder(encoding);
  if (decoder.encoding !== normalized) throw invalidArgValue("outputEncoding", `cannot be changed from '${decoder.encoding}'`, encoding);
  return decoder;
}

const kGcmAnyTag = Symbol("kGcmAnyTag");
let warnedShortTag = false;

function createCipherWithIV(self, cipher, key, options, encrypt, iv) {
  validateString(cipher, "cipher");
  const encoding = getStringOption(options, "encoding");
  key = prepareSecretKey(key, encoding);
  iv = iv === null ? null : bytesOf(iv, "iv");
  const authTagLength = getUIntOption(options, "authTagLength");
  const handle = cryptoCipherNew(cipher, encrypt, key, iv, authTagLength);
  if (typeof handle === "number") throw cipherError(handle, cipher, authTagLength);
  self[kHandle] = handle;
  /* GCM without authTagLength: a short tag on decryption is deprecated (DEP0182) */
  self[kGcmAnyTag] = /-gcm$/i.test(cipher) && authTagLength === -1;
  self._decoder = null;
  LazyTransform.call(self, options);
}

function update(data, inputEncoding, outputEncoding) {
  if (typeof data === "string") validateEncoding(data, inputEncoding);
  else if (!isArrayBufferView(data)) throw invalidArgType("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
  const ret = cryptoCipherUpdate(this[kHandle], typeof data === "string" ? stringBytes(data, inputEncoding) : data);
  if (typeof ret === "number") throw cipherError(ret);
  if (outputEncoding && outputEncoding !== "buffer") {
    this._decoder = getDecoder(this._decoder, outputEncoding);
    return this._decoder.write(ret);
  }
  return ret;
}

function final(outputEncoding) {
  const ret = cryptoCipherFinal(this[kHandle]);
  if (typeof ret === "number") throw cipherError(ret);
  if (outputEncoding && outputEncoding !== "buffer") {
    this._decoder = getDecoder(this._decoder, outputEncoding);
    return this._decoder.end(ret);
  }
  return ret;
}

function setAutoPadding(ap) {
  if (!cryptoCipherSetPadding(this[kHandle], !!ap)) throw invalidState("setAutoPadding");
  return this;
}

function setAAD(aadbuf, options) {
  const encoding = getStringOption(options, "encoding");
  const plaintextLength = getUIntOption(options, "plaintextLength");
  aadbuf = bytesOf(aadbuf, "aadbuf", encoding);
  const code = cryptoCipherSetAAD(this[kHandle], aadbuf, plaintextLength);
  if (code === 5) throw invalidState("setAAD");
  if (code !== 0) throw cipherError(code);
  return this;
}

function _transform(chunk, encoding, callback) {
  this.push(update.call(this, chunk, encoding));
  callback();
}

function _flush(callback) {
  try {
    this.push(final.call(this));
  } catch (e) {
    callback(e);
    return;
  }
  callback();
}

export function Cipheriv(cipher, key, iv, options) {
  if (!(this instanceof Cipheriv)) return new Cipheriv(cipher, key, iv, options);
  createCipherWithIV(this, cipher, key, options, true, iv);
}
Object.setPrototypeOf(Cipheriv.prototype, LazyTransform.prototype);
Object.setPrototypeOf(Cipheriv, LazyTransform);
Object.assign(Cipheriv.prototype, { _transform, _flush, update, final, setAutoPadding });
Cipheriv.prototype.getAuthTag = function getAuthTag() {
  const ret = cryptoCipherGetAuthTag(this[kHandle]);
  if (ret === undefined) throw invalidState("getAuthTag");
  return ret;
};
Cipheriv.prototype.setAAD = setAAD;

export function Decipheriv(cipher, key, iv, options) {
  if (!(this instanceof Decipheriv)) return new Decipheriv(cipher, key, iv, options);
  createCipherWithIV(this, cipher, key, options, false, iv);
}
Object.setPrototypeOf(Decipheriv.prototype, LazyTransform.prototype);
Object.setPrototypeOf(Decipheriv, LazyTransform);
Object.assign(Decipheriv.prototype, { _transform, _flush, update, final, setAutoPadding });
Decipheriv.prototype.setAuthTag = function setAuthTag(tagbuf, encoding) {
  tagbuf = bytesOf(tagbuf, "buffer", encoding);
  const code = cryptoCipherSetAuthTag(this[kHandle], tagbuf);
  if (code === 5) throw invalidState("setAuthTag");
  if (code !== 0) throw cipherError(code, undefined, tagbuf.byteLength);
  if (this[kGcmAnyTag] && tagbuf.byteLength !== 16 && !warnedShortTag) {
    warnedShortTag = true;  /* once a process, as Node's */
    process.emitWarning("Using AES-GCM authentication tags of less than 128 bits without specifying the authTagLength option " +
      "when initializing decryption is deprecated.", "DeprecationWarning", "DEP0182");
  }
  return this;
};
Decipheriv.prototype.setAAD = setAAD;

export function createCipheriv(cipher, key, iv, options) {
  return new Cipheriv(cipher, key, iv, options);
}

export function createDecipheriv(cipher, key, iv, options) {
  return new Decipheriv(cipher, key, iv, options);
}

export function getCiphers() {
  return cryptoCiphers();
}

function validateInt32(value, name) {
  validateNumber(value, name);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < -2147483648 || value > 2147483647) throw outOfRange(name, ">= -2147483648 && <= 2147483647", value);
}

export function getCipherInfo(nameOrNid, options) {
  if (typeof nameOrNid !== "string" && typeof nameOrNid !== "number") {
    throw invalidArgType("nameOrNid", "one of type string or number", nameOrNid);
  }
  if (typeof nameOrNid === "number") validateInt32(nameOrNid, "nameOrNid");
  let keyLength, ivLength;
  if (options !== undefined) {
    validateObject(options, "options");
    ({ keyLength, ivLength } = options);
    if (keyLength !== undefined) validateInt32(keyLength, "options.keyLength");
    if (ivLength !== undefined) validateInt32(ivLength, "options.ivLength");
  }
  const info = cryptoCipherInfo(nameOrNid);
  if (info === null) return undefined;
  const [name, nid, mode, blockSize, ivLen, keyLen] = info;
  if (keyLength !== undefined && keyLength !== keyLen) return undefined;
  if (ivLength !== undefined) {
    const ok = mode === "gcm" ? ivLength > 0 : mode === "ccm" ? ivLength >= 7 && ivLength <= 13 : ivLength === ivLen;
    if (!ok) return undefined;
  }
  const ret = { mode, name, nid };
  if (mode !== "stream") ret.blockSize = blockSize;
  if (ivLen !== 0) ret.ivLength = ivLength ?? ivLen;
  ret.keyLength = keyLen;
  return ret;
}
