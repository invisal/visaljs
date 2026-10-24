// error: a class's instance has only the fields and methods its class declares: name one
"use static";

class Point {
  x = 0;
}

export function f(): number {
  return new Point()["x"];
}
