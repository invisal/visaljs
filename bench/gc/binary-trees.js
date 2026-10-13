// Short-lived trees next to a long-lived one (the benchmarks game's binary-trees): allocation
// throughput, and how often the collector marks again what never changes.
function Node(left, right) { this.left = left; this.right = right; }
function make(d) { return d === 0 ? new Node(null, null) : new Node(make(d - 1), make(d - 1)); }
function check(t) { return t.left === null ? 1 : 1 + check(t.left) + check(t.right); }
const max = 18;
const long = make(max);
let total = 0;
for (let d = 4; d <= max; d += 2) {
  const iters = 1 << (max - d + 4);
  for (let i = 0; i < iters; i++) total += check(make(d));
}
console.log(total, check(long));
