// error: static code has `this` only in a class's constructor, methods and field initializers
"use static";

export function f(this: { n: number }): number {
  return this.n;
}
