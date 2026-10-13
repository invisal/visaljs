// node:test's reporters: Node's tap and spec reporters (lib/internal/
// test_runner/reporter/tap.js, spec.js, utils.js; MIT; Node v22.22.2), ported from streams to
// objects that turn each test event into text. tap is the default when stdout isn't a terminal,
// spec when it is, as in Node. Errors carry no stack frames and tests no location: a compiled
// program knows neither (Node prints the test's file:line:column and V8's frames).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { utilInspect as inspect } from "visaljs:host";
import { isError } from "../comparisons.js";

/** Node's inspectWithNoCustomRetry: util.inspect, again without custom inspectors if one throws. */
export function inspectWithNoCustomRetry(obj, options) {
  try {
    return inspect(obj, options);
  } catch {
    return inspect(obj, { ...options, customInspect: false });
  }
}

/* Node's internal/util/colors: ANSI colors when stderr is a color terminal */
export function colorsFor(stream) {
  const env = process.env;
  let on;
  if (env.FORCE_COLOR !== undefined) on = env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  else on = Boolean(stream?.isTTY) && env.NO_COLOR === undefined && env.NODE_DISABLE_COLORS === undefined && env.TERM !== "dumb";
  const c = (code) => (on ? `\u001b[${code}m` : "");
  return { blue: c(34), green: c(32), white: c(39), yellow: c(33), red: c(31), gray: c(90), reset: c(0), hasColors: on };
}

// ---- tap (lib/internal/test_runner/reporter/tap.js) -------------------------------------------

const kDefaultIndent = "    "; // 4 spaces
const kFrameStartRegExp = /^ {4}at /;
const kLineBreakRegExp = /\n|\r\n/;
const kDefaultTAPVersion = 13;
const tapInspectOptions = { __proto__: null, colors: false, breakLength: Infinity };
const kUnwrapErrors = new Set(["testCodeFailure", "hookFailed", "uncaughtException", "unhandledRejection"]);

export class TapReporter {
  start() {
    return `TAP version ${kDefaultTAPVersion}\n`;
  }

  handle({ type, data }) {
    switch (type) {
      case "test:fail": {
        const location = data.file ? `${data.file}:${data.line}:${data.column}` : null;
        return reportTest(data.nesting, data.testNumber, "not ok", data.name, data.skip, data.todo) + reportDetails(data.nesting, data.details, location);
      }
      case "test:pass":
        return reportTest(data.nesting, data.testNumber, "ok", data.name, data.skip, data.todo) + reportDetails(data.nesting, data.details, null);
      case "test:plan":
        return `${indent(data.nesting)}1..${data.count}\n`;
      case "test:start":
        return `${indent(data.nesting)}# Subtest: ${tapEscape(data.name)}\n`;
      case "test:stderr":
      case "test:stdout": {
        const lines = data.message.split(kLineBreakRegExp);
        let out = "";
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].length === 0) continue;
          out += `# ${tapEscape(lines[i])}\n`;
        }
        return out;
      }
      case "test:diagnostic":
        return `${indent(data.nesting)}# ${tapEscape(data.message)}\n`;
    }
    return "";
  }

  flush() {
    return "";
  }
}

function reportTest(nesting, testNumber, status, name, skip, todo) {
  let line = `${indent(nesting)}${status} ${testNumber}`;

  if (name) {
    line += ` ${tapEscape(`- ${name}`)}`;
  }

  if (skip !== undefined) {
    line += ` # SKIP${typeof skip === "string" && skip.length ? ` ${tapEscape(skip)}` : ""}`;
  } else if (todo !== undefined) {
    line += ` # TODO${typeof todo === "string" && todo.length ? ` ${tapEscape(todo)}` : ""}`;
  }

  line += "\n";

  return line;
}

function reportDetails(nesting, data = {}, location) {
  const { error, duration_ms } = data;
  const _indent = indent(nesting);
  let details = `${_indent}  ---\n`;

  details += jsToYaml(_indent, "duration_ms", duration_ms);
  details += jsToYaml(_indent, "type", data.type);

  if (location) {
    details += jsToYaml(_indent, "location", location);
  }

  details += jsToYaml(_indent, null, error, new Set());
  details += `${_indent}  ...\n`;
  return details;
}

const memo = new Map();
function indent(nesting) {
  let value = memo.get(nesting);
  if (value === undefined) {
    value = kDefaultIndent.repeat(nesting);
    memo.set(nesting, value);
  }

  return value;
}

// In certain places, # and \ need to be escaped as \# and \\.
function tapEscape(input) {
  let result = input.replaceAll("\b", "\\b");
  result = result.replaceAll("\f", "\\f");
  result = result.replaceAll("\t", "\\t");
  result = result.replaceAll("\n", "\\n");
  result = result.replaceAll("\r", "\\r");
  result = result.replaceAll("\v", "\\v");
  result = result.replaceAll("\\", "\\\\");
  result = result.replaceAll("#", "\\#");
  return result;
}

function jsToYaml(indent, name, value, seen) {
  if (value === undefined) {
    return "";
  }

  const prefix = `${indent}  ${name}:`;

  if (value === null) {
    return `${prefix} ~\n`;
  }

  if (typeof value !== "object") {
    if (typeof value !== "string") {
      return `${prefix} ${inspectWithNoCustomRetry(value, tapInspectOptions)}\n`;
    }

    const lines = value.split(kLineBreakRegExp);

    if (lines.length === 1) {
      return `${prefix} ${inspectWithNoCustomRetry(value, tapInspectOptions)}\n`;
    }

    let str = `${prefix} |-\n`;

    for (let i = 0; i < lines.length; i++) {
      str += `${indent}    ${lines[i]}\n`;
    }

    return str;
  }

  seen.add(value);
  const entries = Object.entries(value);
  const isErrorObj = isError(value);
  let propsIndent = indent;
  let result = "";

  if (name != null) {
    result += prefix;
    if (value instanceof Date) {
      // YAML uses the ISO-8601 standard to express dates.
      result += " " + value.toISOString();
    }
    result += "\n";
    propsIndent += "  ";
  }

  for (let i = 0; i < entries.length; i++) {
    const { 0: key, 1: value } = entries[i];

    if (isErrorObj && (key === "cause" || key === "code")) {
      continue;
    }
    if (seen.has(value)) {
      result += `${propsIndent}  ${key}: <Circular>\n`;
      continue;
    }

    result += jsToYaml(propsIndent, key, value, seen);
  }

  if (isErrorObj) {
    const { cause, code, failureType, message, expected, actual, operator, stack, name } = value;
    let errMsg = message ?? "<unknown error>";
    let errName = name;
    let errStack = stack;
    let errCode = code;
    let errExpected = expected;
    let errActual = actual;
    let errOperator = operator;
    let errIsAssertion = isAssertionLike(value);

    // If the ERR_TEST_FAILURE came from an error provided by user code,
    // then try to unwrap the original error message and stack.
    if (code === "ERR_TEST_FAILURE" && kUnwrapErrors.has(failureType)) {
      errStack = cause?.stack ?? errStack;
      errCode = cause?.code ?? errCode;
      errName = cause?.name ?? errName;
      errMsg = cause?.message ?? errMsg;

      if (isAssertionLike(cause)) {
        errExpected = cause.expected;
        errActual = cause.actual;
        errOperator = cause.operator ?? errOperator;
        errIsAssertion = true;
      }
    }

    result += jsToYaml(indent, "error", errMsg, seen);

    if (errCode) {
      result += jsToYaml(indent, "code", errCode, seen);
    }
    if (errName && errName !== "Error") {
      result += jsToYaml(indent, "name", errName, seen);
    }

    if (errIsAssertion) {
      // Note that we're deliberately creating shallow copies of the `seen`
      // set here in order to isolate the discovery of circular references
      // within the expected and actual properties respectively.
      result += jsToYaml(indent, "expected", errExpected, new Set(seen));
      result += jsToYaml(indent, "actual", errActual, new Set(seen));
      if (errOperator) {
        result += jsToYaml(indent, "operator", errOperator, seen);
      }
    }

    if (typeof errStack === "string") {
      const frames = [];

      for (const frame of errStack.split(kLineBreakRegExp)) {
        const processed = frame.replace(kFrameStartRegExp, "");

        if (processed.length > 0 && processed.length !== frame.length) {
          frames.push(processed);
        }
      }

      if (frames.length > 0) {
        const frameDelimiter = `\n${indent}    `;

        result += `${indent}  stack: |-${frameDelimiter}`;
        result += `${frames.join(frameDelimiter)}\n`;
      }
    }
  }

  return result;
}

function isAssertionLike(value) {
  return value && typeof value === "object" && "expected" in value && "actual" in value;
}

// ---- spec (lib/internal/test_runner/reporter/spec.js, utils.js) -------------------------------

const reporterUnicodeSymbolMap = {
  "__proto__": null,
  "test:fail": "✖ ",
  "test:pass": "✔ ",
  "test:diagnostic": "ℹ ",
  "test:coverage": "ℹ ",
  "arrow:right": "▶ ",
  "hyphen:minus": "﹣ ",
};

function specIndent(nesting) {
  return "  ".repeat(nesting);
}

export class SpecReporter {
  #stack = [];
  #reported = [];
  #failedTests = [];
  #colors = colorsFor(process.stderr);
  #inspectOptions = { __proto__: null, colors: colorsFor(process.stdout).hasColors, breakLength: Infinity };

  start() {
    return "";
  }

  #colorMap(type) {
    const c = this.#colors;
    return { "test:fail": c.red, "test:pass": c.green, "test:diagnostic": c.blue, info: c.blue, warn: c.yellow, error: c.red }[type];
  }

  #formatError(error, indent) {
    if (!error) return "";
    const err = error.code === "ERR_TEST_FAILURE" ? error.cause : error;
    const message = inspectWithNoCustomRetry(err, this.#inspectOptions).split(/\r?\n/).join(`\n${indent}  `);
    return `\n${indent}  ${message}\n`;
  }

  #formatTestReport(type, data, prefix = "", indent = "", hasChildren = false, showErrorDetails = true) {
    const colors = this.#colors;
    let color = this.#colorMap(type) ?? colors.white;
    let symbol = reporterUnicodeSymbolMap[type] ?? " ";
    const { skip, todo } = data;
    const duration_ms = data.details?.duration_ms ? ` ${colors.gray}(${data.details.duration_ms}ms)${colors.white}` : "";
    let title = `${data.name}${duration_ms}`;

    if (skip !== undefined) {
      title += ` # ${typeof skip === "string" && skip.length ? skip : "SKIP"}`;
    } else if (todo !== undefined) {
      title += ` # ${typeof todo === "string" && todo.length ? todo : "TODO"}`;
    }

    const error = showErrorDetails ? this.#formatError(data.details?.error, indent) : "";
    const err = hasChildren ? (!error || data.details?.error?.failureType === "subtestsFailed" ? "" : `\n${error}`) : error;

    if (skip !== undefined) {
      color = colors.gray;
      symbol = reporterUnicodeSymbolMap["hyphen:minus"];
    }
    return `${prefix}${indent}${color}${symbol}${title}${colors.white}${err}`;
  }

  #formatFailedTestResults() {
    if (this.#failedTests.length === 0) {
      return "";
    }

    const results = [`\n${this.#colorMap("test:fail")}${reporterUnicodeSymbolMap["test:fail"]}failing tests:${this.#colors.white}\n`];

    for (let i = 0; i < this.#failedTests.length; i++) {
      results.push(this.#formatTestReport("test:fail", this.#failedTests[i]));
    }

    this.#failedTests = []; // Clean up the failed tests
    return results.join("\n");
  }

  #handleTestReportEvent(type, data) {
    this.#stack.shift(); // This is the matching `test:start` event
    let prefix = "";
    while (this.#stack.length) {
      // Report all the parent `test:start` events
      const parent = this.#stack.pop();
      const msg = parent.data;
      this.#reported.unshift(msg);
      prefix += `${specIndent(msg.nesting)}${reporterUnicodeSymbolMap["arrow:right"]}${msg.name}\n`;
    }
    let hasChildren = false;
    if (this.#reported[0] && this.#reported[0].nesting === data.nesting && this.#reported[0].name === data.name) {
      this.#reported.shift();
      hasChildren = true;
    }
    const indentation = specIndent(data.nesting);
    return `${this.#formatTestReport(type, data, prefix, indentation, hasChildren, false)}\n`;
  }

  handle({ type, data }) {
    switch (type) {
      case "test:fail":
        if (data.details?.error?.failureType !== "subtestsFailed") {
          this.#failedTests.push(data);
        }
        return this.#handleTestReportEvent(type, data);
      case "test:pass":
        return this.#handleTestReportEvent(type, data);
      case "test:start":
        this.#stack.unshift({ __proto__: null, data, type });
        break;
      case "test:stderr":
      case "test:stdout":
        return data.message;
      case "test:diagnostic": {
        const diagnosticColor = this.#colorMap(data.level) || this.#colorMap("test:diagnostic");
        return `${diagnosticColor}${specIndent(data.nesting)}${reporterUnicodeSymbolMap[type]}${data.message}${this.#colors.white}\n`;
      }
      case "test:summary":
        // We report only the root test summary
        if (data.file === undefined) {
          return this.#formatFailedTestResults();
        }
    }
    return "";
  }

  flush() {
    return this.#formatFailedTestResults();
  }

  /** A failed test as the dot reporter lists it (utils.js' formatTestReport). */
  formatTestReport(type, data) {
    return this.#formatTestReport(type, data);
  }
}
