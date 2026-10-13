// node:events beyond EventEmitter's methods: errorMonitor, captureRejections, once and on with
// AbortSignals and EventTargets, the listener functions, addAbortListener and
// EventEmitterAsyncResource.
import events, {
  EventEmitter, EventEmitterAsyncResource, addAbortListener, captureRejectionSymbol, errorMonitor, getEventListeners,
  getMaxListeners, listenerCount, on, once, setMaxListeners,
} from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* errorMonitor hears an error first, and doesn't handle it */
{
  const e = new EventEmitter();
  e.on(errorMonitor, (err) => print("monitor: " + err.message));
  try {
    e.emit("error", new Error("boom"));
  } catch (err) {
    print("still thrown: " + err.message);
  }
}

/* captureRejections: an async listener's rejection becomes 'error', or goes to nodejs.rejection */
{
  const e = new EventEmitter({ captureRejections: true });
  e.on("job", async () => {
    throw new Error("rejected");
  });
  e.on("error", (err) => print("captured: " + err.message));
  e.emit("job");
  const f = new EventEmitter({ captureRejections: true });
  f[captureRejectionSymbol] = (err, type, ...args) => print("handler: " + err.message + " " + type + " " + args.join(","));
  f.on("work", async () => {
    throw new Error("nope");
  });
  f.emit("work", 1, 2);
  await tick();
  print("default captureRejections: " + EventEmitter.captureRejections + " " + (captureRejectionSymbol === Symbol.for("nodejs.rejection")));
}

/* once: arguments, an error, an abort, an EventTarget */
{
  const e = new EventEmitter();
  setTimeout(() => e.emit("ready", 1, "two"), 0);
  print("once: " + JSON.stringify(await once(e, "ready")));
  setTimeout(() => e.emit("error", new Error("bad")), 0);
  try {
    await once(e, "ready");
  } catch (err) {
    print("once rejected: " + err.message + " " + e.listenerCount("ready") + " " + e.listenerCount("error"));
  }
  const ac = new AbortController();
  const pending = once(e, "never", { signal: ac.signal });
  ac.abort();
  try {
    await pending;
  } catch (err) {
    print("once aborted: " + err.name + " " + err.code + " " + e.listenerCount("never"));
  }
  const target = new EventTarget();
  setTimeout(() => target.dispatchEvent(new Event("ping")), 0);
  const [event] = await once(target, "ping");
  print("EventTarget once: " + event.type);
}

/* on: buffered events, an error ends it, close events finish it, abort */
{
  const e = new EventEmitter();
  setTimeout(() => {
    e.emit("data", 1);
    e.emit("data", 2);
    e.emit("data", 3);
    e.emit("end");
  }, 0);
  const seen = [];
  for await (const [value] of on(e, "data", { close: ["end"] })) seen.push(value);
  print("on: " + seen.join(",") + " listeners left " + e.listenerCount("data") + e.listenerCount("error") + e.listenerCount("end"));

  const f = new EventEmitter();
  setTimeout(() => {
    f.emit("data", "a");
    f.emit("error", new Error("stream broke"));
  }, 0);
  try {
    for await (const [value] of on(f, "data")) print("on got " + value);
  } catch (err) {
    print("on threw: " + err.message);
  }

  const ac = new AbortController();
  const g = new EventEmitter();
  setTimeout(() => ac.abort(), 0);
  try {
    for await (const args of on(g, "data", { signal: ac.signal })) print("never " + args);
  } catch (err) {
    print("on aborted: " + err.name);
  }

  const h = new EventEmitter();
  const it = on(h, "x");
  h.emit("x", "early");
  print("on buffered: " + JSON.stringify(await it.next()));
  print("on return: " + JSON.stringify(await it.return()) + " " + h.listenerCount("x"));
}

/* the listener functions */
{
  const e = new EventEmitter();
  const a = () => {};
  e.on("x", a);
  e.once("x", () => {});
  print("getEventListeners: " + getEventListeners(e, "x").length + " " + (getEventListeners(e, "x")[0] === a));
  print("listenerCount: " + listenerCount(e, "x"));
  print("getMaxListeners: " + getMaxListeners(e));
  setMaxListeners(3, e);
  print("after set: " + getMaxListeners(e) + " default " + events.defaultMaxListeners);
  const t = new EventTarget();
  setMaxListeners(7, t);
  print("EventTarget max: " + getMaxListeners(t));
  for (const bad of [-1, NaN, "x"]) {
    try {
      setMaxListeners(bad);
    } catch (err) {
      print("setMaxListeners(" + JSON.stringify(bad) + "): " + err.code + " " + err.message);
    }
  }
  print("statics: " + [typeof EventEmitter.on, typeof EventEmitter.once, typeof EventEmitter.getEventListeners, EventEmitter.errorMonitor === errorMonitor, events.usingDomains].join(" "));
}

/* addAbortListener */
{
  const ac = new AbortController();
  const disposable = addAbortListener(ac.signal, () => print("abort listener ran"));
  print("disposable: " + typeof disposable[Symbol.dispose ?? Symbol.for("nodejs.dispose")]);
  ac.abort();
  const done = new AbortController();
  done.abort();
  addAbortListener(done.signal, () => print("already aborted: on a microtask"));
  print("before the microtask");
  await tick();
}

/* EventEmitterAsyncResource: listeners in the context it was made in */
{
  const store = new AsyncLocalStorage();
  const e = store.run("made here", () => new EventEmitterAsyncResource({ name: "Thing" }));
  e.on("go", () => print("context: " + store.getStore()));
  store.run("elsewhere", () => e.emit("go"));
  print("asyncResource: " + (e.asyncResource.eventEmitter === e) + " " + typeof e.asyncId);
  try {
    new EventEmitterAsyncResource({});
  } catch (err) {
    print("no name: " + err.code);
  }
}
