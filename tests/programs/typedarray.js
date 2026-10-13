// Typed arrays (§23.2): every element type, conversions on store, views sharing a buffer,
// the prototype methods, species, resizable buffers, and how console.log prints them.
const t = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(`${e.constructor.name}: ${e.message}`);
  }
};

// Conversions on store: wrapping, clamping, rounding to the element type
const values = [0, 1.5, -1.5, 255.5, 256, -129, 2 ** 31, NaN, Infinity, -0];
for (const C of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]) {
  console.log(C.name.padEnd(17), C.BYTES_PER_ELEMENT, Array.from(new C(values)).join(" "));
}
console.log(Uint8ClampedArray.from([0.5, 1.5, 2.5, 3.5, 254.5, -0.5]).join(" "));

// Views of one buffer see each other's writes, in the platform's byte order
const buffer = new ArrayBuffer(8);
const bytes = new Uint8Array(buffer);
const words = new Uint16Array(buffer, 2, 2);
const floats = new Float32Array(buffer, 4);
words[0] = 0x1234;
floats[0] = 1;
console.log(bytes, words, floats, words.byteOffset, words.byteLength, floats.length);
console.log(new DataView(buffer).getUint16(2, true).toString(16), bytes.buffer === buffer);

// Construction from arrays, iterables, array-likes and other typed arrays
console.log(new Int16Array([1, 2, 3]), new Float64Array(new Set([0.5, 1.5])), new Uint8Array({ length: 3, 0: 7, 2: 9 }));
console.log(new Int8Array(new Uint16Array([255, 256, 257])), new Float32Array(2), Int32Array.of(1, -2), Float64Array.from("123", Number));

// Indices are exotic: out-of-range writes vanish, numeric-string keys are never properties
const u = new Uint8Array(2);
u[5] = 1;
u[-1] = 1;
u["1.5"] = 1;
u.label = "x";
console.log(u[5], u[-1], u["1.5"], "1" in u, "2" in u, "-0" in u, Object.keys(u), u);
console.log(Object.getOwnPropertyDescriptor(u, 0), delete u.label, Reflect.deleteProperty(u, 0), Reflect.set(u, 9, 1));

// Prototype methods
const a = new Int32Array([5, 1, 4, 2, 3]);
console.log(a.at(-1), a.includes(4), a.indexOf(2), a.lastIndexOf(9), a.join("|"), a.toString(), String(a));
console.log(a.map((x) => x * 10), a.filter((x) => x % 2), a.reduce((s, x) => s + x), a.reduceRight((s, x) => s + "," + x, ""));
console.log(a.find((x) => x > 3), a.findIndex((x) => x > 3), a.findLast((x) => x > 3), a.findLastIndex((x) => x > 30));
console.log(a.every((x) => x > 0), a.some((x) => x > 4), [...a.entries()].join(" "), [...a.keys()], [...a]);
console.log(a.slice(1, 3), a.subarray(1, 3), a.toSorted(), a.toReversed(), a.with(0, 9), a);
console.log(new Float64Array([3, NaN, -0, 0, -Infinity, 1]).sort(), a.sort((x, y) => y - x));
const sub = a.subarray(1, 4);
sub.fill(0);
console.log(a, sub, sub.byteOffset);
a.set([7, 8], 3);
a.set(new Uint8Array([1, 2]));
console.log(a, a.copyWithin(0, 3), a.reverse());
const forEach = [];
a.forEach((x, i, self) => forEach.push(`${i}:${x}:${self === a}`));
console.log(forEach.join(" "));

// Species and subclasses
class Vector extends Float64Array {
  sum() {
    return this.reduce((s, x) => s + x, 0);
  }
}
const v = Vector.from([1, 2, 3]);
console.log(v, v.sum(), v.map((x) => x * 2) instanceof Vector, v.slice(1).sum(), v.subarray(1) instanceof Vector);

// Resizable buffers: length-tracking views follow resizes; fixed ones go out of bounds
const rab = new ArrayBuffer(4, { maxByteLength: 16 });
const tracking = new Uint8Array(rab);
const fixed = new Uint8Array(rab, 0, 4);
rab.resize(8);
tracking[7] = 7;
console.log(tracking.length, fixed.length, tracking);
rab.resize(2);
console.log(tracking.length, fixed.length, fixed.byteLength, fixed.byteOffset, fixed);
t(() => fixed.fill(1));
const detached = new Uint8Array(4);
detached.buffer.transfer();
console.log(detached.length, detached[0], detached);
t(() => detached.map((x) => x));

// console.log
console.log(new Uint16Array(30), [new Uint8Array(2)], { f: new Float32Array([0.1]) }, new Float64Array([1.5, -0, NaN]));
console.log(new Int8Array(120));

// errors
t(() => new (Object.getPrototypeOf(Int8Array))());
t(() => Uint8Array(1));
t(() => new Uint8Array(-1));
t(() => new Int32Array(new ArrayBuffer(8), 1));
t(() => new Int32Array(new ArrayBuffer(7)));
t(() => new Int32Array(new ArrayBuffer(8), 4, 2));
t(() => Object.getPrototypeOf(Int8Array).prototype.fill.call([], 1));
t(() => new Uint8Array(2).with(5, 1));
t(() => new Uint8Array(2).set([1, 2, 3]));
t(() => new Uint8Array(2).sort(1));
t(() => Object.defineProperty(new Uint8Array(1), 5, { value: 1 }));
t(() => Object.freeze(new Uint8Array(1)));
t(() => {
  "use strict";
  delete new Uint8Array(1)[0];
});
