// What node:crypto's parts share: argument checks with Node's errors, encodings
// through Buffer, and LazyTransform, the stream base of Hash, Hmac and the ciphers (a Transform
// set up only when a stream property is first used, as Node's is).
import Transform from "../streams/transform.js";
import { codeError, invalidArgType } from "../errors.js";

export const kHandle = Symbol("kHandle");
export const kState = Symbol("kState");
export const kFinalized = Symbol("kFinalized");

export const isArrayBufferView = (v) => ArrayBuffer.isView(v);
export const isAnyArrayBuffer = (v) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && v instanceof SharedArrayBuffer);

/** An encoding Node's C++ takes (ParseEncoding): its Buffer name, or undefined ("buffer" too). */
export function bufferEncoding(enc) {
  if (typeof enc !== "string" || enc.toLowerCase() === "buffer") return undefined;
  return Buffer.isEncoding(enc) ? enc : undefined;
}

/** Bytes as Node returns them: a string in `enc`, or the Buffer. */
export function encodeOutput(buf, enc) {
  const e = bufferEncoding(enc);
  return e === undefined ? buf : buf.toString(e);
}

/** A string's bytes in an encoding (UTF-8 for none or an unknown one), as Node's C++ reads them. */
export function stringBytes(data, enc) {
  const e = bufferEncoding(enc);
  return e === undefined || e === "utf8" || e === "utf-8" ? data : Buffer.from(data, e);
}

/** validateEncoding: hex data must have an even length. */
export function validateEncoding(data, enc) {
  if (typeof enc === "string" && enc.toLowerCase() === "hex" && data.length % 2 !== 0) {
    throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'encoding' is invalid for data of length " + data.length + ". Received '" + enc + "'");
  }
}

/** Node's validateObject: an object, not null nor an array. */
export function validateObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidArgType(name, "of type object", value);
}

/* BoringSSL's libraries (ERR_LIB_*): the name it gives each, and Node's prefix for its codes (none
 * for the libraries OpenSSL doesn't have) */
const SSL_LIBS = {
  3: ["bignum routines", "BN_"], 4: ["RSA routines", "RSA_"], 5: ["Diffie-Hellman routines", "DH_"], 6: ["public key routines", "EVP_"],
  9: ["PEM routines", "PEM_"], 12: ["asn1 encoding routines", "ASN1_"], 15: ["elliptic curve routines", "EC_"], 30: ["Cipher functions", ""],
};

/** An error BoringSSL raised, as Node shows one: `error:1e000065:Cipher functions:OPENSSL_internal:BAD_DECRYPT`,
 *  with its code, library, function and reason. `lib` and `reason` are BoringSSL's numbers. */
export function sslError(lib, reason, name) {
  const [library, prefix] = SSL_LIBS[lib];
  const packed = ((lib << 24) | reason) >>> 0;
  const e = codeError(Error, `ERR_OSSL_${prefix}${name}`, `error:${packed.toString(16).padStart(8, "0")}:${library}:OPENSSL_internal:${name}`);
  e.library = library;
  e.function = "OPENSSL_internal";
  e.reason = name;
  return e;
}

export function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw invalidArgType(name, "of type boolean", value);
}

export function validateNumber(value, name) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
}

/* ---- LazyTransform ------------------------------------------------------------------------------ */

export function LazyTransform(options) {
  this._options = options;
}
Object.setPrototypeOf(LazyTransform.prototype, Transform.prototype);
Object.setPrototypeOf(LazyTransform, Transform);

function makeGetter(name) {
  return function () {
    Transform.call(this, this._options);
    this._writableState.decodeStrings = false;
    return this[name];
  };
}

function makeSetter(name) {
  return function (val) {
    Object.defineProperty(this, name, { value: val, enumerable: true, configurable: true, writable: true });
  };
}

/* Node 24's lib/internal/streams/lazy_transform.js: the two states (Transform keeps no third) */
for (const name of ["_readableState", "_writableState"]) {
  Object.defineProperty(LazyTransform.prototype, name, { get: makeGetter(name), set: makeSetter(name), configurable: true, enumerable: true });
}
