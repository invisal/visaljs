// visaljs-flags: --no-bundle
// Closures: environments, per-iteration let, TDZ, captured params.
function makeCounter(start) {
  var n = start;
  return { inc: function () { n++; return n; }, get: function () { return n; } };
}
var c1 = makeCounter(10), c2 = makeCounter(100);
c1.inc(); c1.inc(); c2.inc();
print(c1.get() + " " + c2.get());
function adder(x) { return function (y) { return function (z) { return x + y + z; }; }; }
print(adder(1)(2)(3));
var fns = [];
for (let i = 0; i < 3; i++) fns.push(function () { return i; });
print(fns[0]() + " " + fns[1]() + " " + fns[2]());
var vfns = [];
for (var j = 0; j < 3; j++) vfns.push(function () { return j; });
print(vfns[0]() + " " + vfns[2]());
{
  let blockVar = "block";
  var readBlock = function () { return blockVar; };
}
print(readBlock());
var fact = function f(n) { return n <= 1 ? 1 : n * (function () { return f(n - 1); })(); };
print(fact(5));
function tdz() {
  var g = function () { return later; };
  try { g(); } catch (e) { print(e.name + ": " + e.message); }
  let later = "ok";
  return g();
}
print(tdz());
function outer() {
  var x = 1;
  function inner() { x += 1; return x; }
  inner(); inner();
  return x;
}
print(outer());
try { throw "caught"; } catch (err) { var viaCatch = function () { return err; }; }
print(viaCatch());
function params(a, b) { return function () { a = a * 10; return a + b; }; }
var p = params(1, 2); p();
print(p());
// deep nesting: each level reads every outer level
function level1(a) {
  var one = a;
  return function level2(b) {
    let two = one + b;
    return function level3(c) {
      const three = two + c;
      return function () { return one + "/" + two + "/" + three; };
    };
  };
}
print(level1(1)(2)(3)());
// a switch block's let, and closures made in a while loop
function inSwitch(k) {
  switch (k) {
    case 1:
      let msg = "one";
      return function () { return msg; };
    default:
      return function () { return "other"; };
  }
}
print(inSwitch(1)() + " " + inSwitch(2)());
var made = [], w = 0;
while (w < 3) { let copy = w * w; made.push(function () { return copy; }); w++; }
print(made[0]() + made[1]() + made[2]());
// many closures alive at once (GC pressure on environments)
var keep = [];
for (let k = 0; k < 2000; k++) keep.push(function () { return k; });
var sum = 0;
for (var m = 0; m < keep.length; m++) sum += keep[m]();
print(sum);
// methods sharing private state
function Account(balance) {
  this.deposit = function (x) { balance += x; return this; };
  this.balance = function () { return balance; };
}
var acct = new Account(5);
print(acct.deposit(10).deposit(1).balance());
