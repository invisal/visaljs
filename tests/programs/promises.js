// Promises and the microtask queue: reactions run after the script, in order.
var log = [];
function show(label) { return function (v) { log.push(label + ":" + v); return v; }; }

// then callbacks run as microtasks, after the synchronous code
Promise.resolve(1).then(show("a"));
log.push("sync");
queueMicrotask(function () { log.push("micro"); });
Promise.reject(new Error("no")).catch(function (e) { log.push("caught:" + e.message); });

// chains: each then waits one tick; a returned promise (a thenable) takes two more
Promise.resolve("x").then(show("c1")).then(show("c2")).then(show("c3"));
Promise.resolve("y").then(function () { return Promise.resolve("inner"); }).then(show("adopted"));

// the executor runs synchronously; resolve and reject only count once
var p = new Promise(function (resolve, reject) {
  log.push("executor");
  resolve("first");
  resolve("second");
  reject(new Error("ignored"));
});
p.then(show("once"));

// throwing in a handler rejects the derived promise; finally passes values through
Promise.resolve(2)
  .then(function () { throw new TypeError("bad"); })
  .then(show("skipped"), function (e) { return e.name; })
  .finally(function () { log.push("finally"); })
  .then(show("after-finally"));

// combinators
function later(v, ticks) {
  var q = Promise.resolve(v);
  for (var i = 0; i < ticks; i++) q = q.then(function (x) { return x; });
  return q;
}
Promise.all([later(1, 3), 2, later(3, 1)]).then(function (vs) { log.push("all:" + vs.join(",")); });
Promise.all([later(1, 1), Promise.reject("r")]).catch(show("all-rejected"));
Promise.race([later("slow", 3), later("fast", 1)]).then(show("race"));
Promise.any([Promise.reject("e1"), later("ok", 2)]).then(show("any"));
Promise.any([Promise.reject("e1"), Promise.reject("e2")]).catch(function (e) {
  log.push("any-failed:" + e.name + ":" + e.errors.join(","));
});
Promise.allSettled([Promise.resolve(1), Promise.reject(2)]).then(function (rs) {
  log.push("settled:" + rs.map(function (r) { return r.status + "=" + (r.status === "fulfilled" ? r.value : r.reason); }).join(","));
});

// a chaining cycle, a thenable object, withResolvers
var cyc = Promise.resolve().then(function () { return cyc; });
cyc.catch(function (e) { log.push("cycle:" + e.constructor.name); });
Promise.resolve({ then: function (res) { res("thenable"); } }).then(show("thenable"));
var wr = Promise.withResolvers();
wr.promise.then(show("with-resolvers"));
wr.resolve("done");

// subclassing: then builds the derived promise through the species constructor
class MyPromise extends Promise {}
var mp = MyPromise.resolve(5).then(function (v) { return v * 2; });
log.push("subclass:" + (mp instanceof MyPromise));
mp.then(show("my"));

print(Object.prototype.toString.call(p) + " " + typeof Promise.prototype.then);
queueMicrotask(function () {
  // runs after everything queued before it, but jobs it queues still run in this checkpoint
  Promise.resolve().then(function () { lateJob(); });
});
function lateJob() { log.push("late"); }

// print the log once the queue has drained: a long chain ends last
later(0, 12).then(function () { print(log.join("\n")); });
