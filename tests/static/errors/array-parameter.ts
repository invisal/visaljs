// error: typed unit: export 'sum' is not a function declaration whose parameters are all number, string or boolean
"use static";

export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
