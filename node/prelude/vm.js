// node:vm: contexts can be made and recognized, and memory measured, but running source text
// needs a JavaScript engine a compiled program doesn't have: Script runs, compileFunction and the
// run* functions throw ERR_VISALJS_UNSUPPORTED.
import { processMemory } from "visaljs:host";
import { invalidArgType, notSupported } from "./internal/errors.js";

const contexts = new WeakSet();
const kRunning = "vm (running source text)";

export const constants = Object.freeze({
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol("vm_dynamic_import_main_context_default"),
  DONT_CONTEXTIFY: Symbol("vm_context_no_contextify"),
});

/** createContext([object]): the object, marked as a context. */
export function createContext(contextObject = {}, options) {
  void options;
  if (contextObject === constants.DONT_CONTEXTIFY) contextObject = {};
  if (contextObject === null || typeof contextObject !== "object") throw invalidArgType("contextObject", "of type object", contextObject);
  contexts.add(contextObject);
  return contextObject;
}

export function isContext(object) {
  if (object === null || typeof object !== "object") throw invalidArgType("object", "of type object", object);
  return contexts.has(object);
}

/** Source text to run: kept, but running it throws. */
export class Script {
  constructor(code, options) {
    if (typeof code !== "string") throw invalidArgType("code", "of type string", code);
    this.code = code;
    this.filename = typeof options === "string" ? options : options?.filename ?? "evalmachine.<anonymous>";
  }

  runInThisContext() {
    throw notSupported(kRunning);
  }

  runInContext() {
    throw notSupported(kRunning);
  }

  runInNewContext() {
    throw notSupported(kRunning);
  }

  createCachedData() {
    return Buffer.alloc(0);
  }
}

export function createScript(code, options) {
  return new Script(code, options);
}

export function runInThisContext() {
  throw notSupported(kRunning);
}

export function runInContext() {
  throw notSupported(kRunning);
}

export function runInNewContext() {
  throw notSupported(kRunning);
}

export function compileFunction() {
  throw notSupported(kRunning);
}

/** The program's memory, as V8's estimate is reported: { total: { jsMemoryEstimate, jsMemoryRange } }. */
let measureWarned = false;
export function measureMemory(options = {}) {
  if (!measureWarned) {
    measureWarned = true;
    process.emitWarning("vm.measureMemory is an experimental feature and might change at any time", "ExperimentalWarning");
  }
  if (options === null || typeof options !== "object") return Promise.reject(invalidArgType("options", "of type object", options));
  const [, , heapUsed] = processMemory();
  return Promise.resolve({ total: { jsMemoryEstimate: heapUsed, jsMemoryRange: [heapUsed, heapUsed] } });
}

export default { Script, compileFunction, constants, createContext, createScript, isContext, measureMemory, runInContext, runInNewContext, runInThisContext };
