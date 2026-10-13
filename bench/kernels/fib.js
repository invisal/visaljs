// Recursive calls: direct calls, number arithmetic on parameters and results.
function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
console.log(fib(35));
