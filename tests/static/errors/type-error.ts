// error: Type 'string' is not assignable to type 'number'.
"use static";
import type { int } from "visaljs";

export function f(n: int): int {
  return n > 0 ? "positive" : n;
}
