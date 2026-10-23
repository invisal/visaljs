// error: a class's instance has only the fields and methods its class declares: 'constructor' isn't one
"use static";

class Point {
  x = 0;
}

export function f(): string {
  return new Point().constructor.name;
}
