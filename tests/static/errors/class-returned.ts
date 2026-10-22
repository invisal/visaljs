// error: export 'make' returns Point: static code's Point instances stay in the unit yet
"use static";

class Point {
  x = 0;
}

export function make(): Point {
  return new Point();
}
