// node:util's rarely used functions: callbackify, aborted, toUSVString, the
// transferable AbortController and signal, getCallSites, setTraceSigInt, and the deprecated is*,
// log and _extend. Linked into programs that name them (internal/features.js).
import { deprecate, format } from "../util.js";
import types from "../util_types.js";
import { codeError, invalidArgType, validateFunction } from "./errors.js";
import { features } from "./features.js";

/** A function returning a promise as one taking a callback (err, value) last. */
function callbackify(original) {
  validateFunction(original, "original");
  function callbackified(...args) {
    const maybeCb = args.pop();
    validateFunction(maybeCb, "last argument");
    const cb = maybeCb.bind(this);
    Reflect.apply(original, this, args).then(
      (ret) => process.nextTick(cb, null, ret),
      (rej) => process.nextTick(callbackifyOnRejected, rej, cb),
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(original);
  if (typeof descriptors.length.value === "number") descriptors.length.value++;
  if (typeof descriptors.name.value === "string") descriptors.name.value += "Callbackified";
  for (const descriptor of Object.values(descriptors)) Object.setPrototypeOf(descriptor, null);
  Object.defineProperties(callbackified, descriptors);
  return callbackified;
}

/* a falsy rejection becomes an Error, which keeps the value as its reason */
function callbackifyOnRejected(reason, cb) {
  if (!reason) {
    const err = codeError(Error, "ERR_FALSY_VALUE_REJECTION", "Promise was rejected with falsy value");
    err.reason = reason;
    reason = err;
  }
  return cb(reason);
}


/** The string with its lone surrogates replaced by U+FFFD. */
function toUSVString(input) {
  return `${input}`.toWellFormed();
}

function validateAbortSignal(signal, name) {
  if (signal === null || typeof signal !== "object" || !("aborted" in signal)) throw invalidArgType(name, "an instance of AbortSignal", signal);
}

/* the resources whose signal a promise waits for: the listener goes when they do */
const abortedListeners = new WeakMap();

/** A promise resolved when the signal aborts, while the resource is alive. */
function aborted(signal, resource) {
  validateAbortSignal(signal, "signal");
  if (resource === null || (typeof resource !== "object" && typeof resource !== "function")) {
    throw invalidArgType("resource", "of type object", resource);
  }
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
    abortedListeners.set(resource, resolve);
  });
}

/** Marks a signal as transferable to workers: a compiled program has none, so it's the signal. */
function transferableAbortSignal(signal) {
  validateAbortSignal(signal, "signal");
  return signal;
}

function transferableAbortController() {
  return new AbortController();
}

/** The call sites: a compiled program has no stack frames to give. */
function getCallSites() {
  return [];
}
const getCallSite = deprecate(getCallSites, "The `util.getCallSite` API has been renamed to `util.getCallSites()`.", "DEP0186");

/** Whether SIGINT prints a stack trace: a compiled program has none to print. */
function setTraceSigInt(enable) {
  if (typeof enable !== "boolean") throw invalidArgType("enable", "of type boolean", enable);
}

/* ---- deprecated ---------------------------------------------------------------------------- */

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => n.toString().padStart(2, "0");

const log = deprecate(function log(...args) {
  const d = new Date();
  const time = [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join(":");
  globalThis.console.log("%s - %s", `${d.getDate()} ${months[d.getMonth()]} ${time}`, format(...args));
}, "The `util.log API is deprecated. Please use console.log() with a custom formatter or a third-party logger instead.", "DEP0059");

const _extend = deprecate(function _extend(target, source) {
  if (source === null || typeof source !== "object") return target;
  const keys = Object.keys(source);
  let i = keys.length;
  while (i--) target[keys[i]] = source[keys[i]];
  return target;
}, "The `util._extend` API is deprecated. Please use Object.assign() instead.", "DEP0060");

const isArray = deprecate(Array.isArray, "The `util.isArray` API is deprecated. Please use `Array.isArray()` instead.", "DEP0044");
const isBoolean = deprecate((arg) => typeof arg === "boolean", "The `util.isBoolean` API is deprecated.  Please use `typeof arg === \"boolean\"` instead.", "DEP0045");
const isBuffer = deprecate((arg) => Buffer.isBuffer(arg), "The `util.isBuffer` API is deprecated. Please use `Buffer.isBuffer()` instead.", "DEP0046");
const isDate = deprecate((arg) => types.isDate(arg), "The `util.isDate` API is deprecated.  Please use `arg instanceof Date` instead.", "DEP0047");
const isError = deprecate((e) => Object.prototype.toString.call(e) === "[object Error]" || e instanceof Error,
  "The `util.isError` API is deprecated. Please use `ObjectPrototypeToString(e) === \"[object Error]\" || e instanceof Error` instead.", "DEP0048");
const isFunction = deprecate((arg) => typeof arg === "function", "The `util.isFunction` API is deprecated.  Please use `typeof arg === \"function\"` instead.", "DEP0049");
const isNull = deprecate((arg) => arg === null, "The `util.isNull` API is deprecated. Please use `arg === null` instead.", "DEP0050");
const isNullOrUndefined = deprecate((arg) => arg === null || arg === undefined,
  "The `util.isNullOrUndefined` API is deprecated. Please use `arg === null || arg === undefined` instead.", "DEP0051");
const isNumber = deprecate((arg) => typeof arg === "number", "The `util.isNumber` API is deprecated. Please use `typeof arg === \"number\"` instead.", "DEP0052");
const isObject = deprecate((arg) => arg !== null && typeof arg === "object",
  "The `util.isObject` API is deprecated. Please use `arg !== null && typeof arg === \"object\"` instead.", "DEP0053");
const isPrimitive = deprecate((arg) => arg === null || (typeof arg !== "object" && typeof arg !== "function"),
  "The `util.isPrimitive` API is deprecated. Please use `arg === null || (typeof arg !== \"object\" && typeof arg !== \"function\")` instead.", "DEP0054");
const isRegExp = deprecate((arg) => types.isRegExp(arg), "The `util.isRegExp` API is deprecated. Please use `arg instanceof RegExp` instead.", "DEP0055");
const isString = deprecate((arg) => typeof arg === "string", "The `util.isString` API is deprecated.  Please use `typeof arg === \"string\"` instead.", "DEP0056");
const isSymbol = deprecate((arg) => typeof arg === "symbol", "The `util.isSymbol` API is deprecated.  Please use `arg === \"symbol\"` instead.", "DEP0057");
const isUndefined = deprecate((arg) => arg === undefined, "The `util.isUndefined` API is deprecated. Please use `arg === undefined` instead.", "DEP0058");

Object.assign(features, { callbackify, toUSVString, aborted, transferableAbortSignal, transferableAbortController, getCallSites, getCallSite, setTraceSigInt, log, _extend, isArray, isBoolean, isBuffer, isDate, isError, isFunction, isNull, isNullOrUndefined, isNumber, isObject, isPrimitive, isRegExp, isString, isSymbol, isUndefined });
