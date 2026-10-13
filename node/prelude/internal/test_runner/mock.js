// node:test's mocks: Node's lib/internal/test_runner/mock/mock.js (MIT; Node
// v22.22.2), ported: mock functions and methods (fn, method, getter, setter) with their calls,
// mocked properties (property), reset and restoreAll. Not here: mock.module(), which Node only
// has with --experimental-test-module-mocks and which needs a module loader at run time, and
// mock.timers, which throws ERR_VISALJS_UNSUPPORTED.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { invalidArgType, invalidArgValue, notSupported, outOfRange, validateFunction } from "../errors.js";

function kDefaultFunction() {}

function validateObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidArgType(name, "of type object", value);
}

function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw invalidArgType(name, "of type boolean", value);
}

function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < min || value > Number.MAX_SAFE_INTEGER) throw outOfRange(name, `>= ${min} && <= ${Number.MAX_SAFE_INTEGER}`, value);
}

function validateStringOrSymbol(value, name) {
  if (typeof value !== "string" && typeof value !== "symbol") throw invalidArgType(name, "of type string or symbol", value);
}

function validateTimes(value, name) {
  if (value === Infinity) {
    return;
  }

  validateInteger(value, name, 1);
}

export class MockFunctionContext {
  #calls;
  #mocks;
  #implementation;
  #restore;
  #times;

  constructor(implementation, restore, times) {
    this.#calls = [];
    this.#mocks = new Map();
    this.#implementation = implementation;
    this.#restore = restore;
    this.#times = times;
  }

  /** The recorded calls to the mock function. */
  get calls() {
    return this.#calls.slice(0);
  }

  /** The number of times the mock function has been called. */
  callCount() {
    return this.#calls.length;
  }

  /** A new implementation for the mock function. */
  mockImplementation(implementation) {
    validateFunction(implementation, "implementation");
    this.#implementation = implementation;
  }

  /** Replaces the implementation for one call: the next, or the call numbered `onCall`. */
  mockImplementationOnce(implementation, onCall) {
    validateFunction(implementation, "implementation");
    const nextCall = this.#calls.length;
    const call = onCall ?? nextCall;
    validateInteger(call, "onCall", nextCall);
    this.#mocks.set(call, implementation);
  }

  /** Restores the original function that was mocked. */
  restore() {
    const { descriptor, object, original, methodName } = this.#restore;

    if (typeof methodName === "string") {
      // This is an object method spy.
      Object.defineProperty(object, methodName, descriptor);
    } else {
      // This is a bare function spy. There isn't much to do here but make
      // the mock call the original function.
      this.#implementation = original;
    }
  }

  /** Forgets the recorded calls. */
  resetCalls() {
    this.#calls = [];
  }

  trackCall(call) {
    this.#calls.push(call);
  }

  nextImpl() {
    const nextCall = this.#calls.length;
    const mock = this.#mocks.get(nextCall);
    const impl = mock ?? this.#implementation;

    if (nextCall + 1 === this.#times) {
      this.restore();
    }

    this.#mocks.delete(nextCall);
    return impl;
  }
}

const { nextImpl, restore: restoreFn, trackCall } = MockFunctionContext.prototype;
delete MockFunctionContext.prototype.trackCall;
delete MockFunctionContext.prototype.nextImpl;

class MockPropertyContext {
  #object;
  #propertyName;
  #value;
  #originalValue;
  #descriptor;
  #accesses;
  #onceValues;

  constructor(object, propertyName, value) {
    this.#onceValues = new Map();
    this.#accesses = [];
    this.#object = object;
    this.#propertyName = propertyName;
    this.#originalValue = object[propertyName];
    this.#value = arguments.length > 2 ? value : this.#originalValue;
    this.#descriptor = Object.getOwnPropertyDescriptor(object, propertyName);
    if (!this.#descriptor) {
      throw invalidArgValue("propertyName", "is not a property of the object", propertyName);
    }

    const { configurable, enumerable } = this.#descriptor;
    Object.defineProperty(object, propertyName, {
      configurable,
      enumerable,
      get: () => {
        const nextValue = this.#getAccessValue(this.#value);
        const access = { __proto__: null, type: "get", value: nextValue, stack: new Error() };
        this.#accesses.push(access);
        return nextValue;
      },
      set: this.mockImplementation.bind(this),
    });
  }

  /** The recorded accesses (get and set) to the property. */
  get accesses() {
    return this.#accesses.slice(0);
  }

  /** The number of times the property was accessed. */
  accessCount() {
    return this.#accesses.length;
  }

  /** A new value for the property. */
  mockImplementation(value) {
    if (!this.#descriptor.writable) {
      throw invalidArgValue("propertyName", "cannot be set", this.#propertyName);
    }
    const nextValue = this.#getAccessValue(value);
    const access = { __proto__: null, type: "set", value: nextValue, stack: new Error() };
    this.#accesses.push(access);
    this.#value = nextValue;
  }

  #getAccessValue(value) {
    const accessIndex = this.#accesses.length;
    let accessValue;
    if (this.#onceValues.has(accessIndex)) {
      accessValue = this.#onceValues.get(accessIndex);
      this.#onceValues.delete(accessIndex);
    } else {
      accessValue = value;
    }
    return accessValue;
  }

  /** A value for one access only: the next, or the access numbered `onAccess`. */
  mockImplementationOnce(value, onAccess) {
    const nextAccess = this.#accesses.length;
    const accessIndex = onAccess ?? nextAccess;
    validateInteger(accessIndex, "onAccess", nextAccess);
    this.#onceValues.set(accessIndex, value);
  }

  /** Forgets the recorded accesses. */
  resetAccesses() {
    this.#accesses = [];
  }

  /** Restores the property's original value. */
  restore() {
    Object.defineProperty(this.#object, this.#propertyName, { ...this.#descriptor, value: this.#originalValue });
  }
}

const { restore: restoreProperty } = MockPropertyContext.prototype;

function findMethodOnPrototypeChain(instance, methodName) {
  let host = instance;
  let descriptor;

  while (host !== null) {
    descriptor = Object.getOwnPropertyDescriptor(host, methodName);

    if (descriptor) {
      break;
    }

    host = Object.getPrototypeOf(host);
  }

  return descriptor;
}

export class MockTracker {
  #mocks = [];

  /** Node's mock timers: not supported yet. */
  get timers() {
    throw notSupported("mock.timers");
  }

  /** A mock function: `original` called through, or `implementation` instead; options.times. */
  fn(original = function () {}, implementation = original, options = {}) {
    if (original !== null && typeof original === "object") {
      options = original;
      original = function () {};
      implementation = original;
    } else if (implementation !== null && typeof implementation === "object") {
      options = implementation;
      implementation = original;
    }

    validateFunction(original, "original");
    validateFunction(implementation, "implementation");
    validateObject(options, "options");
    const { times = Infinity } = options;
    validateTimes(times, "options.times");
    const ctx = new MockFunctionContext(implementation, { __proto__: null, original }, times);
    return this.#setupMock(ctx, original);
  }

  /** Replaces a method (or with options.getter / options.setter, an accessor) with a mock. */
  method(objectOrFunction, methodName, implementation = kDefaultFunction, options = {}) {
    validateStringOrSymbol(methodName, "methodName");
    if (typeof objectOrFunction !== "function") {
      validateObject(objectOrFunction, "object");
    }

    if (implementation !== null && typeof implementation === "object") {
      options = implementation;
      implementation = kDefaultFunction;
    }

    validateFunction(implementation, "implementation");
    validateObject(options, "options");

    const { getter = false, setter = false, times = Infinity } = options;

    validateBoolean(getter, "options.getter");
    validateBoolean(setter, "options.setter");
    validateTimes(times, "options.times");

    if (setter && getter) {
      throw invalidArgValue("options.setter", "cannot be used with 'options.getter'", setter);
    }
    const descriptor = findMethodOnPrototypeChain(objectOrFunction, methodName);

    let original;

    if (getter) {
      original = descriptor?.get;
    } else if (setter) {
      original = descriptor?.set;
    } else {
      original = descriptor?.value;
    }

    if (typeof original !== "function") {
      throw invalidArgValue("methodName", "must be a method", original);
    }

    const restore = { __proto__: null, descriptor, object: objectOrFunction, methodName };
    const impl = implementation === kDefaultFunction ? original : implementation;
    const ctx = new MockFunctionContext(impl, restore, times);
    const mock = this.#setupMock(ctx, original);
    const mockDescriptor = { __proto__: null, configurable: descriptor.configurable, enumerable: descriptor.enumerable };

    if (getter) {
      mockDescriptor.get = mock;
      mockDescriptor.set = descriptor.set;
    } else if (setter) {
      mockDescriptor.get = descriptor.get;
      mockDescriptor.set = mock;
    } else {
      mockDescriptor.writable = descriptor.writable;
      mockDescriptor.value = mock;
    }

    Object.defineProperty(objectOrFunction, methodName, mockDescriptor);

    return mock;
  }

  /** method() for a getter. */
  getter(object, methodName, implementation = kDefaultFunction, options = {}) {
    if (implementation !== null && typeof implementation === "object") {
      options = implementation;
      implementation = kDefaultFunction;
    } else {
      validateObject(options, "options");
    }

    const { getter = true } = options;

    if (getter === false) {
      throw invalidArgValue("options.getter", "cannot be false", getter);
    }

    return this.method(object, methodName, implementation, { __proto__: null, ...options, getter });
  }

  /** method() for a setter. */
  setter(object, methodName, implementation = kDefaultFunction, options = {}) {
    if (implementation !== null && typeof implementation === "object") {
      options = implementation;
      implementation = kDefaultFunction;
    } else {
      validateObject(options, "options");
    }

    const { setter = true } = options;

    if (setter === false) {
      throw invalidArgValue("options.setter", "cannot be false", setter);
    }

    return this.method(object, methodName, implementation, { __proto__: null, ...options, setter });
  }

  /** A property whose value is `value` (or its own) and whose accesses are recorded. */
  property(object, propertyName, value) {
    validateObject(object, "object");
    validateStringOrSymbol(propertyName, "propertyName");

    const ctx = arguments.length > 2 ? new MockPropertyContext(object, propertyName, value) : new MockPropertyContext(object, propertyName);
    this.#mocks.push({ __proto__: null, ctx, restore: restoreProperty });

    return new Proxy(object, {
      __proto__: null,
      get(target, property, receiver) {
        if (property === "mock") {
          return ctx;
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  /** Restores every mock, and forgets them. */
  reset() {
    this.restoreAll();
    this.#mocks = [];
  }

  /** Restores every mock this tracker made. */
  restoreAll() {
    for (let i = 0; i < this.#mocks.length; i++) {
      const { ctx, restore } = this.#mocks[i];

      restore.call(ctx);
    }
  }

  #setupMock(ctx, fnToMatch) {
    const mock = new Proxy(fnToMatch, {
      __proto__: null,
      apply(_fn, thisArg, argList) {
        const fn = nextImpl.call(ctx);
        let result;
        let error;

        try {
          result = Reflect.apply(fn, thisArg, argList);
        } catch (err) {
          error = err;
          throw err;
        } finally {
          trackCall.call(ctx, { __proto__: null, arguments: argList, error, result, stack: new Error(), target: undefined, this: thisArg });
        }

        return result;
      },
      construct(target, argList, newTarget) {
        const realTarget = nextImpl.call(ctx);
        let result;
        let error;

        try {
          result = Reflect.construct(realTarget, argList, newTarget);
        } catch (err) {
          error = err;
          throw err;
        } finally {
          trackCall.call(ctx, { __proto__: null, arguments: argList, error, result, stack: new Error(), target, this: result });
        }

        return result;
      },
      get(target, property, receiver) {
        if (property === "mock") {
          return ctx;
        }

        return Reflect.get(target, property, receiver);
      },
    });

    this.#mocks.push({ __proto__: null, ctx, restore: restoreFn });
    return mock;
  }
}
