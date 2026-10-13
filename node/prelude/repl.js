// node:repl: a REPL evaluates what's typed, which needs a JavaScript engine a compiled program
// doesn't have: start() and REPLServer throw ERR_VISALJS_UNSUPPORTED. The constants, writer and
// Recoverable are Node's.
import { notSupported } from "./internal/errors.js";
import { inspect } from "./util.js";

export const REPL_MODE_SLOPPY = Symbol("repl-sloppy");
export const REPL_MODE_STRICT = Symbol("repl-strict");

/** How the REPL shows a result: util.inspect, with its options. */
export function writer(obj) {
  return inspect(obj, writer.options);
}
writer.options = { ...inspect.defaultOptions, showProxy: true };

/** An error that more input could resolve. */
export class Recoverable extends SyntaxError {
  constructor(err) {
    super();
    this.err = err;
  }
}

export function start() {
  throw notSupported("repl.start (evaluating input)");
}

export class REPLServer {
  constructor() {
    throw notSupported("repl.REPLServer (evaluating input)");
  }
}

export function isValidSyntax() {
  throw notSupported("repl.isValidSyntax (parsing source text)");
}

export default { REPL_MODE_SLOPPY, REPL_MODE_STRICT, REPLServer, Recoverable, isValidSyntax, start, writer };
