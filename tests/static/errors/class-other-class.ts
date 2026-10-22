// error: 'Vec' isn't a Point: static code's classes are nominal
"use static";

class Point {
  x = 0;
}

class Vec {
  x = 0;
}

export function f(): number {
  const p: Point = new Vec();
  return p.x;
}
