"use static";
import type { i32 } from "visaljs";

function squares(n: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(i * i + 0.5);
  return xs;
}

function sum(xs: number[]): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s;
}

export function sumSquares(n: number): number {
  return sum(squares(n));
}

/** What an i32[] stores is converted to an i32: wrapped, truncated. */
export function wraps(): string {
  const xs: i32[] = [];
  xs.push(2147483647);
  xs.push(2.9);
  xs[0] += 1;
  xs[1] = xs[1] * 65536 * 65536;
  return `${xs[0]} ${xs[1]} ${xs.length}`;
}

/** A store at the length appends; the array grows. */
export function grows(n: number): number {
  const xs: i32[] = [];
  for (let i = 0; i < n; i++) xs[i] = i;
  return xs.length + xs[n - 1];
}

export function words(s: string): string {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= s.length; i++)
    if (i === s.length || s.charCodeAt(i) === 32) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  let joined = "";
  for (let i = out.length - 1; i >= 0; i--) joined += out[i] + (i > 0 ? "," : "");
  return joined;
}

export function evens(n: number): number {
  const flags: boolean[] = [];
  for (let i = 0; i < n; i++) flags.push(i % 2 === 0);
  let count = 0;
  for (let i = 0; i < flags.length; i++) if (flags[i]) count++;
  return count;
}

/** Built-ins the code doesn't specialize still work: splice, its elements then read. */
export function inserted(): string {
  const xs: i32[] = [1, 2, 4];
  xs.splice(2, 0, 3);
  return `${xs[0]}${xs[1]}${xs[2]}${xs[3]} ${xs.length}`;
}

/** An array returned to JavaScript is an Array. */
export function digits(n: number): number[] {
  const xs: number[] = [];
  for (let k = n; k > 0; k = Math.floor(k / 10)) xs.push(k % 10);
  return xs;
}

export function readPastEnd(i: number): number {
  const xs: number[] = [1, 2, 3];
  return xs[i];
}

export function writePastEnd(i: number): number {
  const xs: number[] = [1, 2, 3];
  xs[i] = 0;
  return xs.length;
}
