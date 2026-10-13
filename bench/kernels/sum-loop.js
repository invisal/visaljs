// Numeric loop in a function: number arithmetic and a compare per iteration.
function sumTo(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += i * 0.5;
  return s;
}
let total = 0;
for (let k = 0; k < 20; k++) total += sumTo(5000000);
console.log(total);
