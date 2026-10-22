// error: static code doesn't have `extends` yet
"use static";

class A {
  x = 0;
}

class B extends A {
  y = 0;
}

export function f(): number {
  return new B().y;
}
