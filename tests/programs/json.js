// JSON: parse (with reviver and its source context), stringify (replacer, space, toJSON,
// wrappers, cycles), rawJSON/isRawJSON, and util.format's %j.
import { format } from "node:util";

console.log(JSON, Object.prototype.toString.call(JSON));
const value = JSON.parse('{"b": [1, -0, 2.5e3, "x\\u00e9\\ud83d\\ude00", true, null], "a": {"__proto__": 7, "2": "two", "1": "one"}, "": {}}');
console.log(value, Object.keys(value.a), Object.getPrototypeOf(value.a) === Object.prototype, Object.is(value.b[1], -0));
console.log(JSON.parse(" [ ] "), JSON.parse('"\\/\\b\\f\\n\\r\\t\\"\\\\"'), JSON.parse("1E+2"), JSON.parse("-0"), JSON.parse('{"a":1,"a":2}'));

// the reviver: bottom-up, `this` is the holder, undefined deletes, context.source for unchanged primitives
const log = [];
const revived = JSON.parse('{"n": 1.50, "s": "t", "list": [10, 20, 30], "o": {"deep": false}}', function (key, val, context) {
  log.push(`${JSON.stringify(key)} ${typeof val} ${JSON.stringify(context)} ${this === undefined}`);
  if (key === "0") this[1] = 99;
  if (key === "s") return undefined;
  return typeof val === "number" ? val * 2 : val;
});
console.log(log.join("\n"));
console.log(revived);

// stringify
const nested = { s: "q\"\\\n\u0001\ud800", n: [1, -0, NaN, Infinity, 1e21, 0.1], u: undefined, f() {}, sym: Symbol("x"), nil: null };
console.log(JSON.stringify(nested));
console.log(JSON.stringify(nested, null, 2));
console.log(JSON.stringify([[], {}, [{}], { a: [] }], null, "--"));
console.log(JSON.stringify({ a: 1, b: [1, 2] }, null, "abcdefghijklmnop"), JSON.stringify([1], null, 20), JSON.stringify([1], null, new Number(3)), JSON.stringify([1], null, new String("\t")));
console.log(JSON.stringify(undefined), JSON.stringify(() => 1), JSON.stringify(Symbol()), JSON.stringify("x"), JSON.stringify(null), JSON.stringify([undefined, () => 1, Symbol()]));
console.log(JSON.stringify({ toJSON(key) { return `toJSON(${key})`; } }), JSON.stringify({ x: { toJSON(key) { return key + "!"; } } }), JSON.stringify([{ toJSON(k) { return k; } }]));
console.log(JSON.stringify([new Number(3), new String("s"), new Boolean(false), Object(Symbol())]));
console.log(JSON.stringify({ a: 1, b: 2, c: { a: 3, d: 4 }, 1: "one" }, ["a", "c", 1, "a", new String("b"), {}]));
console.log(JSON.stringify({ a: 1, b: [2, { c: 3 }] }, function (key, val) { return typeof val === "number" ? val + 100 : val; }));
console.log(JSON.stringify({ a: 1 }, function (key, val) { return key === "" ? [this[""] === val, key] : val; }));
console.log(JSON.stringify("  "), JSON.stringify({ "😀": "\udc00" }), JSON.stringify([,1]), JSON.stringify(Object.create({ inherited: 1 })));

// cycles
function cycle(f) {
  try {
    JSON.stringify(f());
  } catch (e) {
    console.log(e.name + ": " + e.message);
  }
}
cycle(() => { const a = {}; a.self = a; return a; });
cycle(() => { const b = { x: { y: [1, {}] } }; b.x.y[1].back = b.x; return b; });
cycle(() => { class K { constructor() { this.k = { inner: [this] }; } } return new K(); });
cycle(() => { const r = { a: { b: { c: { d: { e: {} } } } } }; r.a.b.c.d.e.loop = r.a; return [r]; });
cycle(() => { const o = { "": {} }; o[""].again = o; return o; });
cycle(() => { const o = Object.create(null); o.me = o; return o; });

// rawJSON
const raw = JSON.rawJSON("1e1000");
console.log(raw, Object.isFrozen(raw), Object.getPrototypeOf(raw), JSON.isRawJSON(raw), JSON.isRawJSON({ rawJSON: "1" }));
console.log(JSON.stringify({ big: raw, list: [JSON.rawJSON('"s"'), JSON.rawJSON("null"), JSON.rawJSON("-0.10")] }));
for (const t of ["{}", "[]", " 1", "1 ", "", "abc", '"a', "1.", "tru", "1x"]) {
  try {
    JSON.rawJSON(t);
  } catch (e) {
    console.log(JSON.stringify(t), e.name, e.message);
  }
}

// %j is JSON.stringify; a cycle prints [Circular]
const circ = { name: "c" };
circ.me = circ;
console.log(format("%j %j %j %j", { a: [1, "b"] }, undefined, circ, "s"));
console.log("%j", new Number(2));

// deep nesting parses without recursion
const deep = JSON.parse("[".repeat(10000) + "]".repeat(10000));
let depth = 0;
for (let d = deep; Array.isArray(d) && d.length; d = d[0]) depth++;
console.log(depth);
console.log(JSON.parse.length, JSON.stringify.length, JSON.rawJSON.length, JSON.isRawJSON.name, Object.getOwnPropertyNames(JSON).join());
