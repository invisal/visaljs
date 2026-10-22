// node:async_hooks: AsyncLocalStorage, its stores kept in the async
// context the runtime carries through promises, jobs and timers, as Node's AsyncContextFrame
// does; AsyncResource, which keeps the context it was created in for a callback (on-finished,
// raw-body). Hooks never fire: visaljs has no async resources to report.
import { currentContext, runInContext, setContext } from "./internal/async_context.js";
import { codeError, invalidArgType, invalidArgValue, validateFunction, validateString } from "./internal/errors.js";

let nextAsyncId = 2;  /* 1 is the main program's, as in Node */
let currentAsyncId = 1;
let currentTriggerAsyncId = 0;
/* enabled hooks with an init: Node checks a resource's type only then, when init would be told it */
let initHooks = 0;

function invalidAsyncId(name, id) {
  return codeError(RangeError, "ERR_INVALID_ASYNC_ID", `Invalid ${name} value: ${id}`);
}

export class AsyncResource {
  #asyncId;
  #triggerAsyncId;
  #context;

  constructor(type, opts = {}) {
    validateString(type, "type");
    const triggerAsyncId = typeof opts === "number" ? opts : (opts.triggerAsyncId ?? currentAsyncId);
    if (!Number.isSafeInteger(triggerAsyncId) || triggerAsyncId < -1) throw invalidAsyncId("triggerAsyncId", triggerAsyncId);
    if (initHooks > 0 && type.length === 0) throw codeError(TypeError, "ERR_ASYNC_TYPE", `Invalid name for async "type": ${type}`);
    this.#asyncId = nextAsyncId++;
    this.#triggerAsyncId = triggerAsyncId;
    this.#context = currentContext();
  }

  runInAsyncScope(fn, thisArg, ...args) {
    const asyncId = currentAsyncId, triggerId = currentTriggerAsyncId;
    currentAsyncId = this.#asyncId;
    currentTriggerAsyncId = this.#triggerAsyncId;
    try {
      return runInContext(this.#context, fn, thisArg, args);
    } finally {
      currentAsyncId = asyncId;
      currentTriggerAsyncId = triggerId;
    }
  }

  emitDestroy() {
    return this;
  }

  asyncId() {
    return this.#asyncId;
  }

  triggerAsyncId() {
    return this.#triggerAsyncId;
  }

  bind(fn, thisArg) {
    validateFunction(fn, "fn");
    const run = (self, args) => this.runInAsyncScope(fn, self, ...args);
    const bound = thisArg === undefined
      ? function (...args) {
        return run(this, args);
      }
      : (...args) => run(thisArg, args);
    Object.defineProperties(bound, {
      length: { configurable: true, enumerable: false, value: fn.length, writable: false },
      asyncResource: { configurable: true, enumerable: true, value: this, writable: true },
    });
    return bound;
  }

  static bind(fn, type, thisArg) {
    type = type || fn.name || "bound-anonymous-fn";
    return new AsyncResource(type).bind(fn, thisArg);
  }
}

export function executionAsyncId() {
  return currentAsyncId;
}

export function triggerAsyncId() {
  return currentTriggerAsyncId;
}

export function executionAsyncResource() {
  return {};
}

const hookNames = ["init", "before", "after", "destroy", "promiseResolve"];

/** A hook that never fires: visaljs has no async resources to report. */
export function createHook(hooks) {
  for (const name of hookNames) {
    if (hooks[name] !== undefined && typeof hooks[name] !== "function") throw codeError(TypeError, "ERR_ASYNC_CALLBACK", `hook.${name} must be a function`);
  }
  if (hooks.trackPromises !== undefined && typeof hooks.trackPromises !== "boolean") throw invalidArgType("trackPromises", "of type boolean", hooks.trackPromises);
  if (hooks.trackPromises === false && hooks.promiseResolve) {
    throw invalidArgValue("trackPromises", "must not be false when promiseResolve is enabled", false);
  }
  const hasInit = hooks.init !== undefined;
  let enabled = false;
  return {
    enable() {
      if (!enabled && hasInit) initHooks++;
      enabled = true;
      return this;
    },
    disable() {
      if (enabled && hasInit) initHooks--;
      enabled = false;
      return this;
    },
  };
}

/* A frame: each storage's store, the context's value. A new one replaces the current one; it
 * isn't changed while current, but disable() (as Node's). */
class AsyncContextFrame extends Map {
  constructor(storage, store) {
    super(currentContext());
    this.set(storage, store);
  }
}

export class AsyncLocalStorage {
  #defaultValue;
  #name = "";

  constructor(options = {}) {
    if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
    this.#defaultValue = options.defaultValue;
    if (options.name !== undefined) this.#name = `${options.name}`;
  }

  get name() {
    return this.#name;
  }

  /** fn, run in the context current now, wherever it is called. */
  static bind(fn) {
    return AsyncResource.bind(fn);
  }

  /** (fn, ...args) => fn(...args) in the context current now. */
  static snapshot() {
    return AsyncLocalStorage.bind((cb, ...args) => cb(...args));
  }

  disable() {
    currentContext()?.delete(this);
  }

  enterWith(store) {
    setContext(new AsyncContextFrame(this, store));
  }

  /* as Node's: only this storage's store is put back after, so another's enterWith in fn outlasts it */
  run(store, fn, ...args) {
    const prior = this.getStore();
    if (Object.is(prior, store)) return Reflect.apply(fn, null, args);
    this.enterWith(store);
    try {
      return Reflect.apply(fn, null, args);
    } finally {
      this.enterWith(prior);
    }
  }

  exit(fn, ...args) {
    return this.run(undefined, fn, ...args);
  }

  getStore() {
    const frame = currentContext();
    return frame?.has(this) ? frame.get(this) : this.#defaultValue;
  }
}

export const asyncWrapProviders = Object.freeze({ __proto__: null });

export default { AsyncResource, AsyncLocalStorage, createHook, executionAsyncId, triggerAsyncId, executionAsyncResource, asyncWrapProviders };
