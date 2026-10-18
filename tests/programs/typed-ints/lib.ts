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

export function div(a: int, b: int): int { return a / b; }
export function rem(a: int, b: int): int { return a % b; }
export function minOverMinusOne(): int {
  const min: int = -9223372036854775807 - 1;
  return min / -1;
}
export function bits(a: int, b: int): string {
  return [a & b, a | b, a ^ b, ~a, a << 40, a >> 3, -1 >>> 60, a << 65].join(" ");
}
export function halve(n: int): int {
  let steps: int = 0;
  while (n > 1) {
    n = n % 2 === 0 ? n / 2 : 3 * n + 1;
    steps++;
  }
  return steps;
}

export function literals(n: int): string {
  return [1 / 4 * 4, 1.0 / 4 * 4, 1e3 / n, 7 / n, 2.5 * n, n / 2.0 * 2].join(" ");
}
