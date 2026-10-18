// error: `any` isn't a static type: name the type
"use static";

export function f(n: number): number {
  const x: any = n;
  return x;
}
