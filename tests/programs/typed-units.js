// "use static" files: a typed unit the program's JavaScript calls into. Checked
// entries take the plain JS copy for arguments of other types; int arithmetic stays in range here,
// where its C semantics and JavaScript's agree.
import { add, callCount, isToken, norm, scale, sieve, triangle } from "./typed-units/lib.ts";
import { fromOther } from "./typed-units/other.js";

console.log(add(1, 2), JSON.stringify(fromOther()), callCount());
console.log(add("1", 2), add(1), isToken("Content-Type"), isToken("bad header"), isToken(42));
console.log(sieve(100000), sieve(2), triangle(1000));
const v = new Float64Array([3, 4, 12]);
console.log(norm(v, 3), norm(v, 2), norm([3, 4], 2), norm(v, 5));
// arguments read from a typed array: tested at the call, past the end (undefined) the plain JS copy
const w = new Float64Array([1.5, 2, -0.25]);
scale(w, 3, 3);
let sum = 0;
for (let i = 0; i < 4; i++) sum = add(sum, w[i]);
console.log(Array.from(w), sum, add(w[0], "x"), add(w[1], w[2]));
