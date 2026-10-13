// Function objects: a constructor with a prototype method, a named expression,
// a sloppy function using `this`, and calls direct and generic.
function Point(x) {
  this.x = x;
}
Point.prototype.get = function () {
  return this.x;
};
var fact = function f(n) {
  return n <= 1 ? 1 : n * f(n - 1);
};
print(new Point(fact(3)).get());
