// error: a thrown value can't hold a Point: static code's instances stay in static code
"use static";

class Point {
  x = 0;
}

export function f(): number {
  throw new Point();
}
