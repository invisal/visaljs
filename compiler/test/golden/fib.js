function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
let total = 0;
for (let i = 0; i < 10; i++) {
  if (i % 2 === 0) continue;
  total += fib(i);
}
print(total);
