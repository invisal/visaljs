// The errors node:stream throws, as Node's lib/internal/errors.js builds them: each code a class
// (`new ERR_STREAM_DESTROYED("write")`) whose instances are Node's TypeError, RangeError or Error
// with that `code` and Node's message. Only the codes the streams use.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { utilInspect } from "visaljs:host";
import { codeError } from "../errors.js";

const kTypes = ["string", "function", "number", "object", "Function", "Object", "boolean", "bigint", "symbol"];
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

function formatList(array, type = "and") {
  switch (array.length) {
    case 0: return "";
    case 1: return `${array[0]}`;
    case 2: return `${array[0]} ${type} ${array[1]}`;
    case 3: return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default: return `${array.slice(0, -1).join(", ")}, ${type} ${array[array.length - 1]}`;
  }
}

function addNumericalSeparator(val) {
  let res = "";
  let i = val.length;
  const start = val[0] === "-" ? 1 : 0;
  for (; i >= start + 4; i -= 3) res = `_${val.slice(i - 3, i)}${res}`;
  return `${val.slice(0, i)}${res}`;
}

/** Node's determineSpecificType: how a received value is named in a message */
export function determineSpecificType(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const type = typeof value;
  switch (type) {
    case "bigint":
      return `type bigint (${value}n)`;
    case "number":
      if (value === 0) return 1 / value === -Infinity ? "type number (-0)" : "type number (0)";
      if (value !== value) return "type number (NaN)";
      if (value === Infinity) return "type number (Infinity)";
      if (value === -Infinity) return "type number (-Infinity)";
      return `type number (${value})`;
    case "boolean":
      return value ? "type boolean (true)" : "type boolean (false)";
    case "symbol":
      return `type symbol (${String(value)})`;
    case "function":
      return `function ${value.name}`;
    case "object":
      if (value.constructor && "name" in value.constructor) return `an instance of ${value.constructor.name}`;
      return `${utilInspect(value, { depth: -1 })}`;
    case "string":
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      if (value.indexOf("'") === -1) return `type string ('${value}')`;
      return `type string (${JSON.stringify(value)})`;
    default: {
      let inspected = utilInspect(value, { colors: false });
      if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
      return `type ${type} (${inspected})`;
    }
  }
}

function invalidArgTypeMessage(name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];
  let msg = "The ";
  if (name.endsWith(" argument")) msg += `${name} `;
  else msg += `"${name}" ${name.includes(".") ? "property" : "argument"} `;
  msg += "must be ";
  const types = [];
  const instances = [];
  const other = [];
  for (const value of expected) {
    if (kTypes.includes(value)) types.push(value.toLowerCase());
    else if (classRegExp.exec(value) !== null) instances.push(value);
    else other.push(value);
  }
  if (instances.length > 0) {
    const pos = types.indexOf("object");
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push("Object");
    }
  }
  if (types.length > 0) {
    msg += `${types.length > 1 ? "one of type" : "of type"} ${formatList(types, "or")}`;
    if (instances.length > 0 || other.length > 0) msg += " or ";
  }
  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, "or")}`;
    if (other.length > 0) msg += " or ";
  }
  if (other.length > 0) {
    if (other.length > 1) msg += `one of ${formatList(other, "or")}`;
    else {
      if (other[0].toLowerCase() !== other[0]) msg += "an ";
      msg += `${other[0]}`;
    }
  }
  return msg + `. Received ${determineSpecificType(actual)}`;
}

/** A code's class: `new` gives Base's instance with the code and the message format(…args) makes. */
function E(code, format, Base) {
  const make = typeof format === "function" ? format : (...args) => {
    let i = 0;
    return format.replace(/%s/g, () => String(args[i++]));
  };
  const Ctor = function (...args) {
    return codeError(Base, code, make(...args));
  };
  Object.defineProperty(Ctor, "name", { value: code });
  Ctor.prototype = Base.prototype;
  return Ctor;
}

export const codes = {
  ERR_INVALID_ARG_TYPE: E("ERR_INVALID_ARG_TYPE", invalidArgTypeMessage, TypeError),
  ERR_INVALID_ARG_VALUE: E("ERR_INVALID_ARG_VALUE", (name, value, reason = "is invalid") => {
    let inspected = utilInspect(value);
    if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
    return `The ${name.includes(".") ? "property" : "argument"} '${name}' ${reason}. Received ${inspected}`;
  }, TypeError),
  ERR_INVALID_RETURN_VALUE: E("ERR_INVALID_RETURN_VALUE",
    (input, name, value) => `Expected ${input} to be returned from the "${name}" function but got ${determineSpecificType(value)}.`, TypeError),
  ERR_MISSING_ARGS: E("ERR_MISSING_ARGS", (...args) => {
    const len = args.length;
    const wrap = (a) => `"${a}"`;
    args = args.map((a) => (Array.isArray(a) ? a.map(wrap).join(" or ") : wrap(a)));
    return `The ${formatList(args)} argument${len > 1 ? "s" : ""} must be specified`;
  }, TypeError),
  ERR_METHOD_NOT_IMPLEMENTED: E("ERR_METHOD_NOT_IMPLEMENTED", "The %s method is not implemented", Error),
  ERR_MULTIPLE_CALLBACK: E("ERR_MULTIPLE_CALLBACK", "Callback called multiple times", Error),
  ERR_OUT_OF_RANGE: E("ERR_OUT_OF_RANGE", (str, range, input, replaceDefaultBoolean = false) => {
    let msg = replaceDefaultBoolean ? str : `The value of "${str}" is out of range.`;
    let received;
    if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
      received = addNumericalSeparator(String(input));
    } else if (typeof input === "bigint") {
      received = String(input);
      if (input > 2n ** 32n || input < -(2n ** 32n)) received = addNumericalSeparator(received);
      received += "n";
    } else {
      received = utilInspect(input);
    }
    return msg + ` It must be ${range}. Received ${received}`;
  }, RangeError),
  ERR_STREAM_PREMATURE_CLOSE: E("ERR_STREAM_PREMATURE_CLOSE", "Premature close", Error),
  ERR_STREAM_DESTROYED: E("ERR_STREAM_DESTROYED", "Cannot call %s after a stream was destroyed", Error),
  ERR_UNKNOWN_ENCODING: E("ERR_UNKNOWN_ENCODING", "Unknown encoding: %s", TypeError),
  ERR_STREAM_NULL_VALUES: E("ERR_STREAM_NULL_VALUES", "May not write null values to stream", TypeError),
  ERR_STREAM_PUSH_AFTER_EOF: E("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF", Error),
  ERR_ILLEGAL_CONSTRUCTOR: E("ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor", TypeError),
  ERR_STREAM_WRITE_AFTER_END: E("ERR_STREAM_WRITE_AFTER_END", "write after end", Error),
  ERR_STREAM_UNSHIFT_AFTER_END_EVENT: E("ERR_STREAM_UNSHIFT_AFTER_END_EVENT", "stream.unshift() after end event", Error),
  ERR_STREAM_UNABLE_TO_PIPE: E("ERR_STREAM_UNABLE_TO_PIPE", "Cannot pipe to a closed or destroyed stream", Error),
  ERR_STREAM_ITER_MISSING_FLAG: E("ERR_STREAM_ITER_MISSING_FLAG", "The stream/iter API requires the --experimental-stream-iter flag", TypeError),
  ERR_STREAM_CANNOT_PIPE: E("ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable", Error),
  ERR_STREAM_ALREADY_FINISHED: E("ERR_STREAM_ALREADY_FINISHED", "Cannot call %s after a stream was finished", Error),
  ERR_INVALID_STATE: E("ERR_INVALID_STATE", "Invalid state: %s", Error),
};
codes.ERR_INVALID_STATE.TypeError = E("ERR_INVALID_STATE", "Invalid state: %s", TypeError);

export class AbortError extends Error {
  constructor(message = "The operation was aborted", options = undefined) {
    if (options !== undefined && typeof options !== "object") throw new codes.ERR_INVALID_ARG_TYPE("options", "Object", options);
    super(message, options);
    this.code = "ABORT_ERR";
    this.name = "AbortError";
  }
}

/** Two errors as one: the outer one, with the inner one added (an AggregateError of both). */
export function aggregateTwoErrors(innerError, outerError) {
  if (innerError && outerError && innerError !== outerError) {
    if (Array.isArray(outerError.errors)) {
      outerError.errors.push(innerError);
      return outerError;
    }
    const err = new AggregateError([outerError, innerError], outerError.message);
    err.code = outerError.code;
    return err;
  }
  return innerError || outerError;
}
