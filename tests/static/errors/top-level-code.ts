// error: a static file only declares: top-level statements would run code, in no order across files
"use static";

let calls = 0;
calls++;

export function count(): number {
  return calls;
}
