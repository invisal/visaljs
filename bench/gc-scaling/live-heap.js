// A live heap of SIZE megabytes, about, replaced in full while short-lived objects churn: how
// pauses grow with what is live. Young pauses should stay flat; full ones grow with SIZE.
const size = Number(process.env.SIZE || 100);
const n = Math.round(size * 5700);
const keep = [];
for (let i = 0; i < n; i++) keep.push({ id: i, name: "n" + i, tags: [i, i + 1] });
const rounds = Math.max(2 * n, 3_000_000);
const step = Math.floor(rounds / n);
let sum = 0;
for (let r = 0; r < rounds; r++) {
  const tmp = { a: r, b: [r, r * 2], c: { d: r } };
  sum += tmp.b[1] + tmp.c.d;
  if (r % step === 0) keep[(r / step) % n] = { id: r, name: "m" + r, tags: [r] };
}
console.log(sum, keep.length);
