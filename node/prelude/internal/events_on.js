// events.on (Node's lib/events.js): an emitter's or EventTarget's events as an async iterator,
// buffered until read, the emitter paused above highWaterMark and resumed below lowWaterMark.
// Linked into programs that name it (internal/features.js), and with node:readline's iterator.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { invalidArgType, outOfRange } from "./errors.js";
import { features } from "./features.js";

/* the iterator's watermarks and state (events.on's [kWatermarkData]) */
const kWatermarkData = Symbol.for("nodejs.watermarkData");
/** Node's internal option: each event's first argument, not an array of them (readline's lines).
 *  In the registry: readline's iterator names it without linking this module. */
export const kFirstEventParam = Symbol.for("visaljs.events.kFirstEventParam");

const AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}).prototype);

function validateSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
    throw invalidArgType(name, "an instance of AbortSignal", signal);
  }
}

function validateWatermark(value, name) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < 1 || value > Number.MAX_SAFE_INTEGER) throw outOfRange(name, `>= 1 && <= ${Number.MAX_SAFE_INTEGER}`, value);
}

/* Node's AbortError: name and code, the signal's reason as its cause */
function abortError(signal) {
  const error = new Error("The operation was aborted", { cause: signal?.reason });
  error.code = "ABORT_ERR";
  error.name = "AbortError";
  return error;
}

function addListener(emitter, name, listener) {
  if (typeof emitter.on === "function") emitter.on(name, listener);
  else if (typeof emitter.addEventListener === "function") emitter.addEventListener(name, listener);
  else throw invalidArgType("emitter", "an instance of EventEmitter", emitter);
}

function removeListener(emitter, name, listener) {
  if (typeof emitter.removeListener === "function") emitter.removeListener(name, listener);
  else if (typeof emitter.removeEventListener === "function") emitter.removeEventListener(name, listener);
  else throw invalidArgType("emitter", "an instance of EventEmitter", emitter);
}

const iterResult = (value, done) => ({ value, done });

/** events.on(emitter, name[, { signal, close, highWaterMark, lowWaterMark }]) */
export function on(emitter, event, options = {}) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) throw invalidArgType("options", "of type object", options);
  const signal = options.signal;
  validateSignal(signal, "options.signal");
  if (signal?.aborted) throw abortError(signal);
  const highWatermark = options.highWaterMark ?? options.highWatermark ?? Number.MAX_SAFE_INTEGER;
  validateWatermark(highWatermark, "options.highWaterMark");
  const lowWatermark = options.lowWaterMark ?? options.lowWatermark ?? 1;
  validateWatermark(lowWatermark, "options.lowWaterMark");

  const unconsumedEvents = [];
  const unconsumedPromises = [];
  let paused = false;
  let error = null;
  let finished = false;
  const listening = [];

  const iterator = Object.setPrototypeOf({
    next() {
      if (unconsumedEvents.length) {
        const value = unconsumedEvents.shift();
        if (paused && unconsumedEvents.length < lowWatermark) {
          emitter.resume();
          paused = false;
        }
        return Promise.resolve(iterResult(value, false));
      }
      if (error) {
        const p = Promise.reject(error);
        error = null;
        return p;
      }
      if (finished) return closeHandler();
      return new Promise((resolve, reject) => unconsumedPromises.push({ resolve, reject }));
    },
    return() {
      return closeHandler();
    },
    throw(err) {
      if (!err || !(err instanceof Error)) throw invalidArgType("EventEmitter.AsyncIterator", "an instance of Error", err);
      errorHandler(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    [kWatermarkData]: {
      get size() { return unconsumedEvents.length; },
      get low() { return lowWatermark; },
      get high() { return highWatermark; },
      get isPaused() { return paused; },
    },
  }, AsyncIteratorPrototype);

  const listen = (name, handler) => {
    addListener(emitter, name, handler);
    listening.push([name, handler]);
  };

  function eventHandler(value) {
    if (unconsumedPromises.length === 0) {
      if (!paused && unconsumedEvents.length + 1 > highWatermark) {
        paused = true;
        emitter.pause();
      }
      unconsumedEvents.push(value);
    } else {
      unconsumedPromises.shift().resolve(iterResult(value, false));
    }
  }
  function errorHandler(err) {
    if (unconsumedPromises.length === 0) error = err;
    else unconsumedPromises.shift().reject(err);
    closeHandler();
  }
  function abortListener() {
    errorHandler(abortError(signal));
  }
  function closeHandler() {
    signal?.removeEventListener("abort", abortListener);
    while (listening.length) removeListener(emitter, ...listening.pop());
    finished = true;
    paused = false;
    const done = iterResult(undefined, true);
    while (unconsumedPromises.length) unconsumedPromises.shift().resolve(done);
    return Promise.resolve(done);
  }

  listen(event, options[kFirstEventParam] ? eventHandler : (...args) => eventHandler(args));
  if (event !== "error" && typeof emitter.on === "function") listen("error", errorHandler);
  for (const name of options?.close ?? []) listen(name, closeHandler);
  signal?.addEventListener("abort", abortListener, { once: true });
  return iterator;
}

features.on = on;
