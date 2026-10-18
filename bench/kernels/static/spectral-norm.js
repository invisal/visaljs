// Float64Array elements as doubles, int indices, a typed call per element.
import { spectralNorm } from "./spectral-norm.ts";

console.log(spectralNorm(Number(process.argv[2])).toFixed(9));
