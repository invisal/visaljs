// SIZE live property names (an object used as a string-keyed table) while short-lived objects
// churn: the cost a young collection pays for the atom table.
const size = Number(process.env.SIZE || 100_000);
const table = {};
for (let i = 0; i < size; i++) table["key_" + i] = i;
let sum = 0;
for (let r = 0; r < 3_000_000; r++) {
  const tmp = { a: r, b: [r, r + 1], c: { d: r } };
  sum += tmp.b[1] + tmp.c.d;
}
console.log(sum, Object.keys(table).length);
