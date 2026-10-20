// node:crypto's keys: KeyObject and its subclasses, as Node 24's lib/internal/crypto/keys.js
// defines them (their slots hidden, so they inspect as {} as Node's do), over the runtime's key handles,
// which CryptoKey shares. PEM (base64 and its labels) and JWK (base64url and its members) are
// here; DER is the runtime's.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import {
  cryptoCipherInfo, cryptoEcPoint, cryptoHashInfo, cryptoKeyEquals, cryptoRandomFill, cryptoKeyExport, cryptoKeyFromParts, cryptoKeyGenerate, cryptoKeyHandleOf, cryptoKeyInfo,
  cryptoKeyParse, cryptoKeyParts, cryptoKeyPublic, cryptoKeySecret, cryptoKeySecretBytes, cryptoToCryptoKey,
} from "visaljs:host";
import { codeError, invalidArgType, invalidArgValue, notSupported, outOfRange, validateFunction, validateString } from "../errors.js";
import { dhKeyParts, dhParameters } from "./diffiehellman.js";
import { kKeyType } from "./key_type.js";
import { checkPemPassphrase, decryptPemBody, decryptPkcs8, encryptPemBody, encryptPkcs8, isEncryptedPkcs8 } from "./key_encryption.js";
import { isAnyArrayBuffer, isArrayBufferView, kHandle, validateNumber, validateObject } from "./util.js";

const kAsymmetricKeyType = Symbol("kAsymmetricKeyType");
const kAsymmetricKeyDetails = Symbol("kAsymmetricKeyDetails");

const later = (fn) => setTimeout(fn, 0);
/* a slot of the key's: not enumerable, as Node 24's private fields aren't seen */
const slot = (o, key, value) => {
  Object.defineProperty(o, key, { value, enumerable: false, configurable: false, writable: false });
  return value;
};
const isStringOrBuffer = (v) => typeof v === "string" || isArrayBufferView(v) || isAnyArrayBuffer(v);

/* ---- errors ------------------------------------------------------------------------------------ */

const keyObjectType = (actual, expected) =>
  codeError(TypeError, "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", `Invalid key object type ${actual}, expected ${expected}.`);
const incompatible = (encoding, why) =>
  codeError(Error, "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", `The selected key encoding ${encoding} ${why}.`);
const invalidJwk = (message = "Invalid JWK data") => codeError(TypeError, "ERR_CRYPTO_INVALID_JWK", message);

/* the runtime's error codes for a key it couldn't decode or encode */
function keyError(code) {
  switch (code) {
    case 1: return codeError(Error, "ERR_OSSL_UNSUPPORTED", "error:1E08010C:DECODER routines::unsupported");
    case 2: return codeError(Error, "ERR_OSSL_ASN1_WRONG_TAG", "error:068000A8:asn1 encoding routines::wrong tag");
    case 3: return notSupported("This key type");
    default: return new Error("Key operation failed");
  }
}

/** validateOneOf: `The property 'options.format' must be one of: undefined, 'buffer', 'jwk'. Received 'pem'` */
function validateOneOf(value, name, oneOf) {
  if (!oneOf.includes(value)) {
    const allowed = oneOf.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ");
    throw invalidArgValue(name, "must be one of: " + allowed, value);
  }
}

function validateUint32(value, name) {
  validateNumber(value, name);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < 0 || value > 4294967295) throw outOfRange(name, ">= 0 && <= 4294967295", value);
}

function validateIntegerIn(value, name, min, max) {
  validateNumber(value, name);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
}

/* ---- secret keys ------------------------------------------------------------------------------- */

/** A secret key's bytes from what the APIs accept: a string in `encoding`, a buffer or view, a
 *  secret KeyObject or CryptoKey. */
export function prepareSecretKey(key, encoding, bufferOnly = false) {
  if (!bufferOnly) {
    if (key instanceof KeyObject) {
      if (key.type !== "secret") throw keyObjectType(key.type, "secret");
      return cryptoKeySecretBytes(key[kHandle]);
    }
    const handle = cryptoKeyHandleOf(key);
    if (handle !== undefined) {
      const type = cryptoKeyInfo(handle)[0];
      if (type !== "secret") throw keyObjectType(type, "secret");
      return cryptoKeySecretBytes(handle);
    }
  }
  if (typeof key === "string") {
    return Buffer.from(key, encoding === undefined || encoding === "buffer" || !Buffer.isEncoding(encoding) ? "utf8" : encoding);
  }
  if (isArrayBufferView(key) || isAnyArrayBuffer(key)) return key;
  const expected = bufferOnly
    ? "an instance of ArrayBuffer, Buffer, TypedArray, or DataView"
    : "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey";
  throw invalidArgType("key", expected, key);
}

/* ---- KeyObject --------------------------------------------------------------------------------- */

function isKeyHandle(handle) {
  try {
    cryptoKeyInfo(handle);
    return true;
  } catch {
    return false;
  }
}

export class KeyObject {
  constructor(type, handle) {
    if (type !== "secret" && type !== "public" && type !== "private") throw invalidArgValue("type", "is invalid", type);
    if (typeof handle !== "object" || handle === null || !isKeyHandle(handle)) throw invalidArgType("handle", "of type object", handle);
    slot(this, kKeyType, type);
    slot(this, kHandle, handle);
  }

  get type() {
    return this[kKeyType];
  }

  /* Node 24: on KeyObject, for every type */
  toCryptoKey(algorithm, extractable, keyUsages) {
    if (this.type === "secret") return cryptoToCryptoKey("raw", cryptoKeySecretBytes(this[kHandle]), algorithm, extractable, keyUsages);
    const der = cryptoKeyExport(this[kHandle], this.type === "public" ? 0 : 2);
    return cryptoToCryptoKey(this.type === "public" ? "spki" : "pkcs8", der, algorithm, extractable, keyUsages);
  }

  static from(key) {
    const handle = cryptoKeyHandleOf(key);
    if (handle === undefined) throw invalidArgType("key", "an instance of CryptoKey", key);
    return wrapHandle(handle);
  }

  equals(otherKeyObject) {
    if (!(otherKeyObject instanceof KeyObject)) throw invalidArgType("otherKeyObject", "an instance of KeyObject", otherKeyObject);
    return otherKeyObject.type === this.type && cryptoKeyEquals(this[kHandle], otherKeyObject[kHandle]);
  }
}

Object.defineProperty(KeyObject.prototype, Symbol.toStringTag, { configurable: true, value: "KeyObject" });

class SecretKeyObject extends KeyObject {
  constructor(handle) {
    super("secret", handle);
  }

  get symmetricKeySize() {
    return cryptoKeySecretBytes(this[kHandle]).length;
  }

  export(options) {
    if (options !== undefined) {
      validateObject(options, "options");
      validateOneOf(options.format, "options.format", [undefined, "buffer", "jwk"]);
      if (options.format === "jwk") return { kty: "oct", k: cryptoKeySecretBytes(this[kHandle]).toString("base64url") };
    }
    return cryptoKeySecretBytes(this[kHandle]);
  }
}

/* asymmetricKeyDetails: Node's normalized form of the key's details */
const bitLength = (b) => {
  let bits = (b.length - 1) * 8;
  for (let top = b[0]; top; top >>= 1) bits++;
  return bits;
};

function keyDetails(handle) {
  const [, kind, namedCurve, pss] = cryptoKeyInfo(handle);
  if (kind === "ec") return { namedCurve };
  if (kind === "dsa") {
    const [p, q] = cryptoKeyParts(handle);
    return { modulusLength: bitLength(p), divisorLength: bitLength(q) };
  }
  const [n, e] = cryptoKeyParts(handle);
  let bits = (n.length - 1) * 8;
  for (let top = n[0]; top; top >>= 1) bits++;
  const details = { modulusLength: bits, publicExponent: BigInt("0x" + e.toString("hex")) };
  if (pss) {
    details.hashAlgorithm = pss[0];
    details.mgf1HashAlgorithm = pss[1];
    details.saltLength = pss[2];
  }
  return details;
}

class AsymmetricKeyObject extends KeyObject {
  get asymmetricKeyType() {
    return this[kAsymmetricKeyType] ?? slot(this, kAsymmetricKeyType, cryptoKeyInfo(this[kHandle])[1]);
  }

  get asymmetricKeyDetails() {
    switch (this.asymmetricKeyType) {
      case "rsa":
      case "rsa-pss":
      case "ec":
      case "dsa":
        return { ...(this[kAsymmetricKeyDetails] ?? slot(this, kAsymmetricKeyDetails, keyDetails(this[kHandle]))) };
      default:
        return {};
    }
  }

}

class PublicKeyObject extends AsymmetricKeyObject {
  constructor(handle) {
    super("public", handle);
  }

  export(options) {
    if (options && options.format === "jwk") return exportJwk(this[kHandle], false);
    if (options && options.format === "raw-public") return exportRawPublic(this[kHandle], options.type);
    const { format, type } = parseKeyEncoding(options, this.asymmetricKeyType, true);
    return exportKey(this[kHandle], format, type, false);
  }
}

class PrivateKeyObject extends AsymmetricKeyObject {
  constructor(handle) {
    super("private", handle);
  }

  export(options) {
    if (options?.passphrase !== undefined && options.format !== "pem" && options.format !== "der") {
      throw incompatible(options.format, "does not support encryption");
    }
    if (options && options.format === "jwk") return exportJwk(this[kHandle], true);
    if (options && (options.format === "raw-private" || options.format === "raw-seed")) return exportRawPrivate(this[kHandle], options.format);
    const { format, type, cipher, passphrase } = parseKeyEncoding(options, this.asymmetricKeyType, false);
    return exportKey(this[kHandle], format, type, true, cipher, passphrase);
  }
}

function wrapHandle(handle) {
  switch (cryptoKeyInfo(handle)[0]) {
    case "secret": return new SecretKeyObject(handle);
    case "public": return new PublicKeyObject(handle);
    default: return new PrivateKeyObject(handle);
  }
}

/* ---- encodings: PEM and DER -------------------------------------------------------------------- */

/* the runtime's encodings */
const SPKI = 0, PKCS1 = 1, PKCS8 = 2, SEC1 = 3, CERT = 4;
const ENCODING_NAMES = { pkcs1: PKCS1, spki: SPKI, pkcs8: PKCS8, sec1: SEC1 };

/* an option's name in messages: options.format, or under a prefix (Node 24's), key.format */
function option(name, prefix) {
  return prefix === undefined ? `options.${name}` : `${prefix}.${name}`;
}

function parseKeyFormat(formatStr, defaultFormat, optionName) {
  if (formatStr === undefined && defaultFormat !== undefined) return defaultFormat;
  if (formatStr === "pem" || formatStr === "der" || formatStr === "jwk") return formatStr;
  throw invalidArgValue(optionName, "is invalid", formatStr);
}

function parseKeyType(typeStr, required, keyType, isPublic, optionName) {
  if (typeStr === undefined && !required) return undefined;
  if (typeStr === "pkcs1") {
    if (keyType !== undefined && keyType !== "rsa") throw incompatible(typeStr, "can only be used for RSA keys");
    return typeStr;
  }
  if (typeStr === "spki" && isPublic !== false) return typeStr;
  if (typeStr === "pkcs8" && isPublic !== true) return typeStr;
  if (typeStr === "sec1" && isPublic !== true) {
    if (keyType !== undefined && keyType !== "ec") throw incompatible(typeStr, "can only be used for EC keys");
    return typeStr;
  }
  throw invalidArgValue(optionName, "is invalid", typeStr);
}

function parseKeyEncoding(enc, keyType, isPublic, objName) {
  validateObject(enc, "options");
  const isInput = keyType === undefined;
  const format = parseKeyFormat(enc.format, isInput ? "pem" : undefined, option("format", objName));
  const isRequired = (!isInput || format === "der") && format !== "jwk";
  const type = parseKeyType(enc.type, isRequired, keyType, isPublic, option("type", objName));
  let cipher, passphrase, encoding;
  if (isPublic !== true) {
    ({ cipher, passphrase, encoding } = enc);
    if (!isInput) {
      if (cipher != null) {
        if (typeof cipher !== "string") throw invalidArgValue(option("cipher", objName), "is invalid", cipher);
        if (format === "der" && (type === "pkcs1" || type === "sec1")) throw incompatible(type, "does not support encryption");
      } else if (passphrase !== undefined) {
        throw invalidArgValue(option("cipher", objName), "is required when a passphrase is specified", cipher);
      }
    }
    if ((isInput && passphrase !== undefined && !isStringOrBuffer(passphrase)) || (!isInput && cipher != null && !isStringOrBuffer(passphrase))) {
      throw invalidArgValue(option("passphrase", objName), "is invalid", passphrase);
    }
    /* as Node's: an unknown cipher before any work (a key pair isn't generated for nothing) */
    if (!isInput && cipher != null && cryptoCipherInfo(cipher) === null) throw codeError(Error, "ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
  }
  if (passphrase !== undefined) passphrase = passphraseBytes(passphrase, encoding);
  return { format, type, cipher, passphrase };
}

const PEM_LABELS = { [SPKI]: "PUBLIC KEY", [PKCS8]: "PRIVATE KEY", [SEC1]: "EC PRIVATE KEY" };

/* Node's IsRSAPrivateKey: an RSAPrivateKey begins with its version, a one-byte INTEGER 0 or 1, where
 * an RSAPublicKey begins with its modulus */
function isRsaPrivateDer(der) {
  if (der.length < 2 || der[0] !== 0x30) return false;
  const lengthBytes = der[1] & 0x80 ? der[1] & 0x7f : 0;
  const i = 2 + lengthBytes;
  return der[i] === 0x02 && der[i + 1] === 1 && (der[i + 2] === 0 || der[i + 2] === 1);
}

/* an ArrayBuffer's or a view's (a DataView too) bytes, not copied */
const viewBytes = (v) => (isAnyArrayBuffer(v) ? Buffer.from(v) : Buffer.from(v.buffer, v.byteOffset, v.byteLength));

/* Node's getArrayBufferOrView: a passphrase's bytes (a string in `encoding`, else UTF-8) */
function passphraseBytes(passphrase, encoding) {
  if (typeof passphrase === "string") return Buffer.from(passphrase, Buffer.isEncoding(encoding) ? encoding : "utf8");
  return viewBytes(passphrase);
}

const pem = (label, headers, der) => {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${headers}${body}\n-----END ${label}-----\n`;
};

function exportKey(handle, format, type, isPrivate, cipher, passphrase) {
  const encoding = ENCODING_NAMES[type];
  let der = cryptoKeyExport(handle, encoding);
  if (typeof der === "number") throw keyError(der);
  const encrypt = cipher != null;
  if (encrypt && encoding === PKCS8) {
    der = encryptPkcs8(der, cipher, passphrase);
    return format === "der" ? der : pem("ENCRYPTED PRIVATE KEY", "", der);
  }
  if (format === "der") return der;
  const label = encoding === PKCS1 ? (isPrivate ? "RSA PRIVATE KEY" : "RSA PUBLIC KEY") : PEM_LABELS[encoding];
  if (!encrypt) return pem(label, "", der);
  const { headers, body } = encryptPemBody(der, cipher, passphrase);
  return pem(label, headers, body);
}

/* A PEM's label → the encoding it holds, and whether it is private */
const PEM_TYPES = {
  "PUBLIC KEY": [SPKI, false],
  "RSA PUBLIC KEY": [PKCS1, false],
  "CERTIFICATE": [CERT, false],
  "PRIVATE KEY": [PKCS8, true],
  "RSA PRIVATE KEY": [PKCS1, true],
  "EC PRIVATE KEY": [SEC1, true],
};

/** A key handle from PEM or DER: the private key when `wantPrivate`, else a public one (a
 *  private key's public part, as createPublicKey takes it). */
function parseKey(data, format, type, wantPrivate, passphrase) {
  if (format === "der") {
    const encoding = ENCODING_NAMES[type];
    const isPrivate = encoding === PKCS8 || encoding === SEC1 || (encoding === PKCS1 && (wantPrivate || isRsaPrivateDer(viewBytes(data))));
    if (encoding === PKCS8) {
      const bytes = viewBytes(data);
      if (isEncryptedPkcs8(bytes)) data = decryptPkcs8(bytes, passphrase);
    }
    const handle = cryptoKeyParse(data, encoding, isPrivate);
    if (typeof handle === "number") throw keyError(handle);
    return wantPrivate || !isPrivate ? handle : cryptoKeyPublic(handle);
  }
  const text = typeof data === "string" ? data : viewBytes(data).toString("latin1");
  const m = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n([\s\S]*?)-----END \1-----/.exec(text);
  if (m === null) throw keyError(1);
  let label = m[1], body = m[2], der;
  if (label === "ENCRYPTED PRIVATE KEY") {
    checkPemPassphrase(passphrase);
    der = decryptPkcs8(Buffer.from(body, "base64"), passphrase);
    label = "PRIVATE KEY";
  } else if (/^Proc-Type:\s*4,ENCRYPTED/m.test(body)) {
    const split = body.search(/\r?\n\r?\n/);
    der = decryptPemBody(body.slice(0, split), Buffer.from(body.slice(split), "base64"), passphrase);
  } else {
    der = Buffer.from(body, "base64");
  }
  const known = PEM_TYPES[label];
  if (known === undefined || (wantPrivate && !known[1])) throw keyError(1);
  const handle = cryptoKeyParse(der, known[0], known[1]);
  if (typeof handle === "number") throw keyError(handle);
  return known[1] && !wantPrivate ? cryptoKeyPublic(handle) : handle;
}

/* ---- raw keys (Node 24): the public point or key, the private scalar or key -------------------- */

/* the curves raw keys name (Node takes the JWK names too): [OpenSSL's name, JWK's, scalar bytes] */
const P256 = ["prime256v1", "P-256", 32], P384 = ["secp384r1", "P-384", 48], P521 = ["secp521r1", "P-521", 66];
const RAW_CURVES = {
  "P-256": P256, prime256v1: P256, "P-384": P384, secp384r1: P384, "P-521": P521, secp521r1: P521, secp256k1: ["secp256k1", "secp256k1", 32],
};
const RAW_KINDS = new Set(["ec", "ed25519", "x25519"]);
const rawUnsupported = (format) => incompatible(format, "is not supported for this key type");

function exportRawPublic(handle, type = "uncompressed") {
  const [, kind, namedCurve] = cryptoKeyInfo(handle);
  if (!RAW_KINDS.has(kind)) throw rawUnsupported("raw-public");
  const point = cryptoKeyParts(handle)[0];
  if (kind !== "ec") return point;
  if (type !== "compressed" && type !== "uncompressed") throw invalidArgValue("options.type", "must be one of: 'compressed', 'uncompressed'", type);
  return type === "uncompressed" ? point : cryptoEcPoint(namedCurve, point, 2);
}

function exportRawPrivate(handle, format) {
  const [, kind] = cryptoKeyInfo(handle);
  if (format === "raw-seed" || !RAW_KINDS.has(kind)) throw rawUnsupported(format);
  return cryptoKeyParts(handle)[1];
}

/** A key handle from raw bytes: { key, format, asymmetricKeyType, namedCurve }. */
function rawKeyHandle(key, format, wantPrivate) {
  const { key: data, asymmetricKeyType: kind } = key;
  if (wantPrivate && format === "raw-public") throw invalidArgValue("key.format", "is invalid", format);
  if (!isArrayBufferView(data) && !isAnyArrayBuffer(data)) {
    throw invalidArgType("key.key", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", data);
  }
  validateString(kind, "key.asymmetricKeyType");
  if (kind === "ec") validateString(key.namedCurve, "key.namedCurve");
  if (kind === "rsa" || kind === "rsa-pss" || kind === "dsa" || kind === "dh") throw rawUnsupported(format);
  if (!RAW_KINDS.has(kind)) throw invalidArgValue("key.asymmetricKeyType", "is invalid: Invalid asymmetricKeyType", kind);
  if (format === "raw-seed") throw rawUnsupported(format);
  const bytes = viewBytes(data);
  const isPrivate = format === "raw-private";
  let handle;
  if (kind === "ec") {
    const curve = RAW_CURVES[key.namedCurve];
    if (curve === undefined) throw codeError(TypeError, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
    const [name, jwk, size] = curve;
    let point;
    if (isPrivate) {
      if (bytes.length !== size) throw invalidArgValue("key.key", "is invalid", data);
    } else {
      point = cryptoEcPoint(name, bytes, 4);
      if (typeof point === "number") throw invalidArgValue("key.key", "is invalid", data);
    }
    handle = cryptoKeyFromParts("ec", isPrivate, jwk, isPrivate ? [undefined, bytes] : [point]);
  } else {
    if (bytes.length !== 32) throw invalidArgValue("key.key", "is invalid", data);
    handle = cryptoKeyFromParts(kind, isPrivate, undefined, isPrivate ? [undefined, bytes] : [bytes]);
  }
  if (typeof handle === "number") throw invalidArgValue("key.key", "is invalid", data);
  return isPrivate && !wantPrivate ? cryptoKeyPublic(handle) : handle;
}

/* ---- JWK --------------------------------------------------------------------------------------- */

const b64u = (buf) => buf.toString("base64url");
const CURVE_SIZES = { "P-256": 32, "P-384": 48, "P-521": 66 };
const JWK_CURVES = { prime256v1: "P-256", secp384r1: "P-384", secp521r1: "P-521" };

function exportJwk(handle, isPrivate) {
  const [, kind, namedCurve] = cryptoKeyInfo(handle);
  const parts = cryptoKeyParts(handle);
  if (kind === "rsa") {
    const jwk = { kty: "RSA", n: b64u(parts[0]), e: b64u(parts[1]) };
    if (isPrivate) ["d", "p", "q", "dp", "dq", "qi"].forEach((name, i) => (jwk[name] = b64u(parts[i + 2])));
    return jwk;
  }
  if (kind === "ec") {
    const size = (parts[0].length - 1) / 2;
    const jwk = { kty: "EC", x: b64u(parts[0].subarray(1, 1 + size)), y: b64u(parts[0].subarray(1 + size)), crv: JWK_CURVES[namedCurve] };
    if (isPrivate) jwk.d = b64u(parts[1]);
    return jwk;
  }
  if (kind === "x25519" || kind === "ed25519") {
    const crv = kind === "x25519" ? "X25519" : "Ed25519";
    return isPrivate ? { crv, d: b64u(parts[1]), x: b64u(parts[0]), kty: "OKP" } : { crv, x: b64u(parts[0]), kty: "OKP" };
  }
  throw codeError(Error, "ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE", "Unsupported JWK Key Type.");
}

function fromParts(kind, isPrivate, crv, parts, message = "Invalid JWK data") {
  const handle = cryptoKeyFromParts(kind, isPrivate, crv, parts);
  if (typeof handle === "number") throw handle === 3 ? notSupported("This curve") : invalidJwk(message);
  return handle;
}

/* A JWK's key, checked as Node 24's native import checks it: one of its messages for each
   failure. A JWK with "d" is a private key's, whichever is wanted. */
function keyFromJwk(key, isPublic) {
  const handle = jwkHandle(key, isPublic);
  /* a private JWK where a public key is wanted: its public half */
  return isPublic && key.d !== undefined ? cryptoKeyPublic(handle) : handle;
}

function jwkHandle(key, isPublic) {
  validateObject(key, "key");
  if (typeof key.kty !== "string") throw invalidJwk("Invalid JWK format");
  const b64 = (s) => Buffer.from(s, "base64");
  const str = (v) => typeof v === "string";
  const isPrivate = key.d !== undefined;
  const noPrivate = () => invalidJwk("JWK does not contain private key material");
  if (key.kty === "OKP") {
    const size = { Ed25519: 32, X25519: 32, Ed448: 57, X448: 56 }[key.crv];
    if (size === undefined || !str(key.x) || b64(key.x).byteLength !== size) throw invalidJwk("Invalid JWK OKP key");
    if (isPrivate && (!str(key.d) || b64(key.d).byteLength !== size)) throw invalidJwk("Invalid JWK OKP key");
    if (!isPublic && !isPrivate) throw noPrivate();
    if (size !== 32) throw notSupported(key.crv + " keys");
    const kind = key.crv.toLowerCase();
    return isPrivate ? fromParts(kind, true, undefined, [undefined, b64(key.d)]) : fromParts(kind, false, undefined, [b64(key.x)]);
  }
  if (key.kty === "EC") {
    if (!str(key.crv)) throw invalidJwk("Invalid JWK EC key");
    if (!["P-256", "secp256k1", "P-384", "P-521"].includes(key.crv)) throw codeError(TypeError, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
    if (!str(key.x) || !str(key.y) || (isPrivate && !str(key.d))) throw invalidJwk("Invalid JWK EC key");
    const size = CURVE_SIZES[key.crv];
    const x = b64(key.x);
    const y = b64(key.y);
    if (size !== undefined && (x.length !== size || y.length !== size)) throw invalidJwk("Invalid JWK EC key");
    if (!isPublic && !isPrivate) throw noPrivate();
    const point = Buffer.concat([Buffer.from([4]), x, y]);
    return isPrivate ? fromParts("ec", true, key.crv, [point, b64(key.d)]) : fromParts("ec", false, key.crv, [point]);
  }
  if (key.kty === "RSA") {
    const names = ["n", "e"];
    if (isPrivate) names.push("d", "p", "q", "dp", "dq", "qi");
    if (!names.every((name) => str(key[name]))) throw invalidJwk("Invalid JWK RSA key");
    if (!isPublic && !isPrivate) throw noPrivate();
    return fromParts("rsa", isPrivate, undefined, names.map((name) => b64(key[name])), "Invalid JWK RSA key");
  }
  throw invalidJwk(`${key.kty} is not a supported JWK key type`);
}

/* ---- createSecretKey, createPublicKey, createPrivateKey ---------------------------------------- */

export function createSecretKey(key, encoding) {
  const bytes = prepareSecretKey(key, encoding, true);
  return new SecretKeyObject(cryptoKeySecret(bytes));
}

/* Where an asymmetric key is wanted (Node's kCreatePublic, …) */
const CREATE_PUBLIC = 0, CREATE_PRIVATE = 1, CONSUME_PUBLIC = 2, CONSUME_PRIVATE = 3;

/* a KeyObject (or CryptoKey) given where an asymmetric key is wanted */
function handleOfKeyObject(key, ctx) {
  if (ctx === CREATE_PRIVATE) throw invalidArgType("key", "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, or URL", key);
  if (key.type !== "private") {
    if (ctx === CONSUME_PRIVATE || ctx === CREATE_PUBLIC) throw keyObjectType(key.type, "private");
    if (key.type !== "public") throw keyObjectType(key.type, "private or public");
  }
  return key[kHandle];
}

/** prepareAsymmetricKey: a handle (for CREATE_PUBLIC from a PEM or DER private key, its public
 *  part), and whether it came from a KeyObject or CryptoKey. */
function prepareAsymmetricKey(key, ctx) {
  const wantPrivate = ctx === CREATE_PRIVATE || ctx === CONSUME_PRIVATE;
  const asKeyObject = (v) => {
    if (v instanceof KeyObject) return v;
    const handle = cryptoKeyHandleOf(v);
    return handle === undefined ? undefined : wrapHandle(handle);
  };
  let keyObject = asKeyObject(key);
  if (keyObject) return { key: handleOfKeyObject(keyObject, ctx), keyObject: true };
  if (isStringOrBuffer(key)) return { key: parseKey(key, "pem", undefined, wantPrivate) };
  if (typeof key === "object" && key !== null) {
    const { key: data, encoding, format } = key;
    keyObject = asKeyObject(data);
    if (keyObject) return { key: handleOfKeyObject(keyObject, ctx), keyObject: true };
    if (format === "jwk") {
      validateObject(data, "key.key");
      return { key: keyFromJwk(data, !wantPrivate) };
    }
    if (format === "raw-public" || format === "raw-private" || format === "raw-seed") return { key: rawKeyHandle(key, format, wantPrivate) };
    if (!isStringOrBuffer(data)) {
      throw invalidArgType("key.key", "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", data);
    }
    const { format: fmt, type, passphrase } = parseKeyEncoding(key, undefined, wantPrivate ? false : undefined, "key");
    const bytes = typeof data === "string" && fmt === "der" ? Buffer.from(data, encoding ?? "utf8") : data;
    return { key: parseKey(bytes, fmt, type, wantPrivate, passphrase) };
  }
  /* Node 24 lists URL where a private key is wanted (an OpenSSL store's; not visaljs's yet) */
  const expected = ctx === CREATE_PRIVATE
    ? "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, or URL"
    : "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey";
  throw invalidArgType("key", expected, key);
}

/** The handle of a private key from what sign, privateDecrypt, … take. */
export function preparePrivateKey(key) {
  return prepareAsymmetricKey(key, CONSUME_PRIVATE).key;
}

/** The handle of a public or private key from what verify, publicEncrypt, … take. */
export function preparePublicOrPrivateKey(key) {
  return prepareAsymmetricKey(key, CONSUME_PUBLIC).key;
}

export function createPublicKey(key) {
  const { key: handle, keyObject } = prepareAsymmetricKey(key, CREATE_PUBLIC);
  return new PublicKeyObject(keyObject ? cryptoKeyPublic(handle) : handle);
}

export function createPrivateKey(key) {
  return new PrivateKeyObject(prepareAsymmetricKey(key, CREATE_PRIVATE).key);
}

/** The asymmetric key type of a handle ('rsa', 'ec', …). */
export function asymmetricKeyTypeOf(handle) {
  return cryptoKeyInfo(handle)[1];
}

/** A key's RSA-PSS parameters: [hash, mgf1, saltLength], or null. */
export function pssParamsOf(handle) {
  return cryptoKeyInfo(handle)[3];
}

/* ---- generateKey, generateKeyPair -------------------------------------------------------------- */

function secretKeyJob(type, options) {
  validateString(type, "type");
  validateObject(options, "options");
  const { length } = options;
  switch (type) {
    case "hmac":
      validateIntegerIn(length, "options.length", 8, 2 ** 31 - 1);
      break;
    case "aes":
      validateOneOf(length, "options.length", [128, 192, 256]);
      break;
    default:
      throw invalidArgValue("type", "must be a supported key type", type);
  }
  return () => {
    const bytes = Buffer.alloc(Math.floor(length / 8));
    cryptoRandomFill(bytes, 0, bytes.length);
    return new SecretKeyObject(cryptoKeySecret(bytes));
  };
}

export function generateKeySync(type, options) {
  return secretKeyJob(type, options)();
}

export function generateKey(type, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  validateFunction(callback, "callback");
  const job = secretKeyJob(type, options);
  const key = job();
  later(() => callback(null, key));
}

/* Node's parseKeyFormatAndType for the raw formats of a key pair's encodings */
function rawEncoding(enc, isPublic) {
  const { format, type } = enc;
  const name = isPublic ? "options.publicKeyEncoding" : "options.privateKeyEncoding";
  if (format === "raw-public") {
    if (!isPublic) throw invalidArgValue(`${name}.format`, "is invalid", format);
    if (type !== undefined && type !== "uncompressed" && type !== "compressed") throw invalidArgValue(`${name}.type`, "is invalid", type);
    return { format, type };
  }
  if (format === "raw-private" || format === "raw-seed") {
    if (isPublic) throw invalidArgValue(`${name}.format`, "is invalid", format);
    if (type !== undefined) throw invalidArgValue(`${name}.type`, "is invalid", type);
    if (enc.cipher != null || enc.passphrase !== undefined) throw incompatible("raw format", "does not support encryption");
    return { format };
  }
  return undefined;
}

function pairEncodings(keyType, options) {
  const { publicKeyEncoding, privateKeyEncoding } = options ?? {};
  let pub, priv;
  if (publicKeyEncoding != null) {
    if (typeof publicKeyEncoding !== "object") throw invalidArgValue("options.publicKeyEncoding", "is invalid", publicKeyEncoding);
    pub = publicKeyEncoding.format === "jwk" ? { format: "jwk" } : rawEncoding(publicKeyEncoding, true) ?? parseKeyEncoding(publicKeyEncoding, keyType, true, "options.publicKeyEncoding");
  }
  if (privateKeyEncoding != null) {
    if (typeof privateKeyEncoding !== "object") throw invalidArgValue("options.privateKeyEncoding", "is invalid", privateKeyEncoding);
    priv = privateKeyEncoding.format === "jwk" ? { format: "jwk" } : rawEncoding(privateKeyEncoding, false) ?? parseKeyEncoding(privateKeyEncoding, keyType, false, "options.privateKeyEncoding");
  }
  return { pub, priv };
}

function keyPairJob(type, options) {
  validateString(type, "type");
  const encodings = pairEncodings(type, options);
  if (options !== undefined) validateObject(options, "options");
  let generate;
  switch (type) {
    case "rsa":
    case "rsa-pss": {
      validateObject(options, "options");
      const { modulusLength } = options;
      validateUint32(modulusLength, "options.modulusLength");
      let { publicExponent } = options;
      if (publicExponent == null) publicExponent = 0x10001;
      else validateUint32(publicExponent, "options.publicExponent");
      let pss = null;
      if (type === "rsa-pss") {
        const { hashAlgorithm, mgf1HashAlgorithm, saltLength } = options;
        if (saltLength !== undefined) validateIntegerIn(saltLength, "options.saltLength", 0, 2147483647);
        if (hashAlgorithm !== undefined) validateString(hashAlgorithm, "options.hashAlgorithm");
        if (mgf1HashAlgorithm !== undefined) validateString(mgf1HashAlgorithm, "options.mgf1HashAlgorithm");
        if (hashAlgorithm !== undefined || mgf1HashAlgorithm !== undefined || saltLength !== undefined) {
          const hash = hashAlgorithm ?? "sha1";
          pss = [hash, mgf1HashAlgorithm ?? hash, saltLength ?? cryptoHashInfo(hash)];
        }
      }
      if (modulusLength < 512) throw new Error("error:1C8000AB:Provider routines::key size too small");
      if (modulusLength > 4096) throw notSupported("An RSA key of more than 4096 bits");
      generate = () => cryptoKeyGenerate(type, modulusLength, publicExponent, pss);
      break;
    }
    case "ec": {
      validateObject(options, "options");
      const { namedCurve, paramEncoding } = options;
      validateString(namedCurve, "options.namedCurve");
      if (paramEncoding != null && paramEncoding !== "named") {
        if (paramEncoding === "explicit") throw notSupported("Explicit EC parameters");
        throw invalidArgValue("options.paramEncoding", "is invalid", paramEncoding);
      }
      generate = () => cryptoKeyGenerate("ec", namedCurve);
      generate.curve = namedCurve;
      break;
    }
    case "x25519":
    case "ed25519":
      generate = () => cryptoKeyGenerate(type);
      break;
    case "dsa": {
      validateObject(options, "options");
      const { modulusLength } = options;
      validateUint32(modulusLength, "options.modulusLength");
      let { divisorLength } = options;
      if (divisorLength == null) divisorLength = 224;  /* OpenSSL 3's default */
      else validateIntegerIn(divisorLength, "options.divisorLength", 0, 2147483647);
      generate = () => cryptoKeyGenerate("dsa", modulusLength, divisorLength);
      break;
    }
    case "dh": {
      const params = dhParameters(options);
      generate = () => {
        const handle = cryptoKeyFromParts("dh", true, undefined, dhKeyParts(params));
        return handle;
      };
      break;
    }
    case "ed448":
    case "x448":
      throw notSupported(`A ${type} key`);
    default:
      throw invalidArgValue("type", "must be a supported key type", type);
  }
  return () => {
    const handle = generate();
    if (typeof handle === "number") {
      if (type === "ec") throw codeError(TypeError, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
      throw new Error("Key generation failed");
    }
    const privateKey = new PrivateKeyObject(handle);
    const publicKey = new PublicKeyObject(cryptoKeyPublic(handle));
    const encode = (key, enc) => (enc === undefined ? key : enc.format === "jwk" ? key.export({ format: "jwk" }) : key.export(enc));
    return { publicKey: encode(publicKey, encodings.pub), privateKey: encode(privateKey, encodings.priv) };
  };
}

export function generateKeyPairSync(type, options) {
  return keyPairJob(type, options)();
}

export function generateKeyPair(type, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  validateFunction(callback, "callback");
  const job = keyPairJob(type, options);
  let result;
  try {
    result = job();
  } catch (e) {
    later(() => callback(e));
    return;
  }
  later(() => callback(null, result.publicKey, result.privateKey));
}
/* as Node's: util.promisify(generateKeyPair) resolves to { publicKey, privateKey } */
Object.defineProperty(generateKeyPair, Symbol.for("visaljs.util.customPromisifyArgs"), { value: ["publicKey", "privateKey"] });
