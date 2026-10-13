// events.on: an emitter's or EventTarget's events as an async iterator. Linked into programs that
// name it (internal/features.js).
import { invalidArgType } from "./errors.js";
import { features } from "./features.js";

const isEventTarget = (target) => typeof target?.addEventListener === "function" && typeof target?.on !== "function";

function validateSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
    throw invalidArgType(name, "an instance of AbortSignal", signal);
  }
}

/* Node's AbortError: name and code, the signal's reason as its cause */
function abortError(signal) {
  const error = new Error("The operation was aborted", { cause: signal?.reason });
  error.code = "ABORT_ERR";
  error.name = "AbortError";
  return error;
}

/** events.on(emitter, name[, { signal, close }]): the events as an async iterator of their
 *  arguments, buffered until read; an 'error' ends it by throwing, a `close` event by finishing. */
function on(emitter, event, options = {}) {
  const signal = options?.signal;
  validateSignal(signal, "options.signal");
  if (signal?.aborted) throw abortError(signal);
  const close = options?.close ?? [];
  const unconsumedEvents = [];
  const unconsumedPromises = [];
  let error = null;
  let finished = false;
  const listening = [];
  const listen = (name, handler) => {
    if (isEventTarget(emitter)) emitter.addEventListener(name, handler);
    else emitter.on(name, handler);
    listening.push([name, handler]);
  };
  const result = (value, done) => ({ value, done });

  const iterator = {
    next() {
      const value = unconsumedEvents.shift();
      if (value) return Promise.resolve(result(value, false));
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
      if (!(err instanceof Error)) throw invalidArgType("EventEmitter.AsyncIterator", "an instance of Error", err);
      errorHandler(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  function eventHandler(...args) {
    const pending = unconsumedPromises.shift();
    if (pending) pending.resolve(result(args, false));
    else unconsumedEvents.push(args);
  }
  function errorHandler(err) {
    finished = true;
    const pending = unconsumedPromises.shift();
    if (pending) pending.reject(err);
    else error = err;
    iterator.return();
  }
  function abortListener() {
    errorHandler(abortError(signal));
  }
  function closeHandler() {
    for (const [name, handler] of listening) {
      if (isEventTarget(emitter)) emitter.removeEventListener(name, handler);
      else emitter.removeListener(name, handler);
    }
    listening.length = 0;
    signal?.removeEventListener("abort", abortListener);
    finished = true;
    const done = result(undefined, true);
    while (unconsumedPromises.length) unconsumedPromises.shift().resolve(done);
    return Promise.resolve(done);
  }

  listen(event, eventHandler);
  if (event !== "error" && !isEventTarget(emitter)) listen("error", errorHandler);
  for (const name of close) listen(name, closeHandler);
  signal?.addEventListener("abort", abortListener, { once: true });
  return iterator;
}

features.on = on;
