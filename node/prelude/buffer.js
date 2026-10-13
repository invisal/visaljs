// node:buffer: the globals Node also exports from the module (Buffer, Blob,
// File, atob, btoa; Buffer is the buffer component's, in C) and the module's constants.
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

export function isUtf8(input) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(input);
    return true;
  } catch {
    return false;
  }
}

export function isAscii(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
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

export default { Buffer, Blob, File, atob, btoa, INSPECT_MAX_BYTES, kMaxLength, kStringMaxLength, constants, isUtf8, isAscii, SlowBuffer, transcode, resolveObjectURL };
