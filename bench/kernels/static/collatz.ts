"use static";
import type { int } from "visaljs";

/** The start below `limit` with the longest Collatz sequence. */
export function longest(limit: int): int {
  let best: int = 0;
  let bestLength: int = 0;
  for (let start: int = 1; start < limit; start++) {
    let n: int = start;
    let length: int = 1;
    while (n !== 1) {
      n = n % 2 === 0 ? n / 2 : 3 * n + 1;
      length++;
    }
    if (length > bestLength) {
      bestLength = length;
      best = start;
    }
  }
  return best;
}
