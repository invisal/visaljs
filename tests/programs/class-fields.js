// Class fields, private names and static blocks.
class Point {
  x = 1;
  y = this.x + 1;
  ["z" + 1] = 3;
  static count = 0;
  static origin = new Point();
  constructor() { Point.count++; }
}
var p = new Point();
print(p.x + " " + p.y + " " + p.z1 + " " + Point.count + " " + (Point.origin instanceof Point));
print(Object.keys(p).join(","));
class Counter {
  #count = 0;
  static #instances = 0;
  constructor() { Counter.#instances++; }
  inc() { this.#count++; return this; }
  get value() { return this.#count; }
  #secret() { return "secret" + this.#count; }
  reveal() { return this.#secret(); }
  get #doubled() { return this.#count * 2; }
  set #doubled(v) { this.#count = v / 2; }
  double() { this.#doubled = this.#doubled * 2; return this.#count; }
  static instances() { return Counter.#instances; }
  static isCounter(o) { return #count in o; }
}
var c = new Counter();
c.inc().inc();
print(c.value + " " + c.reveal() + " " + c.double() + " " + Counter.instances());
print(Counter.isCounter(c) + " " + Counter.isCounter({}));
print(Object.keys(c).length + " " + Object.getOwnPropertyNames(c).length);
try { Counter.prototype.reveal.call({}); } catch (e) { print(e.name); }
class Base { a = "base"; constructor() { this.order = [this.a]; } }
class Derived extends Base {
  b = this.a + "+derived";
  constructor() { super(); this.order.push(this.b); }
}
var d = new Derived();
print(d.order.join(" | "));
class Static {
  static a = 1;
  static { Static.b = Static.a + 1; }
  static c = Static.b + 1;
  static { this.d = this.c * 10; }
}
print(Static.a + " " + Static.b + " " + Static.c + " " + Static.d);
class Named { fn = function () {}; arrow = () => 1; #p = () => 2; getP() { return this.#p.name; } }
var n = new Named();
print(n.fn.name + " " + n.arrow.name + " " + n.getP());
class A { #x = 1; static read(o) { return o.#x; } }
class B { #x = 2; static read(o) { return o.#x; } }
try { A.read(new B()); } catch (e) { print(e.name); }
print(A.read(new A()) + " " + B.read(new B()));
var frozen = Object.preventExtensions({});
class Stamp extends (class { constructor(o) { return o; } }) { #tag = "t"; static tag(o) { return o.#tag; } }
new Stamp(frozen);
print(Stamp.tag(frozen));
class ThisInField { self = this; }
var t = new ThisInField();
print(t.self === t);
class WithArrow { v = 5; getter = () => this.v; }
print(new WithArrow().getter());
class Uninit { u; }
print(("u" in new Uninit()) + " " + new Uninit().u);
