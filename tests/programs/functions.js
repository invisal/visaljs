// visaljs-flags: --script
// Function values: expressions, methods, constructors, this, names, callbacks.
function Point(x, y) { this.x = x; this.y = y; }
Point.prototype.sum = function () { return this.x + this.y; };
var p = new Point(3, 4);
print(p.sum() + " " + (p instanceof Point) + " " + Point.name + " " + Point.length);
var add = function (a, b) { return a + b; };
print(add(1, 2) + " " + add.name);
var obj = { k: 10, get: function () { return this.k; }, m() { return this.k * 2; } };
print(obj.get() + " " + obj.m() + " " + obj.m.name + " " + obj.get.name);
var fact = function f(n) { return n <= 1 ? 1 : n * f(n - 1); };
print(fact(5) + " " + fact.name);
function apply(fn, v) { return fn(v); }
print(apply(function (x) { return x * x; }, 7));
function who() { return this === globalThis; }
print(who());
function strictWho() { "use strict"; return this; }
print(strictWho());
try { new obj.m(); } catch (e) { print(e.message); }
function outer() { function inner(a) { return a + 1; } return inner(41); }
print(outer());
print(typeof Point + " " + typeof add);
var counter = { n: 0, inc: function () { this.n++; return this; } };
counter.inc().inc().inc();
print(counter.n);
function Box(v) { return { boxed: v }; }
print(new Box(5).boxed);
// hoisting: a declaration is callable before its statement
print(later(2));
function later(x) { return x * 10; }
// duplicates: the last declaration wins, and calls go through the value
function dup() { return 1; }
function dup() { return 2; }
print(dup());
// a reassigned function binding
function swap() { return "old"; }
var saved = swap;
swap = function () { return "new"; };
print(saved() + " " + swap() + " " + saved.name + " " + swap.name);
// methods are not constructors; function expressions are
var Ctor = function (v) { this.v = v; };
print(new Ctor(9).v + " " + (new Ctor(1) instanceof Ctor));
// prototype chain through a constructor's prototype
function Animal(name) { this.name = name; }
Animal.prototype.speak = function () { return this.name + " makes a sound"; };
var dog = new Animal("Rex");
print(dog.speak() + " " + (dog.constructor === Animal) + " " + Object_keys_like(dog));
function Object_keys_like(o) { var s = ""; if ("name" in o) s += "name"; return s; }
// callbacks and higher-order functions
function map3(f) { return [f(1), f(2), f(3)]; }
var squares = map3(function (x) { return x * x; });
print(squares[0] + squares[1] + squares[2]);
function compose(f, g, x) { return f(g(x)); }
print(compose(function (x) { return x + 1; }, function (x) { return x * 2; }, 5));
// a named expression's name is read-only inside it
var ro = function me() { me = 1; return typeof me; };
print(ro());
// errors from calls
try { var notFn = 5; notFn(); } catch (e) { print(e.message); }
try { obj.nope(); } catch (e) { print(e.message); }
try { new add.missing(); } catch (e) { print(e.message); }
