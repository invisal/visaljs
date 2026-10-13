// node:timers: setTimeout, setInterval and setImmediate as Node has them,
// returning Timeout and Immediate objects (ref, unref, hasRef, refresh, close, a primitive id)
// that call back with the object as `this` (internal/timers.js); and the legacy enroll,
// unenroll, active and _unrefActive, on an object of the caller's with an _onTimeout.
import { invalidArgType, outOfRange } from "./internal/errors.js";
import {
  TIMEOUT_MAX, armed, arm, clearImmediate, clearInterval, clearTimeout, duration, kFire, kId, kPending, kRefed,
  setImmediate, setInterval, setTimeout, unenrollTimeout,
} from "./internal/timers.js";
import { deprecate } from "./util.js";
import * as promises from "./timers_promises.js";

export { clearImmediate, clearInterval, clearTimeout, promises, setImmediate, setInterval, setTimeout };

/* util.promisify(setTimeout) and util.promisify(setImmediate): timers/promises' */
const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
Object.defineProperty(setTimeout, promisifyCustom, { value: promises.setTimeout, enumerable: false, writable: true, configurable: true });
Object.defineProperty(setImmediate, promisifyCustom, { value: promises.setImmediate, enumerable: false, writable: true, configurable: true });

/* ---- The legacy API ------------------------------------------------------------------ */

function getTimerDuration(msecs, name) {
  if (typeof msecs !== "number") throw invalidArgType(name, "of type number", msecs);
  if (msecs < 0 || !Number.isFinite(msecs)) throw outOfRange(name, "a non-negative finite number", msecs);
  if (msecs > TIMEOUT_MAX) {
    if (typeof process.emitWarning === "function") {
      process.emitWarning(`${msecs} does not fit into a 32-bit signed integer.\nTimer duration was truncated to ${TIMEOUT_MAX}.`, "TimeoutOverflowWarning");
    }
    return TIMEOUT_MAX;
  }
  return msecs;
}

function enrollItem(item, msecs) {
  if (item._idleNext) unenrollItem(item);
  item._idleNext = item;
  item._idlePrev = item;
  item._idleTimeout = getTimerDuration(msecs, "msecs");
}

function unenrollItem(item) {
  if (item[kFire] === undefined) {  /* never activated */
    item._idleTimeout = -1;
    item._destroyed = true;
    return;
  }
  unenrollTimeout(item);
}

/* arms the item: its _onTimeout() after its _idleTimeout ms */
function activeItem(item, refed) {
  const msecs = item._idleTimeout;
  if (msecs < 0 || msecs === undefined) return;
  if (item[kFire] === undefined) item[kFire] = () => fireItem(item);
  item._destroyed = false;
  item[kRefed] = refed;
  const saved = item._idleTimeout;
  item._idleTimeout = duration(msecs);
  arm(item, refed);
  item._idleTimeout = saved;
}

function fireItem(item) {
  item[kPending] = false;
  armed.delete(item[kId]);
  try {
    if (typeof item._onTimeout === "function") item._onTimeout();
  } finally {
    if (!item[kPending]) item._destroyed = true;
  }
}

export const enroll = deprecate(function enroll(item, msecs) {
  enrollItem(item, msecs);
}, "timers.enroll() is deprecated. Please use setTimeout instead.", "DEP0095");

export const unenroll = deprecate(function unenroll(item) {
  unenrollItem(item);
}, "timers.unenroll() is deprecated. Please use clearTimeout instead.", "DEP0096");

export const active = deprecate(function active(item) {
  activeItem(item, true);
}, "timers.active() is deprecated. Please use timeout.refresh() instead.", "DEP0126");

export const _unrefActive = deprecate(function _unrefActive(item) {
  activeItem(item, false);
}, "timers._unrefActive() is deprecated. Please use timeout.refresh() instead.", "DEP0127");

export default {
  setTimeout, clearTimeout, setImmediate, clearImmediate, setInterval, clearInterval,
  _unrefActive, active, unenroll, enroll, promises,
};
