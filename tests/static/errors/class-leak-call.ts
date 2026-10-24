// error: a Point can't be passed to console.log: static code's instances stay in static code
"use static";

class Point {
  x = 0;
}

export function f(): number {
  const p = new Point();
  console.log(p);
  return p.x;
}
