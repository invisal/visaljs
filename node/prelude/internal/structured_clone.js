// structuredClone, as Node's (V8's ValueSerializer and Node's host objects): ordinary objects and
// arrays (own enumerable properties, cycles and shared references kept), Date, RegExp, Map, Set,
// the primitive wrappers, ArrayBuffers and their views (a Buffer comes back a Uint8Array), the
// errors, Blob and File, DOMException; ArrayBuffers and web streams moved by the transfer list.
// Anything else is V8's DataCloneError. A program that names structuredClone gets this module
// first (implicitModules in node/index.ts).
import { cloneClass } from "visaljs:host";
import { codeError } from "./errors.js";

/* the intrinsics the clone reads through, as they are when the program starts */
const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getter = (proto, key) => Object.getOwnPropertyDescriptor(proto, key).get;
const typedArrayTag = getter(TypedArrayPrototype, Symbol.toStringTag);
const typedArrayBuffer = getter(TypedArrayPrototype, "buffer");
const typedArrayOffset = getter(TypedArrayPrototype, "byteOffset");
const typedArrayLength = getter(TypedArrayPrototype, "length");
const dataViewBuffer = getter(DataView.prototype, "buffer");
const dataViewOffset = getter(DataView.prototype, "byteOffset");
const dataViewLength = getter(DataView.prototype, "byteLength");
const arrayBufferLength = getter(ArrayBuffer.prototype, "byteLength");
const arrayBufferDetached = getter(ArrayBuffer.prototype, "detached");
const arrayBufferResizable = getter(ArrayBuffer.prototype, "resizable");
const arrayBufferMaxLength = getter(ArrayBuffer.prototype, "maxByteLength");
const arrayBufferSlice = ArrayBuffer.prototype.slice;
const arrayBufferTransfer = ArrayBuffer.prototype.transfer;
const regExpSource = getter(RegExp.prototype, "source");
const regExpFlags = getter(RegExp.prototype, "flags");
const dateTime = Date.prototype.getTime;
const mapForEach = Map.prototype.forEach;
const setForEach = Set.prototype.forEach;
const fileName = getter(File.prototype, "name");
const ERRORS = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
const STREAMS = new Set(["ReadableStream", "WritableStream", "TransformStream"]);
/* objects V8 can't serialize: "#<Name> could not be cloned." */
const UNCLONEABLE = new Set(["Proxy", "Arguments", "Promise", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "Generator",
  "AsyncGenerator", "Iterator", "Array Iterator", "Map Iterator", "Set Iterator", "String Iterator", "RegExp String Iterator",
  "AsyncFromSyncIterator", "Symbol"]);

const dataCloneError = (message) => new DOMException(message, "DataCloneError");

function isFile(blob) {
  try {
    fileName.call(blob);
    return true;
  } catch {
    return false;
  }
}

/** A copy of an ArrayBuffer, resizable as it is. */
function copyArrayBuffer(buffer) {
  if (arrayBufferDetached.call(buffer)) throw dataCloneError("An ArrayBuffer is detached and could not be cloned.");
  if (!arrayBufferResizable.call(buffer)) return arrayBufferSlice.call(buffer, 0);
  const length = arrayBufferLength.call(buffer);
  const copy = new ArrayBuffer(length, { maxByteLength: arrayBufferMaxLength.call(buffer) });
  new Uint8Array(copy).set(new Uint8Array(buffer, 0, length));
  return copy;
}

/** A stream moved by the transfer list: a new one of its kind that reads (or writes) through the
 *  original, which is then locked. */
function transferStream(stream, kind) {
  if (kind === "ReadableStream") {
    const reader = stream.getReader();
    return new ReadableStream({
      pull: (controller) => reader.read().then(({ value, done }) => (done ? controller.close() : controller.enqueue(value))),
      cancel: (reason) => reader.cancel(reason),
    });
  }
  if (kind === "WritableStream") {
    const writer = stream.getWriter();
    return new WritableStream({
      write: (chunk) => writer.write(chunk),
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    });
  }
  const readable = transferStream(stream.readable, "ReadableStream");
  const writable = transferStream(stream.writable, "WritableStream");
  const reader = readable.getReader();
  const writer = writable.getWriter();
  return new TransformStream({
    start(controller) {
      const pump = () => reader.read().then(({ value, done }) => {
        if (done) return controller.terminate();
        controller.enqueue(value);
        return pump();
      }, (error) => controller.error(error));
      pump();
    },
    transform: (chunk) => writer.write(chunk),
    flush: () => writer.close(),
  });
}

function defineHidden(object, key, value) {
  Object.defineProperty(object, key, { value, writable: true, enumerable: false, configurable: true });
}

function cloneValue(value, memory, transferred) {
  if (typeof value === "symbol") throw dataCloneError(`${String(value)} could not be cloned.`);
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const known = memory.get(value);
  if (known !== undefined) return known;
  const kind = cloneClass(value);
  const remember = (copy) => {
    memory.set(value, copy);
    return copy;
  };
  switch (kind) {
    case "Function":
      throw dataCloneError(`${Function.prototype.toString.call(value)} could not be cloned.`);
    case "Object": {
      const copy = remember({});
      for (const key of Object.keys(value)) copy[key] = cloneValue(value[key], memory, transferred);
      return copy;
    }
    case "Array": {
      const copy = remember(new Array(value.length));
      for (const key of Object.keys(value)) copy[key] = cloneValue(value[key], memory, transferred);
      return copy;
    }
    case "Date":
      return remember(new Date(dateTime.call(value)));
    case "RegExp":
      return remember(new RegExp(regExpSource.call(value), regExpFlags.call(value)));
    case "Number":
      return remember(Object(Number.prototype.valueOf.call(value)));
    case "String":
      return remember(Object(String.prototype.valueOf.call(value)));
    case "Boolean":
      return remember(Object(Boolean.prototype.valueOf.call(value)));
    case "BigInt":
      return remember(Object(BigInt.prototype.valueOf.call(value)));
    case "Map": {
      const copy = remember(new Map());
      const entries = [];
      mapForEach.call(value, (v, k) => entries.push(k, v));
      for (let i = 0; i < entries.length; i += 2) copy.set(cloneValue(entries[i], memory, transferred), cloneValue(entries[i + 1], memory, transferred));
      return copy;
    }
    case "Set": {
      const copy = remember(new Set());
      const items = [];
      setForEach.call(value, (v) => items.push(v));
      for (const item of items) copy.add(cloneValue(item, memory, transferred));
      return copy;
    }
    case "ArrayBuffer":
      return remember(copyArrayBuffer(value));
    case "TypedArray": {
      const tag = typedArrayTag.call(value);
      const offset = typedArrayOffset.call(value), length = typedArrayLength.call(value);
      const buffer = cloneValue(typedArrayBuffer.call(value), memory, transferred);
      return remember(new globalThis[tag](buffer, offset, length));
    }
    case "DataView": {
      const offset = dataViewOffset.call(value), length = dataViewLength.call(value);
      const buffer = cloneValue(dataViewBuffer.call(value), memory, transferred);
      return remember(new DataView(buffer, offset, length));
    }
    case "Error": {
      /* V8's WriteJSError: the name (one of the native errors', else Error), an own message, the
       * stack, and an own cause */
      const name = value.name;
      const Ctor = Object.hasOwn(ERRORS, name) ? ERRORS[name] : Error;
      const copy = remember(new Ctor());
      const message = Object.getOwnPropertyDescriptor(value, "message");
      if (message && "value" in message) defineHidden(copy, "message", String(message.value));
      const stack = value.stack;
      if (typeof stack === "string") defineHidden(copy, "stack", stack);
      else delete copy.stack;
      if (Object.hasOwn(value, "cause")) defineHidden(copy, "cause", cloneValue(value.cause, memory, transferred));
      return copy;
    }
    case "Blob":
      return remember(isFile(value) ? new File([value], value.name, { type: value.type, lastModified: value.lastModified })
        : new Blob([value], { type: value.type }));
    case "DOMException": {
      const copy = remember(new DOMException(value.message, value.name));
      defineHidden(copy, "stack", value.stack);
      return copy;
    }
    default:
      if (STREAMS.has(kind)) {
        const moved = transferred.get(value);
        if (moved === undefined) throw dataCloneError("Object that needs transfer was found in message but not listed in transferList");
        return remember(moved);
      }
      if (UNCLONEABLE.has(kind)) {
        const name = kind === "Proxy" || kind === "Arguments" ? "Object" : kind;
        throw dataCloneError(`#<${name}> could not be cloned.`);
      }
      throw dataCloneError("Cannot clone object of unsupported type.");
  }
}

function structuredClone(value, options = undefined) {
  if (arguments.length === 0) {
    /* Node's own wording, argument name and all */
    throw codeError(TypeError, "ERR_MISSING_ARGS", 'The "The value argument must be specified" argument must be specified');
  }
  const transfer = [];
  if (options !== undefined && options !== null) {
    if (typeof options !== "object" && typeof options !== "function") {
      throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Failed to execute 'structuredClone': Options cannot be converted to a dictionary");
    }
    const list = options.transfer;
    if (list !== undefined) {
      if ((typeof list !== "object" && typeof list !== "function") || list === null || typeof list[Symbol.iterator] !== "function") {
        throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "Failed to execute 'structuredClone': transfer in Options cannot be converted to sequence.");
      }
      transfer.push(...list);
    }
  }
  /* the transfer list: ArrayBuffers (once each) and streams */
  const buffers = [];
  const transferred = new Map();
  for (const item of transfer) {
    const kind = cloneClass(item);
    if (kind === "ArrayBuffer") {
      if (buffers.includes(item)) throw dataCloneError("Transfer list contains duplicate ArrayBuffer");
      buffers.push(item);
    } else if (!STREAMS.has(kind)) {
      throw dataCloneError("Found invalid value in transferList.");
    }
  }
  for (const item of transfer) {
    const kind = cloneClass(item);
    if (STREAMS.has(kind) && !transferred.has(item)) transferred.set(item, transferStream(item, kind));
  }
  /* a transferred ArrayBuffer is copied like the others, and detached once the clone is made */
  const result = cloneValue(value, new Map(), transferred);
  for (const buffer of buffers) arrayBufferTransfer.call(buffer);
  return result;
}

Object.defineProperty(globalThis, "structuredClone", { value: structuredClone, writable: true, enumerable: true, configurable: true });
