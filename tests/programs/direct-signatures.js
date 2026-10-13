// Types across functions (optimizer step 8): a function only called directly takes its
// parameters' types from its call sites and may take and return C doubles and bools. Each case
// here must still behave as JavaScript does.
"use strict";

function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
console.log(fib(20), fib(1.5), fib(-3));

/* a double-returning function that throws: the pending exception is the signal */
function checked(x) {
  if (x > 10) throw new RangeError("too big: " + x);
  return x * 2;
}
function sumChecked(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += checked(i);
  return s;
}
console.log(sumChecked(5));
try { sumChecked(20); } catch (e) { console.log(e.name, e.message); }

/* stack overflow inside an unboxed function */
function deep(n) {
  return deep(n + 1) + 1;
}
try { deep(0); } catch (e) { console.log(e.name); }

/* a bool result */
function isEven(n) {
  return n % 2 === 0;
}
let evens = 0;
for (let i = 0; i < 10; i++) if (isEven(i)) evens++;
console.log(evens, isEven(3));

/* a parameter some call sites pass a string: stays boxed */
function twice(x) {
  return x + x;
}
console.log(twice(2), twice("ab"), twice(0.5));

/* missing arguments are undefined */
function maybe(a, b) {
  return b === undefined ? a : a + b;
}
console.log(maybe(1), maybe(1, 2));

/* returns of different kinds */
function mixed(n) {
  if (n > 0) return n;
  return "none";
}
console.log(mixed(3), mixed(-1));

/* -0, NaN and Infinity cross the boundary unboxed */
function ident(x) {
  return x;
}
console.log(Object.is(ident(-0), -0), ident(NaN), ident(1 / 0), ident(2 ** 53));

/* called from a generator and an async function (their frames stay boxed) */
function* gen(n) {
  for (let i = 0; i < n; i++) yield checked(i) + ident(0.5);
}
console.log([...gen(4)]);
async function run() {
  await null;
  try { return checked(3) + checked(100); } catch (e) { return e.message; }
}
run().then((v) => console.log("async", v));

/* a function that escapes (its object is made): its parameters stay unknown */
function scale(x) {
  return x * 3;
}
console.log([1, 2].map(scale), scale(2));

/* rest parameters and arguments past the declared ones */
function first(a, ...rest) {
  return a + rest.length;
}
console.log(first(1, 2, 3), first(10));

/* a recursive pair */
function isOdd(n) {
  return n === 0 ? false : isEvenR(n - 1);
}
function isEvenR(n) {
  return n === 0 ? true : isOdd(n - 1);
}
console.log(isOdd(7), isEvenR(7));

/* thrown from a loop inside try / finally */
function guarded(n) {
  let out = 0;
  try {
    for (let i = 0; i < n; i++) out += checked(i);
  } catch (e) {
    out = -1;
  } finally {
    out += 0.25;
  }
  return out;
}
console.log(guarded(5), guarded(50));
