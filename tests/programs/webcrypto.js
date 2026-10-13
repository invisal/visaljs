// Web Crypto: the crypto global, getRandomValues, randomUUID and subtle.digest, with
// Node's errors and attributes.
const show = async (f) => {
  try {
    console.log(await f());
  } catch (e) {
    console.log(`${e.name} [${e.code}]: ${e.message}`);
  }
};

console.log(crypto, crypto.subtle, Object.prototype.toString.call(crypto), Object.prototype.toString.call(crypto.subtle));
console.log(crypto instanceof Crypto, crypto.subtle instanceof SubtleCrypto, crypto.subtle === crypto.subtle);
const d = Object.getOwnPropertyDescriptor(globalThis, "crypto");
console.log(typeof d.get, d.set, d.enumerable, d.configurable);
console.log(Object.getOwnPropertyDescriptor(globalThis, "Crypto").enumerable, Object.getOwnPropertyNames(Crypto.prototype));
console.log(Object.getOwnPropertyDescriptor(Crypto.prototype, "getRandomValues").enumerable, Object.getOwnPropertyDescriptor(Crypto.prototype, "subtle").enumerable);
await show(() => new Crypto());
await show(() => new SubtleCrypto());

/* getRandomValues */
for (const T of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array]) {
  const a = new T(4);
  console.log(T.name, crypto.getRandomValues(a) === a, a.length);
}
const many = crypto.getRandomValues(new Uint8Array(1024));
console.log(many.some((b) => b !== 0), crypto.getRandomValues(new Uint8Array(65536)).length);
await show(() => crypto.getRandomValues(new Float32Array(2)));
await show(() => crypto.getRandomValues(new Float64Array(2)));
await show(() => crypto.getRandomValues(new DataView(new ArrayBuffer(2))));
await show(() => crypto.getRandomValues(new Uint8Array(65537)));
await show(() => crypto.getRandomValues({}));
await show(() => crypto.getRandomValues());
await show(() => crypto.getRandomValues.call({}, new Uint8Array(2)));
console.log(crypto.getRandomValues(Buffer.alloc(3)) instanceof Buffer);

/* randomUUID */
const uuids = new Set();
for (let i = 0; i < 100; i++) uuids.add(crypto.randomUUID());
console.log(uuids.size, [...uuids].every((u) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u)));
await show(() => crypto.randomUUID.call({}));

/* subtle.digest */
const hex = (b) => Buffer.from(b).toString("hex");
const data = new TextEncoder().encode("abc");
for (const alg of ["SHA-1", "SHA-256", "SHA-384", "SHA-512", "sha-256", { name: "SHA-512" }]) {
  const r = await crypto.subtle.digest(alg, data);
  console.log(JSON.stringify(alg), r instanceof ArrayBuffer, hex(r));
}
console.log(hex(await crypto.subtle.digest("SHA-256", data.buffer)), hex(await crypto.subtle.digest("SHA-256", new DataView(data.buffer))));
console.log(hex(await crypto.subtle.digest("SHA-256", new Uint32Array([1, 2]))), hex(await crypto.subtle.digest("SHA-1", new ArrayBuffer(0))));
console.log(crypto.subtle.digest("SHA-256", data) instanceof Promise);
await show(() => crypto.subtle.digest("SHA-3", data));
await show(() => crypto.subtle.digest("SHA-224", data));
await show(() => crypto.subtle.digest("SHA-256", "abc"));
await show(() => crypto.subtle.digest());
await show(() => crypto.subtle.digest("SHA-256"));
await show(() => crypto.subtle.digest({}, data));
await show(() => crypto.subtle.digest(1, data));
await show(() => crypto.subtle.digest.call({}, "SHA-256", data));
const rejected = crypto.subtle.digest("nope", data);
console.log(rejected instanceof Promise);
await rejected.catch((e) => console.log("rejected:", e.name));
