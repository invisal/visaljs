// `new F(…)` of a constructor the program compiles: the instance is made
// from a shape cached on F, the constructor's body runs directly, and `this.x = v` adds inline.
// Everything [[Construct]] does must still hold.
const log = (...a) => console.log(...a);

class Point {
  constructor(x, y) { this.x = x; this.y = y; }
  add(o) { return new Point(this.x + o.x, this.y + o.y); }
}
let p = new Point(1, 2);
for (let i = 0; i < 1000; i++) p = p.add(new Point(1, 1));
log("point", p.x, p.y, p instanceof Point, Object.getPrototypeOf(p) === Point.prototype, Object.keys(p).join());

// a function constructor whose prototype is replaced between instances
function Node(left, right) { this.left = left; this.right = right; }
const a = new Node(null, null);
Node.prototype = { kind: "replaced" };
const b = new Node(a, null);
log("node", Object.getPrototypeOf(a) === Object.getPrototypeOf(b), b.kind, a.kind, b.left === a);
Node.prototype = 42;  // not an object: instances get Object.prototype
const c = new Node(1, 2);
log("node primitive prototype", Object.getPrototypeOf(c) === Object.prototype, c.left);

// a setter on the prototype chain sees the assignment instead of a new property
class Watched {
  constructor(v) { this.value = v; this.other = v + 1; }
}
const w1 = new Watched(1);
Object.defineProperty(Watched.prototype, "value", { set(v) { log("setter got", v); }, get() { return "from getter"; }, configurable: true });
const w2 = new Watched(2);
log("watched", w1.value, w2.value, Object.keys(w2).join());
Object.defineProperty(Object.prototype, "other", { set(v) { log("Object.prototype setter", v); }, configurable: true });
const w3 = new Watched(5);
log("watched 3", Object.keys(w3).join());
delete Object.prototype.other;

// constructors returning objects and primitives
function ReturnsObject() { this.a = 1; return { b: 2 }; }
function ReturnsPrimitive() { this.a = 1; return 7; }
class ReturnsFromClass { constructor() { this.a = 1; return [3]; } }
log("returns", JSON.stringify(new ReturnsObject()), JSON.stringify(new ReturnsPrimitive()), JSON.stringify(new ReturnsFromClass()));

// new.target, fields, arguments the constructor doesn't declare, missing ones
class Fields {
  z = 10;
  constructor(a) { this.target = new.target === Fields; this.a = a; }
}
const f = new Fields(1, 2, 3);
log("fields", f.z, f.target, f.a, Object.keys(f).join());
function Few(a, b, c) { this.sum = [a, b, c].map(String).join(); }
log("few", new Few(1).sum, new Few(1, 2, 3, 4).sum);

// a subclass (not direct), and its base made directly
class Base { constructor(v) { this.v = v; } }
class Derived extends Base { constructor() { super(4); this.w = 5; } }
const d = new Derived();
log("derived", d.v, d.w, d instanceof Base, new Base(6).v);

// a class called without new, and a binding that's reassigned (generic path)
try { Point(1, 2); } catch (e) { log("call", e.constructor.name); }
let Changing = class { constructor() { this.k = "first"; } };
const first = new Changing();
Changing = function () { this.k = "second"; };
log("reassigned", first.k, new Changing().k);

// exceptions from the constructor's body and its arguments
class Throws { constructor(v) { if (v) throw new Error("ctor " + v); this.ok = true; } }
try { new Throws(1); } catch (e) { log("caught", e.message); }
try { new Throws((() => { throw new Error("argument"); })()); } catch (e) { log("caught", e.message); }
log("ok", new Throws(0).ok);

// many properties: past the instance's inline slots
function Wide() { for (let i = 0; i < 20; i++) this["p" + i] = i; this.last = "end"; }
const wide = new Wide();
log("wide", Object.keys(wide).length, wide.p19, wide.last);

// objects frozen or extended after construction keep working
const frozen = Object.freeze(new Point(1, 2));
const extended = new Point(3, 4);
extended.z = 5;
log("after", Object.isFrozen(frozen), extended.z, JSON.stringify(new Point(7, 8)));
