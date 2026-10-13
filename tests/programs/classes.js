// visaljs-flags: --no-bundle
// Classes: extends, super, static and accessor members, new.target, bind.
class Animal {
  constructor(name) { this.name = name; }
  speak() { return this.name + " makes a sound"; }
  get upper() { return this.name.toUpperCase ? this.name : this.name; }
  static create(n) { return new this(n); }
  static get kind() { return "animal"; }
}
class Dog extends Animal {
  constructor(name, breed) { super(name); this.breed = breed; }
  speak() { return super.speak() + " (woof)"; }
  static create(n) { return super.create(n + "!"); }
}
var d = new Dog("Rex", "lab");
print(d.speak() + " | " + d.breed + " | " + (d instanceof Dog) + " " + (d instanceof Animal));
print(Dog.create("Fido").name + " " + (Dog.create("x") instanceof Dog) + " " + Dog.kind + " " + Animal.kind);
print(typeof Animal + " " + Animal.name + " " + Dog.name + " " + Animal.length + " " + Dog.length);
print(Object.getPrototypeOf(Dog) === Animal);
print(Object.getPrototypeOf(Dog.prototype) === Animal.prototype);
print(Object.keys(Animal.prototype).length + " " + Animal.prototype.hasOwnProperty("speak"));
try { Animal("x"); } catch (e) { print(e.name + ": " + e.message); }
class Base {}
class Derived extends Base {}
var inst = new Derived();
print((inst instanceof Base) + " " + (inst.constructor === Derived));
class NoSuper extends Base { constructor() { this.x = 1; } }
try { new NoSuper(); } catch (e) { print(e.name); }
class Twice extends Base { constructor() { super(); super(); } }
try { new Twice(); } catch (e) { print(e.name); }
class ReturnsObj extends Base { constructor() { return { custom: true }; } }
print(new ReturnsObj().custom);
class ReturnsPrim extends Base { constructor() { super(); return 1; } }
try { new ReturnsPrim(); } catch (e) { print(e.name); }
var Expr = class { hi() { return "hi"; } };
print(new Expr().hi() + " " + Expr.name);
var Named = class Inner { who() { return Inner.name; } };
print(new Named().who());
class NT { constructor() { this.nt = new.target === NT; } }
print(new NT().nt);
class Sub extends NT {}
print(new Sub().nt);
function f() { return new.target === undefined; }
print(f());
class Computed { ["m" + 1]() { return "computed"; } static ["s" + 2]() { return "static"; } }
print(new Computed().m1() + " " + Computed.s2());
class Acc { constructor() { this._v = 0; } get v() { return this._v; } set v(x) { this._v = x * 2; } }
var a = new Acc(); a.v = 5;
print(a.v);
class ExtendsNull extends null { }
print(Object.getPrototypeOf(ExtendsNull.prototype));
try { class Bad extends 5 {} } catch (e) { print(e.name); }
var bound = function (a, b) { return this.x + a + b; }.bind({ x: 1 }, 2);
print(bound(3) + " " + bound.name + " " + bound.length);
function P(x) { this.x = x; }
var BP = P.bind(null, 7);
var bp = new BP();
print(bp.x + " " + (bp instanceof P) + " " + (bp instanceof BP));
var objSuper = { __proto__: { greet() { return "proto"; } }, greet() { return "own+" + super.greet(); } };
print(objSuper.greet());
class Counter { constructor() { this.n = 0; } inc() { return () => { this.n++; return this.n; }; } }
var c = new Counter(); var incr = c.inc(); incr(); incr();
print(c.n);
class ArrowThis extends Base { constructor() { super(); this.get = () => this; } }
var at = new ArrowThis();
print(at.get() === at);
print(String(Object.getOwnPropertyDescriptor(Animal, "prototype").writable));
