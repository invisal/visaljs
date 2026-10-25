// error: isn't a Point: static code's classes are nominal, only `new Point` makes one
"use static";

class Point {
  x = 0;
  y = 0;
}

function len(p: Point): number {
  return p.x + p.y;
}

export function f(): number {
  return len({ x: 1, y: 2 });
}
