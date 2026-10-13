// node:crypto: Node's API over the runtime's crypto primitives (C, on
// BoringSSL), which Web Crypto (the `crypto` global, a runtime component) shares. What isn't
// provided yet throws ERR_VISALJS_UNSUPPORTED when called.
import { cryptoTimingSafeEqual } from "visaljs:host";
import { codeError, notSupported } from "./internal/errors.js";
import {
  createECDH, createSign, createVerify, diffieHellman, ECDH, getCurves, privateDecrypt, privateEncrypt, publicDecrypt, publicEncrypt, Sign,
  sign, Verify, verify,
} from "./internal/crypto/asym.js";
import { Cipheriv, createCipheriv, createDecipheriv, Decipheriv, getCipherInfo, getCiphers } from "./internal/crypto/cipher.js";
import {
  checkPrime, checkPrimeSync, createDiffieHellman, createDiffieHellmanGroup, DiffieHellman, DiffieHellmanGroup, generatePrime, generatePrimeSync,
  getDiffieHellman,
} from "./internal/crypto/diffiehellman.js";
import { createHash, createHmac, getHashes, Hash, hash, Hmac } from "./internal/crypto/hash.js";
import {
  createPrivateKey, createPublicKey, createSecretKey, generateKey, generateKeyPair, generateKeyPairSync, generateKeySync, KeyObject,
} from "./internal/crypto/keys.js";
import { hkdf, hkdfSync, pbkdf2, pbkdf2Sync, scrypt, scryptSync } from "./internal/crypto/kdf.js";
import { randomBytes, randomFill, randomFillSync, randomInt, randomUUID } from "./internal/crypto/random.js";
import { isAnyArrayBuffer, isArrayBufferView } from "./internal/crypto/util.js";

export { createHash, createHmac, getHashes, Hash, hash, Hmac, randomBytes, randomFill, randomFillSync, randomInt, randomUUID };
export { hkdf, hkdfSync, pbkdf2, pbkdf2Sync, scrypt, scryptSync };
export { createPrivateKey, createPublicKey, createSecretKey, generateKey, generateKeyPair, generateKeyPairSync, generateKeySync, KeyObject };
export { createECDH, createSign, createVerify, diffieHellman, ECDH, getCurves, privateDecrypt, privateEncrypt, publicDecrypt, publicEncrypt };
export { Sign, sign, Verify, verify };
export { Cipheriv, createCipheriv, createDecipheriv, Decipheriv, getCipherInfo, getCiphers };
export { checkPrime, checkPrimeSync, createDiffieHellman, createDiffieHellmanGroup, DiffieHellman, DiffieHellmanGroup, generatePrime, generatePrimeSync };
export { getDiffieHellman };

export const webcrypto = globalThis.crypto;
export const subtle = webcrypto.subtle;

export function getRandomValues(array) {
  return webcrypto.getRandomValues(array);
}

export function timingSafeEqual(buf1, buf2) {
  const check = (v, name) => {
    if (!isAnyArrayBuffer(v) && !isArrayBufferView(v)) {
      throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", `The "${name}" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.`);
    }
  };
  check(buf1, "buf1");
  check(buf2, "buf2");
  if (buf1.byteLength !== buf2.byteLength) throw codeError(RangeError, "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", "Input buffers must have the same byte length");
  return cryptoTimingSafeEqual(buf1, buf2);
}

const CIPHER_LIST =
  "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:" +
  "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:" +
  "ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:" +
  "DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";

/* Node's (OpenSSL's) values: the RSA paddings and point formats are what the APIs here take */
export const constants = {
  OPENSSL_VERSION_NUMBER: 810549328, SSL_OP_ALL: 2147485776, SSL_OP_ALLOW_NO_DHE_KEX: 1024,
  SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION: 262144, SSL_OP_CIPHER_SERVER_PREFERENCE: 4194304, SSL_OP_CISCO_ANYCONNECT: 32768,
  SSL_OP_COOKIE_EXCHANGE: 8192, SSL_OP_CRYPTOPRO_TLSEXT_BUG: 2147483648, SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS: 2048,
  SSL_OP_LEGACY_SERVER_CONNECT: 4, SSL_OP_NO_COMPRESSION: 131072, SSL_OP_NO_ENCRYPT_THEN_MAC: 524288, SSL_OP_NO_QUERY_MTU: 4096,
  SSL_OP_NO_RENEGOTIATION: 1073741824, SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION: 65536, SSL_OP_NO_SSLv2: 0,
  SSL_OP_NO_SSLv3: 33554432, SSL_OP_NO_TICKET: 16384, SSL_OP_NO_TLSv1: 67108864, SSL_OP_NO_TLSv1_1: 268435456,
  SSL_OP_NO_TLSv1_2: 134217728, SSL_OP_NO_TLSv1_3: 536870912, SSL_OP_PRIORITIZE_CHACHA: 2097152, SSL_OP_TLS_ROLLBACK_BUG: 8388608,
  ENGINE_METHOD_RSA: 1, ENGINE_METHOD_DSA: 2, ENGINE_METHOD_DH: 4, ENGINE_METHOD_RAND: 8, ENGINE_METHOD_EC: 2048,
  ENGINE_METHOD_CIPHERS: 64, ENGINE_METHOD_DIGESTS: 128, ENGINE_METHOD_PKEY_METHS: 512, ENGINE_METHOD_PKEY_ASN1_METHS: 1024,
  ENGINE_METHOD_ALL: 65535, ENGINE_METHOD_NONE: 0, DH_CHECK_P_NOT_SAFE_PRIME: 2, DH_CHECK_P_NOT_PRIME: 1,
  DH_UNABLE_TO_CHECK_GENERATOR: 4, DH_NOT_SUITABLE_GENERATOR: 8, RSA_PKCS1_PADDING: 1, RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4, RSA_X931_PADDING: 5, RSA_PKCS1_PSS_PADDING: 6, RSA_PSS_SALTLEN_DIGEST: -1,
  RSA_PSS_SALTLEN_MAX_SIGN: -2, RSA_PSS_SALTLEN_AUTO: -2, defaultCoreCipherList: CIPHER_LIST, TLS1_VERSION: 769,
  TLS1_1_VERSION: 770, TLS1_2_VERSION: 771, TLS1_3_VERSION: 772, POINT_CONVERSION_COMPRESSED: 2,
  POINT_CONVERSION_UNCOMPRESSED: 4, POINT_CONVERSION_HYBRID: 6, defaultCipherList: CIPHER_LIST,
};

export function getFips() {
  return 0;
}

export function setFips(value) {
  if (value) throw codeError(Error, "ERR_CRYPTO_FIPS_FORCED", "Cannot set FIPS mode in a non-FIPS build.");
}

export function secureHeapUsed() {
  return { total: 0, used: 0, utilization: 0, min: 0 };
}

export function setEngine() {
  throw notSupported("crypto.setEngine");
}

/* not provided yet */
const unsupported = (name) =>
  function () {
    throw notSupported("crypto." + name);
  };
export const Certificate = unsupported("Certificate");
export const Cipher = unsupported("Cipher");
export const Decipher = unsupported("Decipher");
export const X509Certificate = unsupported("X509Certificate");

export default {
  Certificate, Cipher, Cipheriv, Decipher, Decipheriv, DiffieHellman, DiffieHellmanGroup, ECDH, Hash, Hmac, KeyObject, Sign,
  Verify, X509Certificate, checkPrime, checkPrimeSync, constants, createCipheriv, createDecipheriv, createDiffieHellman,
  createDiffieHellmanGroup, createECDH, createHash, createHmac, createPrivateKey, createPublicKey, createSecretKey, createSign,
  createVerify, diffieHellman, generateKey, generateKeyPair, generateKeyPairSync, generateKeySync, generatePrime,
  generatePrimeSync, getCipherInfo, getCiphers, getCurves, getDiffieHellman, getFips, getHashes, getRandomValues, hash, hkdf,
  hkdfSync, pbkdf2, pbkdf2Sync, privateDecrypt, privateEncrypt, publicDecrypt, publicEncrypt, randomBytes, randomFill,
  randomFillSync, randomInt, randomUUID, scrypt, scryptSync, secureHeapUsed, setEngine, setFips, sign, subtle, timingSafeEqual,
  verify, webcrypto,
};
