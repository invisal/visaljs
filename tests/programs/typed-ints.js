// visaljs-expected: by hand
// "use visaljs" integers have C semantics: `int` an int64_t, `i32` an int32_t; what is stored in
// one is converted (truncated toward zero, wrapped), +, -, * wrap, / and % are integer division
// (a zero divisor: a RangeError, as BigInt's), and the bitwise operators are 64-bit. A literal written
// as a float (1.0, 1e3) is a double, as in C: 1.0 / n divides as doubles. The expected output is
// C's (cc of the same operations), not Node's: there the types are erased and these are doubles.
import { add32, bits, div, literals, halve, hash32, minOverMinusOne, mod, mul, mul32, rem, sumSquares, trunc } from "./typed-ints/lib.ts";
console.log(mul(3037000500, 3037000500) === -9223372036709301616, mul(-3, 7), mul32(65536, 65536), mul32(46341, 46341), add32(2147483647, 1));
console.log(trunc(2.9), trunc(-2.9), trunc(NaN), trunc(Infinity), trunc(2 ** 53), mod(-20), mod(20));
console.log(hash32(100000), sumSquares(100000), sumSquares(3000000) > 0);
console.log(div(7, 2), div(-7, 2), div(7, -2), rem(-7, 2), rem(7, -2), div(1e15, 7), minOverMinusOne() < 0);
for (const f of [() => div(1, 0), () => rem(1, 0)]) try { f(); } catch (e) { console.log(e.constructor.name, e.message); }
console.log(bits(0b1100, 0b1010), bits(-5, 3));
console.log(halve(27), halve(837799));
console.log(literals(3));
