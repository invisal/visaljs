// error: export 'pair' returns { first: Point; second: number; }: static code's Point instances stay in the unit yet
"use static";

class Point {
  x = 0;
}

export function pair(): { first: Point; second: number } {
  return { first: new Point(), second: 1 };
}
