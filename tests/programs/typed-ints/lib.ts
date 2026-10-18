"use visaljs";
import type { i32, int } from "visaljs";

export function mul(a: int, b: int): int { return a * b; }
export function mul32(a: i32, b: i32): i32 { return a * b; }
export function add32(a: i32, b: i32): i32 { return a + b; }
export function trunc(x: int): int { return x; }
export function mod(a: int): int { return a % 7; }

export function hash32(n: int): i32 {
  let h: i32 = 0;
  for (let i: int = 0; i < n; i++) h = h * 31 + i;
  return h;
}

export function sumSquares(n: int): int {
  let s: int = 0;
  for (let i: int = 0; i < n; i++) s += i * i;
  return s;
}
