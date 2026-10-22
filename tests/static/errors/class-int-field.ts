// error: static code doesn't have int or i32 fields yet
"use static";
import type { int } from "visaljs";

class Counter {
  n: int = 0;
}

export function f(): number {
  return new Counter().n;
}
