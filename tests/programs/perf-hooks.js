// node:perf_hooks: performance's clock, marks and measures
import { performance, Performance, PerformanceEntry, PerformanceMark, PerformanceMeasure, constants } from "node:perf_hooks";

const m = performance.mark("a", { detail: 1 });
console.log(m.constructor.name, m.name, m.entryType, typeof m.startTime, m.duration, m.detail, m instanceof PerformanceEntry);
performance.mark("b");
const ab = performance.measure("ab", "a", "b");
console.log(ab.constructor.name, ab.entryType, ab.duration >= 0, ab.detail, ab instanceof PerformanceMeasure);
console.log(performance.getEntriesByType("mark").map((e) => e.name), performance.getEntriesByName("ab").length, performance.getEntries().length);
try {
  performance.measure("x", "nope");
} catch (e) {
  console.log(e.name, e.code, e.message, e.constructor.name);
}
for (const C of [PerformanceEntry, PerformanceMeasure, Performance]) {
  try {
    new C();
  } catch (e) {
    console.log(C.name, e.name, e.code, e.message);
  }
}
performance.clearMarks("a");
console.log(performance.getEntriesByType("mark").map((e) => e.name));
performance.clearMarks();
performance.clearMeasures();
console.log(performance.getEntries().length, typeof performance.timeOrigin, Math.abs(performance.timeOrigin + performance.now() - Date.now()) < 50);
const t0 = performance.now();
while (performance.now() - t0 < 2);
console.log(performance.now() > t0, performance.measure("fromStart").startTime);
const opts = performance.measure("opts", { start: 1, end: 3, detail: "d" });
console.log(opts.startTime, opts.duration, opts.detail, performance.measure("dur", { start: 1, duration: 2 }).duration);
console.log(JSON.stringify(Object.keys(m.toJSON())), new PerformanceMark("z", { startTime: 5 }).toJSON());
console.log(constants.NODE_PERFORMANCE_GC_MAJOR, constants.NODE_PERFORMANCE_GC_FLAGS_FORCED);
