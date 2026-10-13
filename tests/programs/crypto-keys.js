// node:crypto's keys: KeyObject for secret, RSA, RSA-PSS, EC and X25519 keys; PEM,
// DER (pkcs1, spki, pkcs8, sec1) and JWK in and out; their details; KeyObject and CryptoKey;
// generateKey and generateKeyPair.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import crypto, { createPrivateKey, createPublicKey, createSecretKey, generateKey, generateKeyPair, generateKeyPairSync, generateKeySync, KeyObject } from "node:crypto";

const show = (f) => {
  try {
    const r = f();
    console.log(r instanceof ArrayBuffer ? "ArrayBuffer " + Buffer.from(r).toString("hex") : r);
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};
const pem = (name) => readFileSync(join(import.meta.dirname, "data", "keys", name), "utf8");
const hex = (b) => Buffer.from(b).toString("hex");

/* secret keys */
const sk = createSecretKey(Buffer.from("0123456789abcdef"));
console.log(sk, sk.type, sk.symmetricKeySize, sk.asymmetricKeyType, sk.asymmetricKeyDetails);
show(() => sk.export());
show(() => sk.export({ format: "jwk" }));
show(() => sk.export({ format: "buffer" }));
show(() => sk.export({ format: "pem" }));
show(() => sk.equals(createSecretKey(Buffer.from("0123456789abcdef"))));
show(() => sk.equals(createSecretKey(Buffer.from("0123456789abcdeF"))));
show(() => sk.equals(1));
show(() => createSecretKey("abc", "utf8").export().toString());
show(() => createSecretKey("616263", "hex").export().toString());
show(() => createSecretKey(1));
show(() => Object.getOwnPropertyNames(KeyObject.prototype));
show(() => Object.getOwnPropertyNames(Object.getPrototypeOf(sk)));
show(() => [Object.getPrototypeOf(sk).constructor.name, sk instanceof KeyObject]);
show(() => new KeyObject("secret", {}));
show(() => KeyObject.from(1));
show(() => crypto.createHmac("sha256", sk).update("x").digest("hex"));
show(() => crypto.createCipheriv("aes-128-cbc", sk, Buffer.alloc(16)).final("hex"));
show(() => crypto.hkdfSync("sha256", sk, "s", "i", 8));

/* asymmetric keys: every format in and out */
for (const name of ["rsa", "pss", "pss0", "prime256v1", "secp384r1", "secp521r1", "x25519"]) {
  const priv = createPrivateKey(pem(name + ".pem"));
  const pub = createPublicKey(priv);
  console.log(name, priv.type, priv.asymmetricKeyType, priv.asymmetricKeyDetails, pub.type, pub.asymmetricKeyType, pub.symmetricKeySize);
  console.log(priv);
  console.log(pub.export({ format: "pem", type: "spki" }));
  console.log(priv.export({ format: "pem", type: "pkcs8" }) === pem(name + ".pem"));
  show(() => hex(pub.export({ format: "der", type: "spki" })));
  show(() => hex(priv.export({ format: "der", type: "pkcs8" })));
  show(() => priv.export({ format: "pem", type: "pkcs1" }));
  show(() => pub.export({ format: "pem", type: "pkcs1" }));
  show(() => priv.export({ format: "pem", type: "sec1" }));
  show(() => priv.export({ format: "jwk" }));
  show(() => pub.export({ format: "jwk" }));
  show(() => priv.export());
  show(() => priv.export({ format: "pem" }));
  show(() => priv.export({ format: "pem", type: "spki" }));
  show(() => pub.export({ format: "pem", type: "pkcs8" }));
  /* back in, from every form */
  const again = [
    () => createPrivateKey({ key: priv.export({ format: "der", type: "pkcs8" }), format: "der", type: "pkcs8" }),
    () => createPrivateKey({ key: priv.export({ format: "jwk" }), format: "jwk" }),
    () => createPublicKey({ key: pub.export({ format: "der", type: "spki" }), format: "der", type: "spki" }),
    () => createPublicKey({ key: pub.export({ format: "jwk" }), format: "jwk" }),
    () => createPublicKey(pub.export({ format: "pem", type: "spki" })),
    () => createPublicKey(pem(name + ".pem")),
    () => createPublicKey({ key: Buffer.from(pem(name + ".pem")), format: "pem" }),
  ];
  for (const f of again) show(() => { const k = f(); return [k.type, k.equals(k.type === "private" ? priv : pub)]; });
  show(() => priv.equals(pub));
  show(() => pub.equals(createPublicKey(pub)));
}

/* the RSA and EC forms only they have */
const rsa = createPrivateKey(pem("rsa.pem"));
const pkcs1 = rsa.export({ format: "pem", type: "pkcs1" });
show(() => createPrivateKey(pkcs1).equals(rsa));
show(() => createPrivateKey({ key: rsa.export({ format: "der", type: "pkcs1" }), format: "der", type: "pkcs1" }).equals(rsa));
show(() => createPublicKey(createPublicKey(rsa).export({ format: "pem", type: "pkcs1" })).export({ format: "pem", type: "spki" }) === pem("rsa.pub.pem"));
show(() => createPublicKey({ key: createPublicKey(rsa).export({ format: "der", type: "pkcs1" }), format: "der", type: "pkcs1" }).asymmetricKeyType);
const ec = createPrivateKey(pem("prime256v1.pem"));
const sec1 = ec.export({ format: "pem", type: "sec1" });
console.log(sec1);
show(() => createPrivateKey(sec1).equals(ec));
show(() => createPrivateKey({ key: ec.export({ format: "der", type: "sec1" }), format: "der", type: "sec1" }).equals(ec));
show(() => createPublicKey(sec1).export({ format: "pem", type: "spki" }) === pem("prime256v1.pub.pem"));

/* errors */
show(() => createPrivateKey("not a key"));
show(() => createPublicKey("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n"));
show(() => createPrivateKey(pem("rsa.pub.pem")));
show(() => createPrivateKey({ key: Buffer.alloc(10), format: "der", type: "pkcs8" }));
show(() => createPrivateKey({ key: Buffer.alloc(10), format: "der" }));
show(() => createPrivateKey({ key: "x", format: "foo" }));
show(() => createPrivateKey({ key: {}, format: "jwk" }));
show(() => createPrivateKey({ key: { kty: "RSA", n: "AQAB", e: "AQAB" }, format: "jwk" }));
show(() => createPublicKey({ key: { kty: "EC", crv: "P-999", x: "AA", y: "AA" }, format: "jwk" }));
show(() => createPublicKey(1));
show(() => createPublicKey(sk));
show(() => createPrivateKey(createPublicKey(rsa)));
show(() => rsa.export({ format: "foo" }));
show(() => rsa.export({ format: "pem", type: "foo" }));
show(() => createPublicKey(rsa).export({ format: "der" }));

/* KeyObject and CryptoKey */
const ck = await crypto.subtle.importKey("raw", Buffer.alloc(16, 1), "AES-CBC", true, ["encrypt"]);
show(() => { const k = KeyObject.from(ck); return [k.type, k.symmetricKeySize, hex(k.export())]; });
show(() => sk.toCryptoKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]));
show(() => sk.toCryptoKey("AES-GCM", false, ["encrypt"]).algorithm);

/* generateKey */
show(() => generateKeySync("hmac", { length: 64 }).symmetricKeySize);
show(() => generateKeySync("aes", { length: 128 }).symmetricKeySize);
show(() => generateKeySync("aes", { length: 100 }));
show(() => generateKeySync("hmac", { length: 7 }));
show(() => generateKeySync("foo", { length: 7 }));
show(() => generateKeySync("hmac"));

/* generateKeyPair: the keys, and their encodings */
for (const [type, options] of [
  ["rsa", { modulusLength: 512 }],
  ["rsa", { modulusLength: 1024, publicExponent: 3 }],
  ["rsa-pss", { modulusLength: 512, hashAlgorithm: "sha256", mgf1HashAlgorithm: "sha1", saltLength: 20 }],
  ["ec", { namedCurve: "P-256" }],
  ["ec", { namedCurve: "secp521r1" }],
  ["x25519", {}],
]) {
  const { publicKey, privateKey } = generateKeyPairSync(type, options);
  console.log(type, publicKey.asymmetricKeyType, publicKey.asymmetricKeyDetails, privateKey.type, createPublicKey(privateKey).equals(publicKey));
}
show(() => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "sec1", format: "der" },
  });
  return [typeof publicKey, publicKey.split("\n")[0], Buffer.isBuffer(privateKey)];
});
show(() => generateKeyPairSync("rsa", { modulusLength: 512, publicKeyEncoding: { format: "jwk" } }).publicKey.kty);
show(() => generateKeyPairSync("rsa", {}));
show(() => generateKeyPairSync("rsa", { modulusLength: 100 }));
show(() => generateKeyPairSync("ec", { namedCurve: "foo" }));
show(() => generateKeyPairSync("ec"));
show(() => generateKeyPairSync("foo"));
generateKeyPair("ec", { namedCurve: "P-384" }, (err, pub, priv) => {
  console.log("generateKeyPair callback", err, pub.asymmetricKeyDetails, priv.type);
  generateKey("aes", { length: 256 }, (err, key) => console.log("generateKey callback", err, key.symmetricKeySize));
});
