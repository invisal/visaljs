// "use visaljs" files: a typed unit the program's JavaScript calls into (prototype). Checked
// entries take the plain JS copy for arguments of other types; int arithmetic stays in range here,
// where its C semantics and JavaScript's agree.
import { add, callCount, isToken, norm, sieve, triangle } from "./typed-units/lib.ts";
import { fromOther } from "./typed-units/other.js";

console.log(add(1, 2), JSON.stringify(fromOther()), callCount());
console.log(add("1", 2), add(1), isToken("Content-Type"), isToken("bad header"), isToken(42));
console.log(sieve(100000), sieve(2), triangle(1000));
const v = new Float64Array([3, 4, 12]);
console.log(norm(v, 3), norm(v, 2), norm([3, 4], 2), norm(v, 5));
