// visaljs-flags: --script
// The first built-ins: what the test262 harness uses, compared with Node.
// Object
var o = { a: 1, b: 2 };
print(Object.prototype.toString.call(o) + " " + Object.prototype.toString.call([]) + " " + Object.prototype.toString.call(null));
print(Object.prototype.toString.call(undefined) + " " + Object.prototype.toString.call(1) + " " + Object.prototype.toString.call("s"));
print(Object.prototype.toString.call(print) + " " + Object.prototype.toString.call(new Error("x")) + " " + String(o));
print(o.hasOwnProperty("a") + " " + o.hasOwnProperty("toString") + " " + "abc".hasOwnProperty(1) + " " + "abc".hasOwnProperty("length"));
print(Object.keys(o).join("|") + " " + Object.getOwnPropertyNames([5, 6]).join("|"));
Object.defineProperty(o, "hidden", { value: 42, enumerable: false });
print(o.hidden + " " + Object.keys(o).length + " " + o.propertyIsEnumerable("hidden") + " " + o.propertyIsEnumerable("a"));
var d = Object.getOwnPropertyDescriptor(o, "hidden");
print(d.value + " " + d.writable + " " + d.enumerable + " " + d.configurable);
d = Object.getOwnPropertyDescriptor(o, "a");
print(d.value + " " + d.writable + " " + d.enumerable + " " + d.configurable + " " + Object.getOwnPropertyDescriptor(o, "zz"));
Object.defineProperty(o, "computed", { get: function () { return this.a * 100; }, configurable: true });
print(o.computed + " " + typeof Object.getOwnPropertyDescriptor(o, "computed").get);
var child = Object.create(o, { own: { value: "mine", enumerable: true } });
print(child.a + " " + child.own + " " + (Object.getPrototypeOf(child) === o) + " " + o.isPrototypeOf(child));
var bare = Object.create(null);
print(Object.getPrototypeOf(bare) + " " + typeof bare);
Object.setPrototypeOf(bare, o);
print(bare.b);
var frozenish = {};
Object.preventExtensions(frozenish);
frozenish.x = 1;
print(Object.isExtensible(frozenish) + " " + frozenish.x + " " + Object.isExtensible({}));
print(Object(o) === o);
try { Object.defineProperty(o, "bad", { get: function () {}, value: 1 }); } catch (e) { print(e.name + ": " + e.message); }
try { Object.defineProperty(1, "x", {}); } catch (e) { print(e.name); }

// Function.prototype
function sum(a, b, c) { return this.base + a + b + c; }
print(sum.call({ base: 100 }, 1, 2, 3) + " " + sum.apply({ base: 10 }, [1, 2, 3]) + " " + sum.apply({ base: 0 }, { length: 3, 0: 4, 1: 5, 2: 6 }));
print(Math_like());
function Math_like() { return Function.prototype.call.call(function () { return "nested call"; }); }
print(typeof Function.prototype.toString.call(sum));

// Array
var arr = new Array(3);
print(arr.length + " " + Array(1, 2, 3).join("-") + " " + Array.isArray(arr) + " " + Array.isArray(o));
var list = [1, 2, 3];
print(list.push(4, 5) + " " + list.join() + " " + list.pop() + " " + list.length);
print(list.map(function (x, i) { return x * 10 + i; }).join(","));
var seen = "";
[5, , 7].forEach(function (x, i, a) { seen += i + ":" + x + "/" + a.length + " "; });
print(seen);
print(list.indexOf(3) + " " + list.indexOf(9) + " " + list.indexOf(1, 1) + " " + [NaN].indexOf(NaN));
print(list.slice(1).join(",") + " " + list.slice(-2).join(",") + " " + list.slice(1, -1).join(","));
print(String([1, [2, 3], null, undefined]) + " " + [].join() + "|");
var arrayLike = { length: 2, 0: "a", 1: "b" };
print(Array.prototype.join.call(arrayLike, "+") + " " + Array.prototype.map.call("xyz", function (c) { return c + c; }).join(""));
Array.prototype.push.call(arrayLike, "c");
print(arrayLike.length + " " + arrayLike[2]);

// String, Number, Boolean
print(String(123) + String(true) + String(null) + String(undefined) + String() + "|" + String(-0));
print("hello".charAt(1) + " " + "hello".charCodeAt(1) + " " + "hello".indexOf("l") + " " + "hello".indexOf("z") + " " + "hello".indexOf("l", 3));
print("hello".slice(1, 3) + " " + "hello".slice(-3) + " " + "hello".substring(3, 1) + " " + "hello".substring(-2));
print(String.fromCharCode(72, 105, 0x263A) + " " + "abc".toString() + " " + "x".valueOf());
print(Number("  42  ") + Number(true) + Number() + " " + Number("x") + " " + (255).toString(16) + " " + (0.5).toString(2));
print(Boolean("") + " " + Boolean("0") + " " + Boolean(0) + " " + true.toString() + " " + (1).valueOf());
try { Number.prototype.toString.call("str"); } catch (e) { print(e.name + ": " + e.message); }
try { (1).toString(1); } catch (e) { print(e.name + ": " + e.message); }
print(String.prototype.constructor === String);
print(Array.prototype.constructor === Array);
