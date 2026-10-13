// for…in (§14.7.5): enumerable string keys, own first, then the prototype chain.
function keys(o) { var out = []; for (var k in o) out.push(k); return out.join(","); }

print(keys({ b: 1, a: 2, 1: "x", 0: "y" }));  // indices first, then insertion order
print(keys([10, 20, 30]));
print(keys("hi"));
print(keys(null) + "|" + keys(undefined) + "|" + keys(42));

// the prototype chain; shadowed keys appear once, non-enumerable ones hide inherited ones
var proto = { inherited: 1, shadowed: 1, hidden: 1 };
var o = Object.create(proto);
o.own = 1;
o.shadowed = 2;
Object.defineProperty(o, "hidden", { value: 2, enumerable: false });
print(keys(o));
Object.defineProperty(o, "secret", { value: 1, enumerable: false });
print(keys(o));
var sym = Symbol("s");
o[sym] = 1;
print(keys(o));

// deleting a key not yet visited skips it; adding keys during the loop doesn't break it
var d = { a: 1, b: 2, c: 3 };
var seen = [];
for (var k in d) { seen.push(k); if (k === "a") delete d.b; }
print(seen.join(","));

// let: a fresh binding per iteration
var fns = [];
for (let k in { x: 1, y: 2, z: 3 }) fns.push(function () { return k; });
print(fns.map(function (f) { return f(); }).join(","));
for (const k in { only: 1 }) print("const " + k);

// TDZ: the object is evaluated with the loop's let binding uninitialized
try { for (let q in q) {} } catch (e) { print(e.constructor.name); }

// any assignment target, evaluated each iteration
var target = {};
for (target.last in { p: 1, q: 2 });
print(target.last);
var i = 0, slots = [];
for (slots[i++] in { m: 1, n: 2 });
print(slots.join(",") + " " + i);

// break, continue, labels
outer: for (var a in { a1: 1, a2: 1 }) {
  for (var b in { b1: 1, b2: 1, b3: 1 }) {
    if (b === "b2") continue outer;
    if (a === "a2") break outer;
    print(a + b);
  }
}

// var in a function; the loop variable keeps the last key
function last(obj) { for (var k in obj); return k; }
print(last({ first: 1, final: 2 }));

// objects that share a shape (the keys a shape lists are reused), and class instances
var rows = [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c", extra: true }];
print(rows.map(keys).join(" | "));
class Point { constructor() { this.x = 1; this.y = 2; } method() {} }
print(keys(new Point()) + " " + keys(Object.create(null, { e: { value: 1, enumerable: true }, n: { value: 2 } })));

// changes during the loop: deleting the last key added (the object goes back to an earlier
// shape), keys added (not visited), a dictionary-mode object
function during(o, f) { var out = []; for (var k in o) { out.push(k); f(o, k); } return out.join(","); }
print(during({ a: 1, b: 2, c: 3 }, function (o, k) { if (k === "a") delete o.c; }));
print(during({ a: 1, b: 2 }, function (o, k) { if (k === "a") { o.z = 1; delete o.b; o.b = 3; } }));
var big = {};
for (var n = 0; n < 200; n++) big["k" + n] = n;
delete big.k5;
print(during(big, function (o, k) { if (k === "k0") delete o.k199; }).split(",").length);

// a prototype that gains an enumerable key, an object that gains elements
var base = {};
var child = Object.create(base);
child.own = 1;
print(keys(child));
base.later = 1;
print(keys(child));
var withElements = { p: 1 };
print(keys(withElements));
withElements[0] = "x";
print(keys(withElements));

// a prototype's non-enumerable key, then made enumerable
var hiddenProto = {};
Object.defineProperty(hiddenProto, "h", { value: 1, enumerable: false, configurable: true });
var inheritor = Object.create(hiddenProto);
inheritor.i = 1;
print(keys(inheritor));
Object.defineProperty(hiddenProto, "h", { enumerable: true });
print(keys(inheritor));
