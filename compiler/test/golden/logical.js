function pick(a, b) {
  let x = a && b;
  let y = a || b;
  let z = a ?? b;
  x ||= y;
  y &&= z;
  z ??= 42;
  return (x ? y : z, typeof x) + void 0 + -a + !b;
}
let n = 5;
n += 2;
n **= 2;
print(pick(0, "b"), n++, --n);
