// node:util's rarely used functions: callbackify, aborted, toUSVString, the
// transferable AbortController and signal, getCallSites, setTraceSigInt,
// convertProcessSignalToExitCode, and the deprecated isArray and _extend (Node 24 removed the other
// is* and log). Linked into programs that name them (internal/features.js).
import { osConstants } from "visaljs:host";
import { deprecate } from "../util.js";
import { codeError, invalidArgType, invalidArgValue, validateFunction } from "./errors.js";
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

/** The exit code of a process a signal ended: 128 and the signal's number, as a shell has it. */
function convertProcessSignalToExitCode(signalCode) {
  const table = osConstants()[0];  /* os.constants.signals': name, number, … */
  const at = table.indexOf(signalCode);
  if (typeof signalCode !== "string" || at < 0 || at % 2) {
    const names = table.filter((_, i) => i % 2 === 0);
    throw invalidArgValue("signalCode", "must be one of: " + names.map((n) => `'${n}'`).join(", "), signalCode);
  }
  return 128 + table[at + 1];
}

/** Whether SIGINT prints a stack trace: a compiled program has none to print. */
function setTraceSigInt(enable) {
  if (typeof enable !== "boolean") throw invalidArgType("enable", "of type boolean", enable);
}

/* ---- deprecated ---------------------------------------------------------------------------- */

const _extend = deprecate(function _extend(target, source) {
  if (source === null || typeof source !== "object") return target;
  const keys = Object.keys(source);
  let i = keys.length;
  while (i--) target[keys[i]] = source[keys[i]];
  return target;
}, "The `util._extend` API is deprecated. Please use Object.assign() instead.", "DEP0060");

const isArray = deprecate(Array.isArray, "The `util.isArray` API is deprecated. Please use `Array.isArray()` instead.", "DEP0044");
Object.assign(features, {
  callbackify, toUSVString, aborted, transferableAbortSignal, transferableAbortController, getCallSites, setTraceSigInt,
  convertProcessSignalToExitCode, _extend, isArray,
});
