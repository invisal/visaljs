// visaljs-expected: by hand
// "use static" classes: fields, a constructor, methods and `this`, a class shared between static
// files, generic classes, instances passed to functions. They are nominal (only `new Vec` makes a
// Vec) and their instances stay in the unit. Node's output but for C's integers (an i32[] field
// wraps: 2147483647 + 1 is -2147483648; an int parameter, field or method result divides as an
// integer: 7 / 2 is 3; an int field holds 2 for 2.9) and a
// field read before it was set, or written before its declaration defined it: a TypeError, where
// Node reads undefined (or writes the field early); a method's argument of another type than
// it declares is a TypeError too, where Node computes with it.
import { boxed, castArgument, counted, early, earlyWrite, halved, histogram, isVec, late, measured, methodOfNull, popEmpty, stack, tally, walk } from "./typed-classes/lib.ts";

console.log(walk(10), stack(100), counted(5));
console.log(histogram(10));
console.log(halved(7), halved(-7), boxed(20), isVec(1), isVec(0), measured(3));
console.log(tally(5), tally(-9));
for (const f of [() => late(1), popEmpty, early, earlyWrite, methodOfNull, castArgument])
  try { console.log(f()); } catch (e) { console.log(e.constructor.name, e.message); }
