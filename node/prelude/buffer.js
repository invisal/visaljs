// node:buffer: the globals Node also exports from the module (Buffer, Blob,
// File, atob, btoa; Buffer is the buffer component's, in C) and the module's constants.
import { bufferInspectMaxBytes } from "visaljs:host";
import { invalidArgType, outOfRange } from "./internal/errors.js";
import { lazyFunction } from "./internal/features.js";

export const Buffer = globalThis.Buffer;
export const Blob = globalThis.Blob;
export const File = globalThis.File;
export const atob = globalThis.atob;
export const btoa = globalThis.btoa;

export const INSPECT_MAX_BYTES = 50;
export const kMaxLength = 9007199254740991;
export const kStringMaxLength = 536870888;
export const constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: kStringMaxLength };

/** isUtf8 and isAscii's input: an ArrayBuffer or a view, as Node's */
function viewBytes(input) {
  /* a detached buffer, or a view of one, is empty */
  if (input instanceof ArrayBuffer) return input.detached ? new Uint8Array(0) : new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return input.buffer.detached ? new Uint8Array(0) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw invalidArgType("input", "an instance of ArrayBuffer, Buffer, or TypedArray", input);
}

export function isUtf8(input) {
  input = viewBytes(input);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(input);
    return true;
  } catch {
    return false;
  }
}

export function isAscii(input) {
  const bytes = viewBytes(input);
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 127) return false;
  return true;
}

export const SlowBuffer = Buffer;

/** buffer.transcode (internal/buffer_transcode.js, linked when the program names it). */
export const transcode = lazyFunction("transcode", 3);

/** The Blob a blob: URL names: none, since URL.createObjectURL makes none here. */
export function resolveObjectURL(url) {
  void `${url}`;
  return undefined;
}

const exports = { Buffer, Blob, File, atob, btoa, INSPECT_MAX_BYTES, kMaxLength, kStringMaxLength, constants, isUtf8, isAscii, SlowBuffer, transcode, resolveObjectURL };

/* require("buffer").INSPECT_MAX_BYTES, as Node's: a number >= 0, which Buffer's inspect shows */
let inspectMaxBytes = INSPECT_MAX_BYTES;
Object.defineProperty(exports, "INSPECT_MAX_BYTES", {
  get() {
    return inspectMaxBytes;
  },
  set(value) {
    if (typeof value !== "number") throw invalidArgType("INSPECT_MAX_BYTES", "of type number", value);
    if (!(value >= 0)) throw outOfRange("INSPECT_MAX_BYTES", ">= 0", value);
    inspectMaxBytes = value;
    bufferInspectMaxBytes(value);
  },
  enumerable: true,
  configurable: true,
});

export default exports;
