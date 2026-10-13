// A million live objects while three million short-lived ones come and go: pause times on a big
// heap, and what a young generation saves.
const keep = [];
for (let i = 0; i < 1_000_000; i++) keep.push({ id: i, name: "n" + i, tags: [i, i + 1] });
let sum = 0;
for (let r = 0; r < 3_000_000; r++) {
  const tmp = { a: r, b: [r, r * 2], c: { d: r } };
  sum += tmp.b[1] + tmp.c.d;
  if (r % 100 === 0) keep[r % keep.length] = { id: r, name: "m" + r, tags: [r] };
}
console.log(sum, keep.length);
