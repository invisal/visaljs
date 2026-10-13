// Generators: state machines resumed by next/throw/return.
function* range(n) { for (let i = 0; i < n; i++) yield i; }
print([...range(5)].join(","));
function r(res) { return res.value + (res.done ? "!" : ""); }

// values flow both ways; return ends it
function* echo() { var x = yield "first"; var y = yield x * 2; return x + y; }
var g = echo();
print([r(g.next()), r(g.next(5)), r(g.next(1)), r(g.next()), r(g.next())].join(" "));

// the prologue runs at call time: defaults, arguments; the body on the first next()
var log = [];
function* lazy(a = (log.push("default"), 1)) { log.push("body " + a + " " + arguments.length); yield a; }
var lz = lazy();
log.push("created");
lz.next();
print(log.join(", "));

// temporaries and locals live across pauses
function pair(a, b) { return a + "/" + b; }
function* temps() { var t = "local"; var s = pair(t, yield 1); yield s + " " + (yield 2) + " " + t; }
var tg = temps();
print([r(tg.next()), r(tg.next("A")), r(tg.next("B")), r(tg.next())].join(" "));

// throw() and return(): at the start, suspended, completed
function* guarded() {
  try { yield 1; yield 2; }
  catch (e) { yield "caught " + e; }
  finally { log.push("finally"); }
  return "end";
}
log = [];
var gg = guarded();
print([r(gg.next()), r(gg.throw("boom")), r(gg.next()), r(gg.next())].join(" ") + " [" + log.join() + "]");
log = [];
gg = guarded();
gg.next();
print(r(gg.return("early")) + " [" + log.join() + "] " + r(gg.next()));
gg = guarded();
print(r(gg.return("never started")) + " " + r(gg.next()));
gg = guarded();
try { gg.throw(new Error("before start")); } catch (e) { print("rethrown: " + e.message + " " + r(gg.next())); }
var done = range(0);
done.next();
try { done.throw("after end"); } catch (e) { print("completed rethrows: " + e); }

// a finally can yield during return(), and override it
function* stubborn() { try { yield "a"; } finally { yield "cleanup"; return "overridden"; } }
var sg = stubborn();
sg.next();
print([r(sg.return("asked")), r(sg.next()), r(sg.next())].join(" "));

// re-entry
function* reenter() { try { it2.next(); } catch (e) { yield e.constructor.name + ": " + e.message; } }
var it2 = reenter();
print(r(it2.next()));

// yield*: generators, iterables, return values, forwarding throw/return
function* inner() { var got = yield "in1"; yield "in2 " + got; return "inner result"; }
function* outer() { var res = yield* inner(); yield "outer got " + res; yield* [7, 8]; yield* "hi"; }
var og = outer();
var outs = [r(og.next()), r(og.next("sent"))];
for (var o of og) outs.push(o);
print(outs.join(" | "));
function* thrower() { try { yield 1; } catch (e) { yield "inner caught " + e; } }
function* delegate() { yield* thrower(); }
var dg = delegate();
dg.next();
print(r(dg.throw("x")));
log = [];
var custom = { [Symbol.iterator]() { return this; }, next() { return { value: "c", done: false }; }, return(v) { log.push("return " + v); return { value: "ret", done: true }; } };
function* delegateCustom() { try { yield* custom; } finally { log.push("outer finally"); } }
var cg = delegateCustom();
cg.next();
print(r(cg.return("R")) + " [" + log.join(", ") + "]");
var noThrow = { [Symbol.iterator]() { return this; }, next() { return { value: 1, done: false }; }, return() { log.push("closed"); return {}; } };
function* delegateNoThrow() { yield* noThrow; }
log = [];
var ng = delegateNoThrow();
ng.next();
try { ng.throw("t"); } catch (e) { print(e.constructor.name + " [" + log.join() + "]"); }
var passthrough = { [Symbol.iterator]() { return this; }, next() { return { value: "raw", done: false, extra: true }; } };
function* delegateRaw() { yield* passthrough; }
print(delegateRaw().next().extra);

// for…of break and destructuring close the generator
log = [];
function* closable() { try { yield 1; yield 2; yield 3; } finally { log.push("closed"); } }
for (var v of closable()) if (v === 2) break;
var [first] = closable();
print(first + " [" + log.join() + "]");

// methods, expressions, closures, recursion
var obj = { *items() { yield "m1"; yield "m2"; }, *[Symbol.iterator]() { yield* this.items(); } };
print([...obj].join());
class Tree {
  constructor(v, l, rt) { this.v = v; this.l = l; this.r = rt; }
  *[Symbol.iterator]() { if (this.l) yield* this.l; yield this.v; if (this.r) yield* this.r; }
  static *count(n) { while (n > 0) yield n--; }
}
print([...new Tree(2, new Tree(1), new Tree(3))].join() + " " + [...Tree.count(3)].join());
var genExpr = function* () { var k = 0; while (true) yield k++; };
var nat = genExpr(), firstFive = [];
for (var n of nat) { if (n >= 5) break; firstFive.push(n); }
print(firstFive.join());
function* counters() { for (let i = 0; i < 3; i++) yield function () { return i; }; }
print([...counters()].map(function (f) { return f(); }).join());

// the object model
function* gf() {}
var gi = gf();
print(Object.getPrototypeOf(gi) === gf.prototype);
print(Object.getPrototypeOf(gf.prototype) === Object.getPrototypeOf(function* () {}).prototype);
print(gi[Symbol.iterator]() === gi);
print(typeof gi.next + " " + gf.prototype.hasOwnProperty("constructor"));
try { new gf(); } catch (e) { print(e.constructor.name); }
gf.prototype = null;
print(Object.getPrototypeOf(gf()) === Object.getPrototypeOf(Object.getPrototypeOf(gi)));
