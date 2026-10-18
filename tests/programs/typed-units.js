// visaljs-expected: by hand
// "use static" files: a typed unit the program's JavaScript calls into. An argument that isn't
// the declared type is a TypeError (ERR_INVALID_ARG_TYPE), where Node, erasing the types, runs
// the JS; int arithmetic stays in range here, where its C semantics and JavaScript's agree.
import { add, callCount, isToken, norm, scale, sieve, triangle } from "./typed-units/lib.ts";
import { fromOther } from "./typed-units/other.js";

const tryCall = (f) => {
  try {
    return f();
  } catch (e) {
    return `${e.name} ${e.code}: ${e.message}`;
  }
};

console.log(add(1, 2), JSON.stringify(fromOther()), callCount());
console.log(isToken("Content-Type"), isToken("bad header"));
for (const f of [() => add("1", 2), () => add(1), () => isToken(42), () => norm([3, 4], 2)]) console.log(tryCall(f));
console.log(sieve(100000), sieve(2), triangle(1000));
const v = new Float64Array([3, 4, 12]);
console.log(norm(v, 3), norm(v, 2), norm(v, 5));
// arguments read from a typed array: tested at the call; past the end (undefined) a TypeError
const w = new Float64Array([1.5, 2, -0.25]);
scale(w, 3, 3);
let sum = 0;
for (let i = 0; i < 3; i++) sum = add(sum, w[i]);
console.log(Array.from(w), sum, add(w[1], w[2]));
for (const f of [() => add(sum, w[3]), () => add(w[0], "x")]) console.log(tryCall(f));
