// node:_http_common: Node's module behind node:http, as its tests reach it: the header checks and
// the method list. Node's HTTPParser isn't here: llhttp runs in C (node/src/host_http.c).
import { hasInvalidHeaderChar, isHttpToken } from "./internal/http_chars.ts";
import { METHODS } from "./http.js";

/* Node's lenientHeaderCharRegex (httpValidation "relaxed"): only NUL, CR, LF and past 0xff */
function hasLenientInvalidChar(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0 || c === 10 || c === 13 || c > 255) return true;
  }
  return false;
}

export function _checkInvalidHeaderChar(val, lenient = false) {
  const s = String(val);
  return lenient ? hasLenientInvalidChar(s) : hasInvalidHeaderChar(s);
}

export function _checkIsHttpToken(val) {
  return typeof val === "string" && isHttpToken(val);
}

export const methods = METHODS.slice().sort();
export const CRLF = "\r\n";
export const continueExpression = /(?:^|\W)100-continue(?:$|\W)/i;
export const chunkExpression = /(?:^|\W)chunked(?:$|\W)/i;

export default { _checkInvalidHeaderChar, _checkIsHttpToken, methods, CRLF, continueExpression, chunkExpression };
