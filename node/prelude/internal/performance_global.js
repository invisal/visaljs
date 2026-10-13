// Node's performance globals: node:perf_hooks' performance and its classes. A program that may
// use them gets this module first (implicitModules in node/index.ts). As in Node, `performance`
// is an accessor (an assignment changes what it gives), and the classes are non-enumerable.
import { Performance, PerformanceEntry, PerformanceMark, PerformanceMeasure, performance } from "../perf_hooks.js";

let current = performance;
Object.defineProperty(globalThis, "performance", {
  get() {
    return current;
  },
  set(value) {
    current = value;
  },
  enumerable: true,
  configurable: true,
});
for (const [name, value] of Object.entries({ Performance, PerformanceEntry, PerformanceMark, PerformanceMeasure })) {
  Object.defineProperty(globalThis, name, { value, writable: true, enumerable: false, configurable: true });
}
