// node:timers: Timeout and Immediate objects (ref, unref, hasRef, refresh, close, a primitive id,
// `this` in the callback), the globals being the module's, the legacy API, and timers/promises.
// Each phase waits for the last one's timers, so the output's order doesn't hang on timing.
import timers from "node:timers";
import { setTimeout as sleep, setImmediate as tick, setInterval as every, scheduler } from "node:timers/promises";

const log = (...args) => console.log(...args);

log("globals are the module's:", setTimeout === timers.setTimeout, clearInterval === timers.clearInterval, setImmediate === timers.setImmediate);
log("exports:", Object.keys(timers).sort().join(", "));

/* a Timeout */
{
  const t = setTimeout(function (a, b) {
    log("timeout this:", this === t, this.constructor.name, a, b, "destroyed while running:", this._destroyed);
  }, 1, "A", "B");
  log("Timeout:", t.constructor.name, t.hasRef(), t.unref() === t, t.hasRef(), t.ref() === t, t.hasRef());
  log("fields:", t._idleTimeout, t._repeat, t._timerArgs, t._destroyed, typeof t._onTimeout);
  log("primitive:", typeof +t, +t > 0, `${t}` === String(+t));
}

/* delays as Node takes them */
for (const delay of [-5, "20", 1.5, NaN, undefined]) {
  const d = setTimeout(() => {}, delay);
  log("delay", delay, "->", d._idleTimeout);
  clearTimeout(d);
}

/* bad callbacks */
for (const make of [() => setTimeout(5), () => setInterval("x"), () => setImmediate(null)]) {
  try {
    make();
  } catch (e) {
    log(e.name, e.code, e.message);
  }
}

await sleep(20);

/* clearing: by object, by its primitive (number or string), close(); an unknown number does nothing */
{
  const a = setTimeout(() => log("never: a"), 2);
  clearTimeout(a);
  log("cleared:", a._destroyed, a._idleTimeout, a._onTimeout);
  const b = setTimeout(() => log("never: b"), 2);
  clearTimeout(String(+b));
  const c = setTimeout(() => log("never: c"), 2);
  clearTimeout(+c);
  const d = setTimeout(() => log("never: d"), 2);
  log("close returns it:", d.close() === d);
  setTimeout(() => log("kept fires"), 3);
  clearTimeout(12345678);
}

await sleep(20);

/* intervals: `this`, cleared from their callback */
{
  let n = 0;
  const iv = setInterval(function () {
    n++;
    log("interval", n, this === iv, this._repeat);
    if (n === 3) clearInterval(this);
  }, 2);
}

await sleep(30);

/* refresh: a fired timer runs again */
{
  let fired = 0;
  const once = setTimeout(() => {
    fired++;
    log("once fired", fired, "destroyed in callback:", once._destroyed);
  }, 1);
  await sleep(20);
  log("after firing, destroyed:", once._destroyed);
  once.refresh();
  log("refreshed, destroyed:", once._destroyed);
  await sleep(20);
}

/* refresh: a pending one starts over (fires once, after the later deadline) */
{
  const started = Date.now();
  const pending = setTimeout(() => log("refreshed pending fired once, late:", Date.now() - started >= 25), 20);
  await sleep(10);
  pending.refresh();
  await sleep(40);
}

/* unref: a timer that alone doesn't keep the program alive */
setTimeout(() => log("never: unref'd"), 5000).unref();
setTimeout(() => log("unref then ref fires"), 4).unref().ref();
await sleep(20);

/* an Immediate */
{
  const im = setImmediate(function (x) {
    log("immediate this:", this === im, this.constructor.name, x, "destroyed:", this._destroyed);
  }, "X");
  log("Immediate:", im.hasRef(), im.unref() === im, im.hasRef(), im.ref() === im, im.hasRef(), im._argv);
  const gone = setImmediate(() => log("never: immediate"));
  clearImmediate(gone);
  log("cleared immediate:", gone._destroyed, gone._onImmediate);
}

await sleep(20);

/* util.promisify's custom symbol */
const custom = Symbol.for("nodejs.util.promisify.custom");
log("promisify.custom:", setTimeout[custom] === sleep, setImmediate[custom] === tick);

/* timers/promises */
log("sleep:", await sleep(2, "slept"), "tick:", await tick("ticked"));
log("scheduler:", await scheduler.wait(1), await scheduler.yield(), Object.getOwnPropertyNames(Object.getPrototypeOf(scheduler)).join(","));
for (const [what, call] of [
  ["signal: 1", () => sleep(1, 1, { signal: 1 })],
  ["options: 5", () => sleep(1, 1, 5)],
  ["ref: 1", () => sleep(1, 1, { ref: 1 })],
  ["delay: 'x'", () => sleep("x")],
  ["immediate signal: {}", () => tick(1, { signal: {} })],
  ["interval options: null", () => every(1, 1, null).next()],
]) {
  try {
    await call();
  } catch (e) {
    log(what, "->", e.name, e.code, e.message);
  }
}
{
  const ac = new AbortController();
  const pending = sleep(1000, 1, { signal: ac.signal });
  ac.abort();
  try {
    await pending;
  } catch (e) {
    log("aborted:", e.name, e.code, e.message, e.cause?.name);
  }
  try {
    await tick(1, { signal: AbortSignal.abort("why") });
  } catch (e) {
    log("already aborted:", e.name, e.code, e.cause);
  }
}
{
  let i = 0;
  for await (const v of every(2, "every")) {
    log("interval yields", v);
    if (++i === 3) break;
  }
  const it = every(2, "it");
  log(await it.next(), await it.return(), await it.next());
  const ac = new AbortController();
  const it2 = every(2, "x", { signal: ac.signal });
  log(await it2.next());
  const waiting = it2.next();
  ac.abort();
  try {
    await waiting;
  } catch (e) {
    log("interval aborted:", e.name, e.code);
  }
}
sleep(10_000, undefined, { ref: false }).then(() => log("never: unref'd sleep"));
