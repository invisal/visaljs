// Optimizer step 9: Number paths for operators on untyped values in loops, inline built-in calls
// (Math.*, charCodeAt, fromCharCode), global reads, object literals' inline slots and primitives'
// property reads. Each fast path must give way to the generic one when its guess is wrong.
"use strict";

/* operators in loops on values of any kind */
function fold(values) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out.push(v + 1, v - 1, v * 2, v / 2, v % 3, -v, v < 2, v <= 2, v > 2, v >= 2, v == 2, v != 2, v | 0, v & 6, v ^ 1, ~v, v << 1, v >> 1, v >>> 28);
  }
  return out;
}
const tricky = { valueOf() { return 2; } };
console.log(fold([2, 2.5, -0, NaN, "2", "x", true, null, undefined, tricky, [3], -2147483648]).map(String).join(","));
function bigs(values) {
  let s = 0n;
  for (let i = 0; i < values.length; i++) s = s + values[i] * 2n;
  return s;
}
console.log(bigs([1n, 2n, 3n]));
try { fold([1n]); } catch (e) { console.log(e.name); }
function counter(start) {
  let c = start;
  for (let i = 0; i < 3; i++) c++;
  return c;
}
console.log(counter(1), counter("1"), counter(1.5), counter(1n), String(counter(undefined)));

/* Math calls: the built-in inline, anything else the call */
function roots(values) {
  const out = [];
  for (const v of values) out.push(Math.sqrt(v), Math.abs(v), Math.floor(v), Math.ceil(v), Math.trunc(v));
  return out;
}
console.log(roots([16, -2.5, 0.5, -0, NaN, Infinity, "9", null, tricky]).map(String).join(","));
const realSqrt = Math.sqrt;
Math.sqrt = (x) => "patched " + x;
console.log(roots([4])[0]);
Math.sqrt = realSqrt;
console.log(roots([4])[0], Math.sqrt(), Math.sqrt(4, 9));
const OtherMath = { sqrt: Math.abs };
console.log(OtherMath.sqrt(-3));

/* charCodeAt and fromCharCode */
function codes(s) {
  const out = [];
  for (let i = -1; i <= s.length; i++) out.push(s.charCodeAt(i));
  out.push(s.charCodeAt(0.5), s.charCodeAt("1"), s.charCodeAt());
  return out;
}
const long = "abcdefghijklmnopqrstuvwxyz".repeat(3);
const rope = long + "ABCDEFGHIJKLMNOP";
console.log(codes("héllo"), codes("日本"), codes(rope).slice(70, 80), codes(rope.slice(20, 40)).slice(0, 4));
console.log(codes(rope).length, rope.length, rope.slice(10, 30).length);
console.log([String.fromCharCode(97), String.fromCharCode(0x65e5), String.fromCharCode(65.7), String.fromCharCode(-1).charCodeAt(0), String.fromCharCode("66"), String.fromCharCode()]);
const realCode = String.prototype.charCodeAt;
String.prototype.charCodeAt = function (i) { return "patched " + this + i; };
console.log(codes("ab")[1]);
String.prototype.charCodeAt = realCode;
console.log(codes("ab")[1], realCode.call(42, 0), [1].map.call("xy", (c) => c.charCodeAt(0)));

/* primitives' properties come from their prototypes (getters see the primitive) */
Object.defineProperty(String.prototype, "twice", { get() { return typeof this + ":" + this + this; }, configurable: true });
Object.defineProperty(Number.prototype, "half", { get() { return this / 2; }, configurable: true });
function props(values) {
  const out = [];
  for (const v of values) out.push(v.twice, v.half, v.length, v.constructor.name, v.toString());
  return out;
}
console.log(props(["ab", 4, true, "c", 8.5, Symbol.iterator.description]));
delete String.prototype.twice;
delete Number.prototype.half;
console.log(props(["ab"])[0]);

/* object literals: their properties in inline slots, whatever their number */
function point(i) {
  return { a: i, b: i + 1, c: i + 2, d: i + 3, e: i + 4, f: i + 5, g: i + 6, h: i + 7 };
}
let sum = 0;
for (let i = 0; i < 100; i++) {
  const p = point(i);
  p.h += 1;
  sum += p.a + p.e + p.h;
  if (i === 50) delete p.c;
}
const wide = {};
const big = { k0: 0, k1: 1, k2: 2, k3: 3, k4: 4, k5: 5, k6: 6, k7: 7, k8: 8, k9: 9, ...wide, k10: 10 };
console.log(sum, Object.keys(point(0)).join(""), JSON.stringify(big));

/* global reads */
globalThis.later = 5;
let seen = 0;
for (let i = 0; i < 3; i++) seen += later + Math.PI;
Object.defineProperty(globalThis, "computed", { get() { return seen; }, configurable: true });
console.log(seen.toFixed(3), computed === seen, typeof notDefinedAnywhere);
try { for (let i = 0; i < 2; i++) seen += missingGlobal; } catch (e) { console.log(e.name, e.message); }
