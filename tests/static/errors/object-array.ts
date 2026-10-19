// error: static code doesn't have arrays of { x: number; } yet
"use static";

export function first(n: number): number {
  const points: { x: number }[] = [{ x: n }];
  return points[0].x;
}
