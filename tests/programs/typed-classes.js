// visaljs-expected: by hand
// "use static" classes: fields, a constructor, methods and `this`, a class shared between static
// files, generic classes. They are nominal (only `new Vec` makes a Vec) and their instances stay
// in the unit. Node's output but for C's integers: an i32[] field wraps (2147483647 + 1 is
// -2147483648) and an int parameter divides as an integer (7 / 2 is 3).
import { boxed, counted, halved, histogram, isVec, stack, walk } from "./typed-classes/lib.ts";

console.log(walk(10), stack(100), counted(5));
console.log(histogram(10));
console.log(halved(7), halved(-7), boxed(20), isVec(1), isVec(0));
