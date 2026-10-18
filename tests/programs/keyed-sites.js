// Element access whose key is a module binding with one store: the site caches its key (the
// constant-keys pass), and must still be right when that store runs again with another key (an
// index, a string that isn't interned), or when the object answers through getters, setters or
// a proxy.
"use strict";
var key;
function setKey(k) { key = k; }
setKey(Symbol("k"));
const kName = "name";
function read(o) { return o[key]; }
function write(o, v) { o[key] = v; }
function readName(o) { return o[kName]; }

const a = {};
write(a, 1);
console.log(read(a), read({}), readName({ name: "n" }));

// the binding now holds other keys: a string, an index-like string, a number, a built string
const keys = ["plain", "7", 7, ["bu", "ilt"].join(""), Symbol.for("shared")];
const results = [];
for (const k of keys) {
  setKey(k);
  const o = {};
  write(o, String(k).length);
  results.push(read(o), Object.keys(o).join() || "(symbol)");
}
console.log(results.join(" "));

// getters, setters, a proxy, a frozen object, a primitive receiver
setKey(Symbol("again"));
const log = [];
const proto = {
  get [key]() { log.push("get"); return "from getter"; },
  set [key](v) { log.push("set " + v); },
};
const child = Object.create(proto);
write(child, 5);
console.log(read(child), Object.getOwnPropertySymbols(child).length, log.join(","));
const proxy = new Proxy({}, { get: (t, k) => typeof k, set: (t, k, v) => (log.push("trap " + v), true) });
write(proxy, 9);
console.log(read(proxy), log.at(-1));
const frozen = Object.freeze({});
try { write(frozen, 1); } catch (e) { console.log(e.constructor.name); }
console.log(String(read("str")), readName(Object.assign(Object.create({ name: "inherited" }), {})));
for (const bad of [null, undefined]) {
  try { read(bad); } catch (e) { console.log(e.constructor.name, e.message.includes("Symbol(again)")); }
  try { write(bad, 1); } catch (e) { console.log(e.constructor.name); }
}
// many shapes through one keyed site, then the key back to an earlier one
const many = [];
for (let i = 0; i < 20; i++) {
  const o = { ["f" + i]: i };
  write(o, i * 2);
  many.push(read(o));
}
console.log(many.join(","));
