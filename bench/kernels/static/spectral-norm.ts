"use static";
import type { int } from "visaljs";

function a(i: int, j: int): number {
  return 1.0 / ((i + j) * (i + j + 1) / 2 + i + 1);
}

function timesA(n: int, v: Float64Array, out: Float64Array): void {
  for (let i: int = 0; i < n; i++) {
    let sum = 0.0;
    for (let j: int = 0; j < n; j++) sum += a(i, j) * v[j]!;
    out[i] = sum;
  }
}

function timesAt(n: int, v: Float64Array, out: Float64Array): void {
  for (let i: int = 0; i < n; i++) {
    let sum = 0.0;
    for (let j: int = 0; j < n; j++) sum += a(j, i) * v[j]!;
    out[i] = sum;
  }
}

function timesAtA(n: int, v: Float64Array, out: Float64Array, tmp: Float64Array): void {
  timesA(n, v, tmp);
  timesAt(n, tmp, out);
}

export function spectralNorm(n: int): number {
  const u = new Float64Array(n);
  const v = new Float64Array(n);
  const tmp = new Float64Array(n);
  for (let i: int = 0; i < n; i++) u[i] = 1.0;
  for (let k: int = 0; k < 10; k++) {
    timesAtA(n, u, v, tmp);
    timesAtA(n, v, u, tmp);
  }
  let uv = 0.0;
  let vv = 0.0;
  for (let i: int = 0; i < n; i++) {
    uv += u[i]! * v[i]!;
    vv += v[i]! * v[i]!;
  }
  return Math.sqrt(uv / vv);
}
