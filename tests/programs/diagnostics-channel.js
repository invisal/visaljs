// node:diagnostics_channel: channels, subscribers, bound stores, and TracingChannel's
// traceSync / tracePromise / traceCallback
import dc from "node:diagnostics_channel";
import { channel, hasSubscribers, subscribe, unsubscribe, tracingChannel, Channel } from "node:diagnostics_channel";

const log = (...args) => console.log(...args);

log("exports:", Object.keys(dc).sort().join(", "));

/* a channel: the same object per name; inactive until subscribed */
const ch = channel("app:query");
log("same channel:", ch === channel("app:query"), ch instanceof Channel, ch.name);
log("inactive:", ch.hasSubscribers, hasSubscribers("app:query"), hasSubscribers("never:made"));
ch.publish({ ignored: true });

const seen = (message, name) => log("seen", JSON.stringify(message), name);
ch.subscribe(seen);
log("active:", ch.hasSubscribers, hasSubscribers("app:query"), ch instanceof Channel);
ch.publish({ sql: "SELECT 1" });
log("unsubscribe:", ch.unsubscribe(seen), ch.unsubscribe(seen), ch.hasSubscribers);
ch.publish({ sql: "nobody hears" });

/* the module's subscribe / unsubscribe, a symbol name */
const sym = Symbol("sym-channel");
const onSym = (message, name) => log("symbol channel:", message, name.toString());
subscribe(sym, onSym);
channel(sym).publish(42);
log("module unsubscribe:", unsubscribe(sym, onSym), unsubscribe(sym, onSym));

/* a subscriber that unsubscribes while publishing: the rest of this publish still runs */
const busy = channel("busy");
const first = () => {
  log("first, unsubscribing the second");
  busy.unsubscribe(second);
};
const second = () => log("second still runs this time");
busy.subscribe(first);
busy.subscribe(second);
busy.publish();
busy.publish();

/* bad arguments */
for (const bad of [() => channel(1), () => tracingChannel(5), () => tracingChannel({ start: 1 }), () => ch.subscribe("x")]) {
  try {
    bad();
  } catch (e) {
    log(e.name, e.code, e.message);
  }
}

/* bound stores: runStores runs fn in each store's context, transformed */
const store = {
  value: undefined,
  run(value, fn) {
    const saved = this.value;
    this.value = value;
    try {
      return fn();
    } finally {
      this.value = saved;
    }
  },
};
const withStore = channel("with-store");
withStore.bindStore(store, (data) => ({ user: data.user }));
log("store active:", withStore.hasSubscribers);
log("runStores:", withStore.runStores({ user: "ada" }, function (a, b) {
  return `${JSON.stringify(store.value)} ${this.tag} ${a + b}`;
}, { tag: "this" }, 1, 2));
log("unbindStore:", withStore.unbindStore(store), withStore.unbindStore(store), withStore.hasSubscribers);
log("runStores inactive:", channel("idle").runStores({}, (x) => x * 2, undefined, 21));

/* TracingChannel */
const tc = tracingChannel("db");
log("tracing channels:", tc.start.name, tc.end.name, tc.asyncStart.name, tc.asyncEnd.name, tc.error.name);
log("no subscribers:", tc.hasSubscribers, tc.traceSync((a) => a + 1, {}, null, 1));

const events = [];
const handlers = Object.fromEntries(["start", "end", "asyncStart", "asyncEnd", "error"].map((name) => [name, (ctx) => {
  events.push(`${name}(${"result" in ctx ? `result=${ctx.result}` : ""}${"error" in ctx ? `error=${ctx.error.message}` : ""})`);
}]));
tc.subscribe(handlers);
log("subscribed:", tc.hasSubscribers);

log("traceSync:", tc.traceSync(function (a, b) { return this.k + a + b; }, { op: "sum" }, { k: 10 }, 1, 2), events.splice(0).join(" "));
try {
  tc.traceSync(() => { throw new Error("sync boom"); });
} catch (e) {
  log("traceSync threw:", e.message, events.splice(0).join(" "));
}

/* from channels of one's own */
const own = tracingChannel({ start: channel("o:start"), end: channel("o:end"), asyncStart: channel("o:as"), asyncEnd: channel("o:ae"), error: channel("o:err") });
log("own channels:", own.start.name, own.error.name, own.hasSubscribers);

const results = await (async () => {
  const out = [];
  out.push(await tc.tracePromise(async (x) => x * 2, {}, null, 21), events.splice(0).join(" "));
  try {
    await tc.tracePromise(async () => { throw new Error("async boom"); });
  } catch (e) {
    out.push(`rejected: ${e.message}`, events.splice(0).join(" "));
  }
  out.push(await tc.tracePromise(() => ({ then: (resolve) => resolve("thenable") })), events.splice(0).join(" "));
  await new Promise((resolve) => {
    tc.traceCallback((a, cb) => setTimeout(() => cb(null, a + "!"), 1), -1, {}, null, "cb", (err, value) => {
      out.push(`callback: ${err} ${value}`);
      resolve();
    });
  });
  out.push(events.splice(0).join(" "));
  await new Promise((resolve) => {
    tc.traceCallback((cb) => setTimeout(() => cb(new Error("cb boom")), 1), 0, {}, null, (err) => {
      out.push(`callback error: ${err.message}`);
      resolve();
    });
  });
  out.push(events.splice(0).join(" "));
  try {
    tc.traceCallback(() => {}, -1, {}, null, "not a function");
  } catch (e) {
    out.push(`${e.code}: ${e.message}`);
  }
  return out;
})();
for (const line of results) log(line);

log("unsubscribe all:", tc.unsubscribe(handlers), tc.unsubscribe(handlers), tc.hasSubscribers);

/* a subscriber's error doesn't stop the others; it is an uncaught exception on the next tick */
process.on("uncaughtException", (err) => log("uncaught:", err.message));
const loud = channel("loud");
loud.subscribe(() => {
  throw new Error("subscriber failed");
});
loud.subscribe(() => log("the next subscriber still runs"));
loud.publish("x");
log("publish returned");
