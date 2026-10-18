// Recursive typed calls: int parameters and results, no boxing.
import { fib } from "./fib.ts";

console.log(fib(Number(process.argv[2])));
