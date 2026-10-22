// error: a parameter property isn't JavaScript
"use static";

class Point {
  constructor(public x: number) {}
}

export function f(): number {
  return new Point(1).x;
}
