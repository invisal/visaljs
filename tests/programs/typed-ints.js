// visaljs-expected: by hand
// "use visaljs" sized integers have C semantics: truncated to their width when stored, wrapping
// arithmetic. The expected output is C's (cc of the same operations), not Node's: there the types
// are erased and these are plain doubles.
import { checksum, wrap16, wrap32, wrap8, wrapI16, wrapI8 } from "./typed-ints/lib.ts";
console.log(wrap8(200, 100), wrap8(300, 0), wrapI8(127), wrap16(30000), wrapI16(300, 300), wrap32(65536, 65536), wrap32(46341, 46341), checksum(100000));
