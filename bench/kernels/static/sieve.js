// A typed array indexed by int loop counters.
import { sieve } from "./sieve.ts";

const n = Number(process.argv[2]);
let primes = 0;
for (let k = 0; k < 5; k++) primes += sieve(n);
console.log(primes);
