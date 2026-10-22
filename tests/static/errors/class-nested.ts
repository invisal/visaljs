// error: a static file declares its classes at its top level
"use static";

export function f(): number {
  class Point {
    x = 1;
  }
  return new Point().x;
}
