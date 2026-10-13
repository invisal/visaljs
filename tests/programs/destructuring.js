// visaljs-flags: --script
// Destructuring (§8.6.2, §13.15.5): binding and assignment patterns.
var { a, b: [c, d = "d-default"], ...others } = { a: 1, b: [3], e: 5, f: 6 };
print(a + " " + c + " " + d + " " + Object.keys(others).join(","));
let [x, , y = 10, ...tail] = [1, 2, undefined, 4, 5];
print(x + " " + y + " " + tail.join(","));
const { length } = "hello";
print(length);
const [h, i, ...j] = "héllo";
print(h + i + " " + j.length);
var { 0: first, [1 + 1]: third } = ["zero", "one", "two"];
print(first + " " + third);

// defaults: used for undefined only; anonymous functions get the binding's name
var { f = function () {}, g = () => 1, n = null } = { n: undefined };
print(f.name + " " + g.name + " " + n);
var [p = "used"] = [null];
print(p);

// parameters
function params({ name, tags: [firstTag = "none"] = [] }, [k, v] = ["k", "v"], ...[r1, r2]) {
  return name + " " + firstTag + " " + k + "=" + v + " " + r1 + r2;
}
print(params({ name: "n" }, undefined, "r", "s"));
print(params({ name: "m", tags: ["t"] }, ["key", "val"]));
print(params.length);
var arrow = ({ w }, [z]) => w + z;
print(arrow({ w: 1 }, [2]));

// catch and for heads
try { throw { code: 42, detail: ["disk"] }; } catch ({ code, detail: [what] }) { print(code + " " + what); }
for (const [key, value] of [["one", 1], ["two", 2]]) print(key + value);
for (const { id, ...rest } of [{ id: 1, v: "a" }]) print(id + Object.keys(rest).join());
for (var [ch1, ch2] in { ab: 1 }) print(ch1 + "," + ch2);

// assignment patterns: any target, the value is the result, swaps
var o = {}, arr = [];
var result = ({ a: o.a, b: arr[0], c: o["c" + 1] = "dflt" } = { a: "A", b: "B" });
print(o.a + arr[0] + o.c1 + " " + (result.a === "A"));
var s = 1, t = 2;
[s, t] = [t, s];
print(s + " " + t);
var q, rest2;
({ q, ...rest2 } = { q: 1, r: 2, [Symbol.for("sym")]: 3 });
print(q + " " + Object.keys(rest2).join() + " " + Object.getOwnPropertySymbols(rest2).length);
[o.x, ...o.more] = "xyz";
print(o.x + o.more.join(""));

// evaluation order: targets before values, left to right
var log = [];
function tgt(name) { log.push("target " + name); return {}; }
var src = { get a() { log.push("get a"); return 1; }, get b() { log.push("get b"); return 2; } };
({ a: tgt("a").p, b: tgt("b").p } = src);
print(log.join(" | "));

// array patterns close the iterator unless it was exhausted
function iter(n, events) {
  var i = 0;
  return { [Symbol.iterator]() { return this; }, next() { i++; events.push("next"); return { value: i, done: i > n }; }, return() { events.push("return"); return {}; } };
}
var ev = [];
var [m1] = iter(3, ev);
print(m1 + " " + ev.join(","));
ev = [];
var [m2, m3, m4, m5] = iter(2, ev);
print(m2 + " " + m4 + " " + ev.join(","));
ev = [];
var [...all] = iter(2, ev);
print(all.join() + " " + ev.join(","));
ev = [];
try { var [z1 = (function () { throw new Error("default threw"); })()] = iter(3, ev); } catch (e) { print(e.message + " " + ev.join(",")); }

// errors
try { var { nope } = null; } catch (e) { print(e.constructor.name); }
try { var [nope2] = {}; } catch (e) { print(e.constructor.name); }
try { let { u = v, v } = {}; } catch (e) { print(e.constructor.name); }
const { frozen } = { frozen: 1 };
try { ({ frozen } = { frozen: 2 }); } catch (e) { print(e.constructor.name); }
var { toString: numToString } = 5;
print(typeof numToString);
