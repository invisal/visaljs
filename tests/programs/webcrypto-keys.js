// Web Crypto keys: CryptoKey; HMAC, PBKDF2 and HKDF through importKey, exportKey,
// generateKey, sign, verify, deriveBits and deriveKey, with Node's errors.
const s = crypto.subtle;
const show = async (f) => {
  try {
    const r = await f();
    console.log(r instanceof ArrayBuffer ? "ArrayBuffer " + Buffer.from(r).toString("hex") : r);
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};
const bytes = (t) => new TextEncoder().encode(t);
const raw = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

console.log(Object.getOwnPropertyNames(SubtleCrypto.prototype).map((n) => n + "/" + (SubtleCrypto.prototype[n].length ?? "")).join(" "));
console.log(Object.getOwnPropertyNames(CryptoKey.prototype), Object.getOwnPropertyDescriptor(CryptoKey.prototype, "type").enumerable);
await show(() => new CryptoKey());

/* HMAC keys */
const k = await s.importKey("raw", raw, { name: "HMAC", hash: { name: "sha-512" } }, true, ["verify", "sign", "verify"]);
console.log(k, k.type, k.extractable, k.algorithm, k.usages, k.algorithm === k.algorithm, k.usages === k.usages);
console.log(k instanceof CryptoKey, Object.prototype.toString.call(k));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, true, ["sign", "verify"]));
await show(() => s.importKey("raw", raw.buffer, { name: "HMAC", hash: "SHA-1", length: 128 }, false, ["sign"]));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256", length: 100 }, true, ["sign"]));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256", length: 0 }, true, ["sign"]));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256", length: -1 }, true, ["sign"]));
await show(() => s.importKey("raw", raw, { name: "HMAC" }, true, ["sign"]));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-3" }, true, ["sign"]));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, true, ["encrypt"]));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, true, []));
await show(() => s.importKey("raw", new Uint8Array(0), { name: "HMAC", hash: "SHA-256" }, true, ["sign"]));
await show(() => s.importKey("foo", raw, { name: "HMAC", hash: "SHA-256" }, true, ["sign"]));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, true, ["bogus"]));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, true));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, true, "sign"));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }));
await show(() => s.importKey("raw", "abc", { name: "HMAC", hash: "SHA-256" }, true, ["sign"]));
await show(() => s.importKey("jwk", "abc", { name: "HMAC", hash: "SHA-256" }, true, ["sign"]));
await show(() => s.importKey("spki", raw, { name: "HMAC", hash: "SHA-256" }, true, ["sign"]));
await show(() => s.importKey("raw", raw, "foo", true, ["sign"]));
await show(() => s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, 0, ["sign"]).then((k) => k.extractable));
await show(() => s.importKey.call({}, "raw", raw, { name: "HMAC", hash: "SHA-256" }, true, ["sign"]));

/* JWK */
const jwk = (j, hash = "SHA-256", usages = ["sign"]) => s.importKey("jwk", j, { name: "HMAC", hash }, true, usages);
await show(() => jwk({ kty: "oct", k: "AQIDBAUGBwgJCgsMDQ4PEA", alg: "HS256" }));
await show(() => jwk({ kty: "oct", k: "AQIDBAUGBwgJCgsMDQ4PEA", alg: "HS384" }));
await show(() => jwk({ kty: "RSA", k: "AQ" }));
await show(() => jwk({ kty: "oct" }));
await show(() => jwk({ k: "AQ" }));
await show(() => jwk({ kty: "oct", k: "AQ", use: "enc" }));
await show(() => jwk({ kty: "oct", k: "AQ", use: "sig" }));
await show(() => jwk({ kty: "oct", k: "AQ", ext: false }));
await show(() => jwk({ kty: "oct", k: "AQ", key_ops: ["verify"] }));
await show(() => jwk({ kty: "oct", k: "AQ", key_ops: ["sign", "sign"] }));
await show(() => jwk({ kty: "oct", k: "AQ", key_ops: ["sign", "other", "other"] }));
await show(() => jwk({ kty: "oct", k: "AQ", key_ops: "sign" }));
await show(() => jwk({ kty: "oct", k: "A+Q/" }).then((k) => s.exportKey("raw", k)));
await show(() => jwk({ kty: "oct", k: 1 }));
await show(() => jwk({ kty: "oct", k: "AQ", alg: "HS1" }, "SHA-1").then((k) => s.exportKey("jwk", k)));
await show(() => s.exportKey("jwk", k));
await show(() => s.exportKey("raw", k));
await show(() => s.exportKey("spki", k));
await show(() => s.exportKey("raw", 1));
await show(() => s.exportKey("foo", k));
await show(async () => s.exportKey("raw", await s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])));

/* sign and verify */
const sig = await s.sign("HMAC", k, bytes("msg"));
console.log(Buffer.from(sig).toString("hex"));
await show(() => s.verify("HMAC", k, sig, bytes("msg")));
await show(() => s.verify({ name: "hmac" }, k, sig, bytes("msg!")));
await show(() => s.verify("HMAC", k, new Uint8Array(3), bytes("msg")));
await show(() => s.verify("HMAC", k, "x", bytes("msg")));
await show(() => s.sign("HMAC", 1, new Uint8Array(1)));
await show(() => s.sign("HMAC", k));
await show(async () => s.sign("HMAC", await s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]), new Uint8Array(1)));
for (const hash of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"]) {
  const key = await s.importKey("raw", bytes("key"), { name: "HMAC", hash }, false, ["sign"]);
  console.log(hash, Buffer.from(await s.sign({ name: "HMAC" }, key, bytes("The quick brown fox jumps over the lazy dog"))).toString("hex"));
}

/* generateKey */
const g = await s.generateKey({ name: "HMAC", hash: "SHA-384" }, true, ["sign", "sign", "verify"]);
console.log(g.algorithm, g.usages, (await s.exportKey("raw", g)).byteLength);
await show(async () => (await s.generateKey({ name: "HMAC", hash: "SHA-1", length: 72 }, true, ["sign"])).algorithm);
await show(() => s.generateKey({ name: "HMAC", hash: "SHA-256" }, true, []));
await show(() => s.generateKey({ name: "HMAC", hash: "SHA-256", length: 0 }, true, ["sign"]));
await show(() => s.generateKey({ name: "HMAC", hash: "SHA-256", length: 7 }, true, ["sign"]));
await show(() => s.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["encrypt"]));
await show(() => s.generateKey({ name: "PBKDF2" }, true, ["deriveBits"]));
await show(() => s.generateKey());

/* PBKDF2 */
const pb = await s.importKey("raw", bytes("password"), "PBKDF2", false, ["deriveBits", "deriveKey"]);
console.log(pb);
await show(() => s.importKey("raw", raw, "PBKDF2", true, ["deriveBits"]));
await show(() => s.importKey("raw", raw, "PBKDF2", false, ["sign"]));
await show(() => s.importKey("jwk", { kty: "oct", k: "AQ" }, "PBKDF2", false, ["deriveBits"]));
const pbkdf2 = (over) => ({ name: "PBKDF2", salt: bytes("salt"), iterations: 2, hash: "SHA-256", ...over });
await show(() => s.deriveBits(pbkdf2(), pb, 128));
await show(() => s.deriveBits(pbkdf2({ hash: "SHA-512", iterations: 1000 }), pb, 512));
await show(() => s.deriveBits(pbkdf2({ iterations: 0 }), pb, 128));
await show(() => s.deriveBits(pbkdf2({ iterations: 1.5 }), pb, 8));
await show(() => s.deriveBits(pbkdf2({ iterations: -1 }), pb, 8));
await show(() => s.deriveBits(pbkdf2({ iterations: "x" }), pb, 8));
await show(() => s.deriveBits(pbkdf2({ salt: 1 }), pb, 8));
await show(() => s.deriveBits(pbkdf2({ salt: undefined }), pb, 8));
await show(() => s.deriveBits(pbkdf2({ hash: "SHA-3" }), pb, 8));
await show(() => s.deriveBits(pbkdf2(), pb, 127));
await show(() => s.deriveBits(pbkdf2(), pb, 0));
await show(() => s.deriveBits(pbkdf2(), pb, null));
await show(() => s.deriveBits(pbkdf2(), pb));
await show(() => s.deriveBits(pbkdf2(), pb, 8.5));
await show(() => s.deriveBits(pbkdf2(), pb, "x"));
await show(() => s.deriveBits(pbkdf2()));
await show(() => s.deriveBits({ name: "HMAC" }, pb, 8));
await show(() => s.deriveBits({ name: "HKDF", salt: raw, info: raw, hash: "SHA-256" }, pb, 8));
await show(() => s.exportKey("raw", pb));

/* HKDF */
const hk = await s.importKey("raw", bytes("ikm"), "HKDF", false, ["deriveBits"]);
const hkdf = (over) => ({ name: "HKDF", salt: new Uint8Array(4), info: new Uint8Array(2), hash: "SHA-256", ...over });
await show(() => s.deriveBits(hkdf(), hk, 256));
await show(() => s.deriveBits(hkdf({ hash: "SHA-1", salt: new Uint8Array(0) }), hk, 400));
await show(() => s.deriveBits(hkdf(), hk, 256 * 255 * 8 + 8));
await show(() => s.deriveBits(hkdf({ info: undefined }), hk, 256));
await show(() => s.importKey("raw", raw, "HKDF", false, ["sign"]));
await show(() => s.importKey("raw", raw, "hkdf", false, ["deriveKey"]));

/* deriveKey */
const pk = await s.importKey("raw", bytes("password"), "PBKDF2", false, ["deriveKey"]);
const salt4 = pbkdf2({ salt: new Uint8Array(4), iterations: 1 });
await show(() => s.deriveKey(salt4, pk, { name: "HMAC", hash: "SHA-1" }, true, ["sign"]));
await show(async () => s.exportKey("raw", await s.deriveKey(salt4, pk, { name: "HMAC", hash: "SHA-1", length: 64 }, true, ["sign"])));
await show(() => s.deriveKey(salt4, pk, { name: "HMAC", hash: "SHA-1", length: 0 }, true, ["sign"]));
await show(() => s.deriveKey(salt4, pk, "HKDF", false, ["deriveBits"]));
await show(() => s.deriveKey(salt4, pk, { name: "HMAC", hash: "SHA-1" }, true, []));
await show(() => s.deriveKey(salt4, pk, { name: "HMAC" }, true, ["sign"]));
await show(() => s.deriveKey(salt4, pb, { name: "HMAC", hash: "SHA-1" }, true, ["sign"]).then((k) => k.algorithm));
await show(() => s.deriveKey(salt4, hk, { name: "HMAC", hash: "SHA-1" }, true, ["sign"]));
const hkk = await s.importKey("raw", bytes("ikm"), "HKDF", false, ["deriveKey"]);
await show(async () => s.exportKey("jwk", await s.deriveKey(hkdf(), hkk, { name: "HMAC", hash: "SHA-256", length: 128 }, true, ["verify"])));
await show(() => s.deriveKey(salt4, pk, { name: "HMAC", hash: "SHA-1" }, true));
