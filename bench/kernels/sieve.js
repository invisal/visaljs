// Array elements indexed by a loop counter.
function sieve(n) {
  const composite = new Array(n + 1).fill(false);
  let count = 0;
  for (let i = 2; i <= n; i++) {
    if (composite[i]) continue;
    count++;
    for (let j = i * i; j <= n; j += i) composite[j] = true;
  }
  return count;
}
let primes = 0;
for (let k = 0; k < 5; k++) primes += sieve(2000000);
console.log(primes);
