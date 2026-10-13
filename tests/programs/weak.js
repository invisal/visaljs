// WeakMap, WeakSet, WeakRef, FinalizationRegistry. Collection itself isn't
// observable without a GC hook, so this checks the API; runtime/tests/test_weak.c covers the GC.
function err(f) { try { f(); return "no error"; } catch (e) { return e.constructor.name; } }

// WeakMap: object and (unregistered) symbol keys, by identity
var a = {}, b = {}, sym = Symbol("s");
var wm = new WeakMap([[a, 1], [b, 2]]);
wm.set(sym, "symbol").set(a, 10);
print([wm.get(a), wm.get(b), wm.get(sym), wm.get({}), wm.has(b), wm.has(1)].join(" "));
print([wm.delete(b), wm.delete(b), wm.has(b), wm.get(b)].join(" "));
print([err(() => wm.set(1, 1)), err(() => wm.set(Symbol.for("registered"), 1)), err(() => WeakMap()), err(() => new WeakMap([1]))].join(" "));
print(wm.set(Symbol.iterator, "well-known").get(Symbol.iterator));

// many keys: the table grows and keeps every entry
var keys = [];
for (var i = 0; i < 1000; i++) { var k = { i }; keys.push(k); wm.set(k, i * 2); }
var sum = 0;
for (var j = 0; j < keys.length; j++) sum += wm.get(keys[j]);
for (var j = 0; j < keys.length; j += 2) wm.delete(keys[j]);
var left = 0;
for (var j = 0; j < keys.length; j++) if (wm.has(keys[j])) left++;
print("sum " + sum + ", left " + left);

// WeakSet
var ws = new WeakSet([a]);
ws.add(b).add(b);
print([ws.has(a), ws.has(b), ws.delete(a), ws.has(a), err(() => ws.add("x"))].join(" "));

// the constructor calls this.set / this.add, which subclasses can see
class LoggingMap extends WeakMap {
  set(k, v) { print("set " + v); return super.set(k, v); }
}
var lm = new LoggingMap([[a, "first"], [b, "second"]]);
print(lm instanceof WeakMap && lm.get(b));

// WeakRef: deref while the target is reachable
var target = { name: "target" };
var ref = new WeakRef(target);
print(ref.deref() === target ? "deref " + ref.deref().name : "gone");
print([err(() => new WeakRef(1)), err(() => WeakRef({}))].join(" "));

// FinalizationRegistry: register and unregister (callbacks run only after a collection)
var registry = new FinalizationRegistry((held) => print("cleanup " + held));
var token = {};
registry.register({}, "held 1", token);
registry.register({}, "held 2");
print([registry.unregister(token), registry.unregister(token), registry.unregister({})].join(" "));
print([err(() => registry.register(1, "x")), err(() => registry.register(target, target)), err(() => registry.unregister(1))].join(" "));

print([wm, ws, ref, registry].map((o) => Object.prototype.toString.call(o)).join(" "));
