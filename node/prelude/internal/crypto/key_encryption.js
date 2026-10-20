// Encrypted private keys, as OpenSSL writes and reads them for Node: PKCS#8's
// EncryptedPrivateKeyInfo (PBES2, RFC 8018: PBKDF2 and a CBC cipher; "ENCRYPTED PRIVATE KEY" in
// PEM), and the PEM headers of a PKCS#1 or SEC1 key (Proc-Type, DEK-Info; the key from OpenSSL's
// EVP_BytesToKey with MD5). The ciphers and digests are the runtime's; the DER here is only these
// structures'.
import {
  cryptoCipherFinal, cryptoCipherInfo, cryptoCipherNew, cryptoCipherUpdate, cryptoDigestFinal, cryptoDigestUpdate, cryptoHashNew,
  cryptoPbkdf2, cryptoRandomFill,
} from "visaljs:host";
import { codeError, notSupported } from "../errors.js";
import { sslError } from "./util.js";

/* OpenSSL 3's choices for PEM_write_bio_PKCS8PrivateKey with a cipher */
const PBKDF2_ITERATIONS = 2048;
const SALT_LENGTH = 16;
/* the buffer OpenSSL's PEM password callback reads into */
const PEM_PASSPHRASE_MAX = 1024;

/* object identifiers' contents, in hex */
const OID_PBES2 = "2a864886f70d01050d";
const OID_PBKDF2 = "2a864886f70d01050c";
const PRFS = {
  "2a864886f70d0207": "sha1", "2a864886f70d0208": "sha224", "2a864886f70d0209": "sha256", "2a864886f70d020a": "sha384",
  "2a864886f70d020b": "sha512",
};
const OID_HMAC_SHA256 = "2a864886f70d0209";
const CIPHERS = {
  "608648016503040102": "aes-128-cbc", "608648016503040116": "aes-192-cbc", "60864801650304012a": "aes-256-cbc",
  "2a864886f70d0307": "des-ede3-cbc", "2b0e030207": "des-cbc",
};
const CIPHER_OIDS = Object.fromEntries(Object.entries(CIPHERS).map(([oid, name]) => [name, oid]));

export const missingPassphrase = () => codeError(TypeError, "ERR_MISSING_PASSPHRASE", "Passphrase required for encrypted key");
const badDecrypt = () => sslError(30, 101, "BAD_DECRYPT");
const decodeError = () => sslError(6, 102, "DECODE_ERROR");
const badPasswordRead = () => sslError(9, 104, "BAD_PASSWORD_READ");

/* ---- DER: just the shapes above ---------------------------------------------------------------- */

function tlv(tag, body) {
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
}
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const oid = (hex) => tlv(0x06, Buffer.from(hex, "hex"));
const octets = (bytes) => tlv(0x04, bytes);
function integer(n) {
  const bytes = [];
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

/** The elements of the TLV at `pos`: { tag, body, end }; a decode error past the input. */
function read(der, pos) {
  if (pos + 2 > der.length) throw decodeError();
  const tag = der[pos];
  let len = der[pos + 1];
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3 || start + n > der.length) throw decodeError();
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[start + i];
    start += n;
  }
  if (start + len > der.length) throw decodeError();
  return { tag, body: der.subarray(start, start + len), end: start + len };
}

function children(der) {
  const out = [];
  for (let pos = 0; pos < der.length;) {
    const el = read(der, pos);
    out.push(el);
    pos = el.end;
  }
  return out;
}

function expect(el, tag) {
  if (el === undefined || el.tag !== tag) throw decodeError();
  return el.body;
}

/** Whether DER PKCS#8 is an EncryptedPrivateKeyInfo: its first element is an AlgorithmIdentifier
 *  (a SEQUENCE), where a PrivateKeyInfo's is its version (an INTEGER). */
export function isEncryptedPkcs8(der) {
  try {
    const [first] = children(expect(read(der, 0), 0x30));
    return first !== undefined && first.tag === 0x30;
  } catch {
    return false;
  }
}

/* ---- the primitives ---------------------------------------------------------------------------- */

function cipherInfo(name) {
  const info = cryptoCipherInfo(name);
  if (info === null) throw codeError(Error, "ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
  const [canonical, , , , ivLength, keyLength] = info;
  return { name: canonical, ivLength, keyLength };
}

function runCipher(name, encrypt, key, iv, data) {
  const handle = cryptoCipherNew(name, encrypt, key, iv, -1);
  if (typeof handle === "number") throw notSupported(`The cipher ${name} for a private key`);
  const head = cryptoCipherUpdate(handle, data);
  const tail = cryptoCipherFinal(handle);
  if (typeof head === "number" || typeof tail === "number") throw badDecrypt();
  return Buffer.concat([head, tail]);
}

function pbkdf2(digest, passphrase, salt, iterations, keyLength) {
  const key = cryptoPbkdf2(digest, passphrase, salt, iterations, keyLength);
  if (!key) throw decodeError();
  return key;
}

/* OpenSSL's EVP_BytesToKey with MD5 and one iteration: D(i) = MD5(D(i-1) ‖ passphrase ‖ salt) */
function bytesToKey(passphrase, salt, keyLength) {
  const parts = [];
  let total = 0;
  let prev = Buffer.alloc(0);
  while (total < keyLength) {
    const md5 = cryptoHashNew("md5", undefined);
    cryptoDigestUpdate(md5, prev);
    cryptoDigestUpdate(md5, passphrase);
    cryptoDigestUpdate(md5, salt);
    prev = cryptoDigestFinal(md5);
    parts.push(prev);
    total += prev.length;
  }
  return Buffer.concat(parts).subarray(0, keyLength);
}

function random(n) {
  const b = Buffer.alloc(n);
  cryptoRandomFill(b, 0, n);
  return b;
}

/* ---- PKCS#8 ------------------------------------------------------------------------------------ */

/** A PrivateKeyInfo in an EncryptedPrivateKeyInfo, as OpenSSL 3 writes one. */
export function encryptPkcs8(der, cipherName, passphrase) {
  const { name, ivLength, keyLength } = cipherInfo(cipherName);
  const cipherOid = CIPHER_OIDS[name];
  if (cipherOid === undefined) throw notSupported(`Encrypting a private key with ${cipherName}`);
  const salt = random(SALT_LENGTH);
  const iv = random(ivLength);
  const key = pbkdf2("sha256", passphrase, salt, PBKDF2_ITERATIONS, keyLength);
  const encrypted = runCipher(name, true, key, iv, der);
  const kdf = seq(oid(OID_PBKDF2), seq(octets(salt), integer(PBKDF2_ITERATIONS), seq(oid(OID_HMAC_SHA256), Buffer.from([5, 0]))));
  return seq(seq(oid(OID_PBES2), seq(kdf, seq(oid(cipherOid), octets(iv)))), octets(encrypted));
}

/** The PrivateKeyInfo an EncryptedPrivateKeyInfo holds (PBES2 with PBKDF2). */
export function decryptPkcs8(der, passphrase) {
  if (passphrase === undefined) throw missingPassphrase();
  const [algorithm, data] = children(expect(read(der, 0), 0x30));
  const [scheme, params] = children(expect(algorithm, 0x30));
  if (expect(scheme, 0x06).toString("hex") !== OID_PBES2) throw notSupported("A private key encrypted without PBES2");
  const [kdf, enc] = children(expect(params, 0x30));
  const [kdfOid, kdfParams] = children(expect(kdf, 0x30));
  if (expect(kdfOid, 0x06).toString("hex") !== OID_PBKDF2) throw notSupported("A private key encrypted without PBKDF2");
  const [salt, iterations, ...rest] = children(expect(kdfParams, 0x30));
  let digest = "sha1";  /* RFC 8018's default PRF */
  for (const el of rest) {
    if (el.tag !== 0x30) continue;  /* keyLength: the cipher's anyway */
    const prf = PRFS[expect(children(el.body)[0], 0x06).toString("hex")];
    if (prf === undefined) throw notSupported("This private key's PBKDF2 digest");
    digest = prf;
  }
  const [cipherOid, iv] = children(expect(enc, 0x30));
  const name = CIPHERS[expect(cipherOid, 0x06).toString("hex")];
  if (name === undefined) throw notSupported("This private key's cipher");
  const count = expect(iterations, 0x02).reduce((n, b) => n * 256 + b, 0);
  const { keyLength } = cipherInfo(name);
  const key = pbkdf2(digest, passphrase, expect(salt, 0x04), count, keyLength);
  return runCipher(name, false, key, expect(iv, 0x04), expect(data, 0x04));
}

/* ---- PEM's own encryption (PKCS#1, SEC1) ------------------------------------------------------- */

/** The headers and body of an encrypted PEM key, as OpenSSL's PEM_write_bio_PrivateKey writes them. */
export function encryptPemBody(der, cipherName, passphrase) {
  const { name, ivLength, keyLength } = cipherInfo(cipherName);
  const iv = random(ivLength);
  const key = bytesToKey(passphrase, iv.subarray(0, 8), keyLength);
  const body = runCipher(name, true, key, iv, der);
  return { headers: `Proc-Type: 4,ENCRYPTED\nDEK-Info: ${name.toUpperCase()},${iv.toString("hex").toUpperCase()}\n\n`, body };
}

/** The DER of an encrypted PEM key: its DEK-Info header names the cipher and the IV. */
export function decryptPemBody(headers, body, passphrase) {
  if (passphrase === undefined) throw missingPassphrase();
  if (passphrase.length > PEM_PASSPHRASE_MAX) throw badPasswordRead();
  const dek = /^DEK-Info:\s*([A-Za-z0-9-]+),([0-9A-Fa-f]+)\s*$/m.exec(headers);
  if (dek === null) throw sslError(9, 101, "BAD_DECRYPT");
  const { name, keyLength } = cipherInfo(dek[1].toLowerCase());
  const iv = Buffer.from(dek[2], "hex");
  const key = bytesToKey(passphrase, iv.subarray(0, 8), keyLength);
  return runCipher(name, false, key, iv, body);
}

export function checkPemPassphrase(passphrase) {
  if (passphrase !== undefined && passphrase.length > PEM_PASSPHRASE_MAX) {
    throw badPasswordRead();
  }
}
