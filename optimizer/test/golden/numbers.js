// Number arithmetic in a loop: s and i are Numbers, n is unknown.
export function sumTo(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += i * 0.5;
  return s;
}
// Bitwise operators give int32s whatever their operands.
export function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
// Strings: "" + anything is a string.
export function label(x) {
  let out = "";
  for (const part of x) out += part;
  return "<" + out + ">";
}
