// visaljs-expected: by hand
// "use static" arrays (number[], i32[], string[], boolean[]): dense, their elements of their type.
// Reading or writing past the end is a RangeError (a write at the length appends), and what an
// i32[] stores is wrapped to an int32. Node erases the types: it prints undefined, holes, doubles.
import { digits, evens, grows, inserted, readPastEnd, sumSquares, words, wraps, writePastEnd } from "./typed-arrays/lib.ts";

console.log(sumSquares(1000), wraps(), grows(1000));
console.log(words("the quick brown fox"), words(""), evens(11), inserted());
console.log(digits(90210), Array.isArray(digits(7)));
for (const f of [() => readPastEnd(3), () => readPastEnd(-1), () => readPastEnd(0.5), () => writePastEnd(4)])
  try { console.log(f()); } catch (e) { console.log(e.constructor.name, e.message); }
console.log(readPastEnd(2), writePastEnd(3));
