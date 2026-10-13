// Object spread in literals (CopyDataProperties, §7.3.25): own enumerable keys, symbols too, in order
const s = Symbol("s");
const base = { a: 1, b: 2, [s]: 3 };
Object.defineProperty(base, "hidden", { value: 9, enumerable: false });
const o = { z: 0, ...base, b: 20, ...null, ...undefined, ..."hi", ...42 };
console.log(o, o[s], Object.keys(o));
const order = [];
const g = { get x() { order.push("x"); return 1; } };
console.log({ ...g }, order);
try { ({ ...{ get bad() { throw new Error("boom"); } } }); } catch (e) { console.log(e.message); }
const { a, ...rest } = o;
console.log(a, rest);
const p = new Proxy({ k: 1 }, { ownKeys(t) { order.push("ownKeys"); return Reflect.ownKeys(t); } });
console.log({ ...p }, order);
