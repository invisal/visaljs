"use static";
// Punycode (RFC 3492), node:punycode's decode and encode, typed: code points in an i32[], the
// arithmetic in ints (its divisions are of non-negative values: Math.floor's).
// Ported from punycode.js 2.1.0 (Copyright Mathias Bynens, MIT): node/third_party/punycode/LICENSE.
import type { i32, int } from "visaljs";

const maxInt: int = 2147483647;
const base: int = 36;
const tMin: int = 1;
const tMax: int = 26;
const skew: int = 38;
const damp: int = 700;
const initialBias: int = 72;
const initialN: int = 128;

const overflow = "Overflow: input needs wider integers to process";
const notBasic = "Illegal input >= 0x80 (not a basic code point)";
const invalidInput = "Invalid input";

/** A string's code points: surrogate pairs joined, lone surrogates kept. */
function ucs2decode(s: string): i32[] {
  const output: i32[] = [];
  const length: int = s.length;
  let counter: int = 0;
  while (counter < length) {
    const value: int = s.charCodeAt(counter++);
    if (value >= 0xd800 && value <= 0xdbff && counter < length) {
      const extra: int = s.charCodeAt(counter++);
      if ((extra & 0xfc00) === 0xdc00) output.push(((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000);
      else {
        output.push(value);
        counter--;
      }
    } else output.push(value);
  }
  return output;
}

/* a basic code point's digit value, or base for anything else */
function basicToDigit(codePoint: int): int {
  if (codePoint >= 0x30 && codePoint < 0x3a) return 26 + (codePoint - 0x30);
  if (codePoint >= 0x41 && codePoint < 0x5b) return codePoint - 0x41;
  if (codePoint >= 0x61 && codePoint < 0x7b) return codePoint - 0x61;
  return base;
}

/* a digit's code point, lowercase (0..25 a..z, 26..35 0..9) */
function digitToBasic(digit: int): int {
  return digit < 26 ? digit + 97 : digit + 22;
}

/* RFC 3492 3.4 */
function adapt(delta: int, numPoints: int, firstTime: boolean): int {
  let k: int = 0;
  delta = firstTime ? delta / damp : delta >> 1;
  delta += delta / numPoints;
  for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = delta / (base - tMin);
  return k + ((base - tMin + 1) * delta) / (delta + skew);
}

/** Punycode (ASCII only) to the Unicode string it encodes. */
export function decode(input: string): string {
  const output: i32[] = [];
  const inputLength: int = input.length;
  let i: int = 0;
  let n: int = initialN;
  let bias: int = initialBias;

  /* the basic code points: everything before the last delimiter */
  let basic: int = input.lastIndexOf("-");
  if (basic < 0) basic = 0;
  for (let j: int = 0; j < basic; ++j) {
    const c: int = input.charCodeAt(j);
    if (c >= 0x80) throw new RangeError(notBasic);
    output.push(c);
  }

  /* the deltas, each inserting a code point */
  for (let index: int = basic > 0 ? basic + 1 : 0; index < inputLength;) {
    const oldi: int = i;
    for (let w: int = 1, k: int = base; ; k += base) {
      if (index >= inputLength) throw new RangeError(invalidInput);
      const digit: int = basicToDigit(input.charCodeAt(index++));
      if (digit >= base) throw new RangeError(invalidInput);
      if (digit > (maxInt - i) / w) throw new RangeError(overflow);
      i += digit * w;
      const t: int = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      const baseMinusT: int = base - t;
      if (w > maxInt / baseMinusT) throw new RangeError(overflow);
      w *= baseMinusT;
    }
    const out: int = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    if (i / out > maxInt - n) throw new RangeError(overflow);
    n += i / out;
    i %= out;
    output.push(0);
    for (let m: int = output.length - 1; m > i; m--) output[m] = output[m - 1];
    output[i++] = n;
  }

  let s = "";
  for (let k: int = 0; k < output.length; k++) {
    const c: int = output[k];
    /* past U+10FFFF: String.fromCodePoint's RangeError */
    s += c < 0x10000 ? String.fromCharCode(c) : String.fromCodePoint(c);
  }
  return s;
}

/** A Unicode string as Punycode (ASCII only). */
export function encode(str: string): string {
  const input = ucs2decode(str);
  const inputLength: int = input.length;
  let n: int = initialN;
  let delta: int = 0;
  let bias: int = initialBias;

  let output = "";
  for (let j: int = 0; j < inputLength; j++) {
    const c: int = input[j];
    if (c < 0x80) output += String.fromCharCode(c);
  }
  const basicLength: int = output.length;
  let handledCPCount: int = basicLength;
  if (basicLength > 0) output += "-";

  while (handledCPCount < inputLength) {
    /* the next code point to insert: the smallest not yet handled */
    let m: int = maxInt;
    for (let j: int = 0; j < inputLength; j++) {
      const c: int = input[j];
      if (c >= n && c < m) m = c;
    }
    const handledCPCountPlusOne: int = handledCPCount + 1;
    if (m - n > (maxInt - delta) / handledCPCountPlusOne) throw new RangeError(overflow);
    delta += (m - n) * handledCPCountPlusOne;
    n = m;
    for (let j: int = 0; j < inputLength; j++) {
      const c: int = input[j];
      if (c < n && ++delta > maxInt) throw new RangeError(overflow);
      if (c === n) {
        let q: int = delta;
        for (let k: int = base; ; k += base) {
          const t: int = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
          if (q < t) break;
          const qMinusT: int = q - t;
          const baseMinusT: int = base - t;
          output += String.fromCharCode(digitToBasic(t + (qMinusT % baseMinusT)));
          q = qMinusT / baseMinusT;
        }
        output += String.fromCharCode(digitToBasic(q));
        bias = adapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
        delta = 0;
        ++handledCPCount;
      }
    }
    ++delta;
    ++n;
  }
  return output;
}
