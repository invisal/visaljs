// "use static" string reads: units at indices proven in the string, from a view taken on entry
// (a flat Latin-1 or UTF-16 string, a slice) or not (a rope not yet flattened), and reads that
// aren't proven (NaN past the end).
import { codeSum, notUpper, readsPastEnd } from "./typed-strings/lib.ts";

const rope = "Hello, ".repeat(3) + String(Date.now()).slice(0, 0) + "World";
console.log(codeSum("abc"), codeSum("café"), codeSum("日本語"), codeSum(""), codeSum(rope), codeSum("xxabcxx".slice(2, 5)));
console.log(readsPastEnd("abc"), readsPastEnd(""), readsPastEnd(rope));
console.log(notUpper("Hello World"), notUpper("ÀB"), notUpper(rope));
