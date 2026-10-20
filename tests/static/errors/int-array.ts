// error: static code doesn't have int[] yet: an i32[], or a number[]
"use static";
import type { int } from "visaljs";

export function first(n: int): int {
  const xs: int[] = [n];
  return xs[0];
}
