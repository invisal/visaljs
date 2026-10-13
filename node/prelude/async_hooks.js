// node:async_hooks: AsyncLocalStorage, its stores kept in the async
// context the runtime carries through promises, jobs and timers, as Node's AsyncContextFrame
// does; AsyncResource, which keeps the context it was created in for a callback (on-finished,
// raw-body). Hooks never fire: visaljs has no async resources to report.
import { currentContext, runInContext, setContext } from "./internal/async_context.js";
import { invalidArgType, validateFunction, validateString } from "./internal/errors.js";

let nextAsyncId = 2;  /* 1 is the main program's, as in Node */

export class AsyncResource {
  #asyncId;
  #triggerAsyncId;
  #context;

  constructor(type, opts = {}) {
    validateString(type, "type");
    this.#asyncId = nextAsyncId++;
    this.#triggerAsyncId = typeof opts === "number" ? opts : (opts.triggerAsyncId ?? 1);
    this.#context = currentContext();
  }

  runInAsyncScope(fn, thisArg, ...args) {
    return runInContext(this.#context, fn, thisArg, args);
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
  return 1;
}

export function triggerAsyncId() {
  return 0;
}

export function executionAsyncResource() {
  return {};
}

/** A hook that never fires: visaljs has no async resources to report. */
export function createHook() {
  return {
    enable() {
      return this;
    },
    disable() {
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
    const resource = new AsyncResource("AsyncLocalStorageSnapshot");
    return function runInAsyncScope(fn, ...args) {
      return resource.runInAsyncScope(fn, this, ...args);
    };
  }

  disable() {
    currentContext()?.delete(this);
  }

  enterWith(store) {
    setContext(new AsyncContextFrame(this, store));
  }

  run(store, fn, ...args) {
    return runInContext(new AsyncContextFrame(this, store), fn, null, args);
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
