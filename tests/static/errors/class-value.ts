// error: static code uses a class only in `new Point` and `instanceof Point`
"use static";

class Point {
  x = 0;
}

export function f(): number {
  const C = Point;
  return new C().x;
}
