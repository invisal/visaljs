// Regular expression literals: what the compiler and the regexp-compile tool share
// with the runtime's libregexp — the flag bits (LRE_FLAG_*, libregexp.h) and the pattern's
// encoding (runtime/src/regexp.c, encode_pattern).

/** LRE_FLAG_* by flag letter. */
const FLAG_BITS: Readonly<Record<string, number>> = { g: 1 << 0, i: 1 << 1, m: 1 << 2, s: 1 << 3, u: 1 << 4, y: 1 << 5, d: 1 << 6, v: 1 << 8 };

/** The flags' LRE_FLAG_* bits, or null when they aren't valid: unknown, repeated, or u with v. */
export function flagBits(flags: string): number | null {
  let bits = 0;
  for (const c of flags) {
    const bit = FLAG_BITS[c];
    if (bit === undefined || bits & bit) return null;
    bits |= bit;
  }
  return bits & FLAG_BITS.u! && bits & FLAG_BITS.v! ? null : bits;
}

/** The pattern as libregexp reads it: UTF-8 with the u or v flag, else CESU-8 (each surrogate
 *  encoded on its own), as QuickJS passes it. */
export function encodePattern(pattern: string, unicode: boolean): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < pattern.length; i++) {
    let c = pattern.charCodeAt(i);
    if (unicode && c >= 0xd800 && c <= 0xdbff && i + 1 < pattern.length) {
      const d = pattern.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

/** A literal's key in the bytecode map the driver hands the emitter. */
export function regexpKey(pattern: string, flags: string): string {
  return `${flags}/${pattern}`;
}
