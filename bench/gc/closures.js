// Closures and their environments: counters, partial application, array callbacks.
function counter() { let n = 0; return () => ++n; }
function adder(a) { return (b) => a + b; }
let total = 0;
for (let i = 0; i < 1_000_000; i++) {
  const c = counter();
  c();
  total += c() + adder(i)(1);
  total += [1, 2, 3].map((x) => x * i).reduce((a, b) => a + b, 0);
}
console.log(total);
