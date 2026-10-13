// Event, EventTarget, AbortController and AbortSignal, as Node has them.
const err = (f) => {
  try {
    f();
    return "no error";
  } catch (e) {
    return `${e.name}${e.code ? ` [${e.code}]` : ""}: ${e.message}`;
  }
};

/* Event */
const e = new Event("ping", { cancelable: true, bubbles: 1 });
console.log(e.type, e.bubbles, e.cancelable, e.composed, e.defaultPrevented, e.returnValue, e.eventPhase, e.target, e.isTrusted);
console.log(typeof e.timeStamp, e.timeStamp >= 0, Event.NONE, Event.AT_TARGET, Event.BUBBLING_PHASE, Event.length);
console.log(Object.prototype.toString.call(e), Object.keys(Event.prototype).length);
console.log(err(() => Event("x")), "|", err(() => new Event()), "|", err(() => new Event("x", 1)));
console.log(err(() => Event.prototype.type.call({})));
console.log(Object.getOwnPropertyNames(e));

/* EventTarget: order, once, handleEvent objects, removal, cancellation */
const t = new EventTarget();
const log = [];
function first(ev) {
  log.push(`first ${this === t} ${ev.currentTarget === t} ${ev.eventPhase} ${ev.composedPath().length}`);
}
t.addEventListener("ping", first);
t.addEventListener("ping", first);  /* a duplicate: ignored */
t.addEventListener("ping", (ev) => log.push(`once ${ev.target === t}`), { once: true });
t.addEventListener("ping", { handleEvent(ev) { log.push(`object ${this !== t} ${ev.type}`); } });
t.addEventListener("ping", (ev) => {
  ev.preventDefault();
  t.addEventListener("ping", () => log.push("added while dispatching"));
});
console.log(t.dispatchEvent(e), e.defaultPrevented, e.returnValue, e.currentTarget, e.eventPhase, e.target === t);
console.log(log.join("; "));
log.length = 0;
t.removeEventListener("ping", first);
t.dispatchEvent(new Event("ping"));
console.log(log.join("; "));

/* stopImmediatePropagation, passive listeners, capture as a separate registration */
const u = new EventTarget();
u.addEventListener("x", (ev) => { ev.preventDefault(); console.log("passive", ev.defaultPrevented); }, { passive: true });
u.addEventListener("x", (ev) => { ev.stopImmediatePropagation(); console.log("stopped", ev.cancelBubble); });
u.addEventListener("x", () => console.log("never"));
console.log(u.dispatchEvent(new Event("x", { cancelable: true })));
const cap = () => console.log("capture listener");
u.addEventListener("y", cap, true);
u.addEventListener("y", cap);
u.removeEventListener("y", cap, { capture: true });
u.dispatchEvent(new Event("y"));

/* errors */
console.log(err(() => u.addEventListener("a")), "|", err(() => u.addEventListener("a", 1)), "|", err(() => u.dispatchEvent({})));
console.log(err(() => u.addEventListener("a", () => {}, { signal: {} })));
const again = new Event("r");
u.addEventListener("r", () => console.log("recursion:", err(() => u.dispatchEvent(again))));
u.dispatchEvent(again);

/* subclasses */
class Ping extends Event {
  constructor(n) {
    super("ping");
    this.n = n;
  }
}
class Emitter extends EventTarget {
  fire(n) { return this.dispatchEvent(new Ping(n)); }
}
const em = new Emitter();
em.addEventListener("ping", (ev) => console.log("subclass", ev.n, ev instanceof Ping, ev instanceof Event));
em.fire(7);
console.log(em instanceof EventTarget, Object.getPrototypeOf(AbortSignal.prototype) === EventTarget.prototype,
  Object.getPrototypeOf(AbortSignal) === EventTarget);

/* inspection */
console.log(new EventTarget(), new AbortController(), AbortSignal.abort());
console.log(new Ping(1) instanceof Event, String(new Event("z")).length > 0);

/* AbortController and AbortSignal */
const ac = new AbortController();
const s = ac.signal;
console.log(s.aborted, s.reason, s.onabort, ac.signal === s, err(() => s.throwIfAborted()));
s.onabort = (ev) => console.log("onabort", ev.type, ev.isTrusted, ev.target === s, s.aborted);
s.addEventListener("abort", () => console.log("listener", String(s.reason)));
const follower = AbortSignal.any([s, new AbortController().signal]);
follower.addEventListener("abort", () => console.log("follower", follower.reason === s.reason));
ac.abort();
ac.abort("ignored");
console.log(s.aborted, s.reason instanceof DOMException, s.reason.name, s.reason.message, err(() => s.throwIfAborted()));
console.log(AbortSignal.abort("why").reason, AbortSignal.any([AbortSignal.abort(5)]).reason);
console.log(err(() => new AbortSignal()), "|", err(() => AbortSignal.timeout(-1)), "|", err(() => AbortSignal.any([1])));
const ac2 = new AbortController();
const listener = () => console.log("removed by its signal: never");
const target = new EventTarget();
target.addEventListener("go", listener, { signal: ac2.signal });
ac2.abort(new Error("stop"));
target.dispatchEvent(new Event("go"));
console.log(ac2.signal.reason.message);
s.onabort = null;
console.log(s.onabort);

/* a listener's exception is rethrown later; the dispatch goes on */
const ts = AbortSignal.timeout(5);
ts.addEventListener("abort", () => console.log("timeout:", ts.reason.name, ts.reason.message));
setTimeout(() => console.log("done"), 30);
