// node:events: EventEmitter, Node's semantics for the common API:
// listeners in order (prepend first), once wrappers, 'newListener' and 'removeListener', an
// 'error' with no listener thrown (errorMonitor's listeners hear it first), the max-listeners
// warning, and captureRejections. The functions on emitters and EventTargets: once and on (as
// promises and an async iterator, with an AbortSignal), getEventListeners, the max-listener
// counts, and addAbortListener.
import { lazyClass, lazyFunction } from "./internal/features.js";

const kCapture = Symbol("kCapture");
export const captureRejectionSymbol = Symbol.for("nodejs.rejection");
export const errorMonitor = Symbol("events.errorMonitor");

function checkListener(listener) {
  if (typeof listener !== "function") {
    const e = new TypeError('The "listener" argument must be of type function. Received ' + describe(listener));
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
}

function describe(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") return "an instance of " + (v.constructor && v.constructor.name ? v.constructor.name : "Object");
  return "type " + typeof v + " (" + (typeof v === "string" ? "'" + v + "'" : String(v)) + ")";
}

export function EventEmitter(opts) {
  EventEmitter.init.call(this, opts);
}

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._eventsCount = 0;
EventEmitter.prototype._maxListeners = undefined;
EventEmitter.prototype[kCapture] = false;

/* emitters created after it's set catch their listeners' rejections */
Object.defineProperty(EventEmitter, "captureRejections", {
  enumerable: true,
  get() {
    return EventEmitter.prototype[kCapture];
  },
  set(value) {
    validateBoolean(value, "EventEmitter.captureRejections");
    EventEmitter.prototype[kCapture] = value;
  },
});
EventEmitter.captureRejectionSymbol = captureRejectionSymbol;
EventEmitter.errorMonitor = errorMonitor;

let defaultMaxListeners = 10;
Object.defineProperty(EventEmitter, "defaultMaxListeners", {
  enumerable: true,
  get() {
    return defaultMaxListeners;
  },
  set(n) {
    defaultMaxListeners = n;
  },
});

EventEmitter.init = function (opts) {
  if (this._events === undefined || this._events === Object.getPrototypeOf(this)._events) {
    this._events = Object.create(null);
    this._eventsCount = 0;
  }
  this._maxListeners = this._maxListeners || undefined;
  if (opts?.captureRejections) {
    validateBoolean(opts.captureRejections, "options.captureRejections");
    this[kCapture] = Boolean(opts.captureRejections);
  } else this[kCapture] = EventEmitter.prototype[kCapture];
};

EventEmitter.prototype.setMaxListeners = function (n) {
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.getMaxListeners = function () {
  return this._maxListeners === undefined ? defaultMaxListeners : this._maxListeners;
};

EventEmitter.prototype.emit = function (type, ...args) {
  const events = this._events;
  if (type === "error" && events !== undefined && events[errorMonitor] !== undefined) this.emit(errorMonitor, ...args);
  if (type === "error" && (events === undefined || events.error === undefined)) {
    const er = args[0];
    if (er instanceof Error) throw er;
    const e = new Error("Unhandled error. (" + String(er) + ")");
    e.code = "ERR_UNHANDLED_ERROR";
    e.context = er;
    throw e;
  }
  if (events === undefined) return false;
  const handler = events[type];
  if (handler === undefined) return false;
  if (typeof handler === "function") {
    const result = handler.apply(this, args);
    if (result !== undefined && result !== null && this[kCapture]) addCatch(this, result, type, args);
  } else {
    const listeners = handler.slice();
    for (let i = 0; i < listeners.length; i++) {
      const result = listeners[i].apply(this, args);
      if (result !== undefined && result !== null && this[kCapture]) addCatch(this, result, type, args);
    }
  }
  return true;
};

/* captureRejections: a listener's rejected promise becomes the emitter's 'error', or goes to its
 * Symbol.for('nodejs.rejection') method */
function addCatch(that, promise, type, args) {
  try {
    const then = promise.then;
    if (typeof then === "function") then.call(promise, undefined, (err) => process.nextTick(emitRejection, that, err, type, args));
  } catch (err) {
    that.emit("error", err);
  }
}

function emitRejection(emitter, err, type, args) {
  if (typeof emitter[captureRejectionSymbol] === "function") {
    emitter[captureRejectionSymbol](err, type, ...args);
    return;
  }
  const prev = emitter[kCapture];
  try {
    emitter[kCapture] = false;  /* an 'error' listener's own rejection isn't caught again */
    emitter.emit("error", err);
  } finally {
    emitter[kCapture] = prev;
  }
}

function addListener(target, type, listener, prepend) {
  checkListener(listener);
  let events = target._events;
  if (events === undefined) {
    events = target._events = Object.create(null);
    target._eventsCount = 0;
  } else if (events.newListener !== undefined) {
    target.emit("newListener", type, listener.listener ? listener.listener : listener);
    events = target._events;
  }
  const existing = events[type];
  if (existing === undefined) {
    events[type] = listener;
    target._eventsCount++;
  } else {
    const list = typeof existing === "function" ? (events[type] = prepend ? [listener, existing] : [existing, listener]) : existing;
    if (typeof existing !== "function") {
      if (prepend) list.unshift(listener);
      else list.push(listener);
    }
    const max = target.getMaxListeners();
    if (max > 0 && list.length > max && !list.warned) {
      list.warned = true;
      process.emitWarning(
        "Possible EventEmitter memory leak detected. " + list.length + " " + String(type) + " listeners added to " +
          (target.constructor && target.constructor.name ? "[" + target.constructor.name + "]" : "[EventEmitter]") +
          ". MaxListeners is " + max + ". Use emitter.setMaxListeners() to increase limit",
        "MaxListenersExceededWarning",
      );
    }
  }
  return target;
}

EventEmitter.prototype.addListener = function (type, listener) {
  return addListener(this, type, listener, false);
};
EventEmitter.prototype.on = EventEmitter.prototype.addListener;
EventEmitter.prototype.prependListener = function (type, listener) {
  return addListener(this, type, listener, true);
};

function onceWrapper(target, type, listener) {
  const state = { fired: false, target, type, listener };
  function wrapped(...args) {
    if (!state.fired) {
      state.target.removeListener(state.type, wrapped);
      state.fired = true;
      return state.listener.apply(state.target, args);
    }
  }
  wrapped.listener = listener;
  return wrapped;
}

EventEmitter.prototype.once = function (type, listener) {
  checkListener(listener);
  this.on(type, onceWrapper(this, type, listener));
  return this;
};

EventEmitter.prototype.prependOnceListener = function (type, listener) {
  checkListener(listener);
  this.prependListener(type, onceWrapper(this, type, listener));
  return this;
};

EventEmitter.prototype.removeListener = function (type, listener) {
  checkListener(listener);
  const events = this._events;
  if (events === undefined) return this;
  const list = events[type];
  if (list === undefined) return this;
  if (list === listener || list.listener === listener) {
    if (--this._eventsCount === 0) this._events = Object.create(null);
    else delete events[type];
    if (events.removeListener) this.emit("removeListener", type, list.listener || listener);
  } else if (typeof list !== "function") {
    let position = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || list[i].listener === listener) {
        position = i;
        break;
      }
    }
    if (position < 0) return this;
    list.splice(position, 1);
    if (list.length === 1) events[type] = list[0];
    if (events.removeListener !== undefined) this.emit("removeListener", type, listener);
  }
  return this;
};
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype.removeAllListeners = function (type) {
  const events = this._events;
  if (events === undefined) return this;
  if (events.removeListener === undefined) {  /* nobody hears of it: drop them at once */
    if (arguments.length === 0) {
      this._events = Object.create(null);
      this._eventsCount = 0;
    } else if (events[type] !== undefined) {
      if (--this._eventsCount === 0) this._events = Object.create(null);
      else delete events[type];
    }
    return this;
  }
  /* one by one, last first, each a 'removeListener' (process stops watching a signal so) */
  if (arguments.length === 0) {
    for (const key of Reflect.ownKeys(events)) if (key !== "removeListener") this.removeAllListeners(key);
    this.removeAllListeners("removeListener");
    this._events = Object.create(null);
    this._eventsCount = 0;
    return this;
  }
  const listeners = events[type];
  if (typeof listeners === "function") this.removeListener(type, listeners);
  else if (listeners !== undefined) for (let i = listeners.length - 1; i >= 0; i--) this.removeListener(type, listeners[i]);
  return this;
};

function listenersOf(target, type, unwrap) {
  const events = target._events;
  if (events === undefined || events[type] === undefined) return [];
  const l = events[type];
  if (typeof l === "function") return unwrap ? [l.listener || l] : [l];
  return l.map((f) => (unwrap ? f.listener || f : f));
}

EventEmitter.prototype.listeners = function (type) {
  return listenersOf(this, type, true);
};
EventEmitter.prototype.rawListeners = function (type) {
  return listenersOf(this, type, false);
};
EventEmitter.prototype.listenerCount = function (type) {
  const l = this._events !== undefined ? this._events[type] : undefined;
  return l === undefined ? 0 : typeof l === "function" ? 1 : l.length;
};
EventEmitter.prototype.eventNames = function () {
  return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
};

EventEmitter.EventEmitter = EventEmitter;

/* ---- the functions ---------------------------------------------------------------------- */

function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw invalidArgType(name, "of type boolean", value);
}

function invalidArgType(name, expected, value) {
  const what = name.includes(".") ? "property" : "argument";
  const e = new TypeError('The "' + name + '" ' + what + " must be " + expected + ". Received " + describe(value));
  e.code = "ERR_INVALID_ARG_TYPE";
  return e;
}

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

const isEventTarget = (target) => typeof target?.addEventListener === "function" && typeof target?.on !== "function";

/** events.once(emitter, name[, { signal }]): a promise of the next event's arguments; an
 *  EventTarget's event as [event]. An 'error' first rejects it. */
export function once(emitter, name, options = {}) {
  const signal = options?.signal;
  validateSignal(signal, "options.signal");
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let cleanup;
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    if (isEventTarget(emitter)) {
      const onEvent = (event) => {
        signal?.removeEventListener("abort", onAbort);
        resolve([event]);
      };
      cleanup = () => emitter.removeEventListener(name, onEvent);
      emitter.addEventListener(name, onEvent, { once: true });
    } else {
      const onError = (err) => {
        emitter.removeListener(name, onEvent);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      };
      const onEvent = (...args) => {
        if (name !== "error") emitter.removeListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
        resolve(args);
      };
      cleanup = () => {
        emitter.removeListener(name, onEvent);
        emitter.removeListener("error", onError);
      };
      emitter.once(name, onEvent);
      if (name !== "error") emitter.once("error", onError);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
EventEmitter.once = once;

/** events.on (internal/events_on.js, linked when the program names it). */
export const on = lazyFunction("on", 3);
EventEmitter.on = on;

/* the rest, in internal/events_extras.js, linked when the program names them (internal/features.js) */
export const getEventListeners = lazyFunction("getEventListeners", 2);
export const getMaxListeners = lazyFunction("getMaxListeners", 1);
export const setMaxListeners = lazyFunction("setMaxListeners");
/** Deprecated: emitter.listenerCount(type). */
export function listenerCount(emitter, type) {
  return typeof emitter.listenerCount === "function" ? emitter.listenerCount(type) : 0;
}
export const addAbortListener = lazyFunction("addAbortListener", 2);
export const usingDomains = false;
export const EventEmitterAsyncResource = lazyClass("EventEmitterAsyncResource");

Object.assign(EventEmitter, { getEventListeners, getMaxListeners, setMaxListeners, listenerCount, addAbortListener, usingDomains, EventEmitterAsyncResource });

export { defaultMaxListeners };
export default EventEmitter;
