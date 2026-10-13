// node:crypto's asymmetric operations: signatures (RSA PKCS#1 v1.5 and PSS, ECDSA in
// DER and P1363), RSA encryption in all four directions, ECDH and diffieHellman. Random outputs
// (PSS, ECDSA, OAEP) are checked by round trips; the rest are Node's bytes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import crypto, {
  constants, createECDH, createPrivateKey, createPublicKey, createSign, createVerify, diffieHellman, ECDH, generateKeyPairSync, getCurves,
  privateDecrypt, privateEncrypt, publicDecrypt, publicEncrypt, sign, verify,
} from "node:crypto";

const show = (f) => {
  try {
    const r = f();
    console.log(Buffer.isBuffer(r) ? r.toString("hex") : r);
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};
const pem = (name) => readFileSync(join(import.meta.dirname, "data", "keys", name), "utf8");
const pemBuffer = (name) => readFileSync(join(import.meta.dirname, "data", "keys", name));
const rsa = createPrivateKey(pem("rsa.pem"));
const rsaPub = createPublicKey(rsa);
const pss = createPrivateKey(pem("pss.pem"));
const pss0 = createPrivateKey(pem("pss0.pem"));
const m = Buffer.from("message");

/* RSA PKCS#1 v1.5: deterministic */
for (const hash of ["sha1", "sha224", "sha256", "sha384", "sha512", "md5", "sha3-256", "sha512-256", "RSA-SHA256"]) {
  const sig = sign(hash, m, rsa);
  console.log(hash, sig.toString("base64"), verify(hash, m, rsaPub, sig), verify(hash, Buffer.from("other"), rsaPub, sig));
}
show(() => sign(null, m, rsa));
show(() => sign(undefined, m, pem("rsa.pem")));
show(() => sign(undefined, m, pemBuffer("rsa.pem")).equals(sign("sha256", m, rsa)));
show(() => verify("sha256", m, rsa, sign("sha256", m, rsa)));
show(() => verify("sha256", m, pem("rsa.pub.pem"), sign("sha256", m, rsa)));
show(() => verify("sha256", m, rsaPub, Buffer.alloc(128)));
show(() => verify("sha256", m, rsaPub, Buffer.alloc(3)));
show(() => createSign("SHA256").update("message").sign(rsa, "base64"));
show(() => createSign("RSA-SHA512").update("mess").update("age").sign({ key: pem("rsa.pem") }, "hex"));
show(() => createVerify("sha256").update("message").verify(rsaPub, sign("sha256", m, rsa)));
show(() => createVerify("sha256").update("message").verify(rsaPub, sign("sha256", m, rsa).toString("base64"), "base64"));
show(() => {
  const s = createSign("sha256");
  s.update("a");
  s.sign(rsa);
  return s.sign(rsa);
});
show(() => {
  const s = createSign("sha256");
  s.sign(rsa);
  return s.update("a");
});
show(() => createSign("foo"));
show(() => sign("foo", m, rsa));
show(() => createSign("sha256").sign());
show(() => sign("sha256", m));
show(() => sign("sha256", m, crypto.createSecretKey(Buffer.alloc(4))));
show(() => sign("sha256", m, rsaPub));
show(() => sign("sha256", m, createPrivateKey(pem("x25519.pem"))));
show(() => verify("sha256", "m", rsaPub, Buffer.alloc(1)));
show(() => verify("sha256", m, rsaPub, "x"));
show(() => sign("sha256", m, { key: rsa, dsaEncoding: "foo" }));
show(() => sign("sha256", m, { key: rsa, padding: "x" }));
show(() => Object.getOwnPropertyNames(crypto.Sign.prototype));
show(() => Object.getOwnPropertyNames(crypto.Verify.prototype));
show(() => createSign("sha256") instanceof crypto.Sign);

/* a Sign is a Writable */
const ws = createSign("sha256");
ws.write("mess");
ws.end("age", () => console.log("stream sign", ws.sign(rsa, "hex") === sign("sha256", m, rsa).toString("hex")));

/* RSA-PSS: random salts; the verifier's salt length, or any */
const PSS = constants.RSA_PKCS1_PSS_PADDING;
for (const saltLength of [undefined, constants.RSA_PSS_SALTLEN_DIGEST, constants.RSA_PSS_SALTLEN_MAX_SIGN, 0, 10]) {
  const sig = sign("sha256", m, { key: rsa, padding: PSS, saltLength });
  console.log("pss", saltLength, sig.length,
    verify("sha256", m, { key: rsaPub, padding: PSS }, sig),
    verify("sha256", m, { key: rsaPub, padding: PSS, saltLength: constants.RSA_PSS_SALTLEN_AUTO }, sig),
    verify("sha256", m, { key: rsaPub, padding: PSS, saltLength: 10 }, sig),
    verify("sha256", m, rsaPub, sig));
}
show(() => verify("sha256", m, { key: rsaPub, padding: PSS }, sign("sha256", m, { key: rsa, padding: PSS, saltLength: 200 })));
show(() => verify("sha256", m, createPublicKey(pss), sign("sha256", m, { key: pss, saltLength: 16 })));
show(() => verify("sha256", m, createPublicKey(pss0), sign("sha256", m, pss0)));
show(() => verify("sha512", m, { key: createPublicKey(pss0), saltLength: 64 }, sign("sha512", m, { key: pss0, saltLength: 64 })));

/* ECDSA: random nonces, DER or P1363 */
for (const name of ["prime256v1", "secp384r1", "secp521r1"]) {
  const key = createPrivateKey(pem(name + ".pem"));
  const pub = createPublicKey(pem(name + ".pub.pem"));
  const der = sign("sha256", m, key);
  const raw = sign("sha384", m, { key, dsaEncoding: "ieee-p1363" });
  console.log(name, der[0] === 0x30, raw.length, verify("sha256", m, pub, der), verify("sha384", m, { key: pub, dsaEncoding: "ieee-p1363" }, raw),
    verify("sha384", m, pub, raw), verify("sha256", Buffer.from("other"), pub, der));
  console.log(createVerify("sha256").update(m).verify(pub, createSign("sha256").update(m).sign(key)));
}

/* RSA encryption */
const hi = Buffer.from("hi");
show(() => publicEncrypt(rsaPub, hi).length);
show(() => privateDecrypt(rsa, publicEncrypt(rsaPub, hi)).toString());
show(() => privateDecrypt(rsa, publicEncrypt(rsa, hi)).toString());
show(() => privateDecrypt(rsa, publicEncrypt(pem("rsa.pub.pem"), hi)).toString());
show(() => privateDecrypt({ key: rsa, padding: constants.RSA_PKCS1_PADDING }, publicEncrypt({ key: rsaPub, padding: constants.RSA_PKCS1_PADDING }, hi)).toString());
show(() => privateDecrypt({ key: rsa, oaepHash: "sha256" }, publicEncrypt({ key: rsaPub, oaepHash: "sha256" }, hi)).toString());
show(() => privateDecrypt({ key: rsa, oaepHash: "sha256", oaepLabel: Buffer.from("L") }, publicEncrypt({ key: rsaPub, oaepHash: "sha256", oaepLabel: Buffer.from("L") }, hi)).toString());
show(() => privateDecrypt({ key: rsa, oaepHash: "sha256" }, publicEncrypt({ key: rsaPub, oaepHash: "sha256", oaepLabel: Buffer.from("L") }, hi)));
show(() => privateDecrypt({ key: rsa, oaepHash: "sha1" }, publicEncrypt({ key: rsaPub, oaepHash: "sha256" }, hi)));
show(() => privateEncrypt(rsa, hi));
show(() => publicDecrypt(rsaPub, privateEncrypt(rsa, hi)).toString());
show(() => publicDecrypt(pem("rsa.pub.pem"), privateEncrypt(pem("rsa.pem"), Buffer.from("text"))).toString());
show(() => publicEncrypt({ key: rsaPub, padding: constants.RSA_NO_PADDING }, Buffer.alloc(128, 1)).length);
show(() => privateDecrypt({ key: rsa, padding: constants.RSA_NO_PADDING }, publicEncrypt({ key: rsaPub, padding: constants.RSA_NO_PADDING }, Buffer.alloc(128, 1))).toString("hex"));
show(() => publicEncrypt(rsaPub, Buffer.alloc(200)));
show(() => publicEncrypt({ key: rsaPub, padding: constants.RSA_PKCS1_PADDING }, Buffer.alloc(118)));
show(() => privateDecrypt(rsa, Buffer.alloc(128)));
show(() => publicEncrypt(createPublicKey(pem("prime256v1.pub.pem")), hi));
show(() => privateDecrypt(rsaPub, Buffer.alloc(128)));
show(() => publicEncrypt(rsaPub, "hi").length);
show(() => publicEncrypt({ key: rsaPub, oaepHash: 1 }, hi));

/* ECDH */
show(() => ["prime256v1", "secp384r1", "secp521r1"].map((c) => getCurves().includes(c)));  /* Node's list has more: BearSSL's three */
const a = createECDH("prime256v1");
a.setPrivateKey(Buffer.alloc(32, 1));
const b = createECDH("prime256v1");
b.setPrivateKey(Buffer.alloc(32, 2));
show(() => a.getPublicKey("hex"));
show(() => a.getPublicKey("hex", "compressed"));
show(() => a.getPublicKey("base64", "hybrid"));
show(() => a.getPrivateKey("hex"));
show(() => a.getPublicKey().length);
show(() => a.computeSecret(b.getPublicKey()));
show(() => a.computeSecret(b.getPublicKey("hex", "compressed"), "hex", "base64"));
show(() => b.computeSecret(a.getPublicKey(null, "hybrid")).equals(a.computeSecret(b.getPublicKey())));
show(() => a.computeSecret(Buffer.alloc(65)));
show(() => a.computeSecret(Buffer.from("02" + "ff".repeat(32), "hex")));
show(() => ECDH.convertKey(a.getPublicKey(), "prime256v1", null, "hex", "compressed"));
show(() => ECDH.convertKey(a.getPublicKey("hex", "compressed"), "prime256v1", "hex", "hex", "uncompressed") === a.getPublicKey("hex"));
show(() => ECDH.convertKey(a.getPublicKey(), "secp999", null, "hex"));
show(() => a.getPublicKey("hex", "foo"));
show(() => createECDH("foo"));
show(() => createECDH("secp384r1").generateKeys().length);
show(() => createECDH("secp521r1").generateKeys("hex", "compressed").length);
for (const curve of ["secp384r1", "secp521r1"]) {
  const x = createECDH(curve);
  const y = createECDH(curve);
  x.generateKeys();
  y.generateKeys();
  console.log(curve, x.computeSecret(y.getPublicKey(null, "compressed")).equals(y.computeSecret(x.getPublicKey())),
    ECDH.convertKey(ECDH.convertKey(x.getPublicKey(), curve, null, null, "compressed"), curve, null, "hex") === x.getPublicKey("hex"));
}
show(() => new ECDH("prime256v1").getPrivateKey());
show(() => ECDH("prime256v1") instanceof ECDH);

/* diffieHellman */
const ec = createPrivateKey(pem("prime256v1.pem"));
const x25519 = createPrivateKey(pem("x25519.pem"));
show(() => diffieHellman({ privateKey: ec, publicKey: createPublicKey(pem("prime256v1.pub.pem")) }));
show(() => diffieHellman({ privateKey: x25519, publicKey: createPublicKey(x25519) }));
show(() => diffieHellman({ privateKey: x25519, publicKey: x25519 }));
show(() => diffieHellman({ privateKey: x25519, publicKey: createPublicKey(ec) }));
show(() => diffieHellman({ privateKey: rsa, publicKey: rsaPub }));
show(() => diffieHellman({ privateKey: createPublicKey(ec), publicKey: ec }));
show(() => diffieHellman({ privateKey: "x", publicKey: ec }));
show(() => diffieHellman());
const p1 = generateKeyPairSync("x25519");
const p2 = generateKeyPairSync("x25519");
show(() => diffieHellman({ privateKey: p1.privateKey, publicKey: p2.publicKey }).equals(diffieHellman({ privateKey: p2.privateKey, publicKey: p1.publicKey })));
const e1 = generateKeyPairSync("ec", { namedCurve: "P-384" });
const e2 = generateKeyPairSync("ec", { namedCurve: "P-384" });
show(() => diffieHellman({ privateKey: e1.privateKey, publicKey: e2.publicKey }).equals(diffieHellman({ privateKey: e2.privateKey, publicKey: e1.publicKey })));

/* callbacks */
sign("sha256", m, rsa, (err, sig) => {
  console.log("sign callback", err, sig.length);
  verify("sha256", m, rsaPub, sig, (err, ok) => console.log("verify callback", err, ok));
});
