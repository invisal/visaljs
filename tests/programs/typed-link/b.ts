"use static";

function scale(x: number): number {
  return x * 3.0;
}

export function tripled(x: number): number {
  return scale(x);
}
