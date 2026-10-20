// node:console: the global console (the runtime's, in C), and Console, a console writing to the
// streams it's given, as Node's: log, info, debug and dirxml to stdout; warn, error and trace to
// stderr; groups indent every line; count, time and table as Node formats them. Its formatting is
// util.format's and util.inspect's, which the global console's is too.
import { inspect, format, formatWithOptions, stripVTControlCharacters } from "./util.js";
import { codeError, invalidArgType } from "./internal/errors.js";

const kIsConsole = Symbol("kIsConsole");
const kSecond = 1000;
const kMinute = 60 * kSecond;
const kHour = 60 * kMinute;

/* ---- console.table: Node's internal/cli_table ------------------------------------------------- */

const isFullWidthCodePoint = (code) => code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
  (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) || (code >= 0x3250 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0xa4c6) ||
  (code >= 0xa960 && code <= 0xa97c) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6b) || (code >= 0xff01 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1b000 && code <= 0x1b001) || (code >= 0x1f200 && code <= 0x1f251) ||
  (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x20000 && code <= 0x3fffd));

const isZeroWidthCodePoint = (code) => code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x300 && code <= 0x36f) ||
  (code >= 0x200b && code <= 0x200f) || (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe00 && code <= 0xfe0f) ||
  (code >= 0xfe20 && code <= 0xfe2f) || (code >= 0xe0100 && code <= 0xe01ef);

/* columns on a terminal: wide characters two, combining ones none */
function getStringWidth(str) {
  let width = 0;
  for (const char of stripVTControlCharacters(str).normalize("NFC")) {
    const code = char.codePointAt(0);
    if (isFullWidthCodePoint(code)) width += 2;
    else if (!isZeroWidthCodePoint(code)) width++;
  }
  return width;
}

const tableChars = {
  middleMiddle: "─", rowMiddle: "┼", topRight: "┐", topLeft: "┌", leftMiddle: "├", topMiddle: "┬", bottomRight: "┘",
  bottomLeft: "└", bottomMiddle: "┴", rightMiddle: "┤", left: "│ ", right: " │", middle: " │ ",
};

function renderRow(row, columnWidths) {
  let out = tableChars.left;
  for (let i = 0; i < row.length; i++) {
    const cell = row[i];
    out += cell + " ".repeat(columnWidths[i] - getStringWidth(cell));  /* left-aligned, as Node 22's */
    if (i !== row.length - 1) out += tableChars.middle;
  }
  return out + tableChars.right;
}

function renderTable(head, columns) {
  const rows = [];
  const columnWidths = head.map((h) => getStringWidth(h));
  const longestColumn = Math.max(...columns.map((a) => a.length));
  for (let i = 0; i < head.length; i++) {
    const column = columns[i];
    for (let j = 0; j < longestColumn; j++) {
      if (rows[j] === undefined) rows[j] = [];
      const value = (rows[j][i] = Object.hasOwn(column, j) ? column[j] : "");
      columnWidths[i] = Math.max(columnWidths[i] || 0, getStringWidth(value));
    }
  }
  const divider = columnWidths.map((w) => tableChars.middleMiddle.repeat(w + 2));
  let result = tableChars.topLeft + divider.join(tableChars.topMiddle) + tableChars.topRight + "\n" +
    renderRow(head, columnWidths) + "\n" + tableChars.leftMiddle + divider.join(tableChars.rowMiddle) + tableChars.rightMiddle + "\n";
  for (const row of rows) result += `${renderRow(row, columnWidths)}\n`;
  return result + tableChars.bottomLeft + divider.join(tableChars.bottomMiddle) + tableChars.bottomRight;
}

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

/* ---- Console ---------------------------------------------------------------------------------- */

/** Console(stdout[, stderr[, ignoreErrors]]) or Console({ stdout, stderr, ignoreErrors,
 *  colorMode, inspectOptions, groupIndentation }). Callable without new, as Node's; its methods
 *  are bound, so they can be passed around. */
export function Console(options, stderr, ignoreErrors) {
  if (!new.target) return Reflect.construct(Console, [options, stderr, ignoreErrors]);
  if (!options || typeof options.write === "function") options = { stdout: options, stderr, ignoreErrors };
  const { stdout, ignoreErrors: ignore = true, colorMode = "auto", inspectOptions, groupIndentation = 2 } = options;
  const err = options.stderr || stdout;
  if (!stdout || typeof stdout.write !== "function") throw codeError(TypeError, "ERR_CONSOLE_WRITABLE_STREAM", "Console expects a writable stream instance for stdout");
  if (!err || typeof err.write !== "function") throw codeError(TypeError, "ERR_CONSOLE_WRITABLE_STREAM", "Console expects a writable stream instance for stderr");
  if (typeof colorMode !== "boolean" && colorMode !== "auto") {
    throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'colorMode' is invalid. Received ${inspect(colorMode)}`);
  }
  if (typeof groupIndentation !== "number" || !Number.isInteger(groupIndentation) || groupIndentation < 0 || groupIndentation > 1000) {
    throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "groupIndentation" is out of range. It must be >= 0 && <= 1000. Received ${groupIndentation}`);
  }
  if (inspectOptions !== undefined && (inspectOptions === null || typeof inspectOptions !== "object")) {
    throw invalidArgType("options.inspectOptions", "of type object", inspectOptions);
  }
  if (inspectOptions?.colors !== undefined && colorMode !== "auto") {
    throw codeError(TypeError, "ERR_INCOMPATIBLE_OPTION_PAIR", 'Option "options.inspectOptions.color" cannot be used in combination with option "colorMode"');
  }
  Object.defineProperties(this, {
    _stdout: { value: stdout, writable: true, configurable: true },
    _stderr: { value: err, writable: true, configurable: true },
    _ignoreErrors: { value: Boolean(ignore), writable: true, configurable: true },
  });
  this[kIsConsole] = true;
  this._colorMode = colorMode;
  this._inspectOptions = inspectOptions;
  this._groupIndent = "";
  this._groupIndentation = groupIndentation;
  this._counts = new Map();
  this._times = new Map();
  /* bound, as Node's: const { log } = console works */
  for (const key of Object.keys(Console.prototype)) {
    this[key] = Console.prototype[key].bind(this);
    Object.defineProperty(this[key], "name", { value: key });
  }
}

Object.defineProperty(Console, Symbol.hasInstance, {
  value: (instance) => instance === globalThis.console || Boolean(instance?.[kIsConsole]),
});

const proto = Console.prototype;

/* a line to a stream: indented by the groups, write errors ignored unless asked not to */
proto._write = function (useStderr, string) {
  const stream = useStderr ? this._stderr : this._stdout;
  if (this._groupIndent.length !== 0) {
    if (string.includes("\n")) string = string.replaceAll("\n", `\n${this._groupIndent}`);
    string = this._groupIndent + string;
  }
  string += "\n";
  if (!this._ignoreErrors) return stream.write(string);
  try {
    if (typeof stream.listenerCount === "function" && stream.listenerCount("error") === 0) stream.once("error", () => {});
    stream.write(string, () => {});
  } catch {
    /* the console doesn't throw for its stream */
  }
};
Object.defineProperty(proto, "_write", { enumerable: false });

/* Node's FORCE_COLOR levels (tty's getColorDepth): '', 1, true, 2 and 3 give colors */
const FORCE_COLORS = new Set(["", "1", "true", "2", "3"]);

/* Node's shouldColorize */
function shouldColorize(stream) {
  if (process.env.FORCE_COLOR !== undefined) return FORCE_COLORS.has(process.env.FORCE_COLOR);
  return Boolean(stream?.isTTY) && (typeof stream.getColorDepth === "function" ? stream.getColorDepth() > 2 : true);
}

/* util.format's arguments as Node's console formats them for a stream: colored as colorMode says */
proto._format = function (args, useStderr = false) {
  const colors = this._colorMode === "auto" ? shouldColorize(useStderr ? this._stderr : this._stdout) : this._colorMode;
  if (this._inspectOptions) return formatWithOptions({ ...this._inspectOptions, colors: this._inspectOptions.colors ?? colors }, ...args);
  return colors ? formatWithOptions({ colors: true }, ...args) : format(...args);
};
Object.defineProperty(proto, "_format", { enumerable: false });

Object.assign(proto, {
  log(...args) {
    this._write(false, this._format(args));
  },
  warn(...args) {
    this._write(true, this._format(args, true));
  },
  dir(object, options) {
    this._write(false, inspect(object, { customInspect: false, ...this._inspectOptions, ...options }));
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
    if (this._timeLog(label, "console.timeEnd()", [])) this._times.delete(label);
  },
  timeLog(label = "default", ...data) {
    this._timeLog(`${label}`, "console.timeLog()", data);
  },
  trace(...args) {
    this._write(true, `Trace${args.length ? ": " + this._format(args, true) : ""}`);
  },
  assert(expression, ...args) {
    if (!expression) {
      if (typeof args[0] === "string") args[0] = `Assertion failed: ${args[0]}`;
      else args.unshift("Assertion failed");
      this.warn(...args);
    }
  },
  /* only on a terminal: the cursor home, and the screen below it cleared */
  clear() {
    if (this._stdout.isTTY && process.env.TERM !== "dumb") this._stdout.write("\x1b[1;1H\x1b[0J");
  },
  count(label = "default") {
    label = `${label}`;
    const count = (this._counts.get(label) ?? 0) + 1;
    this._counts.set(label, count);
    this.log(`${label}: ${count}`);
  },
  countReset(label = "default") {
    label = `${label}`;
    if (!this._counts.has(label)) {
      process.emitWarning(`Count for '${label}' does not exist`);
      return;
    }
    this._counts.delete(label);
  },
  group(...data) {
    if (data.length > 0) this.log(...data);
    this._groupIndent += " ".repeat(this._groupIndentation);
  },
  groupEnd() {
    this._groupIndent = this._groupIndent.slice(0, this._groupIndent.length - this._groupIndentation);
  },
  table(tabularData, properties) {
    if (properties !== undefined && !Array.isArray(properties)) throw invalidArgType("properties", "an instance of Array", properties);
    if (tabularData === null || typeof tabularData !== "object") return this.log(tabularData);
    const final = (k, v) => this.log(renderTable(k, v));
    const _inspect = (v) => {
      const depth = v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 2 ? -1 : 0;
      return inspect(v, { depth, maxArrayLength: 3, breakLength: Infinity, ...this._inspectOptions });
    };
    const getIndexArray = (length) => Array.from({ length }, (_, i) => _inspect(i));
    if (tabularData instanceof Map) {
      const keys = [];
      const values = [];
      for (const [k, v] of tabularData) {
        keys.push(_inspect(k));
        values.push(_inspect(v));
      }
      return final(["(iteration index)", "Key", "Values"], [getIndexArray(keys.length), keys, values]);
    }
    if (tabularData instanceof Set || (typeof tabularData.next === "function" && typeof tabularData[Symbol.iterator] === "function")) {
      const values = [];
      for (const v of tabularData) values.push(_inspect(v));
      return final(["(iteration index)", "Values"], [getIndexArray(values.length), values]);
    }
    const map = Object.create(null);
    let hasPrimitives = false;
    const valuesKeyArray = [];
    const indexKeyArray = Object.keys(tabularData);
    for (let i = 0; i < indexKeyArray.length; i++) {
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
      keys.push("Values");
      values.push(valuesKeyArray);
    }
    keys.unshift("(index)");
    values.unshift(indexKeyArray);
    return final(keys, values);
  },
  /* V8 inspector APIs: nothing to report to here */
  profile() {},
  profileEnd() {},
  timeStamp() {},
  context() {
    return this;
  },
  createTask() {
    return { run: (f) => f() };
  },
});
proto.debug = proto.log;
proto.info = proto.log;
proto.dirxml = proto.log;
proto.error = proto.warn;
proto.groupCollapsed = proto.group;

proto._timeLog = function (label, name, data) {
  const start = this._times.get(label);
  if (start === undefined) {
    process.emitWarning(`No such label '${label}' for ${name}`);
    return false;
  }
  const ms = now() - start;
  this.log("%s: %s", label, formatTime(ms), ...data);
  return true;
};
Object.defineProperty(proto, "_timeLog", { enumerable: false });

/* ---- the module: the global console, with Console, and the V8 extras it lacks ------------------ */

const console = globalThis.console;
for (const key of ["profile", "profileEnd", "timeStamp", "context", "createTask"]) {
  if (typeof console[key] !== "function") Object.defineProperty(console, key, { value: proto[key], writable: true, configurable: true });
}
if (console.Console === undefined) Object.defineProperty(console, "Console", { value: Console, writable: true, configurable: true });

export const {
  log, warn, dir, time, timeEnd, timeLog, trace, assert, clear, count, countReset, group, groupEnd, table, debug, info, dirxml, error,
  groupCollapsed, profile, profileEnd, timeStamp, context, createTask,
} = console;

export default console;
