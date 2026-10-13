// The runtime's string hash: FNV-1a over UTF-16 code units, never 0.
// Static string cells carry it precomputed, so this must match
// js_hash_view() in runtime/src/string.c exactly.

export const HASH_INIT = 0x811c9dc5;
const HASH_PRIME = 0x01000193;

export function jsStringHash(s: string): number {
  let h = HASH_INIT;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), HASH_PRIME) >>> 0;
  return h === 0 ? 1 : h;
}
