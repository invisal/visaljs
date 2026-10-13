// The optimizer's inline Number operators (num_*): every operand here is a proven Number, so
// each operator below compiles to its inline form. Edge cases: int32 overflow, -0, NaN,
// Infinity, the sign of %, shift counts, ToInt32 of doubles.
const show = (x) => (Object.is(x, -0) ? "-0" : String(x));
function ops(a, b) {
  const x = a * 1, y = b * 1;  // Numbers whatever a and b were: types prove it from here on
  return [x + y, x - y, x * y, x / y, x % y, -x, x < y, x <= y, x > y, x >= y, x === y, x !== y, x == y,
    x & y, x | y, x ^ y, ~x, x << y, x >> y, x >>> y].map(show).join(" ");
}
const values = [0, -0, 1, -1, 2147483647, -2147483648, 3, -7, 0.5, -2.5, 1e300, NaN, Infinity, -Infinity, 4294967296, 33];
for (const a of values) for (const b of values) console.log(show(a), show(b), "|", ops(a, b));

function counter(n) {
  let i = 2147483640, steps = 0;
  for (let k = 0; k < n; k++) { i++; steps += 2; }
  let j = -2147483640;
  for (let k = 0; k < n; k++) j--;
  return [i, j, steps, i * 2, j * -1];
}
console.log(counter(20).join(" "));

// Unboxed values (doubles, bools) across phis, a catch, -0 literals; a generator stays boxed.
function flags(n) {
  let any = false;
  for (let i = 0; i < n; i++) any = i > 3;
  return any;
}
function guarded(n) {
  let x = 0;
  try {
    for (let i = 0; i < n; i++) {
      x += 0.25;
      if (i === 5) throw new Error("stop");
    }
  } catch {
    x = -x;
  }
  return x;
}
function zeros() {
  const z = -0;
  return [-z, z * 1, 0 * -1, -(0), z - 0, 0 / -1, -1 % 1].map(show).join(" ");
}
function* running(n) {
  let s = 0;
  for (let i = 0; i < n; i++) yield (s += i * 1.5);
}
console.log(flags(2), flags(9), guarded(3), guarded(10), zeros(), [...running(4)].join(" "));
