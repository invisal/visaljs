// node:timers/promises: setTimeout and setImmediate as promises,
// setInterval as an async iterator, and scheduler.wait and scheduler.yield; each takes an
// AbortSignal, and ref: false for a timer that doesn't keep the program alive.
import { codeError, invalidArgType } from "./internal/errors.js";
import { Immediate, Timeout, arm, clearImmediate, clearInterval, clearTimeout } from "./internal/timers.js";

/* Node's AbortError: name and code, the signal's reason as its cause */
function abortError(signal) {
  const error = new Error("The operation was aborted", { cause: signal?.reason });
  error.code = "ABORT_ERR";
  error.name = "AbortError";
  return error;
}

function validateOptions(options) {
  if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
  const { signal, ref } = options;
  if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
    throw invalidArgType("options.signal", "an instance of AbortSignal", signal);
  }
  if (ref !== undefined && typeof ref !== "boolean") throw invalidArgType("options.ref", "of type boolean", ref);
}

/* a timer's promise: settled by the timer, or rejected when the signal aborts first */
function settle(start, clear, signal) {
  let onAbort;
  const promise = new Promise((resolve, reject) => {
    const timer = start(resolve);
    if (signal) {
      onAbort = () => {
        if (!timer._destroyed) {
          clear(timer);
          reject(abortError(signal));
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return onAbort ? promise.finally(() => signal.removeEventListener("abort", onAbort)) : promise;
}

export function setTimeout(after, value, options = {}) {
  try {
    if (after !== undefined && typeof after !== "number") throw invalidArgType("delay", "of type number", after);
    validateOptions(options);
  } catch (err) {
    return Promise.reject(err);
  }
  const { signal, ref = true } = options;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return settle((resolve) => {
    const timeout = new Timeout(resolve, after, [value], false, ref);
    arm(timeout, ref);
    return timeout;
  }, clearTimeout, signal);
}

export function setImmediate(value, options = {}) {
  try {
    validateOptions(options);
  } catch (err) {
    return Promise.reject(err);
  }
  const { signal, ref = true } = options;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return settle((resolve) => {
    const immediate = new Immediate(resolve, [value]);
    if (!ref) immediate.unref();
    return immediate;
  }, clearImmediate, signal);
}

/* yields value every `after` ms: once per tick, those the consumer was too slow for included */
export async function* setInterval(after, value, options = {}) {
  validateOptions(options);
  const { signal, ref = true } = options;
  if (signal?.aborted) throw abortError(signal);
  let onCancel;
  let interval;
  try {
    let notYielded = 0;
    let callback;
    interval = new Timeout(() => {
      notYielded++;
      if (callback) {
        callback();
        callback = undefined;
      }
    }, after, undefined, true, ref);
    arm(interval, ref);
    if (signal) {
      onCancel = () => {
        clearInterval(interval);
        if (callback) {
          callback(Promise.reject(abortError(signal)));
          callback = undefined;
        }
      };
      signal.addEventListener("abort", onCancel, { once: true });
    }
    while (!signal?.aborted) {
      if (notYielded === 0) await new Promise((resolve) => (callback = resolve));
      for (; notYielded > 0; notYielded--) yield value;
    }
    throw abortError(signal);
  } finally {
    clearInterval(interval);
    if (onCancel) signal.removeEventListener("abort", onCancel);
  }
}

const kScheduler = Symbol("kScheduler");

class Scheduler {
  constructor() {
    throw codeError(TypeError, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
  }

  /* a promise settled after the I/O of this turn of the loop */
  yield() {
    if (!this?.[kScheduler]) throw codeError(TypeError, "ERR_INVALID_THIS", 'Value of "this" must be of type Scheduler');
    return setImmediate();
  }

  wait(delay, options) {
    if (!this?.[kScheduler]) throw codeError(TypeError, "ERR_INVALID_THIS", 'Value of "this" must be of type Scheduler');
    return setTimeout(delay, undefined, options);
  }
}

export const scheduler = Object.create(Scheduler.prototype, { [kScheduler]: { value: true } });

export default { setTimeout, setImmediate, setInterval, scheduler };
