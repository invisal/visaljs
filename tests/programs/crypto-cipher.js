// node:crypto's ciphers: every cipher, its modes' chunking and padding, the AEAD
// tags, getCiphers and getCipherInfo, and Node's errors.
import crypto, { createCipheriv, createDecipheriv, getCipherInfo, getCiphers } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const show = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};
const key = Buffer.alloc(32, 1);
const iv = Buffer.alloc(16, 2);
const msg = Buffer.alloc(37);
for (let i = 0; i < 37; i++) msg[i] = (i * 7 + 3) & 255;

/* every cipher BearSSL backs (Node's list has more: ARIA, Camellia, SM4, OCB, XTS), in two updates, and back */
const CIPHERS = ["aes-128-cbc", "aes-128-ccm", "aes-128-cfb", "aes-128-cfb1", "aes-128-cfb8", "aes-128-ctr", "aes-128-ecb", "aes-128-gcm", "aes-128-ofb", "aes-192-cbc", "aes-192-ccm", "aes-192-cfb", "aes-192-cfb1", "aes-192-cfb8", "aes-192-ctr", "aes-192-ecb", "aes-192-gcm", "aes-192-ofb", "aes-256-cbc", "aes-256-ccm", "aes-256-cfb", "aes-256-cfb1", "aes-256-cfb8", "aes-256-ctr", "aes-256-ecb", "aes-256-gcm", "aes-256-ofb", "aes128", "aes128-wrap", "aes128-wrap-pad", "aes192", "aes192-wrap", "aes192-wrap-pad", "aes256", "aes256-wrap", "aes256-wrap-pad", "chacha20", "chacha20-poly1305", "des-ede", "des-ede-cbc", "des-ede-cfb", "des-ede-ecb", "des-ede-ofb", "des-ede3", "des-ede3-cbc", "des-ede3-cfb", "des-ede3-cfb1", "des-ede3-cfb8", "des-ede3-ecb", "des-ede3-ofb", "des3", "id-aes128-CCM", "id-aes128-GCM", "id-aes128-wrap", "id-aes128-wrap-pad", "id-aes192-CCM", "id-aes192-GCM", "id-aes192-wrap", "id-aes192-wrap-pad", "id-aes256-CCM", "id-aes256-GCM", "id-aes256-wrap", "id-aes256-wrap-pad"];
console.log(CIPHERS.every((n) => getCiphers().includes(n)), getCiphers().includes("aes-256-gcm"));
for (const name of CIPHERS) {
  const info = getCipherInfo(name);
  const n = info.mode === "wrap" ? (info.ivLength === 8 ? 32 : 13) : 37;
  const options = info.mode === "ccm" ? { authTagLength: 16 } : undefined;
  const ivFor = info.ivLength ? iv.subarray(0, info.ivLength) : null;
  const aead = info.mode === "gcm" || info.mode === "ccm" || name === "chacha20-poly1305";
  const once = info.mode === "ccm" || info.mode === "wrap";
  const e = createCipheriv(name, key.subarray(0, info.keyLength), ivFor, options);
  if (aead) e.setAAD(Buffer.from("aad"), { plaintextLength: n });
  const parts = once ? [e.update(msg.subarray(0, n))] : [e.update(msg.subarray(0, 20)), e.update(msg.subarray(20, n))];
  const out = Buffer.concat([...parts, e.final()]);
  const tag = aead ? e.getAuthTag() : null;
  const d = createDecipheriv(name, key.subarray(0, info.keyLength), ivFor, options);
  if (tag) d.setAuthTag(tag);
  if (aead) d.setAAD(Buffer.from("aad"), { plaintextLength: n });
  const back = Buffer.concat([d.update(out), d.final()]);
  console.log(name, out.toString("hex"), tag ? tag.toString("hex") : "", back.equals(msg.subarray(0, n)));
}

/* getCipherInfo */
for (const n of ["aes-256-gcm", "aes128", "AES-128-CBC", "id-aes256-GCM", "aes-128-ecb", "chacha20", "chacha20-poly1305", "des3", "aes128-wrap-pad", 427, 896, "foo", 1])
  console.log(JSON.stringify(n), getCipherInfo(n));
show(() => getCipherInfo({}));
show(() => getCipherInfo(1.5));
show(() => getCipherInfo("aes-128-cbc", 1));

/* encodings: a StringDecoder keeps base64 groups and characters whole */
show(() => {
  const e = createCipheriv("aes-128-cbc", "0123456789abcdef", "0123456789abcdef");
  return e.update("hello world", "utf8", "base64") + "|" + e.final("base64");
});
show(() => {
  const e = createCipheriv("aes-128-ctr", "0123456789abcdef", "0123456789abcdef");
  return [e.update("abcd", "utf8", "base64"), e.update("e", "utf8", "base64"), e.final("base64")];
});
show(() => {
  const e = createCipheriv("aes-128-ctr", "0123456789abcdef", "0123456789abcdef");
  return [e.update("abcd", "latin1", "hex"), e.update("6566", "hex", "hex"), e.final("hex")];
});
show(() => {
  const e = createCipheriv("aes-128-ctr", "0123456789abcdef", "0123456789abcdef");
  return e.update("abc", "utf8", "foo");
});
show(() => {
  const e = createCipheriv("aes-128-ctr", "0123456789abcdef", "0123456789abcdef");
  e.update("abc", "utf8", "hex");
  return e.final("base64");
});
show(() => createCipheriv("aes-128-cbc", "6162636465666768696a6b6c6d6e6f70", iv, { encoding: "hex" }).final("hex"));
show(() => createCipheriv("aes-128-ctr", key.subarray(0, 16), Buffer.from("ffffffffffffffffffffffffffffffff", "hex")).update(Buffer.alloc(40)).toString("hex"));

/* chunking and padding */
show(() => {
  const e = createCipheriv("aes-128-cbc", key.subarray(0, 16), iv);
  return [e.update(Buffer.alloc(10)).length, e.update(Buffer.alloc(10)).length, e.final().length];
});
show(() => {
  const d = createDecipheriv("aes-128-cbc", key.subarray(0, 16), iv);
  return [d.update(Buffer.alloc(16)).length, d.update(Buffer.alloc(16)).length];
});
show(() => {
  const e = createCipheriv("aes-256-cbc", key, iv);
  e.setAutoPadding(false);
  e.update("abc");
  return e.final();
});
show(() => {
  const e = createCipheriv("aes-256-cbc", key, iv);
  e.setAutoPadding(false);
  return Buffer.concat([e.update(Buffer.alloc(32)), e.final()]).toString("hex");
});
show(() => {
  const d = createDecipheriv("aes-256-cbc", key, iv);
  d.update(Buffer.alloc(16));
  return d.final();
});
show(() => {
  const d = createDecipheriv("aes-128-cbc", key.subarray(0, 16), iv);
  d.setAutoPadding(false);
  return d.update(Buffer.alloc(20)).length + " " + d.final().length;
});

/* GCM */
const nonce = Buffer.alloc(12);
const g = createCipheriv("aes-128-gcm", key.subarray(0, 16), nonce);
g.setAAD(Buffer.from("x"));
const gct = Buffer.concat([g.update("hello"), g.final()]);
const gtag = g.getAuthTag();
console.log(gct.toString("hex"), gtag.toString("hex"));
const gcm = (opts, f) => show(() => {
  const d = createDecipheriv("aes-128-gcm", key.subarray(0, 16), nonce, opts);
  return f(d);
});
gcm(undefined, (d) => (d.setAAD(Buffer.from("x")), d.setAuthTag(gtag), d.update(gct).toString() + d.final().length));
gcm(undefined, (d) => {
  d.setAAD(Buffer.from("x"));
  const u = d.update(gct).toString();
  d.setAuthTag(gtag);
  return u + d.final().length;
});
gcm(undefined, (d) => (d.setAAD(Buffer.from("x")), d.setAuthTag(gtag.subarray(0, 12)), d.update(gct).toString() + d.final().length));
gcm(undefined, (d) => (d.setAAD(Buffer.from("y")), d.setAuthTag(gtag), d.update(gct), d.final()));
gcm(undefined, (d) => (d.update(Buffer.from("aa", "hex")), d.final()));
gcm(undefined, (d) => d.setAuthTag(Buffer.alloc(3)));
gcm(undefined, (d) => (d.setAuthTag(Buffer.alloc(16)), d.setAuthTag(Buffer.alloc(16))));
gcm({ authTagLength: 8 }, (d) => d.setAuthTag(Buffer.alloc(16)));
gcm({ authTagLength: 12 }, (d) => (d.setAAD(Buffer.from("x")), d.setAuthTag(gtag.subarray(0, 12)), d.update(gct).toString() + d.final().length));
show(() => {
  const e = createCipheriv("aes-256-gcm", key, Buffer.alloc(12), { authTagLength: 4 });
  e.final();
  return e.getAuthTag().toString("hex");
});
show(() => createCipheriv("aes-256-gcm", key, Buffer.alloc(12), { authTagLength: 5 }));
show(() => createCipheriv("aes-256-gcm", key, Buffer.alloc(12), { authTagLength: 17 }));
show(() => createCipheriv("aes-256-gcm", key, Buffer.alloc(12), { authTagLength: "a" }));
show(() => createCipheriv("aes-256-gcm", key, Buffer.alloc(0)));
show(() => {
  const e = createCipheriv("aes-256-gcm", key, Buffer.alloc(12));
  return e.getAuthTag();
});
show(() => {
  const e = createCipheriv("aes-256-gcm", key, Buffer.alloc(12));
  e.setAAD(Buffer.from("aad"));
  e.update("x");
  return e.setAAD(Buffer.from("a"));
});
for (const n of [1, 8, 16, 64]) {
  show(() => {
    const e = createCipheriv("aes-128-gcm", key.subarray(0, 16), Buffer.alloc(n));
    return n + " " + e.update("x").toString("hex") + e.final("hex") + e.getAuthTag().toString("hex");
  });
}

/* CCM */
const k16 = key.subarray(0, 16);
const ccmE = createCipheriv("aes-128-ccm", k16, nonce, { authTagLength: 8 });
ccmE.setAAD(Buffer.from("a"), { plaintextLength: 5 });
const cct = ccmE.update("hello");
ccmE.final();
const ctag = ccmE.getAuthTag();
console.log(cct.toString("hex"), ctag.toString("hex"));
const ccm = (f) => show(() => f(createDecipheriv("aes-128-ccm", k16, nonce, { authTagLength: 8 })));
ccm((d) => (d.setAuthTag(ctag), d.setAAD(Buffer.from("a"), { plaintextLength: 5 }), d.update(cct).toString() + "|" + d.final().length));
ccm((d) => (d.setAuthTag(Buffer.alloc(8)), d.setAAD(Buffer.from("a"), { plaintextLength: 5 }), d.update(cct).length + "|" + d.final().length));
ccm((d) => (d.setAAD(Buffer.from("a"), { plaintextLength: 5 }), d.update(cct)));
ccm((d) => (d.setAuthTag(ctag), d.update(cct)));
show(() => {
  const e = createCipheriv("aes-128-ccm", k16, nonce, { authTagLength: 16 });
  const ct = e.update("hi");
  e.final();
  return ct.toString("hex") + e.getAuthTag().toString("hex");
});
show(() => {
  const e = createCipheriv("aes-128-ccm", k16, nonce, { authTagLength: 16 });
  e.update("hi");
  return e.update("x");
});
show(() => createCipheriv("aes-128-ccm", k16, nonce, { authTagLength: 16 }).setAAD(Buffer.from("a")));
show(() => createCipheriv("aes-128-ccm", k16, Buffer.alloc(14), { authTagLength: 16 }));
show(() => createCipheriv("aes-128-ccm", k16, nonce, { authTagLength: 3 }));
show(() => createCipheriv("aes-128-ccm", k16, nonce));
show(() => {
  const e = createCipheriv("aes-128-ccm", k16, nonce, { authTagLength: 8 });
  e.setAAD(Buffer.from("a"), { plaintextLength: 5 });
  return e.update("hell");
});
show(() => createCipheriv("aes-128-ccm", k16, nonce, { authTagLength: 8 }).final());
show(() => createCipheriv("aes-128-ccm", k16, Buffer.alloc(7), { authTagLength: 4 }).update("x").toString("hex"));
show(() => createCipheriv("aes-128-ccm", k16, Buffer.alloc(13), { authTagLength: 16 }).update(Buffer.alloc(70000)).length);

/* ChaCha20 and ChaCha20-Poly1305 */
const ch = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
ch.setAAD(Buffer.from("aad"));
const chct = Buffer.concat([ch.update("hello world"), ch.final()]);
const chtag = ch.getAuthTag();
console.log(chct.toString("hex"), chtag.toString("hex"));
show(() => {
  const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  d.setAAD(Buffer.from("aaX"));
  d.setAuthTag(chtag);
  return d.update(chct).toString() + d.final().length;
});
show(() => createDecipheriv("chacha20-poly1305", key, nonce).setAuthTag(chtag.subarray(0, 8)));
show(() => createCipheriv("chacha20-poly1305", key, Buffer.alloc(8)));
show(() => createCipheriv("chacha20", key, Buffer.alloc(12)));
show(() => {
  const e = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 8 });
  e.final();
  return e.getAuthTag().length;
});
show(() => createCipheriv("chacha20", key, Buffer.from("0100000000000000000000000000000a", "hex")).update(Buffer.alloc(70)).toString("hex"));

/* key wrap */
const wiv = Buffer.from("a6a6a6a6a6a6a6a6", "hex");
show(() => {
  const e = createCipheriv("aes128-wrap", k16, wiv);
  return [e.update(Buffer.alloc(16)).toString("hex"), e.update(Buffer.alloc(24)).toString("hex"), e.final("hex")];
});
show(() => createCipheriv("aes128-wrap", k16, wiv).update(Buffer.alloc(15)));
show(() => createCipheriv("aes128-wrap", k16, wiv).update(Buffer.alloc(8)));
show(() => createCipheriv("aes128-wrap", k16, null));
show(() => createDecipheriv("aes128-wrap", k16, wiv).update(Buffer.from("ee1a1573da6ac5d535a9112baa169ef94c6cd39dfb9a7114", "hex")).toString("hex"));
show(() => createDecipheriv("aes128-wrap", k16, wiv).update(Buffer.from("ff1a1573da6ac5d535a9112baa169ef94c6cd39dfb9a7114", "hex")));
const piv = Buffer.from("a65959a6", "hex");
show(() => {
  const e = createCipheriv("aes128-wrap-pad", k16, piv);
  return [e.update(Buffer.alloc(5)).toString("hex"), e.update(Buffer.alloc(9)).toString("hex"), e.final("hex")];
});
show(() => createDecipheriv("aes128-wrap-pad", k16, piv).update(Buffer.from("4ace56f99987a53187b5a9fe6749d12d", "hex")).toString("hex"));

/* errors and states */
show(() => createCipheriv("aes-256-cbc", key.subarray(1), iv));
show(() => createCipheriv("aes-256-cbc", key, iv.subarray(1)));
show(() => createCipheriv("aes-256-cbc", key, null));
show(() => createCipheriv("foo", key, iv));
show(() => createCipheriv("aes-256-cbc", key));
show(() => createCipheriv("aes-256-ecb", key, null).final("hex"));
show(() => createCipheriv("aes-256-ecb", key, Buffer.alloc(0)).final("hex"));
show(() => createCipheriv("aes-256-ecb", key, iv));
show(() => createCipheriv("aes-128-cbc", 1, iv));
show(() => createCipheriv(1, key, iv));
show(() => createCipheriv("aes-128-cbc", new Uint8Array(16).buffer, iv).final("hex"));
show(() => {
  const e = createCipheriv("aes-256-cbc", key, iv);
  e.final();
  return e.final();
});
show(() => {
  const e = createCipheriv("aes-256-cbc", key, iv);
  e.final();
  return e.update("a");
});
show(() => {
  const e = createCipheriv("aes-256-cbc", key, iv);
  e.final();
  return e.setAutoPadding(false);
});
show(() => createCipheriv("aes-256-cbc", key, iv).setAAD(Buffer.alloc(1)));
show(() => createCipheriv("aes-256-cbc", key, iv).getAuthTag());
show(() => createDecipheriv("aes-256-cbc", key, iv).setAuthTag(Buffer.alloc(16)));
show(() => createCipheriv("aes-128-cbc", k16, iv).update(new Uint16Array([1, 2, 3])));
show(() => createCipheriv("aes-128-cbc", k16, iv).update(1));
show(() => createCipheriv("aes-128-cbc", k16, iv).update("zz", "hex"));
show(() => createCipheriv("aes-128-cbc", k16, iv).update("abc", "hex"));
show(() => crypto.Cipheriv("aes-128-cbc", k16, iv) instanceof crypto.Cipheriv);
show(() => createDecipheriv("aes-128-cbc", k16, iv) instanceof crypto.Decipheriv);
show(() => Object.getOwnPropertyNames(crypto.Cipheriv.prototype));
show(() => Object.getOwnPropertyNames(crypto.Decipheriv.prototype));
show(() => typeof createDecipheriv("aes-128-gcm", k16, nonce).getAuthTag);

/* a cipher is a stream */
const sc = createCipheriv("aes-128-cbc", k16, iv);
const chunks = [];
sc.on("data", (c) => chunks.push(c));
sc.on("end", () => console.log("stream", Buffer.concat(chunks).toString("hex")));
sc.write("hello ");
sc.end("stream");

/* node:string_decoder */
const sd = new StringDecoder("utf8");
console.log(JSON.stringify([sd.write(Buffer.from([0xe2, 0x82])), sd.write(Buffer.from([0xac, 0x41])), sd.end(Buffer.from([0xe2]))]));
const sd16 = new StringDecoder("utf16le");
console.log(JSON.stringify([sd16.write(Buffer.from([0x61, 0x00, 0x3d])), sd16.write(Buffer.from([0xd8, 0x00])), sd16.end(Buffer.from([0xde]))]));
const sd64 = new StringDecoder("base64");
console.log(JSON.stringify([sd64.write(Buffer.from("ab")), sd64.write(Buffer.from("cde")), sd64.end()]), sd64.encoding);
show(() => new StringDecoder("foo"));
console.log(new StringDecoder().encoding, new StringDecoder("UTF-16LE").encoding, new StringDecoder("binary").encoding, new StringDecoder("hex").write(Buffer.from("hi")));

/* last: Node's (OpenSSL's) failed key length check stays queued, and a later error reports it */
show(() => getCipherInfo("aes-128-cbc", { keyLength: 16 }));
show(() => getCipherInfo("aes-128-cbc", { keyLength: 32 }));
show(() => getCipherInfo("aes-128-gcm", { ivLength: 16 }));
show(() => getCipherInfo("aes-128-ccm", { ivLength: 14 }));
show(() => getCipherInfo("aes-128-cbc", { ivLength: 12 }));
