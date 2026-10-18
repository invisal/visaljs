"use static";
// The characters HTTP allows in header names (a token, RFC 9110 §5.6.2) and values: Node's
// tokenRegExp and headerCharRegex as loops, typed (setHeader checks both on every call).

export function isHttpToken(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    /* ! # $ % & ' * + - . ^ _ ` | ~ */
    if (!alnum && c !== 33 && !(c >= 35 && c <= 39) && c !== 42 && c !== 43 && c !== 45 && c !== 46 && c !== 94 && c !== 95 && c !== 96 && c !== 124 && c !== 126) return false;
  }
  return s.length > 0;
}

/** A character outside tab, 0x20-0x7e and 0x80-0xff. */
export function hasInvalidHeaderChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 32 && c !== 9) || c === 127 || c > 255) return true;
  }
  return false;
}
