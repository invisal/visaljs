// a[i] / a[i] = v with a Number index (get_index / set_index): the inline dense-array path and
// every case that must leave it.
"use strict";

function sum(a, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i];
  return s;
}
function fill(a, n, v) {
  for (let i = 0; i < n; i++) a[i] = v + i;
  return a;
}
function read(a, i) {
  return a[+i];
}
function write(a, i, v) {
  a[+i] = v;
  return a;
}

console.log(sum([1, 2, 3, 4], 4));
console.log(sum([1, 2, 3, 4], 6));            // past the length: undefined, NaN
console.log(fill(new Array(3), 3, 10));       // holes: created, not stored inline
console.log(fill([], 3, 0));                  // appends
console.log(fill([1, 2, 3], 2, 7));

const holes = [1, , 3];
Array.prototype[1] = "proto";                 // a hole reads the prototype
console.log(read(holes, 1), read(holes, 0));
delete Array.prototype[1];
console.log(read(holes, 1));

console.log(read([5, 6], -1), read([5, 6], 0.5), read([5, 6], -0), read([5, 6], 1.0));
console.log(read([5, 6], NaN), read([5, 6], Infinity), read([5, 6], 2 ** 32));
const big = [];
big[2 ** 31] = "far";                         // sparse
console.log(read(big, 2 ** 31), read(big, 0));

console.log(read({ 0: "obj", 1.5: "frac" }, 0), read({ 1.5: "frac" }, 1.5));
console.log(read("str", 1), read("str", 5));
console.log(read(new Int32Array([7, 8]), 1), read(new Float64Array([0.25]), 0));
const args = (function () { return arguments; })(1, 2);
console.log(read(args, 1));
const proxy = new Proxy([1, 2], { get: (t, k) => (k === "1" ? "trap" : t[k]) });
console.log(read(proxy, 1), read(proxy, 0));
class MyArray extends Array {}
const mine = MyArray.from([4, 5]);
console.log(read(mine, 1), write(mine, 0, 9)[0]);

const frozen = Object.freeze([1, 2]);
try { write(frozen, 0, 9); } catch (e) { console.log(e.constructor.name); }
console.log(frozen[0]);
const readOnly = [1, 2];
Object.defineProperty(readOnly, 1, { value: 2, writable: false });
try { write(readOnly, 1, 9); } catch (e) { console.log(e.constructor.name); }
write(readOnly, 0, 9);
console.log(readOnly);

const withSetter = [0, , 2];
let seen;
Object.defineProperty(Array.prototype, 1, { set(v) { seen = v; }, configurable: true });
write(withSetter, 1, "x");                    // a hole: the prototype's setter runs
delete Array.prototype[1];                    // (before console.log, which reads arrays)
console.log(seen, withSetter.length, Object.keys(withSetter));

const shrinking = [1, 2, 3, 4];
shrinking.length = 2;
console.log(read(shrinking, 3), sum(shrinking, 4));
try { read(null, 0); } catch (e) { console.log(e.constructor.name); }
try { write(undefined, 0, 1); } catch (e) { console.log(e.constructor.name); }

// .length: an array's inline, anything else as before
function len(x) {
  return x.length;
}
console.log(len([1, 2, 3]), len([]), len(new Array(2 ** 32 - 1)), len("abcd"), len({ length: "own" }));
console.log(len(function (a, b) {}), len(mine), len(new Uint8Array(3)));
try { len(null); } catch (e) { console.log(e.constructor.name); }

// Array.prototype.fill: the dense fast path, and every case the generic loop must take
console.log(new Array(5).fill(0), [1, 2, 3, 4].fill(9, 1, -1), [1, 2].fill(7, 5), [1, 2, 3].fill(4, -2));
const sealed = Object.preventExtensions(new Array(3));
try { sealed.fill(1); } catch (e) { console.log(e.constructor.name, sealed); }
const frozenFill = Object.freeze([1, 2]);
try { frozenFill.fill(0); } catch (e) { console.log(e.constructor.name, frozenFill); }
const sparseFill = [];
sparseFill[100000] = 1;
console.log(sparseFill.fill(2, 99998).slice(99998), sparseFill.filter((x) => x === 2).length);
let hits = 0;
Object.defineProperty(Array.prototype, 2, { set() { hits++; }, configurable: true });
const viaSetter = new Array(4).fill("x");
delete Array.prototype[2];
console.log(hits, Object.keys(viaSetter));
const protoed = Object.setPrototypeOf(new Array(3), { set 1(v) { hits += 10; } });
Array.prototype.fill.call(protoed, "y");
console.log(hits, Object.keys(protoed));
console.log(MyArray.from([1, 2, 3]).fill(0), Array.prototype.fill.call({ length: 2 }, 3));

// A TypeScript flag enum: indices that double, up to 2 ** 30. Sparse once past the gap, not a
// dense store of 2 ** 30 holes (a GB).
const Flags = {};
for (let b = 0; b <= 30; b++) Flags[Flags["F" + b] = 2 ** b] = "F" + b;
console.log(Flags[1], Flags[1024], Flags[2 ** 30], Flags.F30, Object.keys(Flags).length, Object.keys(Flags).slice(29, 33));
