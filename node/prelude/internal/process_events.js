// process as an EventEmitter: the runtime's process, in every binary, is a plain
// object. A program that may call its emitter methods gets this module first (the driver adds it:
// implicitModules in node/index.ts), and the runtime emits process's events through its emit.
import { EventEmitter } from "../events.js";
import { invalidArgType, validateString } from "./errors.js";

const p = globalThis.process;

/* its prototype is process.constructor.prototype, an EventEmitter's, as in Node */
function process() {}
process.prototype = Object.create(EventEmitter.prototype, {
  constructor: { value: process, writable: true, configurable: true },
});
Object.setPrototypeOf(p, process.prototype);
EventEmitter.init.call(p);

/* emitWarning, as Node's (lib/internal/process/warning.js): the warning as an Error (name the
 * type, code, detail), printed by the runtime's emitWarning (Node's own 'warning' listener), and
 * emitted as 'warning' on the next tick */
const printWarning = p.emitWarning;
p.emitWarning = function emitWarning(warning, type, code, ctor) {
  if (p.noDeprecation && type === "DeprecationWarning") return;
  let detail;
  if (type !== null && typeof type === "object" && !Array.isArray(type)) {
    ctor = type.ctor;
    code = type.code;
    if (typeof type.detail === "string") detail = type.detail;
    type = type.type || "Warning";
  } else if (typeof type === "function") {
    ctor = type;
    code = undefined;
    type = "Warning";
  }
  if (type !== undefined) validateString(type, "type");
  if (typeof code === "function") {
    ctor = code;
    code = undefined;
  } else if (code !== undefined) {
    validateString(code, "code");
  }
  if (typeof warning === "string") {
    warning = new Error(warning);
    warning.name = String(type || "Warning");
    if (code !== undefined) warning.code = code;
    if (detail !== undefined) warning.detail = detail;
    if (typeof Error.captureStackTrace === "function") Error.captureStackTrace(warning, ctor || p.emitWarning);
  } else if (!(warning instanceof Error)) {
    throw invalidArgType("warning", "of type string or an instance of Error", warning);
  }
  if (warning.name === "DeprecationWarning") {
    if (p.noDeprecation) return;
    if (p.throwDeprecation) {
      p.nextTick(() => {
        throw warning;
      });
      return;
    }
  }
  const text = typeof warning.detail === "string" ? `${warning.message}\n${warning.detail}` : warning.message;
  printWarning.call(p, text, String(warning.name), warning.code === undefined ? undefined : String(warning.code));
  p.nextTick(() => p.emit("warning", warning));
};
