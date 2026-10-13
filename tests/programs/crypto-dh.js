// Finite-field Diffie-Hellman and primes: the MODP groups, createDiffieHellman with a
// prime or a generated one, known answers from fixed private keys, verifyError, the public key
// checks, 'dh' KeyObjects (DER both ways, diffieHellman()), generatePrime and checkPrime.
import crypto, { createHash } from "node:crypto";

const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const show = (f) => {
  try {
    const r = f();
    console.log(r);
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};

/* the groups */
for (const name of ["modp1", "modp2", "modp5", "modp14", "modp15", "modp16", "modp17", "modp18"]) {
  const g = crypto.getDiffieHellman(name);
  console.log(name, g.getPrime().length, sha(g.getPrime()), g.getGenerator("hex"), g.verifyError, g.constructor.name, typeof g.setPrivateKey);
}
show(() => crypto.getDiffieHellman("modp99"));
show(() => crypto.createDiffieHellmanGroup("modp14").getPrime("base64").slice(0, 20));

/* known answers: fixed private keys */
const alice = crypto.createDiffieHellman(crypto.getDiffieHellman("modp14").getPrime(), 2);
const bob = crypto.createDiffieHellman(crypto.getDiffieHellman("modp14").getPrime("hex"), "hex", Buffer.from([2]));
console.log(alice.verifyError, bob.verifyError, alice.constructor.name);
alice.setPrivateKey(Buffer.from("0123456789abcdef0123456789abcdef", "hex"));
bob.setPrivateKey("fedcba9876543210", "hex");
show(() => alice.getPublicKey());
console.log("alice public", sha(alice.generateKeys()), alice.getPrivateKey("hex"));
console.log("bob public", sha(bob.generateKeys("hex")));
const s1 = alice.computeSecret(bob.getPublicKey());
const s2 = bob.computeSecret(alice.getPublicKey("base64"), "base64", "hex");
console.log("secret", s1.length, sha(s1), s1.toString("hex") === s2);

/* random keys on a group */
const g1 = crypto.getDiffieHellman("modp14"), g2 = crypto.getDiffieHellman("modp14");
g1.generateKeys();
g2.generateKeys();
console.log(g1.computeSecret(g2.getPublicKey()).equals(g2.computeSecret(g1.getPublicKey())), g1.getPrivateKey().length <= 29, g1.getPublicKey().length <= 256);

/* the peer's key */
show(() => g1.computeSecret(Buffer.from([1])));
show(() => g1.computeSecret(Buffer.alloc(0)));
show(() => g1.computeSecret(g1.getPrime()));
show(() => g1.computeSecret(Buffer.from(BigInt("0x" + g1.getPrime("hex")) - 1n === 0n ? "" : (BigInt("0x" + g1.getPrime("hex")) - 1n).toString(16), "hex")));

/* verifyError for given parameters */
console.log(crypto.createDiffieHellman(Buffer.from("ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd1", "hex")).verifyError);
console.log(crypto.createDiffieHellman(Buffer.from("17", "hex"), 2).verifyError, crypto.createDiffieHellman(Buffer.from([23]), Buffer.from([5])).verifyError);
console.log(crypto.createDiffieHellman(crypto.getDiffieHellman("modp5").getPrime()).verifyError);
const notSafe = crypto.generatePrimeSync(512, { bigint: false });
console.log(crypto.createDiffieHellman(Buffer.from(notSafe), 2).verifyError & 2 ? "not safe" : "safe");
show(() => crypto.createDiffieHellman(23, 5));
show(() => crypto.createDiffieHellman("not a key", "foo").verifyError);
show(() => crypto.createDiffieHellman({}));

/* generated parameters */
const gen = crypto.createDiffieHellman(512);
console.log(gen.getPrime().length, gen.getGenerator("hex"), gen.verifyError, crypto.checkPrimeSync(gen.getPrime()),
  crypto.checkPrimeSync(Buffer.from((BigInt("0x" + gen.getPrime("hex")) >> 1n).toString(16).padStart(128, "0"), "hex")));

/* 'dh' KeyObjects */
const k1 = crypto.generateKeyPairSync("dh", { group: "modp14" });
const k2 = crypto.generateKeyPairSync("dh", { group: "modp14" });
console.log(k1.privateKey.asymmetricKeyType, k1.publicKey.asymmetricKeyDetails, k1.publicKey.type);
const spki = k1.publicKey.export({ type: "spki", format: "der" });
const pkcs8 = k1.privateKey.export({ type: "pkcs8", format: "der" });
/* (the lengths in front vary with the keys; Node can't read DH SPKI: OpenSSL 3's decoders) */
console.log(spki.length <= 553, spki.subarray(4, 40).toString("hex"), pkcs8.subarray(4, 40).toString("hex"));
console.log(crypto.createPrivateKey(k1.privateKey.export({ type: "pkcs8", format: "pem" })).equals(k1.privateKey));
const a = crypto.diffieHellman({ privateKey: k1.privateKey, publicKey: k2.publicKey });
const b = crypto.diffieHellman({ privateKey: k2.privateKey, publicKey: k1.publicKey });
console.log("stateless", a.length, a.equals(b));
show(() => crypto.diffieHellman({ privateKey: k1.privateKey, publicKey: crypto.generateKeyPairSync("x25519").publicKey }));
show(() => k1.publicKey.export({ format: "jwk" }));
show(() => crypto.generateKeyPairSync("dh", { group: "modp14", prime: Buffer.from([7]) }));
show(() => crypto.generateKeyPairSync("dh", {}));
const withPrime = crypto.generateKeyPairSync("dh", { prime: crypto.getDiffieHellman("modp5").getPrime(), generator: 2 });
console.log(withPrime.publicKey.export({ type: "spki", format: "der" }).length > 200);

/* primes */
const p1 = crypto.generatePrimeSync(64);
console.log(p1 instanceof ArrayBuffer, p1.byteLength, crypto.checkPrimeSync(p1));
const p2 = crypto.generatePrimeSync(32, { bigint: true });
console.log(typeof p2, p2 < 2n ** 32n, p2 >= 2n ** 31n, crypto.checkPrimeSync(p2));
const safe = crypto.generatePrimeSync(32, { safe: true, bigint: true });
console.log(crypto.checkPrimeSync(safe), crypto.checkPrimeSync((safe - 1n) / 2n));
const withRem = crypto.generatePrimeSync(32, { add: 12n, rem: 11n, bigint: true });
console.log(withRem % 12n);
console.log([2n, 3n, 4n, 97n, 91n, 7919n, 7921n, 2n ** 61n - 1n, 2n ** 64n + 1n].map((n) => crypto.checkPrimeSync(n)).join(" "));
console.log(crypto.checkPrimeSync(Buffer.from([0x7f]), { checks: 10 }), crypto.checkPrimeSync(new Uint8Array([1, 1])));
show(() => crypto.generatePrimeSync(0));
show(() => crypto.generatePrimeSync(8, { add: 1024n }));
show(() => crypto.generatePrimeSync(32, { add: 12n, rem: 13n }));
show(() => crypto.checkPrimeSync(-1n));
show(() => crypto.checkPrimeSync("7"));
await new Promise((resolve) => crypto.generatePrime(48, { bigint: true }, (err, p) => {
  console.log("async", err, typeof p, crypto.checkPrimeSync(p));
  crypto.checkPrime(p, (err2, ok) => {
    console.log("async check", err2, ok);
    resolve();
  });
}));
