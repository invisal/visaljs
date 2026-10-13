// i++ on a Number needs no ToNumeric; Number arithmetic can't throw.
export function count(n) {
  let c = 0;
  for (let i = 0; i < 10; i++) c = c + i * 2;
  return c + n;
}
// A TDZ check of a binding the loop proves initialized.
export function late(flag) {
  let x = 1;
  const read = () => x;
  if (flag) x = 2;
  return read() + x;
}
// A branch on an object is always taken; in a try, a conversion that can't throw leaves no handler edge.
export function always(o) {
  const box = {};
  if (box) o.seen = true;
  let k = 0;
  try { k++; } catch { k = -1; }
  return k;
}
