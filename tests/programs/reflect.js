// Reflect (§28.1): the object internal methods as functions, returning booleans where the
// operators would throw or fail silently.
const t = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(`${e.constructor.name}: ${e.message}`);
  }
};

const o = { a: 1, get double() { return this.a * 2; } };
console.log(Reflect.get(o, "a"), Reflect.get(o, "double"), Reflect.get(o, "double", { a: 21 }));
console.log(Reflect.has(o, "a"), Reflect.has(o, "toString"), Reflect.has(o, "nope"));
console.log(Reflect.set(o, "b", 2), o.b, Reflect.deleteProperty(o, "b"), "b" in o);
console.log(Reflect.defineProperty(o, "fixed", { value: 1 }), Reflect.defineProperty(o, "fixed", { value: 2 }), o.fixed);
console.log(Reflect.deleteProperty(o, "fixed"), Reflect.getOwnPropertyDescriptor(o, "fixed"));
console.log(Reflect.getOwnPropertyDescriptor(o, "double"), Reflect.getOwnPropertyDescriptor(o, "missing"));
console.log(Reflect.ownKeys({ b: 1, 2: 2, [Symbol("s")]: 3, a: 4, 1: 5 }), Reflect.ownKeys([1, 2]));

// set with a receiver: the property lands on the receiver
const target = { x: 1 };
const receiver = {};
console.log(Reflect.set(target, "x", 5, receiver), target.x, receiver.x);
const setterTarget = { set v(x) { this.seen = x; } };
Reflect.set(setterTarget, "v", 7, receiver);
console.log(receiver.seen, setterTarget.seen);

// frozen and non-extensible objects: false instead of a TypeError
const frozen = Object.freeze({ x: 1 });
console.log(Reflect.set(frozen, "x", 2), Reflect.defineProperty(frozen, "y", { value: 1 }), Reflect.deleteProperty(frozen, "x"));
const sealed = {};
console.log(Reflect.isExtensible(sealed), Reflect.preventExtensions(sealed), Reflect.isExtensible(sealed));
console.log(Reflect.setPrototypeOf(sealed, {}), Reflect.setPrototypeOf(sealed, Object.prototype));

// prototypes
const proto = { greet() { return "hi " + this.name; } };
const child = { name: "child" };
console.log(Reflect.setPrototypeOf(child, proto), Reflect.getPrototypeOf(child) === proto, child.greet());
const a = {};
const b = Object.create(a);
console.log(Reflect.setPrototypeOf(a, b), Reflect.setPrototypeOf(a, null), Reflect.getPrototypeOf(a));

// apply and construct
console.log(Reflect.apply(Math.max, null, [1, 5, 3]), Reflect.apply(function () { return this.v; }, { v: "this" }, []));
console.log(Reflect.apply(String.prototype.slice, "abcdef", { length: 2, 0: 1, 1: 3 }));
class Point {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}
class Named {}
const p = Reflect.construct(Point, [1, 2]);
const q = Reflect.construct(Point, [3, 4], Named);
console.log(p, p instanceof Point, q, q instanceof Named, q instanceof Point);
function Base() {
  this.target = new.target === Named ? "Named" : String(new.target);
}
console.log(Reflect.construct(Base, [], Named).target, Reflect.construct(Array, [3]).length);

console.log(Reflect, Object.prototype.toString.call(Reflect), typeof Reflect.get, Reflect.get.length, Reflect.set.length);

// errors
t(() => Reflect.get(1, "x"));
t(() => Reflect.ownKeys(null));
t(() => Reflect.apply(1));
t(() => Reflect.apply({}));
t(() => Reflect.apply(Math.max, null, 1));
t(() => Reflect.construct(1));
t(() => Reflect.construct(Math.max, []));
t(() => Reflect.construct(Point, [], {}));
t(() => Reflect.defineProperty({}, "x", 1));
t(() => Reflect.setPrototypeOf({}, 1));
