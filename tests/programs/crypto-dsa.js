// DSA: keys (PEM and DER both ways, their details), sign and verify (DER and IEEE P1363
// signatures, any digest), Node's own signatures verified, key generation, and Node's errors.
import crypto, { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const data = (name) => readFileSync(join(import.meta.dirname, "data", "keys", name), "utf8");
const show = (f) => {
  try {
    const r = f();
    console.log(r);
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};

const priv = createPrivateKey(data("dsa.pem"));
const pub = createPublicKey(data("dsa.pub.pem"));
console.log(priv.asymmetricKeyType, priv.asymmetricKeyDetails, pub.asymmetricKeyDetails, createPublicKey(priv).equals(pub));
console.log(priv.export({ type: "pkcs8", format: "pem" }) === data("dsa.pem"), pub.export({ type: "spki", format: "pem" }) === data("dsa.pub.pem"));
const der = pub.export({ type: "spki", format: "der" });
console.log(createPublicKey({ key: der, format: "der", type: "spki" }).equals(pub), der.length);
show(() => priv.export({ format: "jwk" }));
show(() => priv.export({ type: "pkcs1", format: "pem" }));

/* Node's signatures */
const msg = Buffer.from("visaljs signs with DSA");
const sigs = JSON.parse(data("dsa.sigs.json"));
console.log(verify("sha256", msg, pub, Buffer.from(sigs.der, "hex")), verify("sha256", msg, { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sigs.p1363, "hex")),
  verify("sha1", msg, pub, Buffer.from(sigs.sha1, "hex")), verify("sha256", Buffer.from("other"), pub, Buffer.from(sigs.der, "hex")),
  verify("sha512", msg, pub, Buffer.from(sigs.der, "hex")));

/* ours */
const s = sign("sha256", msg, priv);
const p = sign("sha256", msg, { key: priv, dsaEncoding: "ieee-p1363" });
console.log(s[0], p.length, verify("sha256", msg, pub, s), verify("sha256", msg, { key: pub, dsaEncoding: "ieee-p1363" }, p),
  verify("sha256", msg, pub, p), verify(null, msg, pub, sign(null, msg, priv)));
const signer = crypto.createSign("sha384").update(msg);
const viaStream = signer.sign(priv, "base64");
console.log(crypto.createVerify("sha384").update(msg).verify(pub, viaStream, "base64"), crypto.createVerify("sha3-256").update(msg).verify(pub, viaStream, "base64"));
console.log(verify("sha256", msg, pub, Buffer.alloc(10)), verify("sha256", msg, { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.alloc(64)));
show(() => sign("sha256", msg, { key: priv, dsaEncoding: "raw" }));
show(() => crypto.publicEncrypt(pub, Buffer.from("x")));
show(() => crypto.diffieHellman({ privateKey: priv, publicKey: pub }));

/* generated keys */
for (const options of [{ modulusLength: 1024 }, { modulusLength: 2048 }, { modulusLength: 2048, divisorLength: 256 }]) {
  const pair = generateKeyPairSync("dsa", options);
  const sig = sign("sha256", msg, pair.privateKey);
  console.log(options, pair.publicKey.asymmetricKeyDetails, verify("sha256", msg, pair.publicKey, sig), verify("sha256", msg, pub, sig));
}
const encoded = generateKeyPairSync("dsa", { modulusLength: 1024, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "der" } });
console.log(encoded.publicKey.startsWith("-----BEGIN PUBLIC KEY-----"), Buffer.isBuffer(encoded.privateKey));
show(() => generateKeyPairSync("dsa", {}));
show(() => generateKeyPairSync("dsa", { modulusLength: 1024, divisorLength: "160" }));
await new Promise((resolve) => crypto.generateKeyPair("dsa", { modulusLength: 1024 }, (err, pk, sk) => {
  console.log("async", err, pk.asymmetricKeyDetails, sk.type);
  resolve();
}));
