// visaljs-flags: --script --all-builtins
// Object's statics and prototype: assign, entries/values/fromEntries, freeze/seal,
// descriptors, groupBy, hasOwn, is, and the Annex B accessors and __proto__.
const sym = Symbol("s");
const src = { a: 1, b: 2, [sym]: 3 };
Object.defineProperty(src, "hidden", { value: 4, enumerable: false });
const target = Object.assign({ z: 0 }, src, null, undefined, "xy", 5);
console.log(target, Object.keys(target), target[sym]);
console.log(Object.entries({ x: 1, y: [2] }), Object.values("ab"), Object.entries("hi"));
console.log(Object.fromEntries([["a", 1], ["b", 2]]), Object.fromEntries(Object.entries({ k: "v" })));
const frozen = Object.freeze({ f: 1, nested: { n: 1 } });
frozen.f = 2;
frozen.nested.n = 2;
console.log(frozen, Object.isFrozen(frozen), Object.isSealed(frozen), Object.isFrozen({}), Object.isFrozen(1), Object.isExtensible(frozen));
const sealed = Object.seal({ s: 1 });
sealed.s = 2;
sealed.t = 3;
delete sealed.s;
console.log(sealed, Object.isSealed(sealed), Object.isFrozen(sealed));
try { "use strict"; (function () { "use strict"; frozen.f = 3; })(); } catch (e) { console.log(e.name); }
console.log(Object.getOwnPropertyDescriptors({ get g() { return 1; }, v: 2 }));
console.log(Object.groupBy([1, 2, 3, 4, 5], (n) => (n % 2 ? "odd" : "even")));
console.log(Object.hasOwn({ q: 1 }, "q"), Object.hasOwn({}, "toString"), Object.hasOwn("abc", 1));
console.log(Object.is(NaN, NaN), Object.is(0, -0), Object.is("a", "a"), Object.is({}, {}));
const proto = { greet() { return "hi " + this.name; } };
const o = { name: "o" };
o.__proto__ = proto;
console.log(o.greet(), o.__proto__ === proto, Object.getPrototypeOf(o) === proto, ({ __proto__: null }).__proto__);
const legacy = {};
legacy.__defineGetter__("x", function () { return 42; });
legacy.__defineSetter__("y", function (v) { this._y = v; });
legacy.y = 7;
console.log(legacy.x, legacy._y, typeof legacy.__lookupGetter__("x"), legacy.__lookupSetter__("x"), ({}).toLocaleString());
console.log(Object.getOwnPropertyNames(Object).join(), Object.getOwnPropertyNames(Object.prototype).join());
try { Object.fromEntries([1]); } catch (e) { console.log(e.name); }
try { Object.assign(null); } catch (e) { console.log(e.name); }
