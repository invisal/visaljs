// node:readline's Interface (Node's lib/internal/readline/interface.js, utils.js, callbacks.js and
// the in-memory part of internal/repl/history.js), which node:readline and readline/promises extend.
// The terminal line editor (raw mode keys, editing, completion, the kill ring, undo, history
// navigation, emitKeypressEvents) is a feature module, internal/readline_editor.js, linked into
// programs that may read a terminal; without it an interface on a terminal reads lines as on a pipe.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { EventEmitter } from "../events.js";
import { StringDecoder } from "../string_decoder.js";
import { stripVTControlCharacters } from "../util.js";
import { codeError, invalidArgType, invalidArgValue, outOfRange, validateFunction, validateString } from "./errors.js";
import { kFirstEventParam, on } from "./events_on.js";
import { features } from "./features.js";
import { getStringWidth } from "./string_width.js";

/* ---- utils (Node's internal/readline/utils.js) ---------------------------------------------- */

const kUTF16SurrogateThreshold = 0x10000;
const kEscape = "\x1b";
export const kSubstringSearch = Symbol("kSubstringSearch");

export function CSI(strings, ...args) {
  let ret = `${kEscape}[`;
  for (let n = 0; n < strings.length; n++) {
    ret += strings[n];
    if (n < args.length) ret += args[n];
  }
  return ret;
}
CSI.kEscape = kEscape;
CSI.kClearToLineBeginning = CSI`1K`;
CSI.kClearToLineEnd = CSI`0K`;
CSI.kClearLine = CSI`2K`;
CSI.kClearScreenDown = CSI`0J`;

export function charLengthLeft(str, i) {
  if (i <= 0) return 0;
  if ((i > 1 && str.codePointAt(i - 2) >= kUTF16SurrogateThreshold) || str.codePointAt(i - 1) >= kUTF16SurrogateThreshold) return 2;
  return 1;
}

export function charLengthAt(str, i) {
  if (str.length <= i) {
    /* pretend there's a character at the end, so the cursor can move past the line */
    return 1;
  }
  return str.codePointAt(i) >= kUTF16SurrogateThreshold ? 2 : 1;
}

/* the line's parts in reverse: history keeps a multiline entry's lines last to first */
function reverseString(line, from = "\r", to = "\r") {
  const parts = line.split(from);
  let result = "";
  for (let i = parts.length - 1; i > 0; i--) result += parts[i] + to;
  result += parts[0];
  return result;
}

/* ---- errors and validation ------------------------------------------------------------------- */

const useAfterClose = () => codeError(Error, "ERR_USE_AFTER_CLOSE", "readline was closed");

/* Node's AbortError: name and code, the signal's reason as its cause */
export function abortError(message = "The operation was aborted", options = undefined) {
  const error = new Error(message, options);
  error.code = "ABORT_ERR";
  error.name = "AbortError";
  return error;
}

export function validateAbortSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
    throw invalidArgType(name, "an instance of AbortSignal", signal);
  }
}

/* Node's addAbortListener: the listener once, and a disposable that removes it */
export function addAbortListener(signal, listener) {
  if (signal.aborted) {
    queueMicrotask(() => listener());
    return { [Symbol.dispose]() {} };
  }
  signal.addEventListener("abort", listener, { once: true });
  return { [Symbol.dispose]: () => signal.removeEventListener("abort", listener) };
}

function validateUint32(value, name, positive) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  const min = positive ? 1 : 0;
  if (value < min || value > 4294967295) throw outOfRange(name, `>= ${min} && <= 4294967295`, value);
}

/* ---- the cursor functions (Node's internal/readline/callbacks.js) ---------------------------- */

const done = (callback) => {
  if (typeof callback === "function") process.nextTick(callback, null);
  return true;
};

export function cursorTo(stream, x, y, callback) {
  if (callback !== undefined) validateFunction(callback, "callback");
  if (typeof y === "function") {
    callback = y;
    y = undefined;
  }
  if (Number.isNaN(x)) throw invalidArgValue("x", "is invalid", x);
  if (Number.isNaN(y)) throw invalidArgValue("y", "is invalid", y);
  if (stream == null || (typeof x !== "number" && typeof y !== "number")) return done(callback);
  if (typeof x !== "number") throw codeError(TypeError, "ERR_INVALID_CURSOR_POS", "Cannot set cursor row without setting its column");
  const data = typeof y !== "number" ? CSI`${x + 1}G` : CSI`${y + 1};${x + 1}H`;
  return stream.write(data, callback);
}

export function moveCursor(stream, dx, dy, callback) {
  if (callback !== undefined) validateFunction(callback, "callback");
  if (stream == null || !(dx || dy)) return done(callback);
  let data = "";
  if (dx < 0) data += CSI`${-dx}D`;
  else if (dx > 0) data += CSI`${dx}C`;
  if (dy < 0) data += CSI`${-dy}A`;
  else if (dy > 0) data += CSI`${dy}B`;
  return stream.write(data, callback);
}

export function clearLine(stream, dir, callback) {
  if (callback !== undefined) validateFunction(callback, "callback");
  if (stream === null || stream === undefined) return done(callback);
  const type = dir < 0 ? CSI.kClearToLineBeginning : dir > 0 ? CSI.kClearToLineEnd : CSI.kClearLine;
  return stream.write(type, callback);
}

export function clearScreenDown(stream, callback) {
  if (callback !== undefined) validateFunction(callback, "callback");
  if (stream === null || stream === undefined) return done(callback);
  return stream.write(CSI.kClearScreenDown, callback);
}

/* ---- history (Node's ReplHistory, without the REPL's file) ----------------------------------- */

const kHistorySize = 30;

class ReplHistory {
  #context;
  #removeHistoryDuplicates;
  #size;
  #history;
  #index = -1;

  constructor(context, options) {
    if (options.history !== undefined && !Array.isArray(options.history)) throw invalidArgType("history", "an instance of Array", options.history);
    if (options.size !== undefined) {
      if (typeof options.size !== "number") throw invalidArgType("size", "of type number", options.size);
      if (options.size < 0 || Number.isNaN(options.size)) throw outOfRange("size", ">= 0", options.size);
    }
    this.#context = context;
    this.#removeHistoryDuplicates = options.removeHistoryDuplicates || false;
    this.#size = options.size ?? context.historySize ?? kHistorySize;
    this.#history = options.history ?? [];
  }

  addHistory(isMultiline, lastCommandErrored) {
    const line = this.#context.line;
    if (line.length === 0) return "";
    if (this.#size === 0) return line;
    if (line.trim().length === 0) return line;
    /* a multiline entry replaces the line it continues; a failed command isn't kept */
    if ((isMultiline && this.#index === -1) || lastCommandErrored) this.#history.shift();
    const normalizedLine = reverseString(line, "\n", "\r");
    if (this.#history.length === 0 || this.#history[0] !== normalizedLine) {
      if (this.#removeHistoryDuplicates) {
        const dupIndex = this.#history.indexOf(normalizedLine);
        if (dupIndex !== -1) this.#history.splice(dupIndex, 1);
      }
      this.#history.unshift(normalizedLine);
      if (this.#history.length > this.#size) this.#history.pop();
    }
    this.#index = -1;
    const finalLine = isMultiline ? reverseString(this.#history[0]) : this.#history[0];
    this.#context.emit("history", this.#history);
    return finalLine;
  }

  canNavigateToNext() {
    return this.#index > -1 && this.#history.length > 0;
  }

  navigateToNext(substringSearch) {
    if (!this.canNavigateToNext()) return null;
    const search = substringSearch || "";
    let index = this.#index - 1;
    while (index >= 0 && (!this.#history[index].startsWith(search) || this.#context.line === this.#history[index])) index--;
    this.#index = index;
    if (index === -1) return search;
    return reverseString(this.#history[index], "\r", "\n");
  }

  canNavigateToPrevious() {
    return this.#history.length !== this.#index && this.#history.length > 0;
  }

  navigateToPrevious(substringSearch = "") {
    if (!this.canNavigateToPrevious()) return null;
    const search = substringSearch || "";
    let index = this.#index + 1;
    while (index < this.#history.length && (!this.#history[index].startsWith(search) || this.#context.line === this.#history[index])) index++;
    this.#index = index;
    if (index === this.#history.length) return search;
    return reverseString(this.#history[index], "\r", "\n");
  }

  get size() { return this.#size; }
  get isFlushing() { return false; }
  get history() { return this.#history; }
  set history(value) { this.#history = value; }
  get index() { return this.#index; }
  set index(value) { this.#index = value; }
}

/* ---- Interface ------------------------------------------------------------------------------- */

const kMincrlfDelay = 100;
/* \r\n, \n, \r (not one that a \n may follow in the next chunk), and the Unicode line separators */
const lineEnding = /\r?\n|\r(?!\n)|\u2028|\u2029/g;
const ESCAPE_CODE_TIMEOUT = 500;

export const kLineObjectStream = Symbol("line object stream");
export const kQuestionCancel = Symbol("kQuestionCancel");
export const kQuestion = Symbol("kQuestion");
export const kMultilinePrompt = Symbol("| ");

export const kAddHistory = Symbol("_addHistory");
export const kBeforeEdit = Symbol("_beforeEdit");
export const kDecoder = Symbol("_decoder");
export const kDeleteLeft = Symbol("_deleteLeft");
export const kDeleteLineLeft = Symbol("_deleteLineLeft");
export const kDeleteLineRight = Symbol("_deleteLineRight");
export const kDeleteRight = Symbol("_deleteRight");
export const kDeleteWordLeft = Symbol("_deleteWordLeft");
export const kDeleteWordRight = Symbol("_deleteWordRight");
export const kGetDisplayPos = Symbol("_getDisplayPos");
export const kHistoryNext = Symbol("_historyNext");
export const kMoveDownOrHistoryNext = Symbol("_moveDownOrHistoryNext");
export const kHistoryPrev = Symbol("_historyPrev");
export const kMoveUpOrHistoryPrev = Symbol("_moveUpOrHistoryPrev");
export const kInsertString = Symbol("_insertString");
export const kLine = Symbol("_line");
export const kLine_buffer = Symbol("_line_buffer");
export const kKillRing = Symbol("_killRing");
export const kKillRingCursor = Symbol("_killRingCursor");
export const kMoveCursor = Symbol("_moveCursor");
export const kNormalWrite = Symbol("_normalWrite");
export const kOldPrompt = Symbol("_oldPrompt");
export const kOnLine = Symbol("_onLine");
export const kSetLine = Symbol("_setLine");
export const kPreviousKey = Symbol("_previousKey");
export const kPrompt = Symbol("_prompt");
export const kPushToKillRing = Symbol("_pushToKillRing");
export const kPushToUndoStack = Symbol("_pushToUndoStack");
export const kQuestionCallback = Symbol("_questionCallback");
export const kLastCommandErrored = Symbol("_lastCommandErrored");
export const kQuestionReject = Symbol("_questionReject");
export const kRedo = Symbol("_redo");
export const kRedoStack = Symbol("_redoStack");
export const kRefreshLine = Symbol("_refreshLine");
export const kSawKeyPress = Symbol("_sawKeyPress");
export const kSawReturnAt = Symbol("_sawReturnAt");
export const kSetRawMode = Symbol("_setRawMode");
export const kTabComplete = Symbol("_tabComplete");
export const kTabCompleter = Symbol("_tabCompleter");
export const kTtyWrite = Symbol("_ttyWrite");
export const kUndo = Symbol("_undo");
export const kUndoStack = Symbol("_undoStack");
export const kIsMultiline = Symbol("_isMultiline");
export const kWordLeft = Symbol("_wordLeft");
export const kWordRight = Symbol("_wordRight");
export const kWriteToOutput = Symbol("_writeToOutput");
export const kYank = Symbol("_yank");
export const kYanking = Symbol("_yanking");
export const kYankPop = Symbol("_yankPop");
export const kSavePreviousState = Symbol("_savePreviousState");
export const kRestorePreviousState = Symbol("_restorePreviousState");
export const kPreviousLine = Symbol("_previousLine");
export const kPreviousCursor = Symbol("_previousCursor");
export const kPreviousCursorCols = Symbol("_previousCursorCols");
export const kMultilineMove = Symbol("_multilineMove");
export const kPreviousPrevRows = Symbol("_previousPrevRows");
export const kAddNewLineOnTTY = Symbol("_addNewLineOnTTY");

export function InterfaceConstructor(input, output, completer, terminal) {
  this[kSawReturnAt] = 0;
  this.isCompletionEnabled = true;
  this[kSawKeyPress] = false;
  this[kPreviousKey] = null;
  this.escapeCodeTimeout = ESCAPE_CODE_TIMEOUT;
  this.tabSize = 8;

  EventEmitter.call(this);

  let crlfDelay;
  let prompt = "> ";
  let signal;
  let historyOptions;

  if (input?.input) {
    /* an options object */
    output = input.output;
    completer = input.completer;
    terminal = input.terminal;
    signal = input.signal;
    const historySize = input.historySize;
    const history = input.history;
    const removeHistoryDuplicates = input.removeHistoryDuplicates;
    if (input.tabSize !== undefined) {
      validateUint32(input.tabSize, "tabSize", true);
      this.tabSize = input.tabSize;
    }
    if (input.prompt !== undefined) prompt = input.prompt;
    if (input.escapeCodeTimeout !== undefined) {
      if (Number.isFinite(input.escapeCodeTimeout)) this.escapeCodeTimeout = input.escapeCodeTimeout;
      else throw invalidArgValue("input.escapeCodeTimeout", "is invalid", this.escapeCodeTimeout);
    }
    if (signal) validateAbortSignal(signal, "options.signal");
    crlfDelay = input.crlfDelay;
    input = input.input;
    historyOptions = { __proto__: null, size: historySize, history, removeHistoryDuplicates };
  }

  this.setupHistoryManager(historyOptions ?? input);

  if (completer !== undefined && typeof completer !== "function") throw invalidArgValue("completer", "is invalid", completer);

  /* the output's isTTY, when terminal isn't given (Node's backwards compatibility) */
  if (terminal === undefined && !(output === null || output === undefined)) terminal = !!output.isTTY;

  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const self = this;

  this.line = "";
  this[kIsMultiline] = false;
  this[kSubstringSearch] = null;
  this.output = output;
  this.input = input;
  this[kUndoStack] = [];
  this[kRedoStack] = [];
  this[kPreviousCursorCols] = -1;
  /* the kill ring: what was deleted, the latest first, yanked back (Emacs's) */
  this[kKillRing] = [];
  this[kKillRingCursor] = 0;

  this.crlfDelay = crlfDelay ? Math.max(kMincrlfDelay, crlfDelay) : kMincrlfDelay;
  this.completer = completer;

  this.setPrompt(prompt);

  /* a terminal needs the line editor: a program that doesn't link it reads lines as from a pipe */
  this.terminal = !!terminal && features.readlineEditor !== undefined;

  function onerror(err) {
    self.emit("error", err);
  }

  function ondata(data) {
    self[kNormalWrite](data);
  }

  function onend() {
    if (typeof self[kLine_buffer] === "string" && self[kLine_buffer].length > 0) self.emit("line", self[kLine_buffer]);
    self.close();
  }

  function ontermend() {
    if (typeof self.line === "string" && self.line.length > 0) self.emit("line", self.line);
    self.close();
  }

  function onkeypress(s, key) {
    self[kTtyWrite](s, key);
    if (key?.sequence) {
      /* half a surrogate pair: refreshed, so the character shows once it's whole */
      const ch = key.sequence.codePointAt(0);
      if (ch >= 0xd800 && ch <= 0xdfff) self[kRefreshLine]();
    }
  }

  function onresize() {
    self[kRefreshLine]();
  }

  this[kLineObjectStream] = undefined;

  input.on("error", onerror);

  if (!this.terminal) {
    function onSelfCloseWithoutTerminal() {
      input.removeListener("data", ondata);
      input.removeListener("error", onerror);
      input.removeListener("end", onend);
    }
    input.on("data", ondata);
    input.on("end", onend);
    self.once("close", onSelfCloseWithoutTerminal);
    this[kDecoder] = new StringDecoder("utf8");
  } else {
    function onSelfCloseWithTerminal() {
      input.removeListener("keypress", onkeypress);
      input.removeListener("error", onerror);
      input.removeListener("end", ontermend);
      if (output !== null && output !== undefined) output.removeListener("resize", onresize);
    }
    features.emitKeypressEvents(input, this);
    input.on("keypress", onkeypress);
    input.on("end", ontermend);
    this[kSetRawMode](true);
    this.terminal = true;
    this.cursor = 0;
    if (output !== null && output !== undefined) output.on("resize", onresize);
    self.once("close", onSelfCloseWithTerminal);
  }

  if (signal) {
    const onAborted = () => self.close();
    if (signal.aborted) {
      process.nextTick(onAborted);
    } else {
      const disposable = addAbortListener(signal, onAborted);
      self.once("close", disposable[Symbol.dispose]);
    }
  }

  this[kSetLine]("");

  input.resume();
}

Object.setPrototypeOf(InterfaceConstructor.prototype, EventEmitter.prototype);
Object.setPrototypeOf(InterfaceConstructor, EventEmitter);

/* the history accessors each instance gets */
const kHistoryAccessorDescriptors = {
  __proto__: null,
  history: {
    __proto__: null, configurable: true, enumerable: true,
    get() { return this.historyManager.history; },
    set(newHistory) { return this.historyManager.history = newHistory; },
  },
  historyIndex: {
    __proto__: null, configurable: true, enumerable: true,
    get() { return this.historyManager.index; },
    set(historyIndex) { return this.historyManager.index = historyIndex; },
  },
  historySize: {
    __proto__: null, configurable: true, enumerable: true,
    get() { return this.historyManager.size; },
  },
  isFlushing: {
    __proto__: null, configurable: true, enumerable: true,
    get() { return this.historyManager.isFlushing; },
  },
};

export class Interface extends InterfaceConstructor {
  get columns() {
    if (this.output?.columns) return this.output.columns;
    return Infinity;
  }

  setPrompt(prompt) {
    this[kPrompt] = prompt;
  }

  getPrompt() {
    return this[kPrompt];
  }

  setupHistoryManager(options) {
    this.historyManager = new ReplHistory(this, options);
    Object.defineProperties(this, kHistoryAccessorDescriptors);
  }

  [kSetRawMode](mode) {
    const wasInRawMode = this.input.isRaw;
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(mode);
    return wasInRawMode;
  }

  prompt(preserveCursor) {
    if (this.paused) this.resume();
    if (this.terminal && process.env.TERM !== "dumb") {
      if (!preserveCursor) this.cursor = 0;
      this[kRefreshLine]();
    } else {
      this[kWriteToOutput](this[kPrompt]);
    }
  }

  [kQuestion](query, cb) {
    if (this.closed) throw useAfterClose();
    if (this[kQuestionCallback]) {
      this.prompt();
    } else {
      this[kOldPrompt] = this[kPrompt];
      this.setPrompt(query);
      this[kQuestionCallback] = cb;
      this.prompt();
    }
  }

  [kSetLine](line = "") {
    this.line = line;
    this[kIsMultiline] = line.includes("\n");
  }

  [kOnLine](line) {
    if (this[kQuestionCallback]) {
      const cb = this[kQuestionCallback];
      this[kQuestionCallback] = null;
      this.setPrompt(this[kOldPrompt]);
      cb(line);
    } else {
      this.emit("line", line);
    }
  }

  [kBeforeEdit](oldText, oldCursor) {
    this[kPushToUndoStack](oldText, oldCursor);
  }

  [kQuestionCancel]() {
    if (this[kQuestionCallback]) {
      this[kQuestionCallback] = null;
      this.setPrompt(this[kOldPrompt]);
      this.clearLine();
    }
  }

  [kWriteToOutput](stringToWrite) {
    validateString(stringToWrite, "stringToWrite");
    if (this.output !== null && this.output !== undefined) this.output.write(stringToWrite);
  }

  [kAddHistory]() {
    return this.historyManager.addHistory(this[kIsMultiline], this[kLastCommandErrored]);
  }

  [kRefreshLine]() {
    const line = this[kPrompt] + this.line;
    const dispPos = this[kGetDisplayPos](line);
    const lineCols = dispPos.cols;
    const lineRows = dispPos.rows;
    const cursorPos = this.getCursorPos();
    /* to the bottom of the line, from the cursor; to its left edge; cleared */
    const prevRows = this.prevRows || 0;
    if (prevRows > 0) moveCursor(this.output, 0, -prevRows);
    cursorTo(this.output, 0);
    clearScreenDown(this.output);
    if (this[kIsMultiline]) {
      const lines = this.line.split("\n");
      this[kWriteToOutput](this[kPrompt] + lines[0]);
      for (let i = 1; i < lines.length; i++) this[kWriteToOutput](`\n${kMultilinePrompt.description}` + lines[i]);
    } else {
      this[kWriteToOutput](line);
    }
    /* the terminal makes a new line once something is on it */
    if (lineCols === 0) this[kWriteToOutput](" ");
    cursorTo(this.output, cursorPos.cols);
    const diff = lineRows - cursorPos.rows;
    if (diff > 0) moveCursor(this.output, 0, -diff);
    this.prevRows = cursorPos.rows;
  }

  close() {
    if (this.closed) return;
    this.pause();
    if (this.terminal) this[kSetRawMode](false);
    this.closed = true;
    this.emit("close");
  }

  pause() {
    if (this.closed) throw useAfterClose();
    if (this.paused) return;
    this.input.pause();
    this.paused = true;
    this.emit("pause");
    return this;
  }

  resume() {
    if (this.closed) throw useAfterClose();
    if (!this.paused) return;
    this.input.resume();
    this.paused = false;
    this.emit("resume");
    return this;
  }

  write(d, key) {
    if (this.closed) throw useAfterClose();
    if (this.paused) this.resume();
    if (this.terminal) this[kTtyWrite](d, key);
    else this[kNormalWrite](d);
  }

  [kNormalWrite](b) {
    if (b === undefined) return;
    let string = this[kDecoder].write(b);
    if (this[kSawReturnAt] && Date.now() - this[kSawReturnAt] <= this.crlfDelay) {
      if (string.codePointAt() === 10) string = string.slice(1);
      this[kSawReturnAt] = 0;
    }
    if (!string) return;
    /* the new chunk split, not the whole buffer: a plain split when it has none of the rarer endings */
    const lines = string.includes("\r") || string.includes("\u2028") || string.includes("\u2029") ? string.split(lineEnding) : string.split("\n");
    const lastIndex = lines.length - 1;
    if (lastIndex === 0) {
      if (this[kLine_buffer]) this[kLine_buffer] += string;
      else this[kLine_buffer] = string;
      return;
    }
    this[kSawReturnAt] = string.endsWith("\r") ? Date.now() : 0;
    let first = lines[0];
    if (this[kLine_buffer]) first = this[kLine_buffer] + first;
    /* '' or the next line's start */
    this[kLine_buffer] = lines[lastIndex];
    this[kOnLine](first);
    for (let i = 1; i < lastIndex; i++) this[kOnLine](lines[i]);
  }

  [kSavePreviousState]() {
    this[kPreviousLine] = this.line;
    this[kPreviousCursor] = this.cursor;
    this[kPreviousPrevRows] = this.prevRows;
  }

  [kRestorePreviousState]() {
    this[kSetLine](this[kPreviousLine]);
    this.cursor = this[kPreviousCursor];
    this.prevRows = this[kPreviousPrevRows];
  }

  clearLine() {
    this[kMoveCursor](+Infinity);
    this[kWriteToOutput]("\r\n");
    this[kSetLine]("");
    this.cursor = 0;
    this.prevRows = 0;
  }

  [kPushToUndoStack](text, cursor) {
    if (this[kUndoStack].push({ text, cursor }) > 2048) this[kUndoStack].shift();
  }

  /* where `str` ends on the screen: its rows and the column on the last */
  [kGetDisplayPos](str) {
    let offset = 0;
    const col = this.columns;
    let rows = 0;
    str = stripVTControlCharacters(str);
    for (const char of str) {
      if (char === "\n") {
        rows += Math.ceil(offset / col) || 1;
        offset = this[kIsMultiline] ? kMultilinePrompt.description.length : 0;
        continue;
      }
      if (char === "\t") {
        offset += this.tabSize - (offset % this.tabSize);
        continue;
      }
      const width = getStringWidth(char, false);
      if (width === 0 || width === 1) {
        offset += width;
      } else {
        /* a wide character doesn't fit in the last column: it starts the next row */
        if ((offset + 1) % col === 0) offset++;
        offset += 2;
      }
    }
    const cols = offset % col;
    rows += (offset - cols) / col;
    return { cols, rows };
  }

  getCursorPos() {
    const strBeforeCursor = this[kPrompt] + this.line.slice(0, this.cursor);
    return this[kGetDisplayPos](strBeforeCursor);
  }

  [kMoveCursor](dx) {
    if (dx === 0) return;
    const oldPos = this.getCursorPos();
    this.cursor += dx;
    if (this.cursor < 0) this.cursor = 0;
    else if (this.cursor > this.line.length) this.cursor = this.line.length;
    const newPos = this.getCursorPos();
    /* on the same row: moved; across rows: the line redrawn */
    if (oldPos.rows === newPos.rows) moveCursor(this.output, newPos.cols - oldPos.cols, 0);
    else this[kRefreshLine]();
  }

  [Symbol.asyncIterator]() {
    if (this[kLineObjectStream] === undefined) {
      this[kLineObjectStream] = on(this, "line", { close: ["close"], highWaterMark: 1024, [kFirstEventParam]: true });
    }
    return this[kLineObjectStream];
  }
}

Interface.prototype[Symbol.dispose] = function () {
  this.close();
};
Object.defineProperty(Interface.prototype[Symbol.dispose], "name", { value: "[Symbol.dispose]" });
