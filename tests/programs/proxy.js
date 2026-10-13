// Proxy (§10.5, §28.2): every trap, forwarding to the target when a trap is missing, the
// invariants checked against the target, revocation, callable proxies, and proxies on
// prototype chains.
const t = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(`${e.constructor.name}: ${e.message}`);
  }
};

// A logging handler: each trap reports, then does what the target would.
const log = [];
const logging = {};
for (const name of Object.getOwnPropertyNames(Reflect)) {
  logging[name] = (...args) => {
    log.push(name + (typeof args[1] === "string" ? ` ${args[1]}` : ""));
    return Reflect[name](...args);
  };
}
const target = { a: 1, nested: { b: 2 } };
const p = new Proxy(target, logging);
p.a;
p.c = 3;
"a" in p;
delete p.c;
Object.keys(p);
Object.getOwnPropertyDescriptor(p, "a");
Object.defineProperty(p, "d", { value: 4, configurable: true });
Object.getPrototypeOf(p);
Object.setPrototypeOf(p, Object.prototype);
Object.isExtensible(p);
for (const k in p) log.push("for-in " + k);
JSON.stringify(p);
console.log(log.join("\n"));

// A missing trap forwards to the target.
const plain = new Proxy({ x: 1 }, {});
plain.y = 2;
console.log(plain.x, plain.y, Object.keys(plain), "y" in plain, delete plain.y, plain.y);

// Traps that change the answers
const defaults = new Proxy({}, { get: (t, k) => (k in t ? t[k] : `default ${String(k)}`) });
defaults.real = "real";
console.log(defaults.real, defaults.missing, defaults[1]);
const hidden = new Proxy({ _secret: 1, shown: 2 }, {
  has: (t, k) => !k.startsWith("_") && k in t,
  ownKeys: (t) => Reflect.ownKeys(t).filter((k) => !k.startsWith("_")),
});
console.log("_secret" in hidden, "shown" in hidden, Object.keys(hidden), JSON.stringify(hidden));
const validated = new Proxy({}, {
  set(t, k, v) {
    if (typeof v !== "number") throw new TypeError(`${k} must be a number`);
    t[k] = v;
    return true;
  },
});
validated.n = 5;
t(() => (validated.s = "x"));
console.log(validated.n, Object.keys(validated));

// A proxy as a prototype: lookups that miss the object reach the get/set/has traps.
const protoProxy = new Proxy({}, {
  get: (t, k, receiver) => `from proto: ${String(k)} (receiver has own: ${Object.keys(receiver)})`,
  set: (t, k, v, receiver) => Reflect.defineProperty(receiver, k, { value: v * 10, writable: true, enumerable: true, configurable: true }),
  has: (t, k) => k === "magic",
});
const child = Object.create(protoProxy);
child.own = 1;
console.log(child.own, child.inherited);
child.viaSet = 2;
console.log(child.viaSet, "magic" in child, "other" in child);

// Callable proxies
const add = (a, b) => a + b;
const traced = new Proxy(add, { apply: (f, self, args) => `called with ${args}: ${f(...args)}` });
console.log(traced(1, 2), typeof traced, traced.length, traced.name);
class Point {
  constructor(x) {
    this.x = x;
  }
}
const P = new Proxy(Point, {
  construct(T, args, newTarget) {
    return { built: new T(...args), sameNewTarget: newTarget === P };
  },
});
console.log(new P(7), new Proxy(Point, {}) instanceof Function, new (new Proxy(Point, {}))(1) instanceof Point);
console.log(Array.isArray(new Proxy([], {})), Object.prototype.toString.call(new Proxy([], {})), [].concat(new Proxy([1, 2], {})));

// Revocation
const { proxy, revoke } = Proxy.revocable({ v: 1 }, {});
console.log(proxy.v);
revoke();
revoke();
t(() => proxy.v);
t(() => Array.isArray(proxy));
console.log(proxy, typeof proxy);

// console.log shows the target and runs no traps
const noisy = new Proxy({ shown: true, list: [1, 2] }, { get: () => { throw new Error("trap ran"); }, ownKeys: () => { throw new Error("trap ran"); } });
console.log(noisy, [noisy], new Proxy(function named() {}, {}), new Proxy(new Map([[1, 2]]), {}));

// Invariants
const frozen = Object.freeze({ x: 1 });
t(() => new Proxy(frozen, { get: () => 2 }).x);
t(() => (new Proxy(frozen, { set: () => true }).x = 2));
t(() => "x" in new Proxy(frozen, { has: () => false }));
t(() => delete new Proxy(frozen, { deleteProperty: () => true }).x);
t(() => Object.keys(new Proxy(frozen, { ownKeys: () => [] })));
t(() => Object.keys(new Proxy({}, { ownKeys: () => ["a", "a"] })));
t(() => Object.getOwnPropertyDescriptor(new Proxy(frozen, { getOwnPropertyDescriptor: () => undefined }), "x"));
t(() => Object.defineProperty(new Proxy({}, { defineProperty: () => true }), "z", { value: 1, configurable: false }));
t(() => Object.getPrototypeOf(new Proxy(Object.preventExtensions({}), { getPrototypeOf: () => Array.prototype })));
t(() => Object.isExtensible(new Proxy({}, { isExtensible: () => false })));
t(() => Object.preventExtensions(new Proxy({}, { preventExtensions: () => true })));
t(() => new (new Proxy(function () {}, { construct: () => 1 }))());
t(() => Reflect.set(new Proxy({}, { set: () => false }), "x", 1));
t(() => {
  "use strict";
  new Proxy({}, { set: () => false }).x = 1;
});
t(() => new Proxy({}, { get: 1 }).x);
t(() => Proxy({}, {}));
t(() => new Proxy(1, {}));
console.log(Proxy.length, Proxy.name, "prototype" in Proxy, Object.getOwnPropertyNames(Proxy));
