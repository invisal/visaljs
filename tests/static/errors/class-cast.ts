// error: a cast doesn't make a Point: static code's classes are nominal
"use static";

class Point {
  x = 0;
}

export function f(): number {
  const p = { x: 1 } as Point;
  return p.x;
}
