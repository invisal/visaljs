// node:console (Node's lib/internal/console/constructor.js and internal/cli_table.js): Console, a
// console writing to the streams it's given. The global console is the runtime's (in C), writing
// to the fds; a program that replaces a stdio stream's write gets Node's instead
// (internal/console_global.js, over this module's Console).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { previewEntries } from "visaljs:host";
import { channel } from "./diagnostics_channel.js";
import { codeError, invalidArgType, invalidArgValue, outOfRange } from "./internal/errors.js";
import { getStringWidth } from "./internal/string_width.js";
import { formatWithOptions, inspect } from "./util.js";
import { isMap, isMapIterator, isSet, isSetIterator, isTypedArray } from "./util_types.js";

const kSecond = 1000;
const kMinute = 60 * kSecond;
const kHour = 60 * kMinute;

const onLog = channel("console.log");
const onWarn = channel("console.warn");
const onError = channel("console.error");
const onInfo = channel("console.info");
const onDebug = channel("console.debug");

const kMaxGroupIndentation = 1000;
const kCounts = Symbol("counts");
const kGroupIndentationWidth = Symbol("kGroupIndentWidth");
const kFormatForStderr = Symbol("kFormatForStderr");
const kFormatForStdout = Symbol("kFormatForStdout");
const kGetInspectOptions = Symbol("kGetInspectOptions");
const kColorMode = Symbol("kColorMode");
const kIsConsole = Symbol("kIsConsole");
const kWriteToConsole = Symbol("kWriteToConsole");
export const kBindProperties = Symbol("kBindProperties");
const kBindStreamsEager = Symbol("kBindStreamsEager");
export const kBindStreamsLazy = Symbol("kBindStreamsLazy");
const kUseStdout = Symbol("kUseStdout");
const kUseStderr = Symbol("kUseStderr");
const kGroupIndentationString = Symbol("kGroupIndentationString");

const optionsMap = new WeakMap();

/* ---- console.table (Node's internal/cli_table.js) ------------------------------------------- */

const tableChars = {
  middleMiddle: "─", rowMiddle: "┼", topRight: "┐", topLeft: "┌", leftMiddle: "├", topMiddle: "┬", bottomRight: "┘",
  bottomLeft: "└", bottomMiddle: "┴", rightMiddle: "┤", left: "│ ", right: " │", middle: " │ ",
};

function renderRow(row, columnWidths) {
  let out = tableChars.left;
  for (let i = 0; i < row.length; i++) {
    const cell = row[i];
    const needed = columnWidths[i] - getStringWidth(cell);
    out += cell + " ".repeat(Math.ceil(needed));
    if (i !== row.length - 1) out += tableChars.middle;
  }
  return out + tableChars.right;
}

function cliTable(head, columns) {
  const rows = [];
  const columnWidths = head.map((h) => getStringWidth(h));
  const longestColumn = Math.max(...columns.map((a) => a.length));
  for (let i = 0; i < head.length; i++) {
    const column = columns[i];
    for (let j = 0; j < longestColumn; j++) {
      if (rows[j] === undefined) rows[j] = [];
      const value = rows[j][i] = Object.hasOwn(column, j) ? column[j] : "";
      columnWidths[i] = Math.max(columnWidths[i] || 0, getStringWidth(value));
    }
  }
  const divider = columnWidths.map((i) => tableChars.middleMiddle.repeat(i + 2));
  let result = tableChars.topLeft + divider.join(tableChars.topMiddle) + tableChars.topRight + "\n" + renderRow(head, columnWidths) + "\n" +
    tableChars.leftMiddle + divider.join(tableChars.rowMiddle) + tableChars.rightMiddle + "\n";
  for (const row of rows) result += `${renderRow(row, columnWidths)}\n`;
  return result + tableChars.bottomLeft + divider.join(tableChars.bottomMiddle) + tableChars.bottomRight;
}

/* ---- console.time (Node's internal/util/debuglog.js) --------------------------------------- */

/* "1.234ms", "1.500s", "1:02.345 (m:ss.mmm)", "1:02:03.456 (h:mm:ss.mmm)" */
function formatTime(ms) {
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (ms >= kSecond) {
    if (ms >= kMinute) {
      if (ms >= kHour) {
        hours = Math.floor(ms / kHour);
        ms %= kHour;
      }
      minutes = Math.floor(ms / kMinute);
      ms %= kMinute;
    }
    seconds = ms / kSecond;
  }
  const pad = (n) => String(n).padStart(2, "0");
  if (hours !== 0 || minutes !== 0) {
    [seconds, ms] = seconds.toFixed(3).split(".");
    const res = hours !== 0 ? `${hours}:${pad(minutes)}` : minutes;
    return `${res}:${pad(seconds)}.${ms} (${hours !== 0 ? "h:m" : ""}m:ss.mmm)`;
  }
  if (seconds !== 0) return `${seconds.toFixed(3)}s`;
  return `${Number(ms.toFixed(3))}ms`;
}

const now = () => {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
};

function timeLogImpl(console, label, implementation, data) {
  const start = console._times.get(label);
  if (start === undefined) {
    process.emitWarning(`No such label '${label}' for ${implementation}`);
    return false;
  }
  console.log("%s: %s", label, formatTime(now() - start), ...(data ?? []));
  return true;
}

/* ---- colors (Node's internal/util/colors.js shouldColorize) --------------------------------- */

/* Node's FORCE_COLOR levels (tty's getColorDepth): '', 1, true, 2 and 3 give colors */
const FORCE_COLORS = new Set(["", "1", "true", "2", "3"]);

function shouldColorize(stream) {
  if (process.env.FORCE_COLOR !== undefined) return FORCE_COLORS.has(process.env.FORCE_COLOR);
  return Boolean(stream?.isTTY) && (typeof stream.getColorDepth === "function" ? stream.getColorDepth() > 2 : true);
}

/* ---- Console ---------------------------------------------------------------------------------- */

/** Console(stdout[, stderr[, ignoreErrors]]) or Console({ stdout, stderr, ignoreErrors, colorMode,
 *  inspectOptions, groupIndentation }); callable without new; its methods bound, so they can be
 *  passed around */
export function Console(options /* or: stdout, stderr, ignoreErrors = true */) {
  if (new.target === undefined) return Reflect.construct(Console, arguments);
  if (!options || typeof options.write === "function") options = { stdout: options, stderr: arguments[1], ignoreErrors: arguments[2] };
  const { stdout, stderr = stdout, ignoreErrors = true, colorMode = "auto", inspectOptions, groupIndentation } = options;
  if (!stdout || typeof stdout.write !== "function") {
    throw codeError(TypeError, "ERR_CONSOLE_WRITABLE_STREAM", "Console expects a writable stream instance for stdout");
  }
  if (!stderr || typeof stderr.write !== "function") {
    throw codeError(TypeError, "ERR_CONSOLE_WRITABLE_STREAM", "Console expects a writable stream instance for stderr");
  }
  if (colorMode !== "auto" && colorMode !== true && colorMode !== false) {
    throw invalidArgValue("colorMode", "must be one of: 'auto', true, false", colorMode);
  }
  if (groupIndentation !== undefined) {
    if (typeof groupIndentation !== "number") throw invalidArgType("groupIndentation", "of type number", groupIndentation);
    if (!Number.isInteger(groupIndentation)) throw outOfRange("groupIndentation", "an integer", groupIndentation);
    if (groupIndentation < 0 || groupIndentation > kMaxGroupIndentation) {
      throw outOfRange("groupIndentation", `>= 0 && <= ${kMaxGroupIndentation}`, groupIndentation);
    }
  }
  if (inspectOptions !== undefined) {
    if (inspectOptions === null || typeof inspectOptions !== "object" || Array.isArray(inspectOptions)) {
      throw invalidArgType("options.inspectOptions", "of type object", inspectOptions);
    }
    /* one set of options for both streams, or a Map from a stream to its own */
    const inspectOptionsMap = isMap(inspectOptions) ? inspectOptions : new Map([[stdout, inspectOptions], [stderr, inspectOptions]]);
    for (const streamOptions of inspectOptionsMap.values()) {
      if (streamOptions.colors !== undefined && options.colorMode !== undefined) {
        throw codeError(TypeError, "ERR_INCOMPATIBLE_OPTION_PAIR", 'Option "options.inspectOptions.color" cannot be used in combination with option "colorMode"');
      }
    }
    optionsMap.set(this, inspectOptionsMap);
  }
  /* bound, as Node's: const { log } = console works; a subclass's methods are the ones bound */
  for (const key of Object.keys(Console.prototype)) {
    this[key] = this[key].bind(this);
    Object.defineProperty(this[key], "name", { value: key });
  }
  this[kBindStreamsEager](stdout, stderr);
  this[kBindProperties](ignoreErrors, colorMode, groupIndentation);
}

const consolePropAttributes = { writable: true, enumerable: false, configurable: true };

Object.defineProperty(Console, Symbol.hasInstance, {
  value: function (instance) {
    return instance?.[kIsConsole] === true || instance === globalThis.console;
  },
});

const kColorInspectOptions = { colors: true };
const kNoColorInspectOptions = {};

function noop() {}

function createWriteErrorHandler(instance, streamSymbol) {
  return (err) => {
    /* the stream's 'error' listener that write() adds: kept until the error is emitted */
    const stream = streamSymbol === kUseStdout ? instance._stdout : instance._stderr;
    if (err !== null && !stream._writableState?.errorEmitted) {
      if (stream.listenerCount?.("error") === 0) stream.once("error", noop);
    }
  };
}

const isStackOverflowError = (e) => e instanceof RangeError && e.message === "Maximum call stack size exceeded";

Object.defineProperties(Console.prototype, {
  [kBindStreamsEager]: {
    ...consolePropAttributes,
    value: function (stdout, stderr) {
      Object.defineProperties(this, {
        _stdout: { ...consolePropAttributes, value: stdout },
        _stderr: { ...consolePropAttributes, value: stderr },
      });
    },
  },
  /* the global console's: process.stdout and process.stderr, looked up when first written */
  [kBindStreamsLazy]: {
    ...consolePropAttributes,
    value: function (object) {
      let stdout;
      let stderr;
      Object.defineProperties(this, {
        _stdout: {
          enumerable: false,
          configurable: true,
          get() { return stdout ||= object.stdout; },
          set(value) { stdout = value; },
        },
        _stderr: {
          enumerable: false,
          configurable: true,
          get() { return stderr ||= object.stderr; },
          set(value) { stderr = value; },
        },
      });
    },
  },
  [kBindProperties]: {
    ...consolePropAttributes,
    value: function (ignoreErrors, colorMode, groupIndentation = 2) {
      Object.defineProperties(this, {
        _stdoutErrorHandler: { ...consolePropAttributes, value: createWriteErrorHandler(this, kUseStdout) },
        _stderrErrorHandler: { ...consolePropAttributes, value: createWriteErrorHandler(this, kUseStderr) },
        _ignoreErrors: { ...consolePropAttributes, value: Boolean(ignoreErrors) },
        _times: { ...consolePropAttributes, value: new Map() },
        [kCounts]: { ...consolePropAttributes, value: new Map() },
        [kColorMode]: { ...consolePropAttributes, value: colorMode },
        [kIsConsole]: { ...consolePropAttributes, value: true },
        [kGroupIndentationWidth]: { ...consolePropAttributes, value: groupIndentation },
        [kGroupIndentationString]: { ...consolePropAttributes, value: "" },
        [Symbol.toStringTag]: { writable: false, enumerable: false, configurable: true, value: "console" },
      });
    },
  },
  [kWriteToConsole]: {
    ...consolePropAttributes,
    value: function (streamSymbol, string) {
      const ignoreErrors = this._ignoreErrors;
      const groupIndent = this[kGroupIndentationString];
      const useStdout = streamSymbol === kUseStdout;
      const stream = useStdout ? this._stdout : this._stderr;
      const errorHandler = useStdout ? this._stdoutErrorHandler : this._stderrErrorHandler;
      if (groupIndent.length !== 0) {
        if (string.includes("\n")) string = string.replace(/\n/g, `\n${groupIndent}`);
        string = groupIndent + string;
      }
      string += "\n";
      if (ignoreErrors === false) return stream.write(string);
      /* errors ignored, but for a stack overflow (Node's), which the program should see */
      try {
        if (stream.listenerCount?.("error") === 0) stream.once("error", noop);
        stream.write(string, errorHandler);
      } catch (e) {
        if (isStackOverflowError(e)) throw e;
      } finally {
        stream.removeListener?.("error", noop);
      }
    },
  },
  [kGetInspectOptions]: {
    ...consolePropAttributes,
    value: function (stream) {
      let color = this[kColorMode];
      if (color === "auto") color = shouldColorize(stream);
      const options = optionsMap.get(this)?.get(stream);
      if (options) {
        if (options.colors === undefined) options.colors = color;
        return options;
      }
      return color ? kColorInspectOptions : kNoColorInspectOptions;
    },
  },
  [kFormatForStdout]: {
    ...consolePropAttributes,
    value: function (args) {
      if (args.length === 1 && typeof args[0] === "string") return args[0];
      return formatWithOptions(this[kGetInspectOptions](this._stdout), ...args);
    },
  },
  [kFormatForStderr]: {
    ...consolePropAttributes,
    value: function (args) {
      if (args.length === 1 && typeof args[0] === "string") return args[0];
      return formatWithOptions(this[kGetInspectOptions](this._stderr), ...args);
    },
  },
});

const keyKey = "Key";
const valuesKey = "Values";
const indexKey = "(index)";
const iterKey = "(iteration index)";

const isArray = (v) => Array.isArray(v) || isTypedArray(v) || Buffer.isBuffer(v);

const consoleMethods = {
  log(...args) {
    if (onLog.hasSubscribers) onLog.publish(args);
    this[kWriteToConsole](kUseStdout, this[kFormatForStdout](args));
  },
  info(...args) {
    if (onInfo.hasSubscribers) onInfo.publish(args);
    this[kWriteToConsole](kUseStdout, this[kFormatForStdout](args));
  },
  debug(...args) {
    if (onDebug.hasSubscribers) onDebug.publish(args);
    this[kWriteToConsole](kUseStdout, this[kFormatForStdout](args));
  },
  warn(...args) {
    if (onWarn.hasSubscribers) onWarn.publish(args);
    this[kWriteToConsole](kUseStderr, this[kFormatForStderr](args));
  },
  error(...args) {
    if (onError.hasSubscribers) onError.publish(args);
    this[kWriteToConsole](kUseStderr, this[kFormatForStderr](args));
  },
  dir(object, options) {
    this[kWriteToConsole](kUseStdout, inspect(object, { customInspect: false, ...this[kGetInspectOptions](this._stdout), ...options }));
  },
  time(label = "default") {
    label = `${label}`;
    if (this._times.has(label)) {
      process.emitWarning(`Label '${label}' already exists for console.time()`);
      return;
    }
    this._times.set(label, now());
  },
  timeEnd(label = "default") {
    label = `${label}`;
    if (timeLogImpl(this, label, "console.timeEnd()")) this._times.delete(label);
  },
  timeLog(label = "default", ...data) {
    timeLogImpl(this, `${label}`, "console.timeLog()", data);
  },
  /* compiled code has no stack frames: the trace is its message */
  trace(...args) {
    this.error(`Trace${args.length ? `: ${this[kFormatForStderr](args)}` : ""}`);
  },
  assert(expression, ...args) {
    if (!expression) {
      if (args.length && typeof args[0] === "string") args[0] = `Assertion failed: ${args[0]}`;
      else args.unshift("Assertion failed");
      Reflect.apply(this.warn, this, args);
    }
  },
  /* only on a terminal: the cursor home, and the screen below it cleared */
  clear() {
    if (this._stdout.isTTY && process.env.TERM !== "dumb") this._stdout.write("\x1b[1;1H\x1b[0J");
  },
  count(label = "default") {
    label = `${label}`;
    const counts = this[kCounts];
    const count = (counts.get(label) ?? 0) + 1;
    counts.set(label, count);
    this.log(`${label}: ${count}`);
  },
  countReset(label = "default") {
    const counts = this[kCounts];
    if (!counts.has(label)) {
      process.emitWarning(`Count for '${label}' does not exist`);
      return;
    }
    counts.delete(`${label}`);
  },
  group(...data) {
    if (data.length > 0) Reflect.apply(this.log, this, data);
    this[kGroupIndentationString] += " ".repeat(this[kGroupIndentationWidth]);
  },
  groupEnd() {
    const currentIndentation = this[kGroupIndentationString];
    this[kGroupIndentationString] = currentIndentation.slice(0, currentIndentation.length - this[kGroupIndentationWidth]);
  },
  table(tabularData, properties) {
    if (properties !== undefined && !Array.isArray(properties)) throw invalidArgType("properties", "an instance of Array", properties);
    if (tabularData === null || typeof tabularData !== "object") return this.log(tabularData);
    const final = (k, v) => this.log(cliTable(k, v));
    const _inspect = (v) => {
      const depth = v !== null && typeof v === "object" && !isArray(v) && Object.keys(v).length > 2 ? -1 : 0;
      return inspect(v, { depth, maxArrayLength: 3, breakLength: Infinity, ...this[kGetInspectOptions](this._stdout) });
    };
    const getIndexArray = (length) => Array.from({ length }, (_, i) => _inspect(i));
    const mapIter = isMapIterator(tabularData);
    let isKeyValue = false;
    let i = 0;
    if (mapIter) {
      [tabularData, isKeyValue] = previewEntries(tabularData, true);
    }
    if (isKeyValue || isMap(tabularData)) {
      const keys = [];
      const values = [];
      let length = 0;
      if (mapIter) {
        for (; i < tabularData.length / 2; ++i) {
          keys.push(_inspect(tabularData[i * 2]));
          values.push(_inspect(tabularData[i * 2 + 1]));
          length++;
        }
      } else {
        for (const { 0: k, 1: v } of tabularData) {
          keys.push(_inspect(k));
          values.push(_inspect(v));
          length++;
        }
      }
      return final([iterKey, keyKey, valuesKey], [getIndexArray(length), keys, values]);
    }
    const setIter = isSetIterator(tabularData);
    if (setIter) tabularData = previewEntries(tabularData);
    if (setIter || mapIter || isSet(tabularData)) {
      const values = [];
      let length = 0;
      for (const v of tabularData) {
        values.push(_inspect(v));
        length++;
      }
      return final([iterKey, valuesKey], [getIndexArray(length), values]);
    }
    const map = { __proto__: null };
    let hasPrimitives = false;
    const valuesKeyArray = [];
    const indexKeyArray = Object.keys(tabularData);
    for (; i < indexKeyArray.length; i++) {
      const item = tabularData[indexKeyArray[i]];
      const primitive = item === null || (typeof item !== "function" && typeof item !== "object");
      if (properties === undefined && primitive) {
        hasPrimitives = true;
        valuesKeyArray[i] = _inspect(item);
      } else {
        const keys = properties || Object.keys(item);
        for (const key of keys) {
          map[key] ??= [];
          if ((primitive && properties) || !Object.hasOwn(item, key)) map[key][i] = "";
          else map[key][i] = _inspect(item[key]);
        }
      }
    }
    const keys = Object.keys(map);
    const values = Object.values(map);
    if (hasPrimitives) {
      keys.push(valuesKey);
      values.push(valuesKeyArray);
    }
    keys.unshift(indexKey);
    values.unshift(indexKeyArray);
    return final(keys, values);
  },
};

for (const method of Reflect.ownKeys(consoleMethods)) Console.prototype[method] = consoleMethods[method];
Console.prototype.dirxml = Console.prototype.log;
Console.prototype.groupCollapsed = Console.prototype.group;

/* V8 inspector APIs the global console has: nothing to report to here */
const inspectorMethods = {
  profile() {},
  profileEnd() {},
  timeStamp() {},
  context() {
    return this;
  },
  createTask() {
    return { run: (f) => f() };
  },
};

/* ---- the module: the global console, with Console, and the V8 extras it lacks ------------------ */

const console = globalThis.console;
for (const key of Object.keys(inspectorMethods)) {
  if (typeof console[key] !== "function") Object.defineProperty(console, key, { value: inspectorMethods[key], writable: true, configurable: true });
}
if (console.Console === undefined) Object.defineProperty(console, "Console", { value: Console, writable: true, configurable: true });

export const {
  log, warn, dir, time, timeEnd, timeLog, trace, assert, clear, count, countReset, group, groupEnd, table, debug, info, dirxml, error,
  groupCollapsed, profile, profileEnd, timeStamp, context, createTask,
} = console;

export default console;
