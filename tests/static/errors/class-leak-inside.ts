// error: a Point can't be passed to Object.freeze: static code's instances stay in static code
"use static";

class Point {
  x = 0;
}

export function f(): number {
  const holder = { p: new Point() };
  Object.freeze(holder);
  return holder.p.x;
}
