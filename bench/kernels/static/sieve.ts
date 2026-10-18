"use static";
import type { int } from "visaljs";

export function sieve(n: int): int {
  const composite = new Uint8Array(n + 1);
  let count: int = 0;
  for (let i: int = 2; i <= n; i++) {
    if (composite[i] === 0) {
      count++;
      for (let j: int = i * i; j <= n; j += i) composite[j] = 1;
    }
  }
  return count;
}
