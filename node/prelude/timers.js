// node:timers: setTimeout, setInterval and setImmediate as Node has them, returning Timeout and
// Immediate objects (ref, unref, hasRef, refresh, close, a primitive id) that call back with the
// object as `this` (internal/timers.js).
import { clearImmediate, clearInterval, clearTimeout, setImmediate, setInterval, setTimeout } from "./internal/timers.js";
import * as promises from "./timers_promises.js";

export { clearImmediate, clearInterval, clearTimeout, promises, setImmediate, setInterval, setTimeout };

/* util.promisify(setTimeout) and util.promisify(setImmediate): timers/promises' */
const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
Object.defineProperty(setTimeout, promisifyCustom, { value: promises.setTimeout, enumerable: false, writable: true, configurable: true });
Object.defineProperty(setImmediate, promisifyCustom, { value: promises.setImmediate, enumerable: false, writable: true, configurable: true });

export default { setTimeout, clearTimeout, setImmediate, clearImmediate, setInterval, clearInterval, promises };
