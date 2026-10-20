// node:readline/promises (Node's lib/readline/promises.js and internal/readline/promises.js):
// Interface with question() as a promise, and Readline, cursor moves queued and written by commit().
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { invalidArgType, outOfRange } from "./internal/errors.js";
import {
  abortError, addAbortListener, CSI, Interface as BaseInterface, kQuestion, kQuestionCancel, kQuestionReject, validateAbortSignal,
} from "./internal/readline.js";

const kEmptyObject = Object.freeze({ __proto__: null });

export class Interface extends BaseInterface {
  question(query, options = kEmptyObject) {
    return new Promise((resolve, reject) => {
      let cb = resolve;
      if (options?.signal) {
        validateAbortSignal(options.signal, "options.signal");
        if (options.signal.aborted) return reject(abortError(undefined, { cause: options.signal.reason }));
        const onAbort = () => {
          this[kQuestionCancel]();
          reject(abortError(undefined, { cause: options.signal.reason }));
        };
        const disposable = addAbortListener(options.signal, onAbort);
        cb = (answer) => {
          disposable[Symbol.dispose]();
          resolve(answer);
        };
      }
      this[kQuestionReject] = reject;
      this[kQuestion](query, cb);
    });
  }
}

export function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
}

/* Node's isWritable: a stream that can still be written */
const isWritable = (stream) => stream !== null && typeof stream === "object" && typeof stream.write === "function" &&
  stream.writable !== false && !stream.writableEnded && !stream.destroyed;

export class Readline {
  #autoCommit = false;
  #stream;
  #todo = [];

  constructor(stream, options = undefined) {
    if (!isWritable(stream)) throw invalidArgType("stream", "an instance of Writable", stream);
    this.#stream = stream;
    if (options?.autoCommit != null) {
      if (typeof options.autoCommit !== "boolean") throw invalidArgType("options.autoCommit", "of type boolean", options.autoCommit);
      this.#autoCommit = options.autoCommit;
    }
  }

  #queue(data) {
    if (this.#autoCommit) process.nextTick(() => this.#stream.write(data));
    else this.#todo.push(data);
  }

  cursorTo(x, y = undefined) {
    validateInteger(x, "x");
    if (y != null) validateInteger(y, "y");
    this.#queue(y == null ? CSI`${x + 1}G` : CSI`${y + 1};${x + 1}H`);
    return this;
  }

  moveCursor(dx, dy) {
    if (dx || dy) {
      validateInteger(dx, "dx");
      validateInteger(dy, "dy");
      let data = "";
      if (dx < 0) data += CSI`${-dx}D`;
      else if (dx > 0) data += CSI`${dx}C`;
      if (dy < 0) data += CSI`${-dy}A`;
      else if (dy > 0) data += CSI`${dy}B`;
      this.#queue(data);
    }
    return this;
  }

  clearLine(dir) {
    validateInteger(dir, "dir", -1, 1);
    this.#queue(dir < 0 ? CSI.kClearToLineBeginning : dir > 0 ? CSI.kClearToLineEnd : CSI.kClearLine);
    return this;
  }

  clearScreenDown() {
    this.#queue(CSI.kClearScreenDown);
    return this;
  }

  commit() {
    return new Promise((resolve) => {
      this.#stream.write(this.#todo.join(""), resolve);
      this.#todo = [];
    });
  }

  rollback() {
    this.#todo = [];
    return this;
  }
}

export default { Interface, Readline, createInterface };
