"use static";
import type { int as Int } from "visaljs";

import { tripled } from "./b.ts";

type Count = Int;

/** Private here, and in b.ts too: each file's own. */
function scale(x: number): number {
  return x * 2.0;
}

export function doubled(x: number): number {
  return scale(x);
}

export function both(x: number): number {
  return doubled(x) + tripled(x);
}

/** An int through an alias of a renamed import: n / 2 divides as C's integers. */
export function halvings(n: Count): Count {
  let steps: Count = 0;
  while (n > 0) {
    n = n / 2;
    steps++;
  }
  return steps;
}

/** An arrow's int parameter: x / 2 divides as C's integers there too. */
export function halves(n: Int): Int {
  const half = (x: Int): Int => x / 2;
  return half(n) + half(7);
}
