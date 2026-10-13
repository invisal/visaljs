function repeat(s, n) {
  let out = "";
  for (let i = 0; i < n; i++) out = out + s;
  return out;
}
function describe(n) {
  return "n=" + n + (n % 2 ? " odd" : " even") + ", square " + n * n;
}
let big = repeat("ab", 50000);
print(big === repeat("ab", 50000));
let s = "";
for (let i = 0; i < 5; i++) s += describe(i) + "; ";
print(s);
print("é" + "😀" + 1 + 2 + (1 + 2) + true + null + undefined);
print("apple" < "banana");
print("Z" < "a");
print("10" < "9");
print(10 < 9);
print("10" == 10);
print(null == undefined);
print(null === undefined);
