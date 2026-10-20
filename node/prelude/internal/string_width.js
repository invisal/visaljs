// Node's getStringWidth (internal/util/inspect): columns on a terminal, wide characters two,
// combining ones none; console.table and readline's line editor measure with it.
import { stripVTControlCharacters } from "../util.js";

const isFullWidthCodePoint = (code) => code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
  (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) || (code >= 0x3250 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0xa4c6) ||
  (code >= 0xa960 && code <= 0xa97c) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6b) || (code >= 0xff01 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1b000 && code <= 0x1b001) || (code >= 0x1f200 && code <= 0x1f251) ||
  (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x20000 && code <= 0x3fffd));

const isZeroWidthCodePoint = (code) => code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x300 && code <= 0x36f) ||
  (code >= 0x200b && code <= 0x200f) || (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe00 && code <= 0xfe0f) ||
  (code >= 0xfe20 && code <= 0xfe2f) || (code >= 0xe0100 && code <= 0xe01ef);

export function getStringWidth(str, removeControlChars = true) {
  let width = 0;
  if (removeControlChars) str = stripVTControlCharacters(str);
  for (const char of str.normalize("NFC")) {
    const code = char.codePointAt(0);
    if (isFullWidthCodePoint(code)) width += 2;
    else if (!isZeroWidthCodePoint(code)) width++;
  }
  return width;
}
