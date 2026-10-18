"use static";
import type { int } from "visaljs";

let calls: int = 0;  // one copy, whoever imports it

export function add(x: number, y: number): number {
  calls++;
  return x + y;
}

export function callCount(): int {
  return calls;
}

export function isToken(s: string): boolean {
  for (let i: int = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45)) return false;
  }
  return s.length > 0;
}

export function sieve(n: int): int {
  const composite = new Uint8Array(n + 1);
  let count: int = 0;
  for (let i: int = 2; i <= n; i++) {
    if (composite[i] === 0) {
      count++;
      if (i <= 46340) for (let j: int = i * i; j <= n; j += i) composite[j] = 1;
    }
  }
  return count;
}

export function norm(v: Float64Array, n: int): number {
  let s = 0;
  for (let i: int = 0; i < n; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

export function triangle(n: int): int {
  let t: int = 0;
  for (let i: int = 1; i <= n; i++) t += i;
  return t;
}
