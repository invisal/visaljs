// Closures: a captured parameter and let in the function's environment, a
// per-iteration environment for `for (let …)`, and a nested read two levels up.
function counter(n) {
  let step = 1;
  return function () {
    n += step;
    return n;
  };
}
var fns = [];
for (let i = 0; i < 2; i++) fns.push(function () { return i; });
function outer(a) {
  return function () {
    return function () { return a; };
  };
}
print(counter(1)() + fns[1]() + outer(5)()());
