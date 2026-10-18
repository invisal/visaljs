"use static";
import type { int } from "visaljs";

export function fib(n: int): int {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
