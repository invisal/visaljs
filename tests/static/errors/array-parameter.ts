// error: export 'sum' takes an array: static code doesn't take arrays from JavaScript yet
"use static";

export function sum(xs: number[]): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s;
}
