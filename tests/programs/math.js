// Math: an optional component, V8's fdlibm port for Node's exact results.
console.log(Math.max(1, 5, 3), Math.min(), Math.max(), Math.max(0, -0), 1 / Math.min(0, -0) === -Infinity, Math.max(1, NaN));
console.log(Math.sin(1), Math.cos(1e10), Math.tan(-3.5), Math.exp(709), Math.log(10), Math.pow(1.0000001, 1e9), 2 ** 0.5, 10 ** -2);
console.log(Math.round(-0.5), Math.round(2.5), Math.round(-2.5), Math.round(0.49999999999999994), Math.trunc(-4.7), Math.sign(-0), Math.cbrt(27), Math.hypot(3, 4), Math.hypot(1e300, 1e300), Math.hypot(), Math.hypot(NaN, Infinity));
console.log(Math.clz32(1), Math.imul(0xffffffff, 5), Math.fround(5.5), Math.fround(5.05), Math.atan2(1, -1), Math.expm1(1e-10), Math.log1p(-1));
console.log(Math.PI, Math.E, Math.SQRT2, Object.getOwnPropertyNames(Math).join(), String(Math), Math[Symbol.toStringTag]);
const r = Math.random(); console.log(r >= 0 && r < 1, typeof r, Math.abs.length, Math.max.name, Math);
