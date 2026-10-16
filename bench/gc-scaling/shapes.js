// SIZE live objects of SIZE different layouts (20 property names, a different subset each) while
// short-lived objects churn: the cost a young collection pays for shapes and their transitions.
const size = Number(process.env.SIZE || 100_000);
const keep = [];
for (let i = 1; i <= size; i++) {
  const o = {};
  for (let b = 0; b < 20; b++) if ((i >> b) & 1) o["p" + b] = b;
  keep.push(o);
}
let sum = 0;
for (let r = 0; r < 3_000_000; r++) {
  const tmp = { a: r, b: [r, r + 1], c: { d: r } };
  sum += tmp.b[1] + tmp.c.d;
}
console.log(sum, keep.length);
