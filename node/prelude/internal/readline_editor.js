// node:readline's terminal line editor (Node's lib/internal/readline/interface.js, the editing
// half; utils.js's emitKeys; emitKeypressEvents.js): keys read in raw mode, the line edited and
// redrawn, completion, the kill ring, undo, history. A feature module (internal/features.js),
// linked into programs that may read a terminal; it gives the Interface its methods.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { Interface as LegacyInterface } from "../readline.js";
import { StringDecoder } from "../string_decoder.js";
import { inspect } from "../util.js";
import { features } from "./features.js";
import {
  abortError, charLengthAt, charLengthLeft, clearScreenDown, CSI, cursorTo, Interface, kAddHistory, kAddNewLineOnTTY, kBeforeEdit, kDeleteLeft,
  kDeleteLineLeft, kDeleteLineRight, kDeleteRight, kDeleteWordLeft, kDeleteWordRight, kGetDisplayPos, kHistoryNext, kHistoryPrev,
  kInsertString, kIsMultiline, kKillRing, kKillRingCursor, kLine, kMoveCursor, kMoveDownOrHistoryNext, kMoveUpOrHistoryPrev,
  kMultilineMove, kMultilinePrompt, kOnLine, kPreviousCursorCols, kPreviousKey, kPrompt, kPushToKillRing, kQuestionReject, kRedo,
  kRedoStack, kRefreshLine, kRestorePreviousState, kSavePreviousState, kSawKeyPress, kSawReturnAt, kSetLine, kSetRawMode,
  kSubstringSearch, kTabComplete, kTabCompleter, kTtyWrite, kUndo, kUndoStack, kWordLeft, kWordRight, kWriteToOutput, kYank,
  kYanking, kYankPop, moveCursor,
} from "./readline.js";
import { getStringWidth } from "./string_width.js";

const kEscape = CSI.kEscape;
const kEmptyObject = Object.freeze({ __proto__: null });
const kMaxLengthOfKillRing = 32;
/* \r\n, \n, \r, and the Unicode line separators: a paste's lines */
const lineEnding = /\r?\n|\r(?!\n)|\u2028|\u2029/g;

/* ---- keys (Node's internal/readline/utils.js) ------------------------------------------------ */

function* emitKeys(stream) {
  while (true) {
    let ch = yield;
    let s = ch;
    let escaped = false;
    const key = {
      sequence: null,
      name: undefined,
      ctrl: false,
      meta: false,
      shift: false,
    };

    if (ch === kEscape) {
      escaped = true;
      s += (ch = yield);

      if (ch === kEscape) {
        s += (ch = yield);
      }
    }

    if (escaped && (ch === 'O' || ch === '[')) {
      // ANSI escape sequence
      let code = ch;
      let modifier = 0;

      if (ch === 'O') {
        // ESC O letter
        // ESC O modifier letter
        s += (ch = yield);

        if (ch >= '0' && ch <= '9') {
          modifier = (ch >> 0) - 1;
          s += (ch = yield);
        }

        code += ch;
      } else if (ch === '[') {
        // ESC [ letter
        // ESC [ modifier letter
        // ESC [ [ modifier letter
        // ESC [ [ num char
        s += (ch = yield);

        if (ch === '[') {
          // \x1b[[A
          //      ^--- escape codes might have a second bracket
          code += ch;
          s += (ch = yield);
        }

        /*
         * Here and later we try to buffer just enough data to get
         * a complete ascii sequence.
         *
         * We have basically two classes of ascii characters to process:
         *
         *
         * 1. `\x1b[24;5~` should be parsed as { code: '[24~', modifier: 5 }
         *
         * This particular example is featuring Ctrl+F12 in xterm.
         *
         *  - `;5` part is optional, e.g. it could be `\x1b[24~`
         *  - first part can contain one or two digits
         *  - there is also special case when there can be 3 digits
         *    but without modifier. They are the case of paste bracket mode
         *
         * So the generic regexp is like /^(?:\d\d?(;\d)?[~^$]|\d{3}~)$/
         *
         *
         * 2. `\x1b[1;5H` should be parsed as { code: '[H', modifier: 5 }
         *
         * This particular example is featuring Ctrl+Home in xterm.
         *
         *  - `1;5` part is optional, e.g. it could be `\x1b[H`
         *  - `1;` part is optional, e.g. it could be `\x1b[5H`
         *
         * So the generic regexp is like /^((\d;)?\d)?[A-Za-z]$/
         *
         */
        const cmdStart = s.length - 1;

        // Skip one or two leading digits
        if (ch >= '0' && ch <= '9') {
          s += (ch = yield);

          if (ch >= '0' && ch <= '9') {
            s += (ch = yield);

            if (ch >= '0' && ch <= '9') {
              s += (ch = yield);
            }
          }
        }

        // skip modifier
        if (ch === ';') {
          s += (ch = yield);

          if (ch >= '0' && ch <= '9') {
            s += yield;
          }
        }

        /*
         * We buffered enough data, now trying to extract code
         * and modifier from it
         */
        const cmd = s.slice(cmdStart);
        let match;

        if ((match = (/^(?:(\d\d?)(?:;(\d))?([~^$])|(\d{3}~))$/).exec(cmd))) {
          if (match[4]) {
            code += match[4];
          } else {
            code += match[1] + match[3];
            modifier = (match[2] || 1) - 1;
          }
        } else if (
          (match = (/^((\d;)?(\d))?([A-Za-z])$/).exec(cmd))
        ) {
          code += match[4];
          modifier = (match[3] || 1) - 1;
        } else {
          code += cmd;
        }
      }

      // Parse the key modifier
      key.ctrl = !!(modifier & 4);
      key.meta = !!(modifier & 10);
      key.shift = !!(modifier & 1);
      key.code = code;

      // Parse the key itself
      switch (code) {
        /* xterm/gnome ESC [ letter (with modifier) */
        case '[P': key.name = 'f1'; break;
        case '[Q': key.name = 'f2'; break;
        case '[R': key.name = 'f3'; break;
        case '[S': key.name = 'f4'; break;

        /* xterm/gnome ESC O letter (without modifier) */
        case 'OP': key.name = 'f1'; break;
        case 'OQ': key.name = 'f2'; break;
        case 'OR': key.name = 'f3'; break;
        case 'OS': key.name = 'f4'; break;

        /* xterm/rxvt ESC [ number ~ */
        case '[11~': key.name = 'f1'; break;
        case '[12~': key.name = 'f2'; break;
        case '[13~': key.name = 'f3'; break;
        case '[14~': key.name = 'f4'; break;

        /* paste bracket mode */
        case '[200~': key.name = 'paste-start'; break;
        case '[201~': key.name = 'paste-end'; break;

        /* from Cygwin and used in libuv */
        case '[[A': key.name = 'f1'; break;
        case '[[B': key.name = 'f2'; break;
        case '[[C': key.name = 'f3'; break;
        case '[[D': key.name = 'f4'; break;
        case '[[E': key.name = 'f5'; break;

        /* common */
        case '[15~': key.name = 'f5'; break;
        case '[17~': key.name = 'f6'; break;
        case '[18~': key.name = 'f7'; break;
        case '[19~': key.name = 'f8'; break;
        case '[20~': key.name = 'f9'; break;
        case '[21~': key.name = 'f10'; break;
        case '[23~': key.name = 'f11'; break;
        case '[24~': key.name = 'f12'; break;

        /* xterm ESC [ letter */
        case '[A': key.name = 'up'; break;
        case '[B': key.name = 'down'; break;
        case '[C': key.name = 'right'; break;
        case '[D': key.name = 'left'; break;
        case '[E': key.name = 'clear'; break;
        case '[F': key.name = 'end'; break;
        case '[H': key.name = 'home'; break;

        /* xterm/gnome ESC O letter */
        case 'OA': key.name = 'up'; break;
        case 'OB': key.name = 'down'; break;
        case 'OC': key.name = 'right'; break;
        case 'OD': key.name = 'left'; break;
        case 'OE': key.name = 'clear'; break;
        case 'OF': key.name = 'end'; break;
        case 'OH': key.name = 'home'; break;

        /* xterm/rxvt ESC [ number ~ */
        case '[1~': key.name = 'home'; break;
        case '[2~': key.name = 'insert'; break;
        case '[3~': key.name = 'delete'; break;
        case '[4~': key.name = 'end'; break;
        case '[5~': key.name = 'pageup'; break;
        case '[6~': key.name = 'pagedown'; break;

        /* putty */
        case '[[5~': key.name = 'pageup'; break;
        case '[[6~': key.name = 'pagedown'; break;

        /* rxvt */
        case '[7~': key.name = 'home'; break;
        case '[8~': key.name = 'end'; break;

        /* rxvt keys with modifiers */
        case '[a': key.name = 'up'; key.shift = true; break;
        case '[b': key.name = 'down'; key.shift = true; break;
        case '[c': key.name = 'right'; key.shift = true; break;
        case '[d': key.name = 'left'; key.shift = true; break;
        case '[e': key.name = 'clear'; key.shift = true; break;

        case '[2$': key.name = 'insert'; key.shift = true; break;
        case '[3$': key.name = 'delete'; key.shift = true; break;
        case '[5$': key.name = 'pageup'; key.shift = true; break;
        case '[6$': key.name = 'pagedown'; key.shift = true; break;
        case '[7$': key.name = 'home'; key.shift = true; break;
        case '[8$': key.name = 'end'; key.shift = true; break;

        case 'Oa': key.name = 'up'; key.ctrl = true; break;
        case 'Ob': key.name = 'down'; key.ctrl = true; break;
        case 'Oc': key.name = 'right'; key.ctrl = true; break;
        case 'Od': key.name = 'left'; key.ctrl = true; break;
        case 'Oe': key.name = 'clear'; key.ctrl = true; break;

        case '[2^': key.name = 'insert'; key.ctrl = true; break;
        case '[3^': key.name = 'delete'; key.ctrl = true; break;
        case '[5^': key.name = 'pageup'; key.ctrl = true; break;
        case '[6^': key.name = 'pagedown'; key.ctrl = true; break;
        case '[7^': key.name = 'home'; key.ctrl = true; break;
        case '[8^': key.name = 'end'; key.ctrl = true; break;

        /* misc. */
        case '[Z': key.name = 'tab'; key.shift = true; break;
        default: key.name = 'undefined'; break;
      }
    } else if (ch === '\r') {
      // carriage return
      key.name = 'return';
      key.meta = escaped;
    } else if (ch === '\n') {
      // Enter, should have been called linefeed
      key.name = 'enter';
      key.meta = escaped;
    } else if (ch === '\t') {
      // tab
      key.name = 'tab';
      key.meta = escaped;
    } else if (ch === '\b' || ch === '\x7f') {
      // backspace or ctrl+h
      key.name = 'backspace';
      key.meta = escaped;
    } else if (ch === kEscape) {
      // escape key
      key.name = 'escape';
      key.meta = escaped;
    } else if (ch === ' ') {
      key.name = 'space';
      key.meta = escaped;
    } else if (!escaped && ch <= '\x1a') {
      // ctrl+letter
      key.name = String.fromCharCode(
        ch.charCodeAt() + ('a').charCodeAt() - 1,
      );
      key.ctrl = true;
    } else if ((/^[0-9A-Za-z]$/).exec(ch) !== null) {
      // Letter, number, shift+letter
      key.name = ch.toLowerCase();
      key.shift = (/^[A-Z]$/).exec(ch) !== null;
      key.meta = escaped;
    } else if (escaped) {
      // Escape sequence timeout
      key.name = ch.length ? undefined : 'escape';
      key.meta = true;
    }

    key.sequence = s;

    if (s.length !== 0 && (key.name !== undefined || escaped)) {
      /* Named character or sequence */
      stream.emit('keypress', escaped ? undefined : s, key);
    } else if (charLengthAt(s, 0) === s.length) {
      /* Single unnamed character, e.g. "." */
      stream.emit('keypress', s, key);
    }
    /* Unrecognized or broken escape sequence, don't emit anything */
  }
}

// This runs in O(n log n).
function commonPrefix(strings) {
  if (strings.length === 0) {
    return '';
  }
  if (strings.length === 1) {
    return strings[0];
  }
  const sorted = strings.toSorted();
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  for (let i = 0; i < min.length; i++) {
    if (min[i] !== max[i]) {
      return min.slice(0, i);
    }
  }
  return min;
}

/* ---- emitKeypressEvents (Node's internal/readline/emitKeypressEvents.js) ------------------------ */

const KEYPRESS_DECODER = Symbol('keypress-decoder');
const ESCAPE_DECODER = Symbol('escape-decoder');

// GNU readline library - keyseq-timeout is 500ms (default)
const ESCAPE_CODE_TIMEOUT = 500;

/**
 * accepts a readable Stream instance and makes it emit "keypress" events
 */

function emitKeypressEvents(stream, iface = {}) {
  if (stream[KEYPRESS_DECODER]) return;

  stream[KEYPRESS_DECODER] = new StringDecoder('utf8');

  stream[ESCAPE_DECODER] = emitKeys(stream);
  stream[ESCAPE_DECODER].next();

  const triggerEscape = () => stream[ESCAPE_DECODER].next('');
  const { escapeCodeTimeout = ESCAPE_CODE_TIMEOUT } = iface;
  let timeoutId;

  function onData(input) {
    if (stream.listenerCount('keypress') > 0) {
      const string = stream[KEYPRESS_DECODER].write(input);
      if (string) {
        clearTimeout(timeoutId);

        // This supports characters of length 2.
        iface[kSawKeyPress] = charLengthAt(string, 0) === string.length;
        iface.isCompletionEnabled = false;

        let length = 0;
        for (const character of string) {
          length += character.length;
          if (length === string.length) {
            iface.isCompletionEnabled = true;
          }

          try {
            stream[ESCAPE_DECODER].next(character);
            // Escape letter at the tail position
            if (length === string.length && character === kEscape) {
              timeoutId = setTimeout(triggerEscape, escapeCodeTimeout);
            }
          } catch (err) {
            // If the generator throws (it could happen in the `keypress`
            // event), we need to restart it.
            stream[ESCAPE_DECODER] = emitKeys(stream);
            stream[ESCAPE_DECODER].next();
            throw err;
          }
        }
      }
    } else {
      // Nobody's watching anyway
      stream.removeListener('data', onData);
      stream.on('newListener', onNewListener);
    }
  }

  function onNewListener(event) {
    if (event === 'keypress') {
      stream.on('data', onData);
      stream.removeListener('newListener', onNewListener);
    }
  }

  if (stream.listenerCount('keypress') > 0) {
    stream.on('data', onData);
  } else {
    stream.on('newListener', onNewListener);
  }
}

/* ---- the editing methods, Interface's ------------------------------------------------------- */

class Editor {
  [kInsertString](c) {
    this[kBeforeEdit](this.line, this.cursor);
    if (!this.isCompletionEnabled) {
      if (this.cursor < this.line.length) {
        const beg = this.line.slice(0, this.cursor);
        const end = this.line.slice(this.cursor, this.line.length);
        this.line = beg + c + end;
      } else {
        this.line += c;
      }
      this.cursor += c.length;
      this[kWriteToOutput](c);
      return;
    }
    if (this.cursor < this.line.length) {
      const beg = this.line.slice(0, this.cursor);
      const end = this.line.slice(this.cursor, this.line.length);
      this[kSetLine](beg + c + end);
      this.cursor += c.length;
      this[kRefreshLine]();
    } else {
      const oldPos = this.getCursorPos();
      this.line += c;
      this.cursor += c.length;
      const newPos = this.getCursorPos();

      if (oldPos.rows < newPos.rows) {
        this[kRefreshLine]();
      } else {
        this[kWriteToOutput](c);
      }
    }
  }

  async [kTabComplete](lastKeypressWasTab) {
    this.pause();
    const string = this.line.slice(0, this.cursor);
    let value;
    try {
      value = await this.completer(string);
    } catch (err) {
      this[kWriteToOutput](`Tab completion error: ${inspect(err)}`);
      return;
    } finally {
      this.resume();
    }
    this[kTabCompleter](lastKeypressWasTab, value);
  }

  [kTabCompleter](lastKeypressWasTab, { 0: completions, 1: completeOn }) {
    // Result and the text that was completed.

    if (!completions || completions.length === 0) {
      return;
    }

    // If there is a common prefix to all matches, then apply that portion.
    const prefix = commonPrefix(
      completions.filter((e) => e !== ''),
    );
    if (prefix.startsWith(completeOn) &&
        prefix.length > completeOn.length) {
      this[kInsertString](prefix.slice(completeOn.length));
      return;
    } else if (!completeOn.startsWith(prefix)) {
      this[kSetLine](this.line.slice(0, this.cursor - completeOn.length) +
                  prefix +
                  this.line.slice(this.cursor, this.line.length));
      this.cursor = this.cursor - completeOn.length + prefix.length;
      this[kRefreshLine]();
      return;
    }

    if (!lastKeypressWasTab) {
      return;
    }

    this[kBeforeEdit](this.line, this.cursor);

    // Apply/show completions.
    const completionsWidth = completions.map((e) =>
      getStringWidth(e));
    const width = Math.max(...completionsWidth) + 2; // 2 space padding
    let maxColumns = Math.floor(this.columns / width) || 1;
    if (maxColumns === Infinity) {
      maxColumns = 1;
    }
    let output = '\r\n';
    let lineIndex = 0;
    let whitespace = 0;
    for (let i = 0; i < completions.length; i++) {
      const completion = completions[i];
      if (completion === '' || lineIndex === maxColumns) {
        output += '\r\n';
        lineIndex = 0;
        whitespace = 0;
      } else {
        output += (' ').repeat(whitespace);
      }
      if (completion !== '') {
        output += completion;
        whitespace = width - completionsWidth[i];
        lineIndex++;
      } else {
        output += '\r\n';
      }
    }
    if (lineIndex !== 0) {
      output += '\r\n\r\n';
    }
    this[kWriteToOutput](output);
    this[kRefreshLine]();
  }

  [kWordLeft]() {
    if (this.cursor > 0) {
      // Reverse the string and match a word near beginning
      // to avoid quadratic time complexity
      const leading = this.line.slice(0, this.cursor);
      const reversed = ((Array.from(leading)).reverse()).join('');
      const match = (/^\s*(?:[^\w\s]+|\w+)?/).exec(reversed);
      this[kMoveCursor](-match[0].length);
    }
  }

  [kWordRight]() {
    if (this.cursor < this.line.length) {
      const trailing = this.line.slice(this.cursor);
      const match = (/^(?:\s+|[^\w\s]+|\w+)\s*/).exec(trailing);
      this[kMoveCursor](match[0].length);
    }
  }

  [kDeleteLeft]() {
    if (this.cursor > 0 && this.line.length > 0) {
      this[kBeforeEdit](this.line, this.cursor);
      // The number of UTF-16 units comprising the character to the left
      const charSize = charLengthLeft(this.line, this.cursor);
      this.line =
        this.line.slice(0, this.cursor - charSize) +
        this.line.slice(this.cursor, this.line.length);

      this.cursor -= charSize;
      this[kRefreshLine]();
    }
  }

  [kDeleteRight]() {
    if (this.cursor < this.line.length) {
      this[kBeforeEdit](this.line, this.cursor);
      // The number of UTF-16 units comprising the character to the left
      const charSize = charLengthAt(this.line, this.cursor);
      this.line =
        this.line.slice(0, this.cursor) +
        this.line.slice(this.cursor + charSize, this.line.length);
      this[kRefreshLine]();
    }
  }

  [kDeleteWordLeft]() {
    if (this.cursor > 0) {
      this[kBeforeEdit](this.line, this.cursor);
      // Reverse the string and match a word near beginning
      // to avoid quadratic time complexity
      let leading = this.line.slice(0, this.cursor);
      const reversed = ((Array.from(leading)).reverse()).join('');
      const match = (/^\s*(?:[^\w\s]+|\w+)?/).exec(reversed);
      leading = leading.slice(0, leading.length - match[0].length);
      this.line =
        leading +
        this.line.slice(this.cursor, this.line.length);
      this.cursor = leading.length;
      this[kRefreshLine]();
    }
  }

  [kDeleteWordRight]() {
    if (this.cursor < this.line.length) {
      this[kBeforeEdit](this.line, this.cursor);
      const trailing = this.line.slice(this.cursor);
      const match = (/^(?:\s+|\W+|\w+)\s*/).exec(trailing);
      this.line =
        this.line.slice(0, this.cursor) +
        trailing.slice(match[0].length);
      this[kRefreshLine]();
    }
  }

  [kDeleteLineLeft]() {
    this[kBeforeEdit](this.line, this.cursor);
    const del = this.line.slice(0, this.cursor);
    this[kSetLine](this.line.slice(this.cursor));
    this.cursor = 0;
    this[kPushToKillRing](del);
    this[kRefreshLine]();
  }

  [kDeleteLineRight]() {
    this[kBeforeEdit](this.line, this.cursor);
    const del = this.line.slice(this.cursor);
    this[kSetLine](this.line.slice(0, this.cursor));
    this[kPushToKillRing](del);
    this[kRefreshLine]();
  }

  [kPushToKillRing](del) {
    if (!del || del === this[kKillRing][0]) return;
    this[kKillRing].unshift(del);
    this[kKillRingCursor] = 0;
    while (this[kKillRing].length > kMaxLengthOfKillRing)
      this[kKillRing].pop();
  }

  [kYank]() {
    if (this[kKillRing].length > 0) {
      this[kYanking] = true;
      this[kInsertString](this[kKillRing][this[kKillRingCursor]]);
    }
  }

  [kYankPop]() {
    if (!this[kYanking]) {
      return;
    }
    if (this[kKillRing].length > 1) {
      const lastYank = this[kKillRing][this[kKillRingCursor]];
      this[kKillRingCursor]++;
      if (this[kKillRingCursor] >= this[kKillRing].length) {
        this[kKillRingCursor] = 0;
      }
      const currentYank = this[kKillRing][this[kKillRingCursor]];
      const head =
            this.line.slice(0, this.cursor - lastYank.length);
      const tail =
            this.line.slice(this.cursor);
      this[kSetLine](head + currentYank + tail);
      this.cursor = head.length + currentYank.length;
      this[kRefreshLine]();
    }
  }

  [kLine]() {
    this[kSavePreviousState]();
    const line = this[kAddHistory]();
    this[kUndoStack] = [];
    this[kRedoStack] = [];
    this.clearLine();
    this[kOnLine](line);
  }


  // TODO(puskin94): edit [kTtyWrite] to make call this function on a new key combination
  //                 to make it add a new line in the middle of a "complete" multiline.
  //                 I tried with shift + enter but it is not detected. Find a new one.
  //                 Make sure to call this[kSavePreviousState](); && this.clearLine();
  //                 before calling this[kAddNewLineOnTTY] to simulate what [kLine] is doing.

  // When this function is called, the actual cursor is at the very end of the whole string,
  // No matter where the new line was entered.
  // This function should only be used when the output is a TTY
  [kAddNewLineOnTTY]() {
    // Restore terminal state and store current line
    this[kRestorePreviousState]();
    const originalLine = this.line;

    // Split the line at the current cursor position
    const beforeCursor = this.line.slice(0, this.cursor);
    let afterCursor = this.line.slice(this.cursor, this.line.length);

    // Add the new line where the cursor is at
    this[kSetLine](`${beforeCursor}\n${afterCursor}`);

    // To account for the new line
    this.cursor += 1;

    const hasContentAfterCursor = afterCursor.length > 0;
    const cursorIsNotOnFirstLine = this.prevRows > 0;
    let needsRewriteFirstLine = false;

    // Handle cursor positioning based on different scenarios
    if (hasContentAfterCursor) {
      const splitBeg = beforeCursor.split('\n');
      // Determine if we need to rewrite the first line
      needsRewriteFirstLine = splitBeg.length < 2;

      // If the cursor is not on the first line
      if (cursorIsNotOnFirstLine) {
        const splitEnd = afterCursor.split('\n');

        // If the cursor when I pressed enter was at least on the second line
        // I need to completely erase the line where the cursor was pressed because it is possible
        // That it was pressed in the middle of the line, hence I need to write the whole line.
        // To achieve that, I need to reach the line above the current line coming from the end
        const dy = splitEnd.length + 1;

        // Calculate how many Xs we need to move on the right to get to the end of the line
        const dxEndOfLineAbove = (splitBeg[splitBeg.length - 2] || '').length + kMultilinePrompt.description.length;
        moveCursor(this.output, dxEndOfLineAbove, -dy);

        // This is the line that was split in the middle
        // Just add it to the rest of the line that will be printed later
        afterCursor = `${splitBeg[splitBeg.length - 1]}\n${afterCursor}`;
      } else {
        // Otherwise, go to the very beginning of the first line and erase everything
        const dy = originalLine.split('\n').length;
        moveCursor(this.output, 0, -dy);
      }

      // Erase from the cursor to the end of the line
      clearScreenDown(this.output);

      if (cursorIsNotOnFirstLine) {
        this[kWriteToOutput]('\n');
      }
    }

    if (needsRewriteFirstLine) {
      this[kWriteToOutput](`${this[kPrompt]}${beforeCursor}\n${kMultilinePrompt.description}`);
    } else {
      this[kWriteToOutput](kMultilinePrompt.description);
    }

    // Write the rest and restore the cursor to where the user left it
    if (hasContentAfterCursor) {
      // Save the cursor pos, we need to come back here
      const oldCursor = this.getCursorPos();

      // Write everything after the cursor which has been deleted by clearScreenDown
      const formattedEndContent = afterCursor.replaceAll('\n', `\n${kMultilinePrompt.description}`);

      this[kWriteToOutput](formattedEndContent);

      const newCursor = this[kGetDisplayPos](this.line);

      // Go back to where the cursor was, with relative movement
      moveCursor(this.output, oldCursor.cols - newCursor.cols, oldCursor.rows - newCursor.rows);

      // Setting how many rows we have on top of the cursor
      // Necessary for kRefreshLine
      this.prevRows = oldCursor.rows;
    } else {
      // Setting how many rows we have on top of the cursor
      // Necessary for kRefreshLine
      this.prevRows = this.line.split('\n').length - 1;
    }
  }

  [kUndo]() {
    if (this[kUndoStack].length <= 0) return;

    this[kRedoStack].push({ text: this.line, cursor: this.cursor });

    const entry = this[kUndoStack].pop();
    this[kSetLine](entry.text);
    this.cursor = entry.cursor;

    this[kRefreshLine]();
  }

  [kRedo]() {
    if (this[kRedoStack].length <= 0) return;

    this[kUndoStack].push({ text: this.line, cursor: this.cursor });

    const entry = this[kRedoStack].pop();
    this[kSetLine](entry.text);
    this.cursor = entry.cursor;

    this[kRefreshLine]();
  }

  [kMultilineMove](direction, splitLines, { rows, cols }) {
    const curr = splitLines[rows];
    const down = direction === 1;
    const adj = splitLines[rows + direction];
    const promptLen = kMultilinePrompt.description.length;
    let amountToMove;
    // Clamp distance to end of current + prompt + next/prev line + newline
    const clamp = down ?
      curr.length - cols + promptLen + adj.length + 1 :
      -cols + 1;
    const shouldClamp = cols > adj.length + 1;

    if (shouldClamp) {
      if (this[kPreviousCursorCols] === -1) {
        this[kPreviousCursorCols] = cols;
      }
      amountToMove = clamp;
    } else {
      if (down) {
        amountToMove = curr.length + 1;
      } else {
        amountToMove = -adj.length - 1;
      }
      if (this[kPreviousCursorCols] !== -1) {
        if (this[kPreviousCursorCols] <= adj.length) {
          amountToMove += this[kPreviousCursorCols] - cols;
          this[kPreviousCursorCols] = -1;
        } else {
          amountToMove = clamp;
        }
      }
    }

    this[kMoveCursor](amountToMove);
  }

  [kMoveDownOrHistoryNext]() {
    const cursorPos = this.getCursorPos();
    const splitLines = this.line.split('\n');
    if (this[kIsMultiline] && cursorPos.rows < splitLines.length - 1) {
      this[kMultilineMove](1, splitLines, cursorPos);
      return;
    }
    this[kPreviousCursorCols] = -1;
    this[kHistoryNext]();
  }

  // TODO(BridgeAR): Add underscores to the search part and a red background in
  // case no match is found. This should only be the visual part and not the
  // actual line content!
  // TODO(BridgeAR): In case the substring based search is active and the end is
  // reached, show a comment how to search the history as before. E.g., using
  // <ctrl> + N. Only show this after two/three UPs or DOWNs, not on the first
  // one.
  [kHistoryNext]() {
    if (!this.historyManager.canNavigateToNext()) { return; }

    this[kBeforeEdit](this.line, this.cursor);
    this[kSetLine](this.historyManager.navigateToNext(this[kSubstringSearch]));
    this.cursor = this.line.length; // Set cursor to end of line.
    this[kRefreshLine]();
  }

  [kMoveUpOrHistoryPrev]() {
    const cursorPos = this.getCursorPos();
    if (this[kIsMultiline] && cursorPos.rows > 0) {
      const splitLines = this.line.split('\n');
      this[kMultilineMove](-1, splitLines, cursorPos);
      return;
    }
    this[kPreviousCursorCols] = -1;
    this[kHistoryPrev]();
  }

  [kHistoryPrev]() {
    if (!this.historyManager.canNavigateToPrevious()) { return; }

    this[kBeforeEdit](this.line, this.cursor);
    this[kSetLine](this.historyManager.navigateToPrevious(this[kSubstringSearch]));
    this.cursor = this.line.length; // Set cursor to end of line.
    this[kRefreshLine]();
  }

  // Returns the last character's display position of the given string
  [kTtyWrite](s, key) {
    const previousKey = this[kPreviousKey];
    key ||= kEmptyObject;
    this[kPreviousKey] = key;
    let shouldResetPreviousCursorCols = true;

    if (!key.meta || key.name !== 'y') {
      // Reset yanking state unless we are doing yank pop.
      this[kYanking] = false;
    }

    // Activate or deactivate substring search.
    if (
      (key.name === 'up' || key.name === 'down') &&
      !key.ctrl &&
      !key.meta &&
      !key.shift
    ) {
      if (this[kSubstringSearch] === null && !this[kIsMultiline]) {
        this[kSubstringSearch] = this.line.slice(0, this.cursor);
      }
    } else if (this[kSubstringSearch] !== null) {
      this[kSubstringSearch] = null;
      // Reset the index in case there's no match.
      if (this.history.length === this.historyIndex) {
        this.historyIndex = -1;
      }
    }

    // Undo & Redo
    if (typeof key.sequence === 'string') {
      switch (key.sequence.codePointAt(0)) {
        case 0x1f:
          this[kUndo]();
          return;
        case 0x1e:
          this[kRedo]();
          return;
        default:
          break;
      }
    }

    // Ignore escape key, fixes
    // https://github.com/nodejs/node-v0.x-archive/issues/2876.
    if (key.name === 'escape') return;

    if (key.ctrl && key.shift) {
      /* Control and shift pressed */
      switch (key.name) {
        // TODO(BridgeAR): The transmitted escape sequence is `\b` and that is
        // identical to <ctrl>-h. It should have a unique escape sequence.
        case 'backspace':
          this[kDeleteLineLeft]();
          break;

        case 'delete':
          this[kDeleteLineRight]();
          break;
      }
    } else if (key.ctrl) {
      /* Control key pressed */

      switch (key.name) {
        case 'c':
          if (this.listenerCount('SIGINT') > 0) {
            this.emit('SIGINT');
          } else {
            // This readline instance is finished
            this.close();
            this[kQuestionReject]?.(abortError('Aborted with Ctrl+C'));
          }
          break;

        case 'h': // delete left
          this[kDeleteLeft]();
          break;

        case 'd': // delete right or EOF
          if (this.cursor === 0 && this.line.length === 0) {
            // This readline instance is finished
            this.close();
            this[kQuestionReject]?.(abortError('Aborted with Ctrl+D'));
          } else if (this.cursor < this.line.length) {
            this[kDeleteRight]();
          }
          break;

        case 'u': // Delete from current to start of line
          this[kDeleteLineLeft]();
          break;

        case 'k': // Delete from current to end of line
          this[kDeleteLineRight]();
          break;

        case 'a': // Go to the start of the line
          this[kMoveCursor](-Infinity);
          break;

        case 'e': // Go to the end of the line
          this[kMoveCursor](+Infinity);
          break;

        case 'b': // back one character
          this[kMoveCursor](-charLengthLeft(this.line, this.cursor));
          break;

        case 'f': // Forward one character
          this[kMoveCursor](+charLengthAt(this.line, this.cursor));
          break;

        case 'l': // Clear the whole screen
          cursorTo(this.output, 0, 0);
          clearScreenDown(this.output);
          this[kRefreshLine]();
          break;

        case 'n': // next history item
          this[kHistoryNext]();
          break;

        case 'p': // Previous history item
          this[kHistoryPrev]();
          break;

        case 'y': // Yank killed string
          this[kYank]();
          break;

        case 'z':
          if (process.platform === 'win32') break;
          if (this.listenerCount('SIGTSTP') > 0) {
            this.emit('SIGTSTP');
          } else {
            process.once('SIGCONT', () => {
              // Don't raise events if stream has already been abandoned.
              if (!this.paused) {
                // Stream must be paused and resumed after SIGCONT to catch
                // SIGINT, SIGTSTP, and EOF.
                this.pause();
                this.emit('SIGCONT');
              }
              // Explicitly re-enable "raw mode" and move the cursor to
              // the correct position.
              // See https://github.com/joyent/node/issues/3295.
              this[kSetRawMode](true);
              this[kRefreshLine]();
            });
            this[kSetRawMode](false);
            process.kill(process.pid, 'SIGTSTP');
          }
          break;

        case 'w': // Delete backwards to a word boundary
        // TODO(BridgeAR): The transmitted escape sequence is `\b` and that is
        // identical to <ctrl>-h. It should have a unique escape sequence.
        // Falls through
        case 'backspace':
          this[kDeleteWordLeft]();
          break;

        case 'delete': // Delete forward to a word boundary
          this[kDeleteWordRight]();
          break;

        case 'left':
          this[kWordLeft]();
          break;

        case 'right':
          this[kWordRight]();
          break;
      }
    } else if (key.meta) {
      /* Meta key pressed */

      switch (key.name) {
        case 'b': // backward word
          this[kWordLeft]();
          break;

        case 'f': // forward word
          this[kWordRight]();
          break;

        case 'd': // delete forward word
        case 'delete':
          this[kDeleteWordRight]();
          break;

        case 'backspace': // Delete backwards to a word boundary
          this[kDeleteWordLeft]();
          break;

        case 'y': // Doing yank pop
          this[kYankPop]();
          break;
      }
    } else {
      /* No modifier keys used */

      // \r bookkeeping is only relevant if a \n comes right after.
      if (this[kSawReturnAt] && key.name !== 'enter') this[kSawReturnAt] = 0;

      switch (key.name) {
        case 'return': // Carriage return, i.e. \r
          this[kSawReturnAt] = Date.now();
          this[kLine]();
          break;

        case 'enter':
          // When key interval > crlfDelay
          if (
            this[kSawReturnAt] === 0 ||
            Date.now() - this[kSawReturnAt] > this.crlfDelay
          ) {
            this[kLine]();
          }
          this[kSawReturnAt] = 0;
          break;

        case 'backspace':
          this[kDeleteLeft]();
          break;

        case 'delete':
          this[kDeleteRight]();
          break;

        case 'left':
          // Obtain the code point to the left
          this[kMoveCursor](-charLengthLeft(this.line, this.cursor));
          break;

        case 'right':
          this[kMoveCursor](+charLengthAt(this.line, this.cursor));
          break;

        case 'home':
          this[kMoveCursor](-Infinity);
          break;

        case 'end':
          this[kMoveCursor](+Infinity);
          break;

        case 'up':
          shouldResetPreviousCursorCols = false;
          this[kMoveUpOrHistoryPrev]();
          break;

        case 'down':
          shouldResetPreviousCursorCols = false;
          this[kMoveDownOrHistoryNext]();
          break;

        case 'tab':
          // If tab completion enabled, do that...
          if (
            typeof this.completer === 'function' &&
            this.isCompletionEnabled
          ) {
            const lastKeypressWasTab =
              previousKey && previousKey.name === 'tab';
            this[kTabComplete](lastKeypressWasTab);
            break;
          }
        // falls through
        default:
          if (typeof s === 'string' && s) {
            // Erase state of previous searches.
            lineEnding.lastIndex = 0;
            let nextMatch;
            // Keep track of the end of the last match.
            let lastIndex = 0;
            while ((nextMatch = lineEnding.exec(s)) !== null) {
              this[kInsertString](s.slice(lastIndex, nextMatch.index));
              ({ lastIndex } = lineEnding);
              this[kLine]();
              // Restore lastIndex as the call to kLine could have mutated it.
              lineEnding.lastIndex = lastIndex;
            }
            // This ensures that the last line is written if it doesn't end in a newline.
            // Note that the last line may be the first line, in which case this still works.
            this[kInsertString](s.slice(lastIndex));
          }
      }
    }
    if (shouldResetPreviousCursorCols) {
      this[kPreviousCursorCols] = -1;
    }
  }

}

for (const key of Reflect.ownKeys(Editor.prototype)) {
  if (key !== "constructor") Object.defineProperty(Interface.prototype, key, Object.getOwnPropertyDescriptor(Editor.prototype, key));
}

/* node:readline's Interface: the old names of the editing methods (Node's lib/readline.js) */
const legacy = LegacyInterface.prototype;
legacy._insertString = Interface.prototype[kInsertString];
legacy._tabComplete = function (lastKeypressWasTab) {
  this.pause();
  const string = this.line.slice(0, this.cursor);
  this.completer(string, (err, value) => {
    this.resume();
    if (err) {
      this._writeToOutput(`Tab completion error: ${inspect(err)}`);
      return;
    }
    this[kTabCompleter](lastKeypressWasTab, value);
  });
};
legacy._wordLeft = Interface.prototype[kWordLeft];
legacy._wordRight = Interface.prototype[kWordRight];
legacy._deleteLeft = Interface.prototype[kDeleteLeft];
legacy._deleteRight = Interface.prototype[kDeleteRight];
legacy._deleteWordLeft = Interface.prototype[kDeleteWordLeft];
legacy._deleteWordRight = Interface.prototype[kDeleteWordRight];
legacy._deleteLineLeft = Interface.prototype[kDeleteLineLeft];
legacy._deleteLineRight = Interface.prototype[kDeleteLineRight];
legacy._line = Interface.prototype[kLine];
legacy._historyNext = Interface.prototype[kHistoryNext];
legacy._historyPrev = Interface.prototype[kHistoryPrev];
legacy._ttyWrite = Interface.prototype[kTtyWrite];

features.readlineEditor = true;
features.emitKeypressEvents = emitKeypressEvents;
