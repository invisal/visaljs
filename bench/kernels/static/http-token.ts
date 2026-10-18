"use static";
// RFC 9110's token, as node/prelude/internal/http_chars.ts checks header names.

export function isToken(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!alnum && c !== 33 && !(c >= 35 && c <= 39) && c !== 42 && c !== 43 && c !== 45 && c !== 46 && c !== 94 && c !== 95 && c !== 96 && c !== 124 && c !== 126) return false;
  }
  return s.length > 0;
}
