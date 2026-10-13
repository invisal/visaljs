// Map and Set (§24.1–24.2): keys by SameValueZero, insertion order, iteration while the
// collection changes, Map.groupBy, the Set methods, and how console.log prints them.
const t = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(`${e.constructor.name}: ${e.message}`);
  }
};

// Keys: SameValueZero, so -0 is 0, NaN is NaN, and equal strings are one key.
const m = new Map();
m.set(-0, "zero").set(NaN, "nan").set("ab", 1).set(1.5, "x");
const key = "a" + ["b"].join("");
console.log(m.get(0), m.get(NaN), m.get(key), m.get(3 / 2), m.has("a"), m.size);
console.log(Object.is([...m.keys()][0], 0), [...m]);
const o = {};
m.set(o, "object");
console.log(m.get(o), m.get({}), m.delete(o), m.delete(o), m.size);

// Insertion order: re-setting keeps the position; deleting and adding moves to the end.
const order = new Map([["a", 1], ["b", 2], ["c", 3]]);
order.set("a", 10);
order.delete("b");
order.set("b", 20);
console.log([...order.entries()], [...order.keys()], [...order.values()]);

// Iteration sees entries added during it and skips deleted ones, also across rehashes.
const s = new Set([1, 2, 3]);
const seen = [];
for (const v of s) {
  seen.push(v);
  if (v === 1) s.delete(2);
  if (v < 40) s.add(v + 10);
}
console.log(seen.join(" "));
const big = new Set();
for (let i = 0; i < 100; i++) big.add(i);
const it = big.values();
console.log(it.next().value, it.next().value);
for (let i = 0; i < 95; i++) big.delete(i);  // shrinks the table under the iterator
console.log([...it]);
const cleared = new Map([[1, 1], [2, 2]]);
const cit = cleared.keys();
cit.next();
cleared.clear();
cleared.set(3, 3);
console.log([...cit], cleared.size);
const done = new Set([1]).values();
console.log(done.next(), done.next(), done.next());

// forEach: (value, key, collection), with thisArg.
new Map([["x", 1]]).forEach(function (v, k, map) {
  console.log(v, k, map.size, this.tag);
}, { tag: "this" });
new Set(["y"]).forEach((v, k, set) => console.log(v, k, set.has(v)));

// Many entries
const n = new Map();
for (let i = 0; i < 20000; i++) n.set("k" + i, i);
for (let i = 0; i < 20000; i += 2) n.delete("k" + i);
let sum = 0;
for (const [, v] of n) sum += v;
console.log(n.size, sum, n.get("k19999"), n.get("k0"));

// Map.groupBy and the Set methods
console.log(Map.groupBy([1, 2, 3, 4, 5], (x) => (x % 2 ? "odd" : "even")));
const a = new Set([1, 2, 3, 4]);
const b = new Set([3, 4, 5]);
console.log(a.union(b), a.intersection(b), a.difference(b), a.symmetricDifference(b));
console.log(a.isSubsetOf(b), new Set([3]).isSubsetOf(b), a.isSupersetOf(new Set([1, 2])), a.isDisjointFrom(new Set([9])));
const setLike = { size: 2, has: (x) => x === 1, keys: () => [1, 7][Symbol.iterator]() };
console.log(a.union(setLike), a.intersection(setLike), a.difference(setLike), a.isDisjointFrom(setLike));
console.log(new Set([1, 2]).union(new Map([[5, "five"]])));

// Subclasses, species, the prototypes
class Counter extends Map {
  add(k) {
    return this.set(k, (this.get(k) ?? 0) + 1);
  }
}
const c = new Counter().add("a").add("a").add("b");
console.log(c, c instanceof Map, Map[Symbol.species] === Map, Set[Symbol.species] === Set);
console.log(Map.prototype[Symbol.iterator] === Map.prototype.entries, Set.prototype.keys === Set.prototype.values);
console.log(Object.prototype.toString.call(new Map()), String(new Set()), String(new Map().keys()));
console.log(Map.name, Map.length, Set.length, Map.prototype.set.length, Map.groupBy.length, Set.prototype.union.length);

// console.log
const deep = new Map([["k", new Set([new Map([[1, { a: [1, 2] }]])])]]);
console.log(deep, { nested: { deeper: { deepest: deep } } });
const self = new Set([1]);
self.add(self);
const props = new Map([[1, 2]]);
props.extra = true;
console.log(self, props, new Map(), new Set());
const iter = new Map([["a", 1], ["b", 2]]).entries();
iter.next();
console.log(iter, new Set([1, 2]).entries(), new Map([[1, 2]]).values(), new Map().keys());
console.log(new Set(Array.from({ length: 105 }, (_, i) => i)));
console.log(new Map(Array.from({ length: 8 }, (_, i) => ["key number " + i, { value: i }])));

// Errors
t(() => Map());
t(() => Map.prototype.get.call({}, 1));
t(() => Set.prototype.add.call(new Map(), 1));
t(() => new Map([1]).size);
t(() => new Map().forEach(1));
t(() => new Set([1]).union(1));
t(() => new Set([1]).union({}));
t(() => new Set([1]).union({ size: 1 }));
t(() => new Set([1]).union({ size: -1, has() {}, keys() {} }));
t(() => new Set([1]).union({ size: 1, has() {}, keys() { return 1; } }));
t(() => new Map().keys().next.call(new Set().values()));
t(() => {
  const set = Map.prototype.set;
  Map.prototype.set = 1;
  try {
    return new Map([[1, 2]]).size;
  } finally {
    Map.prototype.set = set;
  }
});
