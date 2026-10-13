// visaljs-flags: --script
// Block-level functions (Annex B.3.3) and super / new.target inside arrows.
// block-level functions
print(typeof hoisted);
{
  print(hoisted());
  function hoisted() { return "block fn"; }
}
print(typeof hoisted + " " + hoisted());
function outer(flag) {
  if (flag) { function inner() { return "inner " + flag; } }
  return typeof inner === "function" ? inner() : typeof inner;
}
print(outer(1) + " | " + outer(0));
function strictBlock() {
  "use strict";
  { function s() { return 1; } }
  return typeof s;
}
print(strictBlock());
if (true) function branch() { return "branch"; }
print(branch());
switch (1) { case 1: function inSwitch() { return "switch"; } }
print(inSwitch());
function closures() {
  var out = [];
  for (let i = 0; i < 3; i++) { function get() { return i; } out.push(get); }
  return out.map(function (f) { return f(); }).join(",");
}
print(closures());
let shadowed = "outer";
{ function shadowed2() { return shadowed; } print(shadowed2()); }
// super and new.target in arrows
class Base { hello() { return "base hello"; } static make() { return "static base"; } constructor(v) { this.v = v; } }
class Derived extends Base {
  #p = "private";
  constructor() {
    const init = () => super(42);
    init();
    this.after = (() => this.v + 1)();
  }
  hello() { const f = () => super.hello() + " via arrow"; return f(); }
  getP() { return (() => this.#p)(); }
  static make() { return (() => super.make() + "!")(); }
}
var d = new Derived();
print(d.v + " " + d.after + " " + d.hello() + " " + d.getP() + " " + Derived.make());
function NT() { return (() => new.target === NT)(); }
print(new NT() instanceof NT);
function nt2() { var f = () => new.target; return f(); }
print(nt2() === undefined);
class Twice extends Base { constructor() { const s = () => super(); s(); try { s(); } catch (e) { print(e.name); } } }
new Twice();
