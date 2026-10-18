// f.apply(t, args) and f.call(t, …) called directly when the method is the built-in (specialize):
// each way out of the shortcut, and the arrays it copies.
"use strict";
function f(...a) { return [this && this.tag, a.length, ...a].join(","); }
const o = { tag: "o" };
const outs = [];
outs.push(f.apply(o, [1, 2]), f.apply(o), f.apply(o, null), f.apply(o, { length: 2, 0: "x", 1: "y" }), f.apply(o, [1, , 3]));
outs.push(f.apply(o, Array.from({ length: 12 }, (_, i) => i)));
outs.push(f.call(o), f.call(o, 1), f.call(o, 1, 2, 3), f.call());
const fake = { apply() { return "own apply"; }, call() { return "own call"; } };
outs.push(fake.apply(o, [1]), fake.call(o, 1));
const g = function () { return "g"; };
g.apply = () => "patched";
outs.push(g.apply(o, []));
try { (class K {}).apply(o, []); } catch (e) { outs.push(e.constructor.name + ": " + e.message); }
try { f.apply(o, 5); } catch (e) { outs.push(e.constructor.name + ": " + e.message); }
const arr = [1, 2];
function mut(...x) { arr.push(9); return x.join("+"); }
outs.push(mut.apply(null, arr), arr.length);
console.log(outs.join(" | "));
