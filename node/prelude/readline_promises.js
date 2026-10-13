// node:readline/promises: node:readline's Interface with question() as a promise, and Readline,
// cursor moves queued and written by commit().
import { codeError } from "./internal/errors.js";
import {
  Interface as BaseInterface, abortError, clearLineEscape, cursorToEscape, kQuestion, kQuestionCancel, moveCursorEscape,
} from "./internal/readline.js";

export class Interface extends BaseInterface {
  /** The next line, or an AbortError when the signal aborts first. */
  question(query, options = {}) {
    return new Promise((resolve, reject) => {
      let cb = resolve;
      const signal = options?.signal;
      if (signal) {
        if (signal === null || typeof signal !== "object" || !("aborted" in signal)) {
          throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "options.signal" property must be an instance of AbortSignal.');
        }
        if (signal.aborted) return reject(abortError(signal));
        const onAbort = () => {
          this[kQuestionCancel]();
          reject(abortError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        cb = (answer) => {
          signal.removeEventListener("abort", onAbort);
          resolve(answer);
        };
      }
      this[kQuestion](query, cb);
    });
  }
}

export function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

/** Cursor moves on a stream, queued until commit() (or written at once with autoCommit). */
export class Readline {
  #stream;
  #todo = [];
  #autoCommit;

  constructor(stream, options = undefined) {
    if (stream === null || typeof stream !== "object" || typeof stream.write !== "function") {
      throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "stream" argument must be an instance of Writable.');
    }
    this.#stream = stream;
    this.#autoCommit = Boolean(options?.autoCommit);
  }

  #add(data) {
    if (this.#autoCommit) process.nextTick(() => this.#stream.write(data));
    else this.#todo.push(data);
    return this;
  }

  cursorTo(x, y = undefined) {
    return this.#add(cursorToEscape(x, y));
  }

  moveCursor(dx, dy) {
    if (!dx && !dy) return this;
    return this.#add(moveCursorEscape(dx, dy));
  }

  clearLine(dir) {
    return this.#add(clearLineEscape(dir));
  }

  clearScreenDown() {
    return this.#add("\x1b[0J");
  }

  /** Writes what's queued: resolved once written. */
  commit() {
    const data = this.#todo.join("");
    this.#todo = [];
    return new Promise((resolve) => this.#stream.write(data, resolve));
  }

  rollback() {
    this.#todo = [];
    return this;
  }
}

export default { Interface, Readline, createInterface };
