// node:readline (Node's lib/readline.js): Interface, with the callback question() and the old
// underscored names of its methods, createInterface, the cursor functions, emitKeypressEvents
// (with the terminal editor, internal/readline_editor.js), and readline/promises as promises.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { features, lazyFunction } from "./internal/features.js";
import {
  abortError, addAbortListener, clearLine, clearScreenDown, cursorTo, Interface as BaseInterface, InterfaceConstructor, kAddHistory,
  kDecoder, kDeleteLeft, kDeleteLineLeft, kDeleteLineRight, kDeleteRight, kDeleteWordLeft, kDeleteWordRight, kGetDisplayPos, kHistoryNext,
  kHistoryPrev, kInsertString, kLine, kLine_buffer, kMoveCursor, kNormalWrite, kOldPrompt, kOnLine, kPreviousKey, kPrompt, kQuestion,
  kQuestionCallback, kQuestionCancel, kRefreshLine, kSawKeyPress, kSawReturnAt, kSetRawMode, kTabComplete, kTtyWrite, kWordLeft,
  kWordRight, kWriteToOutput, moveCursor, validateAbortSignal,
} from "./internal/readline.js";
import promises from "./readline_promises.js";

const kEmptyObject = Object.freeze({ __proto__: null });
const kPromisifyCustom = Symbol.for("nodejs.util.promisify.custom");

export const emitKeypressEvents = lazyFunction("emitKeypressEvents", 2);

/** Interface(input, output, completer, terminal), or with an options object; callable without new */
export function Interface(input, output, completer, terminal) {
  if (!(this instanceof Interface)) return new Interface(input, output, completer, terminal);
  /* a completer of one argument: its result, given to the callback */
  if (input?.input && typeof input.completer === "function" && input.completer.length !== 2) {
    const { completer } = input;
    input.completer = (v, cb) => cb(null, completer(v));
  } else if (typeof completer === "function" && completer.length !== 2) {
    const realCompleter = completer;
    completer = (v, cb) => cb(null, realCompleter(v));
  }
  InterfaceConstructor.call(this, input, output, completer, terminal);
  /* a terminal is the editor's (internal/readline_editor.js): a dumb one gets its plain writer */
  if (this.terminal && process.env.TERM === "dumb") this._ttyWrite = features.ttyWriteDumb.bind(this);
}

Object.setPrototypeOf(Interface.prototype, BaseInterface.prototype);
Object.setPrototypeOf(Interface, BaseInterface);

Interface.prototype.question = function question(query, options, cb) {
  cb = typeof options === "function" ? options : cb;
  if (options === null || typeof options !== "object") options = kEmptyObject;
  if (options.signal) {
    validateAbortSignal(options.signal, "options.signal");
    if (options.signal.aborted) return;
    const onAbort = () => {
      this[kQuestionCancel]();
    };
    const disposable = addAbortListener(options.signal, onAbort);
    const originalCb = cb;
    cb = typeof cb === "function" ? (answer) => {
      disposable[Symbol.dispose]();
      return originalCb(answer);
    } : disposable[Symbol.dispose];
  }
  if (typeof cb === "function") this[kQuestion](query, cb);
};

Interface.prototype.question[kPromisifyCustom] = function question(query, options) {
  if (options === null || typeof options !== "object") options = kEmptyObject;
  if (options.signal?.aborted) return Promise.reject(abortError(undefined, { cause: options.signal.reason }));
  return new Promise((resolve, reject) => {
    let cb = resolve;
    if (options.signal) {
      const onAbort = () => {
        reject(abortError(undefined, { cause: options.signal.reason }));
      };
      const disposable = addAbortListener(options.signal, onAbort);
      cb = (answer) => {
        disposable[Symbol.dispose]();
        resolve(answer);
      };
    }
    this.question(query, options, cb);
  });
};

export function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

/* the methods' old names: each symbol reads the underscored method, which a program may replace */
const underscored = [
  [kSetRawMode, "_setRawMode"], [kOnLine, "_onLine"], [kWriteToOutput, "_writeToOutput"], [kAddHistory, "_addHistory"],
  [kRefreshLine, "_refreshLine"], [kNormalWrite, "_normalWrite"], [kInsertString, "_insertString"], [kTabComplete, "_tabComplete"],
  [kWordLeft, "_wordLeft"], [kWordRight, "_wordRight"], [kDeleteLeft, "_deleteLeft"], [kDeleteRight, "_deleteRight"],
  [kDeleteWordLeft, "_deleteWordLeft"], [kDeleteWordRight, "_deleteWordRight"], [kDeleteLineLeft, "_deleteLineLeft"],
  [kDeleteLineRight, "_deleteLineRight"], [kLine, "_line"], [kHistoryNext, "_historyNext"], [kHistoryPrev, "_historyPrev"],
  [kGetDisplayPos, "_getDisplayPos"], [kMoveCursor, "_moveCursor"], [kTtyWrite, "_ttyWrite"],
];
for (const [symbol, name] of underscored) {
  Object.defineProperty(Interface.prototype, symbol, { get() { return this[name]; }, configurable: true });
}
/* and the state's */
const state = [[kDecoder, "_decoder"], [kLine_buffer, "_line_buffer"], [kOldPrompt, "_oldPrompt"], [kPreviousKey, "_previousKey"],
  [kPrompt, "_prompt"], [kQuestionCallback, "_questionCallback"], [kSawKeyPress, "_sawKeyPress"], [kSawReturnAt, "_sawReturnAt"]];
for (const [symbol, name] of state) {
  Object.defineProperty(Interface.prototype, name, {
    get() { return this[symbol]; },
    set(value) { this[symbol] = value; },
    configurable: true,
  });
}

/* the editor's methods (the editor module gives the rest of the underscored names) */
Interface.prototype._setRawMode = BaseInterface.prototype[kSetRawMode];
Interface.prototype._onLine = BaseInterface.prototype[kOnLine];
Interface.prototype._writeToOutput = BaseInterface.prototype[kWriteToOutput];
Interface.prototype._addHistory = BaseInterface.prototype[kAddHistory];
Interface.prototype._refreshLine = BaseInterface.prototype[kRefreshLine];
Interface.prototype._normalWrite = BaseInterface.prototype[kNormalWrite];
Interface.prototype._getDisplayPos = BaseInterface.prototype[kGetDisplayPos];
Interface.prototype._getCursorPos = BaseInterface.prototype.getCursorPos;
Interface.prototype._moveCursor = BaseInterface.prototype[kMoveCursor];

export { clearLine, clearScreenDown, cursorTo, moveCursor, promises };

export default { Interface, clearLine, clearScreenDown, createInterface, cursorTo, emitKeypressEvents, moveCursor, promises };
