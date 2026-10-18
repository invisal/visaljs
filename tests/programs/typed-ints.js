// visaljs-expected: by hand
// "use visaljs" integers have C semantics: `int` an int64_t, `i32` an int32_t; what is stored in
// one is converted (truncated toward zero, wrapped), and +, -, * wrap. The expected output is
// C's (cc of the same operations), not Node's: there the types are erased and these are doubles.
import { add32, hash32, mod, mul, mul32, sumSquares, trunc } from "./typed-ints/lib.ts";
console.log(mul(3037000500, 3037000500) === -9223372036709301616, mul(-3, 7), mul32(65536, 65536), mul32(46341, 46341), add32(2147483647, 1));
console.log(trunc(2.9), trunc(-2.9), trunc(NaN), trunc(Infinity), trunc(2 ** 53), mod(-20), mod(20));
console.log(hash32(100000), sumSquares(100000), sumSquares(3000000) > 0);
