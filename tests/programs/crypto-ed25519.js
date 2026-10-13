// Ed25519 in node:crypto and Web Crypto: RFC 8032's test vector (signatures are
// deterministic), key generation, sign and verify (the message itself: no digest), PEM, DER and
// JWK both ways, and Node's errors.
import crypto, { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign, verify, webcrypto } from "node:crypto";

const { subtle } = webcrypto;
const hex = (b) => Buffer.from(b).toString("hex");
const show = (f) => {
  try {
    const r = f();
    console.log(r);
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};

/* RFC 8032, 7.1, TEST 1 and TEST 3 */
const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const pub = createPublicKey(priv);
console.log(priv.type, priv.asymmetricKeyType, priv.asymmetricKeyDetails, pub.type, pub.asymmetricKeyType);
console.log("public", hex(pub.export({ format: "der", type: "spki" })));
console.log("sig(empty)", hex(sign(null, Buffer.alloc(0), priv)));
const msg3 = Buffer.from("af82", "hex");
const seed3 = Buffer.from("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7", "hex");
const priv3 = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: seed3.toString("base64url"), x: createPublicKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed3]), format: "der", type: "pkcs8" }).export({ format: "jwk" }).x }, format: "jwk" });
console.log("sig(af82)", hex(sign(undefined, msg3, priv3)));

/* PEM, DER and JWK */
const pem = priv.export({ format: "pem", type: "pkcs8" });
console.log(pem);
console.log(pub.export({ format: "pem", type: "spki" }));
console.log(priv.export({ format: "jwk" }), pub.export({ format: "jwk" }));
const fromJwk = createPublicKey({ key: pub.export({ format: "jwk" }), format: "jwk" });
console.log("jwk round trip", fromJwk.equals(pub), createPrivateKey(pem).equals(priv), createPublicKey(pem).equals(pub));
console.log("from the PEM's public part", hex(createPublicKey(pub.export({ format: "pem", type: "spki" })).export({ format: "der", type: "spki" })));

/* sign and verify */
const data = Buffer.from("visaljs signs with Ed25519");
const sig = sign(null, data, priv);
console.log(sig.length, verify(null, data, pub, sig), verify(null, data, priv, sig), verify(null, Buffer.from("other"), pub, sig));
console.log(verify(null, data, pub, Buffer.alloc(64)), verify(null, data, pub, sig.subarray(0, 63)));
console.log(sign(null, data, { key: pem, dsaEncoding: "ieee-p1363" }).equals(sig));
show(() => sign("sha256", data, priv));
show(() => verify("sha512", data, pub, sig));
show(() => crypto.createSign("sha256").update(data).sign(priv));
show(() => crypto.createVerify("sha256").update(data).verify(pub, sig));
show(() => crypto.diffieHellman({ privateKey: priv, publicKey: pub }));
await new Promise((resolve) => sign(null, data, priv, (err, s) => {
  console.log("async sign", err, s.equals(sig));
  verify(null, data, pub, s, (err2, ok) => {
    console.log("async verify", err2, ok);
    resolve();
  });
}));

/* generated keys */
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const s2 = sign(null, data, privateKey);
console.log(publicKey.asymmetricKeyType, privateKey.asymmetricKeyType, verify(null, data, publicKey, s2), verify(null, data, pub, s2));
const encoded = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
console.log(encoded.publicKey.length, encoded.privateKey.startsWith("-----BEGIN PRIVATE KEY-----"));
const jwkPair = generateKeyPairSync("ed25519", { publicKeyEncoding: { format: "jwk" }, privateKeyEncoding: { format: "jwk" } });
console.log(Object.keys(jwkPair.publicKey), Object.keys(jwkPair.privateKey), jwkPair.publicKey.x === jwkPair.privateKey.x);
await new Promise((resolve) => crypto.generateKeyPair("ed25519", (err, pk, sk) => {
  console.log("async pair", err, pk.type, sk.type);
  resolve();
}));

/* Web Crypto */
const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
console.log(pair.publicKey.algorithm, pair.privateKey.algorithm, pair.publicKey.usages, pair.privateKey.usages, pair.publicKey.type);
const wsig = await subtle.sign({ name: "Ed25519" }, pair.privateKey, data);
console.log(wsig.byteLength, await subtle.verify("Ed25519", pair.publicKey, wsig, data), await subtle.verify("Ed25519", pair.publicKey, wsig, Buffer.from("x")));
const raw = await subtle.exportKey("raw", pair.publicKey);
const jwk = await subtle.exportKey("jwk", pair.privateKey);
console.log(raw.byteLength, Object.keys(jwk).sort(), jwk.crv, jwk.kty);
const imported = await subtle.importKey("raw", raw, "Ed25519", true, ["verify"]);
console.log(await subtle.verify("Ed25519", imported, wsig, data));
const fromRfc = await subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
console.log("subtle RFC vector", hex(await subtle.sign("Ed25519", fromRfc, Buffer.alloc(0))) === hex(sign(null, Buffer.alloc(0), priv)));
const asKeyObject = KeyObject.from(pair.privateKey);
console.log(asKeyObject.asymmetricKeyType, verify(null, data, KeyObject.from(pair.publicKey), sign(null, data, asKeyObject)));
const back = pub.toCryptoKey("Ed25519", true, ["verify"]);
console.log(back.algorithm, hex(await subtle.exportKey("raw", back)) === hex(pub.export({ format: "jwk" }).x ? Buffer.from(pub.export({ format: "jwk" }).x, "base64url") : ""));
for (const f of [
  () => subtle.importKey("raw", new Uint8Array(31), "Ed25519", true, ["verify"]),
  () => subtle.generateKey("Ed25519", true, ["encrypt"]),
  () => subtle.importKey("jwk", { ...jwk, crv: "X25519" }, "Ed25519", true, ["sign"]),
  () => subtle.sign("Ed25519", pair.publicKey, data),
]) {
  try {
    await f();
    console.log("no error");
  } catch (e) {
    console.log(`${e.name}: ${e.message}`);
  }
}
