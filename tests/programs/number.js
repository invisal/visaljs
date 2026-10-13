// visaljs-flags: --all-builtins
// Number and the global functions on numbers: the statics, toFixed/toPrecision/
// toExponential/toString(radix), toLocaleString (en-US until Intl), parseInt/parseFloat.
console.log(Object.getOwnPropertyNames(Number).join(), Object.getOwnPropertyNames(Number.prototype).join());
console.log(Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER);
console.log(Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, Object.getOwnPropertyDescriptor(Number, "EPSILON"));
console.log(Number.parseInt === parseInt, Number.parseFloat === parseFloat, parseInt.length, parseFloat.name, isNaN.length);

for (const v of [1, 1.5, -0, NaN, Infinity, "5", 2 ** 53, 2 ** 53 - 1, -(2 ** 53 - 1), 1e300, null]) {
  console.log(v, Number.isFinite(v), Number.isInteger(v), Number.isNaN(v), Number.isSafeInteger(v), isNaN(v), isFinite(v));
}

for (const s of ["  42px", "-0x1F", "0x", "0b11", "  -0", "1e3", "12.5", "", "   ", "+7", "1_000", "Infinity", "-.5e-3", "  9"]) {
  console.log(`[${s}]`, parseInt(s), parseFloat(s), parseInt(s, 16), parseInt(s, 2), parseInt(s, 37));
}
console.log(parseInt("zz", 36), parseInt("123", 4.9), parseInt("11", -0), parseInt("11", 2 ** 32 + 2), parseInt(0.0000005), parseInt(null, 36));
console.log(parseInt("900719925474099267"), parseFloat("1.7976931348623159e308"), parseFloat("5e-325"));

const xs = [0, -0, 1.005, 1.45, 123.456, -1.5, 0.000001234, 1e21, 1e-7, 2 ** 70, 25, 1 / 3];
for (const x of xs) {
  console.log(x, x.toFixed(), x.toFixed(2), x.toFixed(20), x.toPrecision(), x.toPrecision(1), x.toPrecision(4), x.toPrecision(21));
  console.log(" ", x.toExponential(), x.toExponential(0), x.toExponential(3), x.toString(2), x.toString(16), x.toString(36));
}
for (const x of [0, -0, 1.0005, 1234.5678, -1234567.891, 1e21, 1.2345678901234567e25, 0.0005, 0.0004999, 999.9996, NaN, Infinity, -Infinity, 1e-7, 2 ** 53]) {
  console.log(x, x.toLocaleString());
}
console.log(NaN.toFixed(2), Infinity.toExponential(200), (-Infinity).toPrecision(0), (1e21).toFixed(2));

const errors = [
  () => (1).toFixed(101), () => (1).toFixed(-1), () => (1).toPrecision(0), () => (1).toPrecision(101),
  () => (1).toExponential(-1), () => (1).toString(1), () => (1).toString(37),
  () => Number.prototype.toFixed.call("1"), () => Number.prototype.valueOf.call({}),
  () => Number.prototype.toString.call(true), () => parseInt(Symbol()),
];
for (const f of errors) {
  try {
    console.log(f());
  } catch (e) {
    console.log(e.constructor.name, e.message);
  }
}
console.log(Number(), Number("  12  "), Number("0b101"), Number("0o17"), Number([5]), Number(undefined), Number(null), Number(true));
console.log(typeof Number.prototype.toFixed, Number.prototype.toFixed.length, Number.prototype.toString.length, Number.prototype.toLocaleString.name);
