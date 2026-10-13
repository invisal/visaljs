// a[i] with a Number index: get_index / set_index (inline for a dense array's elements).
// Another index stays get_elem.
export function sieve(n) {
  const composite = new Array(n + 1).fill(false);
  let count = 0;
  for (let i = 2; i <= n; i++) {
    if (composite[i]) continue;
    count++;
    for (let j = i * i; j <= n; j += i) composite[j] = true;
  }
  return count;
}

export function byKey(o, k) {
  return o[k] + o.length;
}
