// node:sys: node:util under its old name, deprecated (DEP0025): the same object.
import util from "./util.js";

process.emitWarning("sys is deprecated. Use util instead.", "DeprecationWarning", "DEP0025");

export * from "./util.js";
export default util;
