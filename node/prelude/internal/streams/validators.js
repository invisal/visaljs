// The validators and helpers node:stream uses, as Node's lib/internal/validators.js and
// lib/internal/util.js have them.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { codes } from "./errors.js";

const { ERR_INVALID_ARG_TYPE, ERR_INVALID_ARG_VALUE, ERR_OUT_OF_RANGE } = codes;

export const kEmptyObject = Object.freeze({ __proto__: null });

export function validateObject(value, name) {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
}

export function validateAbortSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
    throw new ERR_INVALID_ARG_TYPE(name, "AbortSignal", signal);
  }
}

export function validateFunction(value, name) {
  if (typeof value !== "function") throw new ERR_INVALID_ARG_TYPE(name, "Function", value);
}

export function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw new ERR_INVALID_ARG_TYPE(name, "boolean", value);
}

export function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  if (value < min || value > max) throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
}

export function validateOneOf(value, name, oneOf) {
  if (!oneOf.includes(value)) {
    const allowed = oneOf.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ");
    throw new ERR_INVALID_ARG_VALUE(name, value, "must be one of: " + allowed);
  }
}

export function once(callback, { preserveReturnValue = false } = kEmptyObject) {
  let called = false;
  let returnValue;
  return function (...args) {
    if (called) return returnValue;
    called = true;
    const result = Reflect.apply(callback, this, args);
    returnValue = preserveReturnValue ? result : undefined;
    return result;
  };
}

/** events.addAbortListener (lib/internal/events/abort_listener.js): the listener once the signal
 *  aborts (now, a microtask later, when it already has), and a disposable that removes it. */
export function addAbortListener(signal, listener) {
  if (signal === undefined) throw new codes.ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
  validateAbortSignal(signal, "signal");
  validateFunction(listener, "listener");
  let removeEventListener;
  if (signal.aborted) {
    queueMicrotask(() => listener());
  } else {
    signal.addEventListener("abort", listener, { __proto__: null, once: true });
    removeEventListener = () => signal.removeEventListener("abort", listener);
  }
  return {
    __proto__: null,
    [Symbol.dispose]() {
      removeEventListener?.();
    },
  };
}

/** A function named after `name` (a symbol: its description in brackets), as Node's util has it. */
export function assignFunctionName(name, fn, descriptor = kEmptyObject) {
  if (typeof name !== "string") name = `[${name.description}]`;
  return Object.defineProperty(fn, "name", {
    __proto__: null,
    writable: false,
    enumerable: false,
    configurable: true,
    ...Object.getOwnPropertyDescriptor(fn, "name"),
    ...descriptor,
    value: name,
  });
}
