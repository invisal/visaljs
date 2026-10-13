// The Node timer globals: the runtime's setTimeout and friends, in every binary,
// return numbers. A program that may use what Node's return (a Timeout's unref(), refresh(),
// hasRef(), or node:timers itself, whose clearTimeout must take the globals' timers) gets this
// module first (implicitModules in node/index.ts), so that setTimeout === timers.setTimeout.
import { clearImmediate, clearInterval, clearTimeout, setImmediate, setInterval, setTimeout } from "../timers.js";

for (const [name, fn] of Object.entries({ setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate })) {
  Object.defineProperty(globalThis, name, { value: fn, writable: true, enumerable: true, configurable: true });
}
