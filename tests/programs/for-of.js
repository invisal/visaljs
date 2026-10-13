// for…of and the iterator protocol (§7.4, §14.7.5).
var out = [];
for (var x of [1, 2, 3]) out.push(x);
print(out.join(","));
out = [];
for (const ch of "a😀b") out.push(ch);
print(out.length + " " + out.join("|"));
out = [];
for (let k of [].slice(0)) out.push(k);  // no iterations
print(out.length);

// a user-defined iterable that logs what the loop does to it
var log = [];
function counter(n, opts) {
  opts = opts || {};
  var i = 0;
  var it = {
    next: function () { log.push("next"); i++; return i <= n ? { value: i, done: false } : { value: "end", done: true }; },
    [Symbol.iterator]: function () { log.push("get"); return it; },
  };
  if (!opts.noReturn) it.return = function () { log.push("return"); if (opts.throwInReturn) throw new Error("from return"); return {}; };
  return it;
}
function run(label, f) { log = []; try { print(label + ": " + f() + " [" + log.join(" ") + "]"); } catch (e) { print(label + ": threw " + e.message + " [" + log.join(" ") + "]"); } }

run("all", function () { var s = 0; for (var v of counter(3)) s += v; return s; });
run("break", function () { for (var v of counter(3)) if (v === 2) break; return v; });
run("return", function () { for (var v of counter(3)) if (v === 2) return "early"; });
run("throw", function () { for (var v of counter(3)) if (v === 2) throw new Error("body"); });
run("continue", function () { var s = 0; for (var v of counter(3)) { if (v === 2) continue; s += v; } return s; });
run("labelled continue", function () {
  var s = "";
  outer: for (var a of [1, 2]) { for (var v of counter(3)) { s += a + "" + v + " "; continue outer; } }
  return s;
});
run("no return method", function () { for (var v of counter(3, { noReturn: true })) break; return "ok"; });
run("return throws on break", function () { for (var v of counter(3, { throwInReturn: true })) break; return "unreached"; });
run("return throws after a throw", function () { for (var v of counter(3, { throwInReturn: true })) throw new Error("body wins"); });
run("finally", function () {
  var r = "";
  for (var v of counter(3)) { try { return "from try"; } finally { log.push("finally"); } }
  return r;
});

// a next() that throws or returns a non-object doesn't close
var bad = { [Symbol.iterator]() { return { next() { throw new Error("next failed"); }, return() { log.push("return"); } }; } };
run("next throws", function () { for (var v of bad); });
var prim = { [Symbol.iterator]() { return { next() { return 1; }, return() { log.push("return"); } }; } };
run("next not an object", function () { for (var v of prim); });
try { for (var v of 5); } catch (e) { print(e.constructor.name + ": " + e.message); }
try { for (var v of {}); } catch (e) { print(e.constructor.name); }  // V8 quotes the source text

// per-iteration let, member targets
var fns = [];
for (let n of [1, 2, 3]) fns.push(function () { return n; });
print(fns.map(function (f) { return f(); }).join(","));
var o = {};
for (o.last of ["p", "q"]);
print(o.last);

// the built-in iterators
var it = [7, 8][Symbol.iterator]();
print(JSON_like(it.next()) + " " + JSON_like(it.next()) + " " + JSON_like(it.next()));
function JSON_like(r) { return "{" + r.value + "," + r.done + "}"; }
out = [];
for (var e of ["a", "b"].entries()) out.push(e[0] + "=" + e[1]);
print(out.join(" "));
out = [];
for (var k of ["a", "b"].keys()) out.push(k);
print(out.join(" "));
print(Array.prototype[Symbol.iterator] === Array.prototype.values);
print(Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) === Object.getPrototypeOf(Object.getPrototypeOf(""[Symbol.iterator]())));
var sit = "xy"[Symbol.iterator]();
print(sit[Symbol.iterator]() === sit);
function args() { var r = []; for (var a of arguments) r.push(a); return r.join(""); }
print(args("q", "r", "s"));

// spread uses the protocol
print([...counter(2)].join(",") + " [" + log.join(" ") + "]");
function max3(a, b, c) { return a > b ? (a > c ? a : c) : (b > c ? b : c); }
print(max3(...counter(3)));
print([..."héllo"].length);
var holes = [1, , 3];
print([...holes].length + " " + (1 in [...holes]));

// patching the array iterator is seen (no fast path then)
var saved = Array.prototype[Symbol.iterator];
Array.prototype[Symbol.iterator] = function () { var done = false; return { next: function () { var r = { value: "patched", done: done }; done = true; return r; } }; };
out = [];
for (var p of [1, 2, 3]) out.push(p);
print(out.join(","));
Array.prototype[Symbol.iterator] = saved;
