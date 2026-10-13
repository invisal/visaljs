// node:util: inspect and format are the runtime's (console prints
// with them), Node's algorithms in C; deprecate, inherits, types (node:util/types),
// isDeepStrictEqual (node:assert's deepStrictEqual, internal/comparisons.js), promisify,
// callbackify, stripVTControlCharacters and styleText, debuglog, parseArgs, parseEnv, MIMEType,
// diff, the system error names, and the deprecated is* functions and log; TextEncoder and
// TextDecoder, the globals (the runtime's encoding component).
import { utilFormat, utilFormatWithOptions, utilInspect } from "visaljs:host";
import { isDeepStrictEqual } from "./internal/comparisons.js";
import { validateFunction, validateString } from "./internal/errors.js";
import { lazyClass, lazyFunction } from "./internal/features.js";
import types, { isPromise } from "./util_types.js";

export { types };

export const inspect = utilInspect;
inspect.custom = Symbol.for("nodejs.util.inspect.custom");
inspect.defaultOptions = {
  showHidden: false,
  depth: 2,
  colors: false,
  customInspect: true,
  showProxy: false,
  maxArrayLength: 100,
  maxStringLength: 10000,
  breakLength: 80,
  compact: 3,
  sorted: false,
  getters: false,
  numericSeparator: false,
};
export const format = utilFormat;
export const formatWithOptions = utilFormatWithOptions;
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;

/* ANSI escape codes, as Node's internal/util/inspect.js matches them */
const ansi = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*" +
  "(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*" +
  "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?" +
  "(?:\\u0007|\\u001B\\u005C|\\u009C))" +
  "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?" +
  "[\\dA-PR-TZcf-nq-uy=><~]))", "g",
);

const kCustomPromisifiedSymbol = Symbol.for("nodejs.util.promisify.custom");
/* names to make an object of when the callback gets several values, e.g. ['bytesRead', 'buffer'] */
const kCustomPromisifyArgsSymbol = Symbol("customPromisifyArgs");

/** A function taking a callback (err, value) as one returning a promise: Node's
 *  internal/util.js promisify, with its util.promisify.custom. */
export function promisify(original) {
  validateFunction(original, "original");

  if (original[kCustomPromisifiedSymbol]) {
    const fn = original[kCustomPromisifiedSymbol];

    validateFunction(fn, "util.promisify.custom");

    return Object.defineProperty(fn, kCustomPromisifiedSymbol, { value: fn, enumerable: false, writable: false, configurable: true });
  }

  const argumentNames = original[kCustomPromisifyArgsSymbol];

  function fn(...args) {
    return new Promise((resolve, reject) => {
      args.push((err, ...values) => {
        if (err) {
          return reject(err);
        }
        if (argumentNames !== undefined && values.length > 1) {
          const obj = {};
          for (let i = 0; i < argumentNames.length; i++) obj[argumentNames[i]] = values[i];
          resolve(obj);
        } else {
          resolve(values[0]);
        }
      });
      if (isPromise(Reflect.apply(original, this, args))) {
        process.emitWarning("Calling promisify on a function that returns a Promise is likely a mistake.", "DeprecationWarning", "DEP0174");
      }
    });
  }

  Object.setPrototypeOf(fn, Object.getPrototypeOf(original));

  Object.defineProperty(fn, kCustomPromisifiedSymbol, { value: fn, enumerable: false, writable: false, configurable: true });

  const descriptors = Object.getOwnPropertyDescriptors(original);
  for (const descriptor of Object.values(descriptors)) Object.setPrototypeOf(descriptor, null);
  return Object.defineProperties(fn, descriptors);
}

promisify.custom = kCustomPromisifiedSymbol;

/** The string without its ANSI escape codes (colors, cursor movements, …). */
export function stripVTControlCharacters(str) {
  validateString(str, "str");
  return str.replace(ansi, "");
}

const codesWarned = new Set();

/** util.deprecate: fn, warning once (per code) the first time it is called. */
export function deprecate(fn, msg, code) {
  if (typeof fn !== "function") {
    const e = new TypeError('The "fn" argument must be of type function.');
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  if (process.noDeprecation === true) return fn;
  let warned = false;
  function deprecated(...args) {
    if (!warned && process.noDeprecation !== true) {
      warned = true;
      if (code !== undefined) {
        if (!codesWarned.has(code)) {
          process.emitWarning(msg, "DeprecationWarning", code);
          codesWarned.add(code);
        }
      } else {
        process.emitWarning(msg, "DeprecationWarning");
      }
    }
    if (new.target) return Reflect.construct(fn, args, new.target);
    return Reflect.apply(fn, this, args);
  }
  Object.setPrototypeOf(deprecated, fn);
  if (fn.prototype) deprecated.prototype = fn.prototype;
  return deprecated;
}

/** util.inherits: ctor's prototype inherits superCtor's (the legacy way), and ctor.super_. */
export function inherits(ctor, superCtor) {
  if (ctor === undefined || ctor === null) throw new TypeError('The "ctor" argument must be of type function.');
  if (superCtor === undefined || superCtor === null) throw new TypeError('The "superCtor" argument must be of type function.');
  if (superCtor.prototype === undefined) throw new TypeError('The "superCtor.prototype" property must be of type object.');
  Object.defineProperty(ctor, "super_", { value: superCtor, writable: true, configurable: true });
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

export { isDeepStrictEqual };

/* features in modules of their own, linked when the program names them (internal/features.js) */
export const MIMEType = lazyClass("MIMEType");
export const MIMEParams = lazyClass("MIMEParams");

export const parseArgs = lazyFunction("parseArgs");  /* internal/parse_args.js */

/* internal/system_errors.js */
export const getSystemErrorName = lazyFunction("getSystemErrorName", 1);
export const getSystemErrorMessage = lazyFunction("getSystemErrorMessage", 1);
export const getSystemErrorMap = lazyFunction("getSystemErrorMap");

export const parseEnv = lazyFunction("parseEnv", 1);  /* internal/dotenv.js */

/* internal/util_styles.js (with inspect.colors and inspect.styles), internal/util_diff.js */
export const styleText = lazyFunction("styleText", 2);
export const diff = lazyFunction("diff", 2);

/* the rarely used ones: internal/util_more.js */
export const callbackify = lazyFunction("callbackify", 1);
export const debuglog = lazyFunction("debuglog", 2);
export const debug = debuglog;
export const toUSVString = lazyFunction("toUSVString", 1);
export const aborted = lazyFunction("aborted", 2);
export const transferableAbortSignal = lazyFunction("transferableAbortSignal", 1);
export const transferableAbortController = lazyFunction("transferableAbortController");
export const getCallSites = lazyFunction("getCallSites");
export const setTraceSigInt = lazyFunction("setTraceSigInt", 1);
export const convertProcessSignalToExitCode = lazyFunction("convertProcessSignalToExitCode", 1);
export const _extend = lazyFunction("_extend", 2);
export const isArray = lazyFunction("isArray", 1);

/* in Node 24's order, which Object.keys(util) shows (less the internal _errnoException and
   _exceptionWithHostPort) */
export default {
  _extend, callbackify, convertProcessSignalToExitCode, debug, debuglog, deprecate, format, styleText, formatWithOptions, getCallSites,
  getSystemErrorMap, getSystemErrorName, getSystemErrorMessage, inherits, inspect, isArray, isDeepStrictEqual, promisify,
  stripVTControlCharacters, toUSVString, transferableAbortSignal, transferableAbortController, aborted, types, parseEnv, parseArgs,
  TextDecoder, TextEncoder, MIMEType, MIMEParams, diff, setTraceSigInt,
};
