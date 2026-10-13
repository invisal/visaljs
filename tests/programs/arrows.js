// visaljs-flags: --no-bundle
// Arrow functions, default and rest parameters, spread, accessors.
var add = (a, b) => a + b;
var sq = x => x * x;
print(add(2, 3) + " " + sq(4) + " " + add.name + " " + add.length + " " + (() => 1).name);
var obj = {
  base: 10,
  later: function () { return [1, 2, 3].map(x => x + this.base); },
  nested: function () { var f = () => () => this.base * 2; return f()(); },
};
print(obj.later().join(",") + " " + obj.nested());
try { new add(1, 2); } catch (e) { print(e.message); }
print(typeof add.prototype);
function defaults(a, b = a + 1, c = b * 2) { return a + "/" + b + "/" + c; }
print(defaults(1) + " " + defaults(1, 5) + " " + defaults(1, undefined, 0) + " " + defaults.length);
function tdz(a = b, b) { return a; }
try { tdz(); } catch (e) { print(e.name + ": " + e.message); }
var named = function (fn = function () {}) { return fn.name; };
print(named());
function rest(first, ...others) { return first + ":" + others.length + ":" + others.join("+"); }
print(rest(1) + " " + rest(1, 2, 3) + " " + rest.length);
var restArrow = (...all) => all.length;
print(restArrow() + " " + restArrow(1, 2, 3, 4));
var arr = [1, 2, 3];
print(add(...arr) + " " + rest(...arr, ...["x", "y"]));
print([0, ...arr, 4, ...[], ..."ab"].join(","));
print([...arr].length + " " + [, ...arr].length + " " + [..."a😀b"].length);
function Point(x, y) { this.x = x; this.y = y; }
var p = new Point(...[7, 8]);
print(p.x + p.y);
var acc = {
  _v: 1,
  get v() { return this._v * 10; },
  set v(x) { this._v = x; },
  get ["comp" + "uted"]() { return "c"; },
};
acc.v = 5;
print(acc.v + " " + acc.computed);
var d = Object.getOwnPropertyDescriptor(acc, "v");
print(typeof d.get + " " + typeof d.set + " " + d.enumerable + " " + d.get.name + " " + d.set.name);
try { [...5]; } catch (e) { print(e.name); }
print(((a, b = 2) => a + b)(1));
var counter = { n: 0, inc() { return () => { this.n++; return this.n; }; } };
var inc = counter.inc(); inc(); inc();
print(counter.n);
// an arrow keeps its function's `this` even when called as a method
var holder = { tag: "outer", make: function () { return { tag: "inner", arrow: () => this.tag }; } };
print(holder.make().arrow());
// defaults referring to earlier parameters and closures in defaults
function closure(a, f = () => a) { a = 2; return f(); }
print(closure(1));
