// int arithmetic past 2^31: %, / and * of int64s.
import { longest } from "./collatz.ts";

console.log(longest(Number(process.argv[2])));
