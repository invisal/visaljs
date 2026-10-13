// Async functions: state machines resumed by the promises they await.
var log = [];

// runs synchronously to the first await; the rest runs as microtasks
async function steps(name) {
  log.push(name + " start");
  var a = await 1;
  log.push(name + " after 1: " + a);
  var b = await Promise.resolve(2);
  log.push(name + " after 2: " + b);
  return a + b;
}
var p1 = steps("A");
var p2 = steps("B");
log.push("sync");
p1.then(function (v) { log.push("A result " + v); });

// interleaving with plain reactions: await on a native promise takes one tick
Promise.resolve().then(function () { log.push("then 1"); }).then(function () { log.push("then 2"); });

// throw and try/catch/finally across awaits
async function fails() {
  try {
    await Promise.reject(new Error("rejected"));
  } catch (e) {
    log.push("caught " + e.message);
  } finally {
    log.push("finally");
  }
  await null;
  throw new TypeError("thrown after await");
}
fails().catch(function (e) { log.push("fails rejected: " + e.name + ": " + e.message); });

// errors before the first await (even in parameter defaults) reject; they never throw
async function early(x = undefinedName) { return x; }
var pe = early();
log.push("early returned a promise: " + (pe instanceof Promise));
pe.catch(function (e) { log.push("early rejected: " + e.name); });

// loops, closures and the values live across each await
async function sum(n) {
  var total = 0;
  for (let i = 1; i <= n; i++) {
    total += await new Promise(function (resolve) { resolve(i); });
  }
  return total;
}
sum(10).then(function (v) { log.push("sum " + v); });

// arrows keep `this` and `arguments` of the enclosing function; methods and class members
var obj = {
  base: 100,
  async add(x) { var y = await x; return this.base + y; },
  later() { return (async () => this.base + (await 1) + arguments.length)("ignored"); },
};
obj.add(5).then(function (v) { log.push("method " + v); });
obj.later().then(function (v) { log.push("arrow " + v); });

class Counter {
  constructor() { this.n = 0; }
  async tick() { await null; return ++this.n; }
  static async make() { var c = new Counter(); await c.tick(); return c; }
}
Counter.make().then(function (c) { log.push("class " + c.n); });

// awaiting a thenable, and returning one
async function thenables() {
  var v = await { then: function (resolve) { resolve("from thenable"); } };
  return { then: function (resolve) { resolve(v + "!"); } };
}
thenables().then(function (v) { log.push(v); });

// await in nested expressions: the temporaries survive the pause
async function exprs() {
  function pair(a, b) { return a + "/" + b; }
  return pair(await "x", [await "y", await "z"].join(""));
}
exprs().then(function (v) { log.push("exprs " + v); });

// async function objects
log.push(typeof steps + " " + (Object.getPrototypeOf(steps) !== Function.prototype));
log.push(Object.prototype.toString.call(steps) + " " + ("prototype" in steps));
try { new steps("C"); } catch (e) { log.push("new: " + e.name); }

function drain(n) { return n ? Promise.resolve().then(function () { return drain(n - 1); }) : Promise.resolve(); }
drain(30).then(function () { print(log.join("\n")); });
