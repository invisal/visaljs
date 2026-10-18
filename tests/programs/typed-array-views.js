// Typed arrays a function makes and only indexes (the typed-arrays pass): each access checks the
// index against the view taken after `new`, and everything else must still behave as the spec says.
"use strict";
function bytes(n) {
  const a = new Uint8Array(n);
  const out = [];
  a[0] = 255; a[1] = 256; a[2] = -1; a[3] = 3.7; a[4] = "7"; a[5] = { valueOf: () => 9 };
  a[n] = 1;                                   // past the end: ignored
  a[-1] = 1; a[1.5] = 1;                      // not indexes: ignored on a typed array
  out.push(a[0], a[1], a[2], a[3], a[4], a[5], a[n], a[-1], a[1.5], a[-0]);
  return out.join(",");
}
function signed() {
  const a = new Int8Array(4), b = new Int32Array(4);
  for (let i = 0; i < 4; i++) { a[i] = 126 + i; b[i] = 2147483646 + i; }
  return [...Array(4).keys()].map((i) => a[i] + ":" + b[i]).join(",");
}
function doubles(n) {
  const f = new Float64Array(n);
  for (let i = 0; i < n; i++) f[i] = i / 3;
  f[1] = NaN; f[2] = -0;
  let s = 0;
  for (let i = 0; i < n; i++) if (f[i] === f[i]) s += f[i];
  return [s.toFixed(6), Object.is(f[2], -0), f[n] === undefined].join(",");
}
function sieve(n) {
  const composite = new Uint8Array(n + 1);
  let count = 0;
  for (let i = 2; i <= n; i++) {
    if (composite[i] === 0) {
      count++;
      for (let j = i * i; j <= n; j += i) composite[j] = 1;
    }
  }
  return count;
}
console.log(bytes(8));
console.log(signed());
console.log(doubles(10));
console.log(sieve(100000));
// a constructor that isn't the built-in any more: the view is empty, everything generic
const Real = Uint8Array;
globalThis.Uint8Array = function (n) { return { length: n, 0: "not a typed array" }; };
console.log(bytes(8));
globalThis.Uint8Array = Real;
