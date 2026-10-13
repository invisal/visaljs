// node:perf_hooks: `performance`'s clock, marks and measures. The clock is
// process.hrtime's, from when this module loads: timeOrigin is that time on the epoch clock.
// PerformanceObserver and the histograms are modules of their own (internal/perf_observe.js,
// internal/perf_histogram.js), linked when the program names them.
import { codeError, invalidArgType } from "./internal/errors.js";
import { features, lazyClass, lazyFunction } from "./internal/features.js";

const hrMs = () => {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
};
const origin = hrMs();
const timeOrigin = Date.now();
const now = () => hrMs() - origin;

const kConstruct = Symbol("construct");

export class PerformanceEntry {
  constructor(key, name, entryType, startTime, duration, detail) {
    if (key !== kConstruct) throw codeError(TypeError, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
    this.name = name;
    this.entryType = entryType;
    this.startTime = startTime;
    this.duration = duration;
    this.detail = detail;
  }

  toJSON() {
    return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration, detail: this.detail };
  }
}

export class PerformanceMark extends PerformanceEntry {
  constructor(name, options) {
    if (name === undefined) throw codeError(TypeError, "ERR_MISSING_ARGS", 'The "name" argument must be specified');
    const startTime = options?.startTime ?? now();
    if (typeof startTime !== "number") throw invalidArgType("options.startTime", "of type number", startTime);
    super(kConstruct, String(name), "mark", startTime, 0, options?.detail ?? null);
  }
}

export class PerformanceMeasure extends PerformanceEntry {
  constructor(key, name, startTime, duration, detail) {
    super(key, name, "measure", startTime, duration, detail);
  }
}

/* marks and measures, in the order they were made */
const entries = [];

/** A mark's time: a number as is, else the latest mark of that name. */
function markTime(mark) {
  if (typeof mark === "number") return mark;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].entryType === "mark" && entries[i].name === mark) return entries[i].startTime;
  }
  throw new globalThis.DOMException('The "' + mark + '" performance mark has not been set', "SyntaxError");
}

export class Performance {
  constructor(key) {
    if (key !== kConstruct) throw codeError(TypeError, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
  }

  get timeOrigin() {
    return timeOrigin;
  }

  now() {
    return now();
  }

  mark(name, options) {
    const mark = new PerformanceMark(name, options);
    entries.push(mark);
    features.perfObserve?.(mark);
    return mark;
  }

  /** measure(name, startMark?, endMark?) or measure(name, { start, end, duration, detail }). */
  measure(name, startOrOptions, endMark) {
    let start = 0, end, detail = null;
    if (startOrOptions !== null && typeof startOrOptions === "object") {
      const { start: s, end: e, duration, detail: d } = startOrOptions;
      if (s !== undefined) start = markTime(s);
      end = e !== undefined ? markTime(e) : duration !== undefined ? start + duration : now();
      detail = d ?? null;
    } else {
      if (startOrOptions !== undefined) start = markTime(startOrOptions);
      end = endMark !== undefined ? markTime(endMark) : now();
    }
    const measure = new PerformanceMeasure(kConstruct, String(name), start, end - start, detail);
    entries.push(measure);
    features.perfObserve?.(measure);
    return measure;
  }

  clearMarks(name) {
    clear("mark", name);
  }

  clearMeasures(name) {
    clear("measure", name);
  }

  getEntries() {
    return entries.slice().sort((a, b) => a.startTime - b.startTime);
  }

  getEntriesByName(name, type) {
    return this.getEntries().filter((e) => e.name === name && (type === undefined || e.entryType === type));
  }

  getEntriesByType(type) {
    return this.getEntries().filter((e) => e.entryType === type);
  }

  toJSON() {
    return { timeOrigin };
  }
}

function clear(type, name) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].entryType === type && (name === undefined || entries[i].name === name)) entries.splice(i, 1);
  }
}

export const performance = new Performance(kConstruct);

export const constants = {
  NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1, NODE_PERFORMANCE_GC_INCREMENTAL: 8, NODE_PERFORMANCE_GC_WEAKCB: 16,
  NODE_PERFORMANCE_GC_FLAGS_NO: 0, NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2, NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
  NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8, NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
  NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32, NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
};

export const PerformanceObserver = lazyClass("PerformanceObserver");
export const PerformanceObserverEntryList = lazyClass("PerformanceObserverEntryList");
export const PerformanceResourceTiming = lazyClass("PerformanceResourceTiming");
export const createHistogram = lazyFunction("createHistogram");
export const monitorEventLoopDelay = lazyFunction("monitorEventLoopDelay");

export default {
  Performance, PerformanceEntry, PerformanceMark, PerformanceMeasure, PerformanceObserver, PerformanceObserverEntryList, PerformanceResourceTiming,
  performance, constants, createHistogram, monitorEventLoopDelay,
};
