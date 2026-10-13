// Web Crypto's asymmetric algorithms: RSASSA-PKCS1-v1_5, RSA-PSS, RSA-OAEP, ECDSA, ECDH
// and X25519: importKey and exportKey (spki, pkcs8, jwk, raw), generateKey, sign, verify,
// encrypt, decrypt, deriveBits, deriveKey, and KeyObject.toCryptoKey, with Node's errors.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createECDH, createPrivateKey, createPublicKey, ECDH, KeyObject } from "node:crypto";

const s = crypto.subtle;
const t = async (f) => {
  try {
    const r = await f();
    console.log(r instanceof ArrayBuffer ? "ArrayBuffer " + Buffer.from(r).toString("hex") : r);
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};
const file = (name) => readFileSync(join(import.meta.dirname, "data", "keys", name), "utf8");
const pkcs8 = (name) => createPrivateKey(file(name)).export({ format: "der", type: "pkcs8" });
const spki = (name) => createPublicKey(file(name)).export({ format: "der", type: "spki" });
const m = Buffer.from("message");

/* RSA */
const rk = await s.importKey("pkcs8", pkcs8("rsa.pem"), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
const rp = await s.importKey("spki", spki("rsa.pub.pem"), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]);
console.log(rk, rk.algorithm, rp);
await t(() => s.sign("RSASSA-PKCS1-v1_5", rk, m));
await t(async () => s.verify("RSASSA-PKCS1-v1_5", rp, await s.sign("RSASSA-PKCS1-v1_5", rk, m), m));
await t(async () => s.verify("RSASSA-PKCS1-v1_5", rp, await s.sign("RSASSA-PKCS1-v1_5", rk, m), Buffer.from("other")));
for (const hash of ["SHA-1", "SHA-384", "SHA-512"]) {
  const k = await s.importKey("pkcs8", pkcs8("rsa.pem"), { name: "RSASSA-PKCS1-v1_5", hash }, false, ["sign"]);
  console.log(hash, Buffer.from(await s.sign("RSASSA-PKCS1-v1_5", k, m)).toString("base64"));
}
await t(() => s.exportKey("jwk", rk));
await t(() => s.exportKey("jwk", rp));
await t(async () => Buffer.from(await s.exportKey("spki", rp)).equals(spki("rsa.pub.pem")));
await t(async () => Buffer.from(await s.exportKey("pkcs8", rk)).equals(pkcs8("rsa.pem")));
await t(() => s.exportKey("raw", rp));
await t(() => s.exportKey("spki", rk));
await t(() => s.exportKey("pkcs8", rp));
await t(() => s.exportKey("raw", rk));
await t(() => s.importKey("spki", spki("rsa.pub.pem"), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]));
await t(() => s.importKey("pkcs8", pkcs8("rsa.pem"), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]));
await t(() => s.importKey("pkcs8", pkcs8("rsa.pem"), { name: "RSASSA-PKCS1-v1_5" }, true, ["sign"]));
await t(() => s.importKey("pkcs8", pkcs8("prime256v1.pem"), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]));
await t(() => s.importKey("spki", spki("pss.pub.pem"), { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"]));
await t(() => s.importKey("spki", Buffer.alloc(5), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]));
await t(() => s.importKey("raw", Buffer.alloc(5), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]));
await t(async () => s.importKey("jwk", await s.exportKey("jwk", rk), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]).then((k) => s.sign("RSASSA-PKCS1-v1_5", k, m)));
await t(async () => s.importKey("jwk", await s.exportKey("jwk", rp), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, true, ["verify"]));
await t(() => s.importKey("jwk", { kty: "RSA", n: "AQAB", e: "AQAB" }, { name: "RSA-OAEP", hash: "SHA-1" }, true, ["encrypt"]).then((k) => s.exportKey("jwk", k)));
await t(() => s.importKey("jwk", { kty: "EC", n: "AQAB", e: "AQAB" }, { name: "RSA-OAEP", hash: "SHA-1" }, true, ["encrypt"]));
await t(() => s.importKey("jwk", { kty: "RSA", n: "AQAB", e: "AQAB", use: "sig" }, { name: "RSA-OAEP", hash: "SHA-1" }, true, ["encrypt"]));

/* RSA-PSS */
const pk = await s.importKey("pkcs8", pkcs8("rsa.pem"), { name: "RSA-PSS", hash: "SHA-256" }, true, ["sign"]);
const pp = await s.importKey("spki", spki("rsa.pub.pem"), { name: "RSA-PSS", hash: "SHA-256" }, true, ["verify"]);
for (const saltLength of [0, 20, 32]) {
  const sig = await s.sign({ name: "RSA-PSS", saltLength }, pk, m);
  console.log("pss", saltLength, sig.byteLength, await s.verify({ name: "RSA-PSS", saltLength }, pp, sig, m), await s.verify({ name: "RSA-PSS", saltLength: 1 }, pp, sig, m));
}
await t(() => s.sign({ name: "RSA-PSS" }, pk, m));
await t(() => s.sign({ name: "RSA-PSS", saltLength: 200 }, pk, m));
await t(() => s.exportKey("jwk", pp).then((j) => j.alg));

/* RSA-OAEP */
const ok = await s.importKey("pkcs8", pkcs8("rsa.pem"), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]);
const op = await s.importKey("spki", spki("rsa.pub.pem"), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
await t(async () => Buffer.from(await s.decrypt({ name: "RSA-OAEP" }, ok, await s.encrypt({ name: "RSA-OAEP" }, op, Buffer.from("hi")))).toString());
await t(async () => Buffer.from(await s.decrypt({ name: "RSA-OAEP", label: Buffer.from("L") }, ok, await s.encrypt({ name: "RSA-OAEP", label: Buffer.from("L") }, op, Buffer.from("hi")))).toString());
await t(async () => s.decrypt({ name: "RSA-OAEP" }, ok, await s.encrypt({ name: "RSA-OAEP", label: Buffer.from("L") }, op, Buffer.from("hi"))));
await t(() => s.encrypt({ name: "RSA-OAEP" }, op, Buffer.alloc(100)));
await t(() => s.decrypt({ name: "RSA-OAEP" }, ok, Buffer.alloc(100)));
await t(() => s.encrypt({ name: "RSA-OAEP" }, ok, m));
await t(() => s.exportKey("jwk", op).then((j) => j.alg));
await t(() => s.importKey("pkcs8", pkcs8("rsa.pem"), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]));
const kw = await s.importKey("raw", new Uint8Array(16).fill(1), "AES-KW", true, ["wrapKey"]);
await t(async () => {
  const wrapped = await s.wrapKey("raw", kw, op, { name: "RSA-OAEP" });
  return s.unwrapKey("raw", wrapped, await s.importKey("pkcs8", pkcs8("rsa.pem"), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["unwrapKey"]), { name: "RSA-OAEP" }, "AES-KW", true, ["wrapKey"]);
});

/* ECDSA */
for (const [name, crv] of [["prime256v1", "P-256"], ["secp384r1", "P-384"], ["secp521r1", "P-521"]]) {
  const ek = await s.importKey("pkcs8", pkcs8(name + ".pem"), { name: "ECDSA", namedCurve: crv }, true, ["sign"]);
  const ep = await s.importKey("spki", spki(name + ".pub.pem"), { name: "ECDSA", namedCurve: crv }, true, ["verify"]);
  const sig = await s.sign({ name: "ECDSA", hash: "SHA-256" }, ek, m);
  console.log(crv, ek.algorithm, sig.byteLength, await s.verify({ name: "ECDSA", hash: "SHA-256" }, ep, sig, m), await s.verify({ name: "ECDSA", hash: "SHA-384" }, ep, sig, m));
  console.log(await s.exportKey("jwk", ek), Buffer.from(await s.exportKey("raw", ep)).toString("hex"));
  const raw = await s.importKey("raw", await s.exportKey("raw", ep), { name: "ECDSA", namedCurve: crv }, true, ["verify"]);
  console.log(await s.verify({ name: "ECDSA", hash: "SHA-256" }, raw, sig, m));
}
const ek = await s.importKey("pkcs8", pkcs8("prime256v1.pem"), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const ep = await s.importKey("spki", spki("prime256v1.pub.pem"), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
await t(() => s.sign({ name: "ECDSA" }, ek, m));
await t(() => s.verify({ name: "ECDSA", hash: "SHA-256" }, ep, Buffer.alloc(3), m));
await t(() => s.exportKey("spki", ek));
await t(() => s.exportKey("raw", ek));
await t(() => s.importKey("spki", spki("prime256v1.pub.pem"), { name: "ECDSA", namedCurve: "P-384" }, true, ["verify"]));
await t(() => s.importKey("spki", spki("prime256v1.pub.pem"), { name: "ECDSA", namedCurve: "P-999" }, true, ["verify"]));
await t(() => s.importKey("raw", Buffer.alloc(3), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]));
await t(() => s.importKey("raw", ECDH.convertKey(createECDH("prime256v1").setPrivateKey(Buffer.alloc(32, 1)).getPublicKey(), "prime256v1", null, null, "compressed"), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]).then((k) => s.exportKey("raw", k)));
await t(() => s.importKey("jwk", { kty: "EC", crv: "P-384", x: "AA", y: "AA" }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]));
await t(async () => s.importKey("jwk", { ...(await s.exportKey("jwk", ep)), alg: "ES384" }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]));
await t(async () => s.importKey("jwk", { ...(await s.exportKey("jwk", ep)), alg: "ES256" }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]).then((k) => k.algorithm));

/* ECDH */
const dk = await s.importKey("pkcs8", pkcs8("prime256v1.pem"), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
const dp = await s.importKey("spki", spki("prime256v1.pub.pem"), { name: "ECDH", namedCurve: "P-256" }, true, []);
console.log(dk, dp);
await t(() => s.deriveBits({ name: "ECDH", public: dp }, dk, 256));
await t(() => s.deriveBits({ name: "ECDH", public: dp }, dk, null));
await t(() => s.deriveBits({ name: "ECDH", public: dp }, dk, 128));
await t(() => s.deriveBits({ name: "ECDH", public: dp }, dk, 12));
await t(() => s.deriveBits({ name: "ECDH", public: dp }, dk, 300));
await t(() => s.deriveBits({ name: "ECDH", public: dk }, dk, 128));
await t(() => s.deriveBits({ name: "ECDH", public: 1 }, dk, 128));
await t(() => s.deriveBits({ name: "ECDH" }, dk, 128));
await t(() => s.deriveKey({ name: "ECDH", public: dp }, dk, { name: "AES-GCM", length: 128 }, true, ["encrypt"]).then((k) => s.exportKey("raw", k)));
await t(() => s.importKey("spki", spki("prime256v1.pub.pem"), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
await t(() => s.exportKey("jwk", dp));
const p384 = (await s.generateKey({ name: "ECDH", namedCurve: "P-384" }, true, ["deriveBits"])).publicKey;
await t(() => s.deriveBits({ name: "ECDH", public: p384 }, dk, 128));

/* X25519 */
const xk = await s.importKey("pkcs8", pkcs8("x25519.pem"), { name: "X25519" }, true, ["deriveBits"]);
const xp = await s.importKey("spki", spki("x25519.pub.pem"), "X25519", true, []);
console.log(xk, xp);
await t(() => s.deriveBits({ name: "X25519", public: xp }, xk, 256));
await t(() => s.deriveBits({ name: "X25519", public: xp }, xk));
await t(() => s.exportKey("raw", xp));
await t(() => s.exportKey("jwk", xk));
await t(() => s.importKey("raw", new Uint8Array(32).fill(9), "X25519", true, []).then((k) => [k.type, k.algorithm]));
await t(() => s.importKey("raw", new Uint8Array(31), "X25519", true, []));
await t(() => s.importKey("pkcs8", pkcs8("x25519.pem"), "X25519", true, ["sign"]));
await t(() => s.importKey("raw", new Uint8Array(32), "X25519", true, ["deriveBits"]));
await t(() => s.importKey("pkcs8", pkcs8("rsa.pem"), "X25519", true, ["deriveBits"]));
await t(() => s.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: "AA" }, "X25519", true, []));
await t(() => s.deriveBits({ name: "ECDH", public: xp }, dk, 128));
await t(() => s.deriveBits({ name: "X25519", public: xp }, dk, 128));

/* generateKey */
await t(async () => {
  const kp = await s.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  return [kp.publicKey.algorithm, kp.publicKey.usages, kp.privateKey.usages, Object.keys(kp), kp.publicKey.extractable, kp.privateKey.extractable,
    await s.verify("RSASSA-PKCS1-v1_5", kp.publicKey, await s.sign("RSASSA-PKCS1-v1_5", kp.privateKey, m), m)];
});
await t(async () => {
  const kp = await s.generateKey({ name: "RSA-OAEP", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" }, false, ["decrypt", "encrypt", "wrapKey"]);
  return [kp.publicKey.usages, kp.privateKey.usages, kp.privateKey.extractable, Buffer.from(await s.decrypt("RSA-OAEP", kp.privateKey, await s.encrypt("RSA-OAEP", kp.publicKey, m))).toString()];
});
await t(async () => {
  const kp = await s.generateKey({ name: "ECDSA", namedCurve: "P-384" }, false, ["sign", "verify"]);
  return [kp.publicKey.algorithm, kp.publicKey.usages, kp.privateKey.usages, kp.publicKey.extractable,
    await s.verify({ name: "ECDSA", hash: "SHA-384" }, kp.publicKey, await s.sign({ name: "ECDSA", hash: "SHA-384" }, kp.privateKey, m), m)];
});
await t(async () => {
  const a = await s.generateKey({ name: "ECDH", namedCurve: "P-521" }, true, ["deriveBits"]);
  const b = await s.generateKey({ name: "ECDH", namedCurve: "P-521" }, true, ["deriveBits"]);
  return [a.publicKey.usages, a.privateKey.usages, Buffer.from(await s.deriveBits({ name: "ECDH", public: b.publicKey }, a.privateKey, 528)).equals(Buffer.from(await s.deriveBits({ name: "ECDH", public: a.publicKey }, b.privateKey, 528)))];
});
await t(async () => {
  const a = await s.generateKey("X25519", true, ["deriveKey", "deriveBits"]);
  const b = await s.generateKey("X25519", true, ["deriveBits"]);
  return [a.publicKey.usages, a.privateKey.usages, a.publicKey.algorithm, Buffer.from(await s.deriveBits({ name: "X25519", public: b.publicKey }, a.privateKey)).equals(Buffer.from(await s.deriveBits({ name: "X25519", public: a.publicKey }, b.privateKey)))];
});
await t(() => s.generateKey({ name: "RSA-OAEP", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]));
await t(() => s.generateKey({ name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 0, 0, 0, 1]), hash: "SHA-256" }, true, ["sign"]));
await t(() => s.generateKey({ name: "RSA-PSS", modulusLength: 1024, publicExponent: [1, 0, 1], hash: "SHA-256" }, true, ["sign"]));
await t(() => s.generateKey({ name: "RSA-PSS", modulusLength: 100, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]));
await t(() => s.generateKey({ name: "RSA-PSS", publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]));
await t(() => s.generateKey({ name: "RSA-PSS", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, []));
await t(() => s.generateKey({ name: "ECDSA", namedCurve: "P-999" }, true, ["sign"]));
await t(() => s.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, []));
await t(() => s.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["encrypt"]));
await t(() => s.generateKey("X25519", true, ["sign"]));

/* KeyObject and CryptoKey */
await t(() => KeyObject.from(rk).asymmetricKeyType);
await t(() => KeyObject.from(dp).export({ format: "pem", type: "spki" }) === file("prime256v1.pub.pem"));
await t(() => createPrivateKey(file("rsa.pem")).toCryptoKey({ name: "RSA-PSS", hash: "SHA-1" }, false, ["sign"]));
await t(() => createPublicKey(file("prime256v1.pub.pem")).toCryptoKey({ name: "ECDH", namedCurve: "P-256" }, true, []));
await t(() => createPublicKey(file("x25519.pub.pem")).toCryptoKey("X25519", true, []).algorithm);
