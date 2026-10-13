// Map, Set and WeakMap churn around a live table: the collections' storage and ephemerons.
const live = new Map();
let sum = 0;
for (let i = 0; i < 2_000_000; i++) {
  live.set("k" + (i % 200_000), { i, list: [i] });
  if (i % 3 === 0) live.delete("k" + ((i * 7) % 200_000));
  sum += new Set([i, i + 1, i + 2]).size;
}
const weak = new WeakMap();
for (let i = 0; i < 500_000; i++) {
  const key = { i };
  weak.set(key, { v: i });
  if (i % 1000 === 0) sum += weak.get(key).v;
}
console.log(sum, live.size);
