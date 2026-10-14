// Node's error shapes: argument errors with a `code`, and system errors built
// from the -errno that host primitives return.
import { errnoMessage, errnoName, utilInspect } from "visaljs:host";

/** How Node describes a bad argument: "Received type number (1)", "Received undefined", … */
function received(value) {
  if (value == null) return " Received " + value;
  if (typeof value === "function") return " Received function " + value.name;  /* determineSpecificType: empty when anonymous */
  if (typeof value === "object") {
    const ctor = value.constructor;
    return ctor && ctor.name ? " Received an instance of " + ctor.name : " Received " + String(value);
  }
  let shown = typeof value === "string" ? "'" + value + "'" : String(value);
  if (shown.length > 28) shown = shown.slice(0, 25) + "...";
  return " Received type " + typeof value + " (" + shown + ")";
}

function withCode(error, code) {
  Object.defineProperty(error, "code", { value: code, writable: true, enumerable: true, configurable: true });
  /* Node's NodeError: String(error) shows the code, "TypeError [ERR_X]: …" */
  Object.defineProperty(error, "toString", { value: nodeErrorToString(code), writable: true, enumerable: false, configurable: true });
  return error;
}

const toStrings = new Map();
function nodeErrorToString(code) {
  let fn = toStrings.get(code);
  if (fn === undefined) {
    fn = function toString() {
      return `${this.name} [${code}]: ${this.message}`;
    };
    toStrings.set(code, fn);
  }
  return fn;
}

/** An error of class Ctor with Node's `code`: codeError(TypeError, "ERR_X", "message"). */
export function codeError(Ctor, code, message) {
  return withCode(new Ctor(message), code);
}

/** ERR_INVALID_ARG_TYPE: `The "path" argument must be of type string. Received …` (a dotted
 *  name is a property: `The "options.encoding" property must be …`). */
export function invalidArgType(name, expected, value) {
  const what = name.indexOf(".") !== -1 ? "property" : "argument";
  return withCode(new TypeError("The \"" + name + "\" " + what + " must be " + expected + "." + received(value)), "ERR_INVALID_ARG_TYPE");
}

/** ERR_INVALID_ARG_VALUE: `The argument 'path' must be a string without null bytes. Received …`
 *  (a dotted name is a property; the value as util.inspect shows it). */
export function invalidArgValue(name, reason, value) {
  const what = name.indexOf(".") !== -1 ? "property" : "argument";
  return withCode(new TypeError("The " + what + " '" + name + "' " + reason + ". Received " + utilInspect(value)), "ERR_INVALID_ARG_VALUE");
}

/** A feature of the Node API that visaljs doesn't provide yet. */
export function notSupported(what) {
  return withCode(new Error(what + " is not supported by visaljs yet"), "ERR_VISALJS_UNSUPPORTED");
}

/** A failed system call: `ENOENT: no such file or directory, open 'x'`, with errno, code,
 *  syscall and path (and dest: `rename 'a' -> 'b'`), as Node's uvException builds it. */
export function systemError(errno, syscall, path, dest) {
  const code = errnoName(errno);
  const error = new Error(code + ": " + errnoMessage(errno) + ", " + syscall + (path === undefined ? "" : " '" + path + "'") +
    (dest === undefined ? "" : " -> '" + dest + "'"));
  error.errno = errno;
  error.code = code;
  error.syscall = syscall;
  if (path !== undefined) error.path = path;
  if (dest !== undefined) error.dest = dest;
  return error;
}

/** A failed libuv call as Node's errnoException builds it: `kill ESRCH`, with errno, code and
 *  syscall. */
export function errnoException(errno, syscall) {
  const code = errnoName(errno);
  const error = new Error(syscall + " " + code);
  error.errno = errno;
  error.code = code;
  error.syscall = syscall;
  return error;
}

export function validateString(value, name) {
  if (typeof value !== "string") throw invalidArgType(name, "of type string", value);
}

/** 1_000_000_000_000: Node's separators for large integers in messages. */
function separated(digits) {
  let out = "";
  let i = digits.length;
  const start = digits[0] === "-" ? 1 : 0;
  for (; i >= start + 4; i -= 3) out = "_" + digits.slice(i - 3, i) + out;
  return digits.slice(0, i) + out;
}

/** ERR_OUT_OF_RANGE: `The value of "code" is out of range. It must be an integer. Received 1.5` */
export function outOfRange(name, range, value) {
  let shown;
  if (Number.isInteger(value) && Math.abs(value) > 2 ** 32) shown = separated(String(value));
  else if (typeof value === "bigint") shown = String(value) + "n";  /* no BigInt literal here: it would link BigInt into every program */
  else shown = utilInspect(value);
  return withCode(new RangeError("The value of \"" + name + "\" is out of range. It must be " + range + ". Received " + shown), "ERR_OUT_OF_RANGE");
}

export function validateInteger(value, name) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (value !== value || value === Infinity || value === -Infinity || value % 1 !== 0) throw outOfRange(name, "an integer", value);
}

export function validateFunction(value, name) {
  if (typeof value !== "function") throw invalidArgType(name, "of type function", value);
}
