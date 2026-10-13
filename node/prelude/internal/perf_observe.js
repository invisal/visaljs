// perf_hooks' PerformanceObserver, PerformanceObserverEntryList and PerformanceResourceTiming, as
// Node's: marks and measures go to the observers of their type, delivered together in a later
// setImmediate, sorted by start time; buffered gives an observer the entries made before it.
// Linked into programs that name them (internal/features.js).
import {
  PerformanceObserver as ObserverWrapper, PerformanceObserverEntryList as ListWrapper, PerformanceResourceTiming as ResourceWrapper,
  PerformanceEntry, performance,
} from "../perf_hooks.js";
import { codeError, invalidArgType } from "./errors.js";
import { features, provideClass } from "./features.js";

const kConstruct = Symbol("construct");
const supportedEntryTypes = Object.freeze(["dns", "function", "gc", "http", "http2", "mark", "measure", "net", "resource"]);
const observers = new Set();

const byStartTime = (entries) => entries.slice().sort((a, b) => a.startTime - b.startTime);

class PerformanceObserverEntryList {
  #entries;

  constructor(key, entries) {
    if (key !== kConstruct) throw codeError(TypeError, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
    this.#entries = byStartTime(entries);
  }

  getEntries() {
    return this.#entries.slice();
  }

  getEntriesByType(type) {
    return this.#entries.filter((e) => e.entryType === `${type}`);
  }

  getEntriesByName(name, type) {
    return this.#entries.filter((e) => e.name === `${name}` && (type === undefined || e.entryType === `${type}`));
  }
}

class PerformanceObserver {
  #callback;
  #types = new Set();
  #pending = [];
  #scheduled = false;

  constructor(callback) {
    if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
    this.#callback = callback;
  }

  static get supportedEntryTypes() {
    return supportedEntryTypes;
  }

  /** observe({ entryTypes }) or observe({ type, buffered }). */
  observe(options = {}) {
    if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
    const { entryTypes, type, buffered } = options;
    if (entryTypes === undefined && type === undefined) {
      throw codeError(TypeError, "ERR_MISSING_ARGS", 'The "options.entryTypes" and "options.type" arguments must be specified');
    }
    if (entryTypes !== undefined && type !== undefined) {
      throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'options.entryTypes' can not be used with 'options.type'");
    }
    if (entryTypes !== undefined) {
      if (!Array.isArray(entryTypes)) throw invalidArgType("options.entryTypes", "an instance of Array", entryTypes);
      this.#types = new Set(entryTypes.filter((t) => supportedEntryTypes.includes(t)));
    } else {
      if (!supportedEntryTypes.includes(type)) return;
      this.#types.add(type);
      if (buffered) for (const entry of performance.getEntriesByType(type)) this._enqueue(entry);
    }
    if (this.#types.size > 0) observers.add(this);
    else this.disconnect();
  }

  disconnect() {
    observers.delete(this);
    this.#types.clear();
    this.#pending = [];
  }

  takeRecords() {
    const records = this.#pending;
    this.#pending = [];
    return records;
  }

  _observes(type) {
    return this.#types.has(type);
  }

  /* an entry for the callback, which runs once in a later setImmediate with all of them */
  _enqueue(entry) {
    this.#pending.push(entry);
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      const entries = this.takeRecords();
      if (entries.length) this.#callback(new PerformanceObserverEntryList(kConstruct, entries), this);
    });
  }
}

/** A fetch's timing: made by Node's fetch, which a compiled program's fetch doesn't record. */
class PerformanceResourceTiming extends PerformanceEntry {
  constructor() {
    throw codeError(TypeError, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
  }
}

/* perf_hooks.js calls this with each mark and measure */
features.perfObserve = (entry) => {
  for (const observer of observers) if (observer._observes(entry.entryType)) observer._enqueue(entry);
};
provideClass(ObserverWrapper, PerformanceObserver);
provideClass(ListWrapper, PerformanceObserverEntryList);
provideClass(ResourceWrapper, PerformanceResourceTiming);
Object.defineProperty(ObserverWrapper, "supportedEntryTypes", { get: () => supportedEntryTypes, configurable: true });
