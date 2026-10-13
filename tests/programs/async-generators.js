// Async generators and for await: queued requests, each answered by a promise.
var log = [];

async function* countdown(n) {
  while (n > 0) {
    await null;
    yield n--;
  }
  return "liftoff";
}

// for await over an async generator; over an array of promises (a sync iterable, wrapped)
async function consume() {
  for await (const x of countdown(3)) log.push("count " + x);
  var sum = 0;
  for await (const v of [1, Promise.resolve(2), 3]) sum += v;
  log.push("sum " + sum);
  return "consumed";
}

// next() calls queue up: each gets its own promise, settled in order
async function queued() {
  var g = countdown(2);
  var ps = [g.next(), g.next(), g.next(), g.next()];
  var rs = await Promise.all(ps);
  log.push("queued " + rs.map((r) => r.value + (r.done ? "!" : "")).join(" "));
}

// yield awaits its operand; return(v) awaits v; finally blocks run on return()
async function* guarded() {
  try {
    yield Promise.resolve("awaited");
    yield "second";
  } finally {
    log.push("finally ran");
  }
}
async function early() {
  var g = guarded();
  log.push("first " + (await g.next()).value);
  var r = await g.return(Promise.resolve("bye"));
  log.push("return " + r.value + " " + r.done);
  log.push("after " + (await g.next()).done);
}

// throw() lands in the generator's catch; errors reject the request's promise
async function* catcher() {
  try { yield 1; } catch (e) { yield "caught " + e; }
  throw new Error("boom");
}
async function errors() {
  var g = catcher();
  await g.next();
  log.push((await g.throw("x")).value);
  try { await g.next(); } catch (e) { log.push("rejected " + e.message); }
  log.push("done " + (await g.next()).done);
}

// breaking out of for await calls (and awaits) return()
async function breaks() {
  for await (const x of guarded()) {
    log.push("got " + x);
    break;
  }
  log.push("after break");
}

// yield* delegates to another async iterable, and to sync iterables
async function* inner() { yield "a"; yield "b"; return "inner done"; }
async function* outer() {
  var r = yield* inner();
  log.push("yield* gave " + r);
  yield* ["c", "d"];
}
async function delegation() {
  var all = [];
  for await (const x of outer()) all.push(x);
  log.push("delegated " + all.join(""));
}

// a hand-written async iterator
var ticker = {
  [Symbol.asyncIterator]() {
    var i = 0;
    return { next: () => Promise.resolve({ value: i, done: i++ >= 2 }), return: () => { log.push("ticker closed"); return {}; } };
  },
};
async function custom() {
  for await (const t of ticker) log.push("tick " + t);
  for await (const t of ticker) { log.push("one tick " + t); break; }
}

// async generator objects and methods
var obj = { async *items() { yield 1; } };
class Store { static async *keys() { yield "k"; } }
log.push(Object.prototype.toString.call(countdown(1)) + " " + typeof countdown.prototype.next);
log.push(Object.getPrototypeOf(obj.items) === Object.getPrototypeOf(Store.keys));

// tick ordering: each request, yield and for await step against a plain then chain
async function ticks() {
  var order = [];
  async function* g() { order.push("g1"); yield 1; order.push("g2"); yield Promise.resolve(2); return 3; }
  var it = g();
  var p = Promise.resolve();
  for (let i = 0; i < 10; i++) p = p.then(() => order.push("t" + i));
  it.next().then((r) => order.push("n" + r.value));
  it.next().then((r) => order.push("n" + r.value));
  it.return(Promise.resolve("r")).then((r) => order.push("ret " + r.value));
  for await (const x of [Promise.resolve("w1"), "w2"]) order.push(x);
  var inner = (async function* () { yield* (async function* () { yield "d1"; })(); })();
  inner.next().then((r) => order.push(r.value));
  await p;
  log.push(order.join(" "));
}

async function main() {
  log.push(await consume());
  await queued();
  await early();
  await errors();
  await breaks();
  await delegation();
  await custom();
  for await (const k of Store.keys()) log.push("static " + k);
  await ticks();
  print(log.join("\n"));
}
main();
