// visaljs-flags: --embed-source --script
// Function.prototype.toString returns the exact source text (§20.2.3.5).
function  decl ( a,b ) { /* body */ return a + b; }
print(decl.toString());
var expr = function named() { return 1; };
print(expr.toString());
var arrow = (x) =>   x * 2;
print(arrow.toString());
var obj = { method(a) { return a; }, get g() { return 1; }, set s(v) {}, ["comp" + "uted"]() {} };
print(obj.method.toString());
print(Object.getOwnPropertyDescriptor(obj, "g").get.toString());
print(Object.getOwnPropertyDescriptor(obj, "s").set.toString());
print(obj.computed.toString());
class K extends Object {
  constructor() { super(); }
  m() { return "m"; }
  static   sm() { return "sm"; }
  get v() { return 1; }
}
print(K.toString());
print(K.prototype.m.toString());
print(K.sm.toString());
class Empty {}
print(Empty.toString());
print(Math_max.toString());
function Math_max() {}
print([].push.toString());
print(decl.bind(null).toString());
print(Object.keys.toString());
var unicode = function () { return "héllo ☺"; };
print(unicode.toString());
