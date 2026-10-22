// error: static code doesn't have static members yet
"use static";

class Counter {
  static count = 0;
}

export function f(): number {
  return Counter.count;
}
