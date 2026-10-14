// The Readable operators (map, filter, flatMap, drop, take, every, forEach, reduce, toArray,
// some, find): Node's internal/streams/operators.js, installed on Readable.prototype as
// lib/stream.js does. Linked into programs that name one (implicitModules in node/index.ts).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { Readable } from "../stream.js";
import { codes } from "./streams/errors.js";
import { promiseReturningOperators, streamReturningOperators } from "./streams/operators.js";

function install(operators, wrap) {
  for (const key of Object.keys(operators)) {
    const op = operators[key];
    function fn(...args) {
      if (new.target) throw new codes.ERR_ILLEGAL_CONSTRUCTOR();
      return wrap(Reflect.apply(op, this, args));
    }
    Object.defineProperty(fn, "name", { __proto__: null, value: op.name });
    Object.defineProperty(fn, "length", { __proto__: null, value: op.length });
    Object.defineProperty(Readable.prototype, key, { __proto__: null, value: fn, enumerable: false, configurable: true, writable: true });
  }
}
install(streamReturningOperators, (result) => Readable.from(result));
install(promiseReturningOperators, (result) => result);
