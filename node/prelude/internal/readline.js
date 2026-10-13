// node:readline's Interface, which node:readline/promises extends: an input stream read a line at
// a time, as Node's Interface reads one that isn't a terminal: 'line' for each line (ended by \n,
// \r\n or \r), a question's answer to its callback, the prompt written to the output, and the lines
// as an async iterator. A terminal is read in its normal mode, the terminal editing the line and
// echoing it; Node's own editor in raw mode (keys, history, completion) isn't provided, nor is
// emitKeypressEvents. The cursor functions write ANSI escapes.
import { EventEmitter } from "../events.js";
import { codeError, invalidArgType, invalidArgValue, notSupported, validateFunction, validateString } from "./errors.js";
import { Readable } from "../stream.js";
import { StringDecoder } from "../string_decoder.js";

/* what ends a line; a \r at a chunk's end may be a \r\n split across chunks: a \n first in the
 * next chunk, within crlfDelay, belongs to it */
const lineEnding = /\r?\n|\r(?!\n)/g;
const kMinCrlfDelay = 100;
const kPromisifyCustom = Symbol.for("nodejs.util.promisify.custom");

export const kQuestion = Symbol("question");
export const kQuestionCancel = Symbol("questionCancel");

function validateSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
    throw invalidArgType(name, "an instance of AbortSignal", signal);
  }
}

/** Node's AbortError: name and code, the signal's reason as its cause. */
export function abortError(signal) {
  const error = new Error("The operation was aborted", { cause: signal?.reason });
  error.code = "ABORT_ERR";
  error.name = "AbortError";
  return error;
}

/** Interface(input, output, completer, terminal), or Interface({ input, output, … }). A function,
 *  as Node's is: callable without new. */
export function Interface(input, output, completer, terminal) {
  if (!(this instanceof Interface)) return new Interface(input, output, completer, terminal);
  EventEmitter.call(this);
  let prompt = "> ";
  let crlfDelay;
  let signal;
  if (input?.input) {
    ({ output, completer, terminal, signal, crlfDelay } = input);
    if (input.prompt !== undefined) prompt = input.prompt;
    input = input.input;
  }
  if (completer !== undefined && typeof completer !== "function") throw invalidArgValue("completer", "must be a function", completer);
  validateSignal(signal, "options.signal");
  this.input = input;
  this.output = output;
  this.completer = completer;
  this.terminal = terminal === undefined ? Boolean(output?.isTTY) : Boolean(terminal);
  this.crlfDelay = crlfDelay ? Math.max(kMinCrlfDelay, crlfDelay) : kMinCrlfDelay;
  this.line = "";
  this.cursor = 0;
  this.history = [];
  this.closed = false;
  this.paused = false;
  this._prompt = prompt;
  this._oldPrompt = prompt;
  this._questionCallback = null;
  this._lineBuffer = null;
  this._sawReturnAt = 0;
  this._decoder = new StringDecoder("utf8");
  this._lines = undefined;

  const ondata = (data) => this._normalWrite(data);
  const onend = () => {
    if (typeof this._lineBuffer === "string" && this._lineBuffer.length > 0) this.emit("line", this._lineBuffer);
    this.close();
  };
  const onerror = (err) => this.emit("error", err);
  input.on("error", onerror);
  input.on("data", ondata);
  input.on("end", onend);
  this.once("close", () => {
    input.removeListener("error", onerror);
    input.removeListener("data", ondata);
    input.removeListener("end", onend);
  });
  if (signal) {
    const onAbort = () => this.close();
    if (signal.aborted) process.nextTick(onAbort);
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      this.once("close", () => signal.removeEventListener("abort", onAbort));
    }
  }
  input.resume();
}
Object.setPrototypeOf(Interface.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Interface, EventEmitter);

Interface.prototype.setPrompt = function setPrompt(prompt) {
  this._prompt = prompt;
};

Interface.prototype.getPrompt = function getPrompt() {
  return this._prompt;
};

Interface.prototype._writeToOutput = function _writeToOutput(text) {
  validateString(text, "stringToWrite");
  if (this.output !== null && this.output !== undefined) this.output.write(text);
};

/** Writes the prompt, and reads again if paused. */
Interface.prototype.prompt = function prompt() {
  if (this.paused) this.resume();
  if (this.closed) throw codeError(Error, "ERR_USE_AFTER_CLOSE", "readline was closed");
  this._writeToOutput(this._prompt);
};

Interface.prototype[kQuestion] = function question(query, cb) {
  if (this.closed) throw codeError(Error, "ERR_USE_AFTER_CLOSE", "readline was closed");
  if (this._questionCallback) this.prompt();
  else {
    this._oldPrompt = this._prompt;
    this.setPrompt(query);
    this._questionCallback = cb;
    this.prompt();
  }
};

/* a question given up: its prompt goes, and the line is cleared, as Node's clearLine */
Interface.prototype[kQuestionCancel] = function questionCancel() {
  if (!this._questionCallback) return;
  this._questionCallback = null;
  this.setPrompt(this._oldPrompt);
  this._writeToOutput("\r\n");
  this.line = "";
  this.cursor = 0;
};

/** question(query[, { signal }], cb): writes the query, and gives the next line to cb instead of
 *  'line'. */
Interface.prototype.question = function question(query, options, cb) {
  cb = typeof options === "function" ? options : cb;
  if (options !== null && typeof options === "object") {
    const { signal } = options;
    if (signal) {
      validateSignal(signal, "options.signal");
      if (signal.aborted) return;
      const onAbort = () => this[kQuestionCancel]();
      signal.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const original = cb;
      cb = typeof cb === "function" ? (answer) => {
        cleanup();
        return original(answer);
      } : cleanup;
    }
  }
  if (typeof cb === "function") this[kQuestion](query, cb);
};

/* util.promisify(rl.question): the answer, or an AbortError */
Interface.prototype.question[kPromisifyCustom] = function question(query, options) {
  if (options === null || typeof options !== "object") options = {};
  return new Promise((resolve, reject) => {
    let cb = resolve;
    const { signal } = options;
    if (signal) {
      validateSignal(signal, "options.signal");
      if (signal.aborted) return reject(abortError(signal));
      const onAbort = () => reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      cb = (answer) => {
        signal.removeEventListener("abort", onAbort);
        resolve(answer);
      };
    }
    this.question(query, options, cb);
  });
};

Interface.prototype.pause = function pause() {
  if (this.paused) return;
  this.input.pause();
  this.paused = true;
  this.emit("pause");
  return this;
};

Interface.prototype.resume = function resume() {
  if (!this.paused) return;
  this.input.resume();
  this.paused = false;
  this.emit("resume");
  return this;
};

/** Ends reading: the input is paused and 'close' emitted, once. */
Interface.prototype.close = function close() {
  if (this.closed) return;
  this.pause();
  this.closed = true;
  this.emit("close");
};

/** Data as if it had come from the input. */
Interface.prototype.write = function write(data) {
  if (this.closed) throw codeError(Error, "ERR_USE_AFTER_CLOSE", "readline was closed");
  if (this.paused) this.resume();
  this._normalWrite(data);
};

Interface.prototype._onLine = function _onLine(line) {
  if (this._questionCallback) {
    const cb = this._questionCallback;
    this._questionCallback = null;
    this.setPrompt(this._oldPrompt);
    cb(line);
  } else this.emit("line", line);
};

/* Node's _normalWrite: the chunk decoded, split into lines; what follows the last ending waits */
Interface.prototype._normalWrite = function _normalWrite(chunk) {
  if (chunk === undefined) return;
  let string = this._decoder.write(chunk);
  if (this._sawReturnAt && Date.now() - this._sawReturnAt <= this.crlfDelay) {
    if (string.codePointAt(0) === 10) string = string.slice(1);
    this._sawReturnAt = 0;
  }
  lineEnding.lastIndex = 0;
  let match = lineEnding.exec(string);
  if (match === null) {
    if (string) this._lineBuffer = this._lineBuffer ? this._lineBuffer + string : string;
    return;
  }
  if (this._lineBuffer) {
    string = this._lineBuffer + string;
    this._lineBuffer = null;
    lineEnding.lastIndex = 0;
    match = lineEnding.exec(string);
  }
  this._sawReturnAt = string.endsWith("\r") ? Date.now() : 0;
  const indexes = [0, match.index, lineEnding.lastIndex];
  while ((match = lineEnding.exec(string)) !== null) indexes.push(match.index, lineEnding.lastIndex);
  const last = indexes.length - 1;
  this._lineBuffer = string.slice(indexes[last]);
  for (let i = 1; i < last; i += 2) {
    this._onLine(string.slice(indexes[i - 1], indexes[i]));
    if (this.closed) break;
  }
};

/** The lines, as an async iterator; reading pauses while the iterator's buffer is full. */
Interface.prototype[Symbol.asyncIterator] = function asyncIterator() {
  if (this._lines === undefined) {
    const onLine = (line) => {
      if (!readable.push(line)) this.pause();
    };
    const onClose = () => readable.push(null);
    const onError = (err) => readable.destroy(err);
    const readable = new Readable({
      objectMode: true,
      read: () => this.resume(),
      destroy: (err, cb) => {
        this.off("line", onLine);
        this.off("close", onClose);
        this.off("error", onError);
        this.close();
        cb(err);
      },
    });
    this.on("error", onError);
    this.on("line", onLine);
    this.on("close", onClose);
    this._lines = readable;
  }
  return this._lines[Symbol.asyncIterator]();
};

export function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

/* ---- the cursor: ANSI escapes ------------------------------------------------------------ */

const CSI = "\x1b[";

/* a write, or with no stream the callback on a later tick */
function writeTo(stream, data, callback) {
  if (callback !== undefined) validateFunction(callback, "callback");
  if (stream === null || stream === undefined || data === "") {
    if (typeof callback === "function") process.nextTick(callback, null);
    return true;
  }
  return stream.write(data, callback);
}

/** The escape that clears the line: to its start (dir < 0), its end (dir > 0) or all of it. */
export function clearLineEscape(dir) {
  return dir < 0 ? CSI + "1K" : dir > 0 ? CSI + "0K" : CSI + "2K";
}

export function cursorToEscape(x, y) {
  if (Number.isNaN(x)) throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'x' is invalid. Received NaN");
  if (Number.isNaN(y)) throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'y' is invalid. Received NaN");
  if (typeof x !== "number") throw codeError(TypeError, "ERR_INVALID_CURSOR_POS", "Cannot set cursor row without setting its column");
  return typeof y !== "number" ? CSI + (x + 1) + "G" : CSI + (y + 1) + ";" + (x + 1) + "H";
}

export function moveCursorEscape(dx, dy) {
  let data = "";
  if (dx < 0) data += CSI + -dx + "D";
  else if (dx > 0) data += CSI + dx + "C";
  if (dy < 0) data += CSI + -dy + "A";
  else if (dy > 0) data += CSI + dy + "B";
  return data;
}

export function clearLine(stream, dir, callback) {
  return writeTo(stream, clearLineEscape(dir), callback);
}

export function clearScreenDown(stream, callback) {
  return writeTo(stream, CSI + "0J", callback);
}

export function cursorTo(stream, x, y, callback) {
  if (typeof y === "function") {
    callback = y;
    y = undefined;
  }
  if (stream === null || stream === undefined || (typeof x !== "number" && typeof y !== "number")) return writeTo(null, "", callback);
  return writeTo(stream, cursorToEscape(x, y), callback);
}

export function moveCursor(stream, dx, dy, callback) {
  return writeTo(stream, moveCursorEscape(dx, dy), callback);
}

export function emitKeypressEvents() {
  throw notSupported("readline.emitKeypressEvents");
}
