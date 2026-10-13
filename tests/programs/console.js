// console and util.inspect from the host prelude, compared with Node's output.
import util from "node:util";

/* errors print their stack; visaljs records no frames, and Node
 * records none with this, so both print [Error: message] */
Error.stackTraceLimit = 0;

const o = {};
for (let i = 0; i < 8; i++) o["key" + i] = "value" + i;
console.log(o);
const long40 = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
console.log({ a: long40, b: long40 });
(function () { console.log(arguments); })(1, "a");
console.log(new WeakMap(), new WeakSet(), Promise.resolve(4), new Promise(() => {}));
const rejected = Promise.reject(new RangeError("r"));
rejected.catch(() => {});
console.log(rejected);
const e = new Error("boom");
e.code = "E1";
console.log(e);
console.log({ e, list: [new TypeError("t")] });
class MyErr extends Error {}
console.log(new MyErr("m"), new Error("with cause", { cause: "why" }));
const nums = [];
for (let i = 1; i <= 27; i++) nums.push(i);
console.log(nums);
const strs = [];
for (let i = 0; i < 30; i++) strs.push("s" + i);
console.log(strs);
const many = [];
for (let i = 0; i < 120; i++) many.push(i);
console.log(many);
async function af() {}
function* gf() {}
async function* agf() {}
class A {}
class B extends A {}
function f() {}
f.p = 1;
console.log(af, gf, agf, A, B, () => {}, f, function () {}, f.bind(null));
console.log({ a: { b: { c: { d: 1 } } } }, [[[[1]]]], { arr: [[1, [2, [3]]]] });
const c = { name: "c" };
c.self = c;
c.list = [c, { back: c }];
console.log(c);
console.log("%s|%d|%i|%f|%j|%o|%O|%%|%c.", "s", 42.5, "42.9px", "1.5e3x", { j: [1, "x"] }, [1], { O: 1 }, "css", "extra", 7);
console.log("%s %s %s %s", { a: 1 }, [1, 2], null, Symbol("q"), "rest");
console.log("%d %i", "abc", -0, "100%", "%%", "%x");
console.log(Object.create(null), [1, , 3], [, , ], Symbol("s"), -0, [undefined, null], { [Symbol("k")]: 1, "a-b": 2, get g() { return 1; }, set s(v) {}, get gs() { return 1; }, set gs(v) {} });
console.log("it's", ["it's", "say \"hi\"", "it's \"x\"", "a\nb\x01\x7f\ud800", "tab\there"]);
class Point { constructor(x, y) { this.x = x; this.y = y; } }
console.log(new Point(1, 2), [new Point(3, 4)], Object.create(Point.prototype));
const tagged = { [Symbol.toStringTag]: "Custom" };
Object.defineProperty(tagged, Symbol.toStringTag, { enumerable: false });
console.log(tagged, { [util.inspect.custom]() { return "custom!"; } }, { [util.inspect.custom]() { return { replaced: true }; } });
const hidden = { visible: 1 };
Object.defineProperty(hidden, "secret", { value: 2, enumerable: false });
console.log(hidden, util.inspect(hidden, { showHidden: true }), util.inspect({ a: { b: { c: {} } } }, { depth: 0 }));
console.log(util.format("%s=%d", "x", 5, "more"), util.inspect("str"), util.inspect([1, 2], { compact: false }));
/* sorted: an object's, a Map's and a Set's entries, an array's named properties only; getters: their values */
const unsorted = Object.assign([3, 1, 2], { z: 1, b: 2 });
console.log(util.inspect({ b: 1, a: { d: 2, c: 3 }, m: new Map([["y", 1], ["x", 2]]), s: new Set([2, 1]) }, { sorted: true }), util.inspect(unsorted, { sorted: true }));
const accessors = { get num() { return 1; }, get nil() { return null; }, get obj() { return { k: [1] }; }, get bad() { throw new Error("nope"); }, get both() { return "b"; }, set both(v) {}, set only(v) {} };
console.log(util.inspect(accessors, { getters: true }), util.inspect(accessors, { getters: "get" }), util.inspect(accessors, { getters: "set" }), util.inspect(accessors));
console.log("a very long string that goes past the break length of eighty characters for sure, yes", ["a very long string that goes past the break length of eighty characters\nwith a newline"]);
console.error("to stderr");
console.warn({ warn: true });
console.info("info"); console.debug("debug");
console.group("Group A");
console.log("inside\nmultiline");
console.group();
console.log({ nested: [1, 2] });
console.groupEnd();
console.groupEnd();
console.log("outside");
console.count(); console.count(); console.count("x"); console.countReset(); console.count();
console.assert(true, "never"); console.assert(false, "printed %s", "on stderr"); console.assert(false);
console.dir({ a: { b: { c: { d: 1 } } } }, { depth: 0 });
console.log();
console.log(undefined, null, true, 3.14, NaN, -Infinity, "");
