// The performance globals, node:perf_hooks' without importing it
console.log(typeof performance, typeof performance.now(), performance.now() >= 0, typeof performance.timeOrigin);
const d = Object.getOwnPropertyDescriptor(globalThis, "performance");
console.log(typeof d.get, typeof d.set, d.enumerable, d.configurable, Object.keys(globalThis).includes("performance"));
for (const name of ["Performance", "PerformanceEntry", "PerformanceMark", "PerformanceMeasure"]) {
  const c = Object.getOwnPropertyDescriptor(globalThis, name);
  console.log(name, typeof c.value, c.enumerable, c.writable, c.configurable);
}
const m = performance.mark("a");
console.log(m instanceof PerformanceMark, m instanceof PerformanceEntry, performance instanceof Performance, performance.getEntriesByName("a").length);
/* an assignment replaces it, as a data property */
performance = 42;
const after = Object.getOwnPropertyDescriptor(globalThis, "performance");
console.log(performance, after.value, after.writable, after.enumerable);
