// error: 'x' is declared twice in this function with different types: give one of them another name
"use static";
import type { int } from "visaljs";

export function f(n: number): number {
  {
    const x: int = n;
    if (x > 0) return x;
  }
  const x: number = n / 2;
  return x;
}
