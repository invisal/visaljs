// node:crypto's finite-field Diffie-Hellman and primes: DiffieHellman, DiffieHellmanGroup,
// createDiffieHellman, getDiffieHellman (createDiffieHellmanGroup), generatePrime(Sync) and
// checkPrime(Sync), as Node's lib/internal/crypto/{diffiehellman,random}.js have them, over the
// runtime's big integers (crypto_bn.c: modular exponentiation, prime generation and testing).
// What OpenSSL decides beneath Node's API is OpenSSL's here too: the private key lengths of the
// MODP groups, DH_check's flags (verifyError), the public key checks of computeSecret.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { cryptoCheckPrime, cryptoGeneratePrime, cryptoModExp, cryptoRandomFill } from "visaljs:host";
import { codeError, invalidArgType, outOfRange, validateFunction } from "../errors.js";
import { DH_GROUPS } from "./dh_groups.js";
import { isAnyArrayBuffer, isArrayBufferView, kHandle, validateObject } from "./util.js";

const later = (fn) => setTimeout(fn, 0);

function validateInt32(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
}

function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw invalidArgType(name, "of type boolean", value);
}

/* getArrayBufferOrView / toBuf: a string in `encoding`, or the buffer's bytes */
function toBuf(value, encoding) {
  if (typeof value === "string") return Buffer.from(value, encoding === undefined || encoding === "buffer" || !encoding ? "utf8" : encoding);
  if (isAnyArrayBuffer(value)) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function bytesArg(value, name, encoding) {
  if (typeof value !== "string" && !isAnyArrayBuffer(value) && !isArrayBufferView(value)) {
    throw invalidArgType(name, "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", value);
  }
  return toBuf(value, encoding);
}

const encode = (buffer, encoding) => (encoding && encoding !== "buffer" ? buffer.toString(encoding) : buffer);

/* big-endian integers: minimal, compared, and as BigInts */
const strip = (b) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
};
const toBig = (b) => (b.length ? BigInt("0x" + Buffer.from(b).toString("hex")) : 0n);
function fromBig(n) {
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
}
const bitsOf = (b) => {
  const s = strip(b);
  return s.length === 0 || (s.length === 1 && s[0] === 0) ? 0 : (s.length - 1) * 8 + (32 - Math.clz32(s[0]));
};

/** A private value of at most `bits` bits, not zero */
function randomPrivate(bits) {
  const n = Math.ceil(bits / 8);
  const b = Buffer.alloc(n);
  do {
    cryptoRandomFill(b, 0, n);
    if (bits % 8) b[0] &= (1 << (bits % 8)) - 1;
  } while (b.every((x) => x === 0));
  return Buffer.from(strip(b));
}

/* the generator as OpenSSL generates parameters for it: a safe prime p with p mod 24 = 23 for
 * generator 2, p mod 60 = 59 for 5, else p mod 12 = 11 */
function generateParameters(bits, generator) {
  const [add, rem] = generator === 2 ? [24, 23] : generator === 5 ? [60, 59] : [12, 11];
  const p = cryptoGeneratePrime(bits, true, Buffer.from([add]), Buffer.from([rem]));
  if (p === null) throw new Error("Prime generation failed");
  return p;
}

const invalidParameters = () => codeError(TypeError, "ERR_INVALID_ARG_VALUE", "Invalid DH parameters");

/* DH_check's flags (OpenSSL 3): what verifyError reports for given parameters */
const DH_CHECK_P_NOT_PRIME = 0x01, DH_CHECK_P_NOT_SAFE_PRIME = 0x02, DH_NOT_SUITABLE_GENERATOR = 0x08, DH_MODULUS_TOO_SMALL = 0x80;
function dhCheck(p, g) {
  let flags = 0;
  const big = toBig(p);
  const gen = toBig(g);
  if (!(big & 1n)) flags |= DH_CHECK_P_NOT_PRIME;
  if (gen <= 1n || gen >= big - 1n) flags |= DH_NOT_SUITABLE_GENERATOR;
  if (bitsOf(p) < 512) flags |= DH_MODULUS_TOO_SMALL;
  if (!cryptoCheckPrime(p, 0)) flags |= DH_CHECK_P_NOT_PRIME;
  else if (!cryptoCheckPrime(fromBig(big >> 1n), 0)) flags |= DH_CHECK_P_NOT_SAFE_PRIME;
  return flags;
}

/* ---- DiffieHellman and DiffieHellmanGroup ------------------------------------------------------ */

function defineVerifyError(self, value) {
  Object.defineProperty(self, "verifyError", { enumerable: true, value, writable: false });
}

export function DiffieHellman(sizeOrKey, keyEncoding, generator, genEncoding) {
  if (!(this instanceof DiffieHellman)) return new DiffieHellman(sizeOrKey, keyEncoding, generator, genEncoding);
  if (typeof sizeOrKey !== "number" && typeof sizeOrKey !== "string" && !isArrayBufferView(sizeOrKey) && !isAnyArrayBuffer(sizeOrKey)) {
    throw invalidArgType("sizeOrKey", "one of type number or string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", sizeOrKey);
  }
  if (typeof sizeOrKey === "number") validateInt32(sizeOrKey, "sizeOrKey");
  if (keyEncoding && !Buffer.isEncoding(keyEncoding) && keyEncoding !== "buffer") {
    genEncoding = generator;
    generator = keyEncoding;
    keyEncoding = false;
  }
  if (typeof sizeOrKey !== "number") sizeOrKey = toBuf(sizeOrKey, keyEncoding);
  if (!generator) {
    generator = 2;
  } else if (typeof generator === "number") {
    validateInt32(generator, "generator");
  } else if (typeof generator === "string") {
    generator = toBuf(generator, genEncoding);
  } else if (!isArrayBufferView(generator) && !isAnyArrayBuffer(generator)) {
    throw invalidArgType("generator", "one of type number or string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView", generator);
  } else {
    generator = toBuf(generator);
  }
  let p, g, verifyError;
  if (typeof sizeOrKey === "number") {
    if (sizeOrKey < 512 || typeof generator !== "number" || generator < 2) throw invalidParameters();
    p = generateParameters(sizeOrKey, generator);
    g = fromBig(BigInt(generator));
    verifyError = 0;
  } else {
    p = Buffer.from(strip(sizeOrKey));
    g = typeof generator === "number" ? fromBig(BigInt(generator)) : Buffer.from(strip(generator));
    if (bitsOf(p) === 0 || toBig(g) < 2n) throw invalidParameters();
    verifyError = dhCheck(p, g);
  }
  this[kHandle] = { p, g, privateBits: bitsOf(p) - 1, publicKey: null, privateKey: null };
  defineVerifyError(this, verifyError);
}

export function DiffieHellmanGroup(name) {
  if (!(this instanceof DiffieHellmanGroup)) return new DiffieHellmanGroup(name);
  const group = typeof name === "string" && Object.hasOwn(DH_GROUPS, name) ? DH_GROUPS[name] : undefined;
  if (group === undefined) throw codeError(Error, "ERR_CRYPTO_UNKNOWN_DH_GROUP", "Unknown DH group");
  const p = Buffer.from(group[1], "hex");
  this[kHandle] = { p, g: Buffer.from([2]), privateBits: group[0] || bitsOf(p) - 1, publicKey: null, privateKey: null };
  defineVerifyError(this, 0);
}

function dhGenerateKeys(encoding) {
  const state = this[kHandle];
  if (state.privateKey === null) state.privateKey = randomPrivate(state.privateBits);
  const pub = cryptoModExp(state.g, state.privateKey, state.p, undefined);
  if (pub === null) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Key generation failed");
  state.publicKey = Buffer.from(strip(pub));
  return encode(state.publicKey, encoding);
}

/* the peer's public value, checked as OpenSSL's DH_check_pub_key does */
function checkPeer(state, key) {
  const pub = toBig(key);
  const p = toBig(state.p);
  if (pub <= 1n) throw codeError(RangeError, "ERR_CRYPTO_INVALID_KEYLEN", "Supplied key is too small");
  if (pub >= p - 1n) throw codeError(RangeError, "ERR_CRYPTO_INVALID_KEYTYPE", "Unspecified validation error");
}

function dhComputeSecret(key, inEnc, outEnc) {
  key = bytesArg(key, "key", inEnc);
  const state = this[kHandle];
  if (state.privateKey === null) throw codeError(Error, "ERR_CRYPTO_INVALID_STATE", "No private key - did you forget to generate one?");
  checkPeer(state, key);
  return encode(cryptoModExp(key, state.privateKey, state.p, state.p.length), outEnc);
}

function dhGetPrime(encoding) {
  return encode(Buffer.from(this[kHandle].p), encoding);
}

function dhGetGenerator(encoding) {
  return encode(Buffer.from(this[kHandle].g), encoding);
}

function dhGetPublicKey(encoding) {
  const key = this[kHandle].publicKey;
  if (key === null) throw codeError(Error, "ERR_CRYPTO_INVALID_STATE", "No public key - did you forget to generate one?");
  return encode(Buffer.from(key), encoding);
}

function dhGetPrivateKey(encoding) {
  const key = this[kHandle].privateKey;
  if (key === null) throw codeError(Error, "ERR_CRYPTO_INVALID_STATE", "No private key - did you forget to generate one?");
  return encode(Buffer.from(key), encoding);
}

for (const C of [DiffieHellman, DiffieHellmanGroup]) {
  C.prototype.generateKeys = dhGenerateKeys;
  C.prototype.computeSecret = dhComputeSecret;
  C.prototype.getPrime = dhGetPrime;
  C.prototype.getGenerator = dhGetGenerator;
  C.prototype.getPublicKey = dhGetPublicKey;
  C.prototype.getPrivateKey = dhGetPrivateKey;
}

DiffieHellman.prototype.setPublicKey = function setPublicKey(key, encoding) {
  this[kHandle].publicKey = Buffer.from(strip(bytesArg(key, "key", encoding)));
  return this;
};

DiffieHellman.prototype.setPrivateKey = function setPrivateKey(key, encoding) {
  this[kHandle].privateKey = Buffer.from(strip(bytesArg(key, "key", encoding)));
  return this;
};

export function createDiffieHellman(sizeOrKey, keyEncoding, generator, genEncoding) {
  return new DiffieHellman(sizeOrKey, keyEncoding, generator, genEncoding);
}

export function createDiffieHellmanGroup(name) {
  return new DiffieHellmanGroup(name);
}

export const getDiffieHellman = createDiffieHellmanGroup;

/* ---- 'dh' KeyObjects: their parameters and keys, and the stateless agreement ---------------------- */

/** [p, g, privateBits] of generateKeyPair('dh')'s options (validated as Node's keygen does) */
export function dhParameters(options) {
  validateObject(options, "options");
  const { group, primeLength, prime, generator } = options;
  const pair = (a, b) => codeError(TypeError, "ERR_INCOMPATIBLE_OPTION_PAIR", `Option "${a}" cannot be used in combination with option "${b}"`);
  if (group != null) {
    if (prime != null) throw pair("group", "prime");
    if (primeLength != null) throw pair("group", "primeLength");
    if (generator != null) throw pair("group", "generator");
    if (typeof group !== "string") throw invalidArgType("options.group", "of type string", group);
    const { [kHandle]: state } = new DiffieHellmanGroup(group);
    return [state.p, state.g, state.privateBits];
  }
  if (prime != null) {
    if (primeLength != null) throw pair("prime", "primeLength");
    if (!isArrayBufferView(prime)) throw invalidArgType("options.prime", "an instance of Buffer, TypedArray, or DataView", prime);
  } else if (primeLength != null) {
    validateInt32(primeLength, "options.primeLength", 0);
  } else {
    throw codeError(TypeError, "ERR_MISSING_OPTION", "At least one of the group, prime, or primeLength options is required");
  }
  if (generator != null) validateInt32(generator, "options.generator", 0);
  const gen = generator == null ? 2 : generator;
  const p = prime != null ? Buffer.from(strip(toBuf(prime))) : generateParameters(primeLength, gen);
  return [p, fromBig(BigInt(gen)), bitsOf(p) - 1];
}

/** A 'dh' key pair's parts [p, g, pub, priv] for those parameters */
export function dhKeyParts([p, g, privateBits]) {
  const priv = randomPrivate(privateBits);
  return [p, g, Buffer.from(strip(cryptoModExp(g, priv, p, undefined))), priv];
}

/** The shared secret of two 'dh' keys' parts (diffieHellman()), as long as the prime */
export function dhStateless(privateParts, publicParts) {
  const [p, g, , priv] = privateParts;
  const [p2, g2, pub] = publicParts;
  if (!p.equals(p2) || !g.equals(g2)) throw codeError(Error, "ERR_OSSL_MISMATCHING_DOMAIN_PARAMETERS", "error:1C800073:Provider routines::mismatching domain parameters");
  checkPeer({ p }, pub);
  return cryptoModExp(pub, priv, p, p.length);
}

/* ---- Primes ------------------------------------------------------------------------------------- */

function unsignedBigIntToBuffer(bigint, name) {
  if (bigint < 0) throw outOfRange(name, ">= 0", bigint);
  return fromBig(bigint);
}

const bufferOrBigint = (v, name) => {
  if (typeof v === "bigint") return unsignedBigIntToBuffer(v, name);
  if (!isAnyArrayBuffer(v) && !isArrayBufferView(v)) {
    throw invalidArgType(name, "of type bigint or an instance of ArrayBuffer, TypedArray, Buffer, or DataView", v);
  }
  return toBuf(v);
};

function primeJob(size, options) {
  validateObject(options, "options");
  const { safe = false, bigint = false } = options;
  let { add, rem } = options;
  validateBoolean(safe, "options.safe");
  validateBoolean(bigint, "options.bigint");
  if (add !== undefined) add = bufferOrBigint(add, "options.add");
  if (rem !== undefined) rem = bufferOrBigint(rem, "options.rem");
  /* RandomPrimeConfig's checks */
  if (add !== undefined) {
    if (bitsOf(add) > size) throw codeError(RangeError, "ERR_OUT_OF_RANGE", "invalid options.add");
    if (rem !== undefined && toBig(add) <= toBig(rem)) throw codeError(RangeError, "ERR_OUT_OF_RANGE", "invalid options.rem");
  }
  return () => {
    const p = cryptoGeneratePrime(size, safe, add, rem);
    if (p === null) throw codeError(Error, "ERR_CRYPTO_OPERATION_FAILED", "Prime generation failed");
    if (bigint) return toBig(p);
    const out = new ArrayBuffer(p.length);
    new Uint8Array(out).set(p);
    return out;
  };
}

export function generatePrimeSync(size, options = {}) {
  validateInt32(size, "size", 1);
  return primeJob(size, options)();
}

export function generatePrime(size, options, callback) {
  validateInt32(size, "size", 1);
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  validateFunction(callback, "callback");
  const job = primeJob(size, options);
  later(() => {
    let result;
    try {
      result = job();
    } catch (e) {
      callback(e);
      return;
    }
    callback(undefined, result);
  });
}

function candidateOf(candidate) {
  if (typeof candidate === "bigint") return unsignedBigIntToBuffer(candidate, "candidate");
  if (!isAnyArrayBuffer(candidate) && !isArrayBufferView(candidate)) {
    throw invalidArgType("candidate", "of type bigint or an instance of ArrayBuffer, TypedArray, Buffer, or DataView", candidate);
  }
  return toBuf(candidate);
}

export function checkPrimeSync(candidate, options = {}) {
  candidate = candidateOf(candidate);
  validateObject(options, "options");
  const { checks = 0 } = options;
  validateInt32(checks, "options.checks", 0);
  return cryptoCheckPrime(candidate, checks);
}

export function checkPrime(candidate, options = {}, callback) {
  candidate = candidateOf(candidate);
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  validateFunction(callback, "callback");
  validateObject(options, "options");
  const { checks = 0 } = options;
  validateInt32(checks, "options.checks", 0);
  later(() => callback(undefined, cryptoCheckPrime(candidate, checks)));
}
