// node:util/types and util.types: each check against values of every kind, including ones whose
// Symbol.toStringTag or prototype lies, subclasses, proxies and boxed primitives.
import util from "node:util";
import utilTypes from "node:util/types";
import * as types from "node:util/types";
import { createSecretKey, webcrypto } from "node:crypto";

console.log(util.types === utilTypes, utilTypes === types.default);
console.log(Object.keys(util.types).join(" "));
console.log(types.isDate === util.types.isDate);

class MyDate extends Date {}
class MyMap extends Map {}
const fakeDate = { [Symbol.toStringTag]: "Date" };
Object.setPrototypeOf(fakeDate, Date.prototype);
const map = new Map([[1, 2]]);
const set = new Set([1]);
function* gen() {}
async function* agen() {}
const key = createSecretKey(Buffer.from("k"));
const cryptoKey = await webcrypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", false, ["encrypt"]);

const values = {
  "undefined": undefined,
  "null": null,
  "number": 1,
  "string": "s",
  "object": {},
  "array": [],
  "date": new Date(0),
  "MyDate": new MyDate(0),
  "fake date": fakeDate,
  "arguments": (function () { return arguments; })(1),
  "strict arguments": (function () { "use strict"; return arguments; })(),
  "Number(1)": new Number(1),
  "String": new String("a"),
  "Boolean": new Boolean(false),
  "Object(Symbol)": Object(Symbol("s")),
  "Object(1n)": Object(1n),
  "Error": new Error("e"),
  "TypeError": new TypeError("e"),
  "fake error": Object.create(Error.prototype),
  "RegExp": /a/g,
  "function": function () {},
  "arrow": () => {},
  "class": class {},
  "async function": async function () {},
  "async arrow": async () => {},
  "generator function": gen,
  "async generator function": agen,
  "generator": gen(),
  "async generator": agen(),
  "Promise": Promise.resolve(1),
  "thenable": { then() {} },
  "Map": map,
  "MyMap": new MyMap(),
  "Set": set,
  "map iterator": map.entries(),
  "map keys": map.keys(),
  "set iterator": set.values(),
  "array iterator": [].values(),
  "WeakMap": new WeakMap(),
  "WeakSet": new WeakSet(),
  "ArrayBuffer": new ArrayBuffer(2),
  "DataView": new DataView(new ArrayBuffer(2)),
  "Uint8Array": new Uint8Array(2),
  "Buffer": Buffer.from("a"),
  "Uint8ClampedArray": new Uint8ClampedArray(1),
  "Int8Array": new Int8Array(1),
  "Int16Array": new Int16Array(1),
  "Uint16Array": new Uint16Array(1),
  "Int32Array": new Int32Array(1),
  "Uint32Array": new Uint32Array(1),
  "Float32Array": new Float32Array(1),
  "Float64Array": new Float64Array(1),
  "BigInt64Array": new BigInt64Array(1),
  "BigUint64Array": new BigUint64Array(1),
  "Proxy of object": new Proxy({}, {}),
  "Proxy of Date": new Proxy(new Date(), {}),
  "Proxy of function": new Proxy(function () {}, {}),
  "KeyObject": key,
  "CryptoKey": cryptoKey,
  "fake KeyObject": { type: "secret" },
};

for (const check of Object.keys(util.types)) {
  const yes = Object.entries(values).filter(([, v]) => util.types[check](v)).map(([k]) => k);
  console.log(check + ": " + (yes.join(", ") || "-"));
}
