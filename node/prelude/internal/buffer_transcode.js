// buffer.transcode: bytes in one encoding as bytes in another. Linked into programs that name it
// (internal/features.js).
import { features } from "./features.js";

/* transcode's encodings, by Buffer's names for them */
const transcodable = { ascii: "ascii", latin1: "latin1", binary: "latin1", ucs2: "utf16le", "ucs-2": "utf16le", utf16le: "utf16le", "utf-16le": "utf16le", utf8: "utf8", "utf-8": "utf8" };

/** The bytes in one encoding as bytes in another: ascii, latin1, ucs2 or utf8. A character the
 *  target can't hold becomes "?", as Node's (ICU's) transcode makes it. */
function transcode(source, fromEncoding, toEncoding) {
  if (!(source instanceof Uint8Array)) {
    const e = new TypeError(`The "source" argument must be an instance of Buffer or Uint8Array.${received(source)}`);
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  if (source.length === 0) return Buffer.alloc(0);
  const from = transcodable[String(fromEncoding).toLowerCase()];
  const to = transcodable[String(toEncoding).toLowerCase()];
  if (from === undefined || to === undefined) {
    const e = new Error("Unable to transcode Buffer [U_ILLEGAL_ARGUMENT_ERROR]");
    e.code = "U_ILLEGAL_ARGUMENT_ERROR";
    e.errno = 1;
    throw e;
  }
  let text = Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString(from);
  const max = to === "ascii" ? 0x7f : to === "latin1" ? 0xff : -1;
  if (max >= 0) {
    let out = "";
    for (const ch of text) out += ch.codePointAt(0) > max ? "?" : ch;
    text = out;
  }
  return Buffer.from(text, to);
}

/* Node's "Received …" for the message */
function received(value) {
  if (value === null || value === undefined) return ` Received ${value}`;
  if (typeof value === "function") return ` Received function ${value.name}`;
  if (typeof value === "object") return ` Received an instance of ${value.constructor?.name ?? "Object"}`;
  const shown = typeof value === "string" ? `'${value.length > 25 ? value.slice(0, 25) + "..." : value}'` : String(value);
  return ` Received type ${typeof value} (${shown})`;
}

features.transcode = transcode;
