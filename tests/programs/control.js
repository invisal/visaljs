function classify(n) {
  switch (n % 4) {
    case 0:
      return "zero";
    case 1:
    case 2:
      return "low";
    default:
      return "high";
  }
}
let log = "";
outer: for (let i = 0; i < 6; i++) {
  for (let j = 0; j < 6; j++) {
    if (j > i) continue outer;
    if (i + j > 7) break outer;
    log += i * j + ",";
  }
}
print(log);
let k = 0;
do {
  k++;
} while (k < 10);
print(k);
let w = 100;
while (w > 1) w = w % 2 ? 3 * w + 1 : w / 2;
print(w);
print(classify(4) + classify(5) + classify(7));
let a = null, b = 0, c = "";
print(a ?? "dflt");
print(b || "falsy");
print(c && "never");
let n = 1;
n ||= 5;
n &&= n + 1;
print(n);
