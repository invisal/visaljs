// visaljs-flags: --script
// Primitive wrapper objects: new Number/String/Boolean, Object(primitive), a sloppy
// function's boxed `this`, String exotic objects, and how they print, convert and compare.
const n = new Number(5), s = new String("ab"), b = new Boolean(false), y = Object(Symbol("q"));
console.log(n, s, b, y, typeof n, typeof s, typeof b, typeof y);
console.log(n + 1, `${s}!`, b ? "truthy" : "falsy", n == 5, n === 5, s == "ab", new Number(5) == n);
console.log(n.valueOf(), s.valueOf(), b.valueOf(), y.valueOf() === y.valueOf(), y.description, String(y.valueOf()));
console.log(Object.prototype.toString.call(n), Object.prototype.toString.call(s), Object.prototype.toString.call(b), Object.prototype.toString.call(y));
console.log(Object.prototype.toString.call(Number.prototype), Number.prototype.valueOf(), String.prototype.valueOf() === "", Boolean.prototype.valueOf());

// String exotic objects (§10.4.3)
s.x = 1;
s[5] = "five";
console.log(Object.getOwnPropertyNames(s), Object.keys(s), s.length, s[0], s[1], s[2]);
console.log(Object.getOwnPropertyDescriptor(s, "0"), Object.getOwnPropertyDescriptor(s, "length"));
s[0] = "z";
console.log(s[0], delete s[0], delete s.x, "0" in s, 2 in s, Object.isFrozen(s));
try {
  "use strict";
  (function () { "use strict"; s[1] = "q"; })();
} catch (e) {
  console.log(e.constructor.name);  /* V8 adds "of object '[object String]'" */
}
try {
  Object.defineProperty(s, "length", { value: 9 });
} catch (e) {
  console.log(e.constructor.name, e.message);
}
console.log(Object.defineProperty(s, "1", { value: "b" }) === s, [...new String("hé😀")], Array.from(new String("xy")));

// Object(primitive) and ToObject
const o = Object("hi");
console.log(o, o instanceof String, Object(1) instanceof Number, Object(true) instanceof Boolean, Object(o) === o);
console.log(Object.assign("ab", { c: 1 }), Object.assign(3, null), Object.prototype.valueOf.call(7));
console.log(Array.prototype.map.call("abc", (c) => c + c), [...Array.prototype.entries.call("xy")]);

// sloppy functions box `this`; strict ones don't
function sloppy() { return this; }
function strict() { "use strict"; return this; }
console.log(typeof sloppy.call(1), sloppy.call("s") instanceof String, sloppy.call(true).valueOf(), typeof strict.call(1));
Object.defineProperty(Number.prototype, "self", { get() { return this; }, configurable: true });
console.log(typeof (4).self, (4).self + 1);
Number.prototype.twice = function () { return this * 2; };
console.log((21).twice());

// subclasses
class Big extends Number {
  double() { return this * 2; }
}
class Str extends String {}
const big = new Big(4);
console.log(big, big.double(), big instanceof Number, new Str("ok"), new Str("ok").length, `${new Str("k")}`);

// this-value checks
for (const f of [
  () => Number.prototype.toFixed.call(new Number(1.5), 2),
  () => Number.prototype.toFixed.call(new String("1")),
  () => String.prototype.toString.call(new String("w")),
  () => String.prototype.valueOf.call(new Number(1)),
  () => Boolean.prototype.toString.call(new Boolean(true)),
  () => Boolean.prototype.valueOf.call(0),
  () => Symbol.prototype.toString.call(Object(Symbol("t"))),
  () => new Symbol(),
]) {
  try {
    console.log(f());
  } catch (e) {
    console.log(e.constructor.name, e.message);
  }
}
try {
  Symbol.keyFor(Object(Symbol.for("r")));
} catch (e) {
  console.log(e.constructor.name);  /* V8 describes the value: "[object Symbol] is not a symbol" */
}
/* Node 22 polyfills these as Symbol("nodejs.dispose"); the spec's description is "Symbol.dispose" */
console.log(typeof Symbol.dispose, typeof Symbol.asyncDispose, Object.getOwnPropertyNames(Symbol).join());
