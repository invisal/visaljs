// node:crypto's key derivation: pbkdf2, hkdf and scrypt, as Node gives them.
import { hkdf, hkdfSync, pbkdf2, pbkdf2Sync, scrypt, scryptSync } from "node:crypto";

const show = (f) => {
  try {
    const r = f();
    console.log(r instanceof ArrayBuffer ? "ArrayBuffer " + Buffer.from(r).toString("hex") : r);
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};

/* PBKDF2: every hash, and the RFC 6070 vectors */
for (const digest of ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-256", "sha3-256", "sha3-512", "RSA-SHA256"]) {
  console.log("pbkdf2", digest, pbkdf2Sync("password", "salt", 3, 40, digest).toString("hex"));
}
show(() => pbkdf2Sync("password", "salt", 4096, 20, "sha1").toString("hex"));
show(() => pbkdf2Sync("passwordPASSWORDpassword", "saltSALTsaltSALTsaltSALTsaltSALTsalt", 4096, 25, "sha1").toString("hex"));
show(() => pbkdf2Sync("pass\0word", "sa\0lt", 4096, 16, "sha1").toString("hex"));
show(() => pbkdf2Sync(Buffer.from("pw"), new Uint8Array([1, 2, 3]).buffer, 1, 8, "sha256").toString("hex"));
show(() => pbkdf2Sync(new DataView(new ArrayBuffer(2)), new Uint16Array([1, 2]), 1, 8, "sha256").toString("hex"));
show(() => pbkdf2Sync("pw", "salt", 1, 20));
show(() => pbkdf2Sync("pw", "salt", 1, 20, "foo"));
show(() => pbkdf2Sync("pw", "salt", 0, 20, "sha1"));
show(() => pbkdf2Sync("pw", "salt", 1, -1, "sha1"));
show(() => pbkdf2Sync(1, "salt", 1, 1, "sha1"));
show(() => pbkdf2Sync("pw", 1, 1, 1, "sha1"));
show(() => pbkdf2Sync("pw", "s", 1.5, 1, "sha1"));
show(() => pbkdf2Sync("pw", "s", "1", 1, "sha1"));
show(() => pbkdf2Sync("pw", "s", 1, 0, "sha1"));
show(() => pbkdf2Sync("pw", "s", 1, 1, "shake256"));
show(() => pbkdf2("pw", "s", 1, 1, "sha1"));
show(() => pbkdf2("pw", "s", 1, 1, "foo", () => {}));

/* HKDF: the RFC 5869 vector, and Node's checks */
const ikm = Buffer.from("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "hex");
show(() => hkdfSync("sha256", ikm, Buffer.from("000102030405060708090a0b0c", "hex"), Buffer.from("f0f1f2f3f4f5f6f7f8f9", "hex"), 42));
for (const digest of ["sha1", "sha256", "sha384", "sha512", "sha3-256", "md5"]) show(() => hkdfSync(digest, "key", "salt", "info", 50));
show(() => hkdfSync("sha256", "key", "", "", 16));
show(() => hkdfSync("sha256", "", "salt", "info", 16));
show(() => Buffer.from(hkdfSync("sha256", "key", "salt", "info", 255 * 32)).length);
show(() => hkdfSync("sha256", "key", "salt", "info", 255 * 32 + 1));
show(() => hkdfSync("foo", "key", "salt", "info", 16));
show(() => hkdfSync("sha256", 1, "salt", "info", 16));
show(() => hkdfSync("sha256", "key", 1, "info", 16));
show(() => hkdfSync("sha256", "key", "s", 1, 16));
show(() => hkdfSync("sha256", "key", "s", "i".repeat(1025), 16));
show(() => hkdfSync("sha256", "k", "s", "i", 0));
show(() => hkdfSync("sha256", "k", "s", "i", -1));
show(() => hkdfSync("sha256", "k", "s", "i", 1.5));
show(() => hkdfSync(1, "k", "s", "i", 1));
show(() => hkdf("sha256", "k", "s", "i", 4));

/* scrypt: the RFC 7914 vectors (the small ones), options and Node's checks */
show(() => scryptSync("", "", 64, { N: 16, r: 1, p: 1 }).toString("hex"));
show(() => scryptSync("password", "NaCl", 64, { N: 1024, r: 8, p: 16 }).toString("hex"));
show(() => scryptSync("pw", "salt", 16).toString("hex"));
show(() => scryptSync("pw", "salt", 16, { cost: 1024, blockSize: 8, parallelization: 2 }).toString("hex"));
show(() => scryptSync("pw", "salt", 16, { N: 0, r: 0, p: 0, maxmem: 0 }).toString("hex"));
show(() => scryptSync("pw", "salt", 0));
show(() => scryptSync("pw", "salt", 16, 1).toString("hex"));
show(() => scryptSync("pw", "salt", 16, { N: 1000 }));
show(() => scryptSync("pw", "salt", 16, { N: 1 }));
show(() => scryptSync("pw", "salt", 16, { N: 1024, cost: 1024 }));
show(() => scryptSync("pw", "salt", 16, { r: 1, blockSize: 1 }));
show(() => scryptSync("pw", "salt", 16, { p: 1, parallelization: 1 }));
show(() => scryptSync("pw", "salt", 16, { N: 2 ** 20 }));
show(() => scryptSync("pw", "salt", 16, { N: 2 ** 16, r: 1 }));
show(() => scryptSync("pw", "salt", 16, { N: 1024, maxmem: 1024 }));
show(() => scryptSync("pw", "salt", 16, { N: -1 }));
show(() => scryptSync("pw", "salt", 16, { N: "a" }));
show(() => scryptSync("pw", "salt", 16, { maxmem: -1 }));
show(() => scryptSync("pw", "salt", -1));
show(() => scryptSync(1, "salt", 16));
show(() => scrypt("pw", "salt", 16));

/* callbacks, one at a time */
pbkdf2("pw", "salt", 2, 10, "sha256", (e, k) => {
  console.log("pbkdf2 callback", e, k);
  hkdf("sha256", "k", "s", "i", 4, (e, k) => {
    console.log("hkdf callback", e, k);
    scrypt("pw", "salt", 8, (e, k) => {
      console.log("scrypt callback", e, k);
      scrypt("pw", "salt", 8, { N: 16 }, (e, k) => {
        console.log("scrypt options callback", e, k);
        pbkdf2("pw", "s", 1, 0, "sha1", (e) => console.log("pbkdf2 error callback", e.message));
      });
    });
  });
});
