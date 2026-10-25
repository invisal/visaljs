// error: static code calls a method, it doesn't take it as a value: norm(…)
"use static";

class Point {
  x = 0;

  norm(): number {
    return this.x;
  }
}

export function f(): number {
  const norm = new Point().norm;
  return norm.call(new Point());
}
