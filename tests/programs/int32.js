// Int32s (optimizer step 7): values proven int32 are C int32_t. Loop counters only when their
// bound keeps i + 1 in range; every other case must still overflow into doubles as JS does.
"use strict";

/* i < b with b an int32: i + 1 can't pass 2^31 - 1 */
function upTo(from, to) {
  let n = 0, last = 0;
  for (let i = from; i < to; i++) {
    n++;
    last = i;
  }
  return [n, last];
}
console.log(upTo(0, 5), upTo(2147483640, 2147483647), upTo(-3, -1), upTo(5, 0));

/* i <= 2^31 - 1: not provable, i reaches 2^31 */
let wide = 0;
for (let i = 2147483645; i <= 2147483647; i++) wide = i + 1;
console.log(wide);

/* counting down to the bottom of the range */
function downTo(from, to) {
  let last = 0;
  for (let i = from; i > to; i--) last = i - 1;
  return last;
}
console.log(downTo(-2147483643, -2147483648), downTo(3, 0));

/* i += 1 and 1 + i */
let s = 0;
for (let i = 0; i < 10; i += 1) s += i;
for (let i = 0; i < 10; i = 1 + i) s += i;
console.log(s);

/* bitwise results, mixed with doubles */
function mix(a, b) {
  return [a | 0, a & b, a ^ b, ~a, a << 3, a >> 1, a >>> 1, (a | 0) + 0.5, (a & b) * 2 ** 31, (a << 30) + (a << 30)];
}
console.log(mix(7, 3), mix(-1, 255), mix(2 ** 31 + 5, 1), mix(-0, 0), mix(1.9, -1.9), mix(NaN, Infinity));

/* a hash loop: int32 all the way */
function hash(n) {
  let h = 0;
  for (let i = 0; i < n; i++) h = (h * 31 + i) | 0;
  return h;
}
console.log(hash(1000), hash(100000));

/* int32 compared with doubles */
function cmp(n) {
  let below = 0;
  for (let i = 0; i < n; i++) if (i < 2.5 || i === 3.0 || i >= 1e10) below++;
  return below;
}
console.log(cmp(10));

/* an int32 parameter from some call sites, a double from another */
function half(x) {
  return x / 2;
}
console.log(half(7), half(-3), half(0.5), half(2147483647));

/* an int32 return value */
function low(x) {
  return x & 0xff;
}
let lows = 0;
for (let i = 0; i < 1000; i++) lows += low(i * 7);
console.log(lows, low(-1), low(2 ** 32 + 3));

/* -0 is never an int32 */
function negZero(x) {
  return x * -1;
}
console.log(Object.is(negZero(0), -0), Object.is(0 | -0, 0), 1 / (-0 >> 0));

/* an int32 index */
const arr = [10, 20, 30, 40];
let total = 0;
for (let i = 0; i < 4; i++) total += arr[i] + arr[i ^ 1];
console.log(total);

/* int32 phis across a catch */
function caught(n) {
  let k = 0;
  for (let i = 0; i < n; i++) {
    try {
      if (i === 3) throw new Error("x");
      k = k | (1 << i);
    } catch (e) {
      k = k ^ 0x100;
    }
  }
  return k;
}
console.log(caught(6));
