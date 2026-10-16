// node:events' functions on emitters and EventTargets (getEventListeners, the max-listener
// counts, addAbortListener) and EventEmitterAsyncResource. Linked into programs that name them
// (internal/features.js).
import { eventTargetListeners } from "visaljs:host";
import { AsyncResource } from "../async_hooks.js";
import { EventEmitter, EventEmitterAsyncResource as EventEmitterAsyncResourceWrapper } from "../events.js";
import { invalidArgType } from "./errors.js";
import { features, provideClass } from "./features.js";

const kMaxEventTargetListeners = Symbol("events.maxEventTargetListeners");
const isEventTarget = (target) => typeof target?.addEventListener === "function" && typeof target?.on !== "function";

function validateSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
    throw invalidArgType(name, "an instance of AbortSignal", signal);
  }
}

/** An emitter's listeners for the event, or an EventTarget's (as its listeners() would). */
function getEventListeners(emitterOrTarget, type) {
  if (typeof emitterOrTarget?.listeners === "function") return emitterOrTarget.listeners(type);
  if (isEventTarget(emitterOrTarget)) return eventTargetListeners(emitterOrTarget, type) ?? [];
  throw invalidArgType("emitter", "an instance of EventEmitter or EventTarget", emitterOrTarget);
}

function getMaxListeners(emitterOrTarget) {
  if (typeof emitterOrTarget?.getMaxListeners === "function") return emitterOrTarget.getMaxListeners();
  if (isEventTarget(emitterOrTarget)) return emitterOrTarget[kMaxEventTargetListeners] ?? EventEmitter.defaultMaxListeners;
  throw invalidArgType("emitter", "an instance of EventEmitter or EventTarget", emitterOrTarget);
}

/** setMaxListeners(n, ...targets): theirs, or with none the default for new ones. */
function setMaxListeners(n = EventEmitter.defaultMaxListeners, ...eventTargets) {
  if (typeof n !== "number") throw invalidArgType("setMaxListeners", "of type number", n);
  if (n < 0 || Number.isNaN(n)) {
    const e = new RangeError(`The value of "setMaxListeners" is out of range. It must be >= 0. Received ${n}`);
    e.code = "ERR_OUT_OF_RANGE";
    throw e;
  }
  if (eventTargets.length === 0) EventEmitter.defaultMaxListeners = n;
  for (const target of eventTargets) {
    if (typeof target?.setMaxListeners === "function") target.setMaxListeners(n);
    else if (isEventTarget(target)) target[kMaxEventTargetListeners] = n;
    else throw invalidArgType("eventTargets", "an instance of EventEmitter or EventTarget", target);
  }
}


/** Calls listener once the signal aborts (on a later microtask if it has), until disposed. */
function addAbortListener(signal, listener) {
  if (signal === undefined) throw invalidArgType("signal", "an instance of AbortSignal", signal);
  validateSignal(signal, "signal");
  if (typeof listener !== "function") throw invalidArgType("listener", "of type function", listener);
  let remove;
  if (signal.aborted) queueMicrotask(() => listener());
  else {
    signal.addEventListener("abort", listener, { once: true });
    remove = () => signal.removeEventListener("abort", listener);
  }
  return { __proto__: null, [Symbol.dispose ?? Symbol.for("nodejs.dispose")]() {
    remove?.();
  } };
}


/* the AsyncResource of an EventEmitterAsyncResource, which knows its emitter */
class EventEmitterReferencingAsyncResource extends AsyncResource {
  #emitter;
  constructor(emitter, type, options) {
    super(type, options);
    this.#emitter = emitter;
  }
  get eventEmitter() {
    return this.#emitter;
  }
}

/** An EventEmitter whose listeners run in the async context it was created in. */
class EventEmitterAsyncResource extends EventEmitter {
  #resource;
  constructor(options = undefined) {
    let name;
    if (typeof options === "string") {
      name = options;
      options = undefined;
    } else {
      if ((new.target === EventEmitterAsyncResource || new.target === EventEmitterAsyncResourceWrapper) && typeof options?.name !== "string") {
        throw invalidArgType("options.name", "of type string", options?.name);
      }
      name = options?.name || new.target.name;
    }
    super(options);
    this.#resource = new EventEmitterReferencingAsyncResource(this, name, options);
  }
  emit(event, ...args) {
    return this.#resource.runInAsyncScope(EventEmitter.prototype.emit, this, event, ...args);
  }
  emitDestroy() {
    this.#resource.emitDestroy();
  }
  get asyncId() {
    return this.#resource.asyncId();
  }
  get triggerAsyncId() {
    return this.#resource.triggerAsyncId();
  }
  get asyncResource() {
    return this.#resource;
  }
}

Object.assign(features, { getEventListeners, getMaxListeners, setMaxListeners, addAbortListener });
provideClass(EventEmitterAsyncResourceWrapper, EventEmitterAsyncResource);
