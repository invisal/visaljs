// node:punycode: Punycode (RFC 3492) and IDNA's toASCII / toUnicode for domain names, as the
// punycode.js 2.1.0 Node bundles (deprecated in Node, still required by older packages).
// Ported from punycode.js 2.1.0 (Copyright Mathias Bynens, MIT): node/third_party/punycode/LICENSE.

import { decode, encode } from "./internal/punycode.ts";

const regexPunycode = /^xn--/;
const regexNonASCII = /[^\0-\x7F]/;
const regexSeparators = /[\x2E。．｡]/g;  /* RFC 3490 separators */

/* a domain name's labels mapped, an email address's local part kept */
function mapDomain(domain, fn) {
  const parts = domain.split("@");
  let result = "";
  if (parts.length > 1) {
    result = parts[0] + "@";
    domain = parts[1];
  }
  domain = domain.replace(regexSeparators, "\x2E");
  const encoded = domain.split(".").map(fn).join(".");
  return result + encoded;
}

/** A string's code points: surrogate pairs joined, lone surrogates kept. */
function ucs2decode(string) {
  const output = [];
  let counter = 0;
  const length = string.length;
  while (counter < length) {
    const value = string.charCodeAt(counter++);
    if (value >= 0xd800 && value <= 0xdbff && counter < length) {
      const extra = string.charCodeAt(counter++);
      if ((extra & 0xfc00) === 0xdc00) output.push(((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000);
      else {
        output.push(value);
        counter--;
      }
    } else output.push(value);
  }
  return output;
}

/** Code points as a string. */
const ucs2encode = (codePoints) => String.fromCodePoint(...codePoints);

/** A domain name (or email address) with its Punycode labels (xn--…) as Unicode. */
export function toUnicode(input) {
  return mapDomain(input, (string) => (regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string));
}

/** A domain name (or email address) with its non-ASCII labels as Punycode (xn--…). */
export function toASCII(input) {
  return mapDomain(input, (string) => (regexNonASCII.test(string) ? "xn--" + encode(string) : string));
}

export { decode, encode };
export const version = "2.1.0";
export const ucs2 = { decode: ucs2decode, encode: ucs2encode };

export default { version, ucs2, decode, encode, toASCII, toUnicode };
