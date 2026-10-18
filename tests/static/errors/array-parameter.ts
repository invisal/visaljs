// error: parameter 'xs' of 'sum': number[] isn't a static type yet
"use static";

export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
