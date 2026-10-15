// A require() of a file that isn't there, or of a native addon, in CommonJS: the build warns, and
// the require() throws when it's reached (MODULE_NOT_FOUND), as in Node.
import cjs from "./missing-requires/commonjs.cjs";

console.log(`missing file: ${cjs.missing}, missing addon: ${cjs.addon}`);
