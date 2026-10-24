// error: export 'f' takes Point: static code's Point instances stay in the unit yet
"use static";

class Point {
  x = 0;
}

export function f(p: Point): number {
  return p.x;
}
