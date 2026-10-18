// error: static code doesn't have `this` yet
"use static";

export function f(this: { n: number }): number {
  return this.n;
}
