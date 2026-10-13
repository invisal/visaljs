// node:crypto's hashes, HMAC, random bytes and timingSafeEqual, as Node gives them.
import crypto, { createHash, createHmac, getHashes, hash, randomBytes, randomFill, randomFillSync, randomInt, randomUUID, timingSafeEqual } from "node:crypto";

const show = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};

/* every algorithm, every output encoding */
const long = "The quick brown fox jumps over the lazy dog. ".repeat(40);
for (const alg of ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "md5-sha1", "sha512-224", "sha512-256", "sha3-224", "sha3-256", "sha3-384", "sha3-512", "shake128", "shake256"]) {
  console.log(alg, createHash(alg).update("").digest("hex"), createHash(alg).update(long).digest("base64"));
  if (!alg.startsWith("shake")) console.log("hmac", alg, createHmac(alg, "key").update(long).digest("hex"), createHmac(alg, long).update("x").digest("base64url"));
}
for (const name of ["SHA256", "sha-256", "RSA-SHA256", "sha2-256", "sha256WithRSAEncryption", "SHA-512/256", "SHAKE-128", "ssl3-md5"]) console.log(name, createHash(name).update("a").digest("hex"));
for (const enc of ["hex", "base64", "base64url", "latin1", "binary", "buffer", undefined, "foo"]) show(() => createHash("sha1").update("abc").digest(enc));
show(() => createHash("sha1").update("é", "latin1").digest("hex"));
show(() => createHash("sha1").update("6162", "hex").update("Yw==", "base64").digest("hex"));
show(() => createHash("sha1").update(new Uint16Array([1, 2])).update(new DataView(new ArrayBuffer(3))).digest("hex"));
show(() => createHash("shake256", { outputLength: 8 }).update("a").digest("hex"));
show(() => createHash("shake128", { outputLength: 100 }).update("a").digest("hex"));
show(() => createHash("shake256", { outputLength: 0 }).digest("hex"));
show(() => createHash("sha256", { outputLength: 32 }).digest("hex"));

/* incremental, copies */
const h = createHash("sha256").update("one");
const c = h.copy();
h.update("two");
console.log(h.digest("hex"), c.digest("hex"));
const x = createHash("shake256").update("abc");
console.log(x.copy({ outputLength: 4 }).digest("hex"), x.digest("hex"));

/* errors */
show(() => createHash("foo"));
show(() => createHash());
show(() => createHash("sha256", { outputLength: 8 }));
show(() => createHash("shake256", { outputLength: -1 }));
show(() => createHash("shake256", { outputLength: "a" }));
show(() => createHash("sha1").update(1));
show(() => createHash("sha1").update("abc", "hex"));
show(() => {
  const d = createHash("sha1");
  d.digest();
  return d.digest();
});
show(() => {
  const d = createHash("sha1");
  d.digest();
  return d.update("x");
});
show(() => {
  const d = createHash("sha1");
  d.digest();
  return d.copy();
});
show(() => createHmac("sha1"));
show(() => createHmac("foo", "k"));
show(() => createHmac("sha1", {}));
show(() => {
  const m = createHmac("sha1", "k");
  m.digest();
  return [m.digest(), m.digest("buffer"), m.digest("hex")];
});
show(() => createHmac("sha256", Buffer.from("6b6579", "hex")).update("data").digest("hex"));
show(() => createHmac("sha256", "6b6579", { encoding: "hex" }).update("data").digest("hex"));
show(() => createHmac("sha256", new Uint8Array([1, 2, 3]).buffer).update("data").digest("hex"));

/* crypto.hash */
show(() => hash("sha1", "abc"));
show(() => hash("sha1", "abc", "base64"));
show(() => hash("sha1", "abc", "buffer"));
show(() => hash("sha512", Buffer.from("abc")));
show(() => hash("foo", "a"));
show(() => hash("sha1", "a", "foo"));
show(() => hash("sha1", 1));

/* Hash is a stream */
const s = createHash("sha256");
s.write("ab");
s.end("c");
console.log(s.read().toString("hex"));
const sm = createHmac("sha256", "k");
sm.on("data", (d) => console.log("hmac stream", d.toString("hex")));
sm.end("message");
console.log(createHash("sha1") instanceof crypto.Hash, createHmac("sha1", "k") instanceof crypto.Hmac);

/* getHashes */
console.log(getHashes().includes("sha256"), getHashes().includes("sha3-512"), getHashes().includes("shake256"));

/* random */
console.log(randomBytes(0).length, randomBytes(16).length, randomBytes(16).equals(randomBytes(16)));
show(() => randomBytes(-1));
show(() => randomBytes("1"));
show(() => randomBytes(1, 1));
show(() => randomFillSync(1));
show(() => randomFillSync(new Uint32Array(2), 1).length);
show(() => randomFillSync(new Uint32Array(2), 3));
show(() => randomFillSync(new Uint32Array(2), 1, 2));
const zeros = Buffer.alloc(8);
randomFillSync(zeros, 2, 4);
console.log(zeros[0], zeros[1], zeros[6], zeros[7]);
const ab = new ArrayBuffer(4);
console.log(randomFillSync(ab) === ab);
for (let i = 0; i < 5; i++) {
  const n = randomInt(10);
  const m = randomInt(-5, 5);
  if (n < 0 || n >= 10 || m < -5 || m >= 5 || !Number.isInteger(n)) console.log("bad randomInt", n, m);
}
show(() => randomInt(1.5));
show(() => randomInt(10, 5));
show(() => randomInt(2 ** 48 + 1));
show(() => randomInt(0, 2 ** 48 + 1));
show(() => randomUUID(1));
show(() => randomUUID({ disableEntropyCache: 1 }));
console.log(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(randomUUID({ disableEntropyCache: true })));

/* timingSafeEqual */
show(() => timingSafeEqual(Buffer.from("abc"), Buffer.from("abc")));
show(() => timingSafeEqual(Buffer.from("abc"), new Uint8Array([97, 98, 100])));
show(() => timingSafeEqual(Buffer.from("a"), Buffer.from("ab")));
show(() => timingSafeEqual("a", "b"));
show(() => timingSafeEqual(Buffer.from("a"), "b"));

/* the module */
console.log(crypto.webcrypto === globalThis.crypto, crypto.subtle === globalThis.crypto.subtle, crypto.getFips(), crypto.constants.RSA_PKCS1_OAEP_PADDING);
console.log(crypto.getRandomValues(new Uint8Array(4)).length);

/* asynchronous forms call back later (one at a time: Node's thread pool finishes them in any order) */
randomBytes(4, (err, buf) => {
  console.log("randomBytes callback", err, buf.length);
  randomFill(new Uint8Array(4), (err, buf) => {
    console.log("randomFill callback", err, buf.length);
    randomFill(new Uint8Array(4), 1, 2, (err, buf) => {
      console.log("randomFill offset callback", err, buf.length);
      randomInt(3, (err, n) => console.log("randomInt callback", err, n >= 0 && n < 3));
    });
  });
});
Promise.resolve().then(() => console.log("microtask first"));
