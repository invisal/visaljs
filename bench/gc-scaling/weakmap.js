// SIZE live WeakMap entries while short-lived objects churn: the cost a young collection pays
// for ephemerons.
const size = Number(process.env.SIZE || 100_000);
const keys = [];
const map = new WeakMap();
for (let i = 0; i < size; i++) {
  const k = { i };
  keys.push(k);
  map.set(k, [i]);
}
let sum = 0;
for (let r = 0; r < 3_000_000; r++) {
  const tmp = { a: r, b: [r, r + 1], c: { d: r } };
  sum += tmp.b[1] + tmp.c.d;
}
console.log(sum, map.get(keys[size - 1])[0]);
