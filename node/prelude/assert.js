// node:assert: Node's lib/assert.js with lib/internal/assert/ (assertion_error,
// myers_diff, utils, calltracker) (MIT; Node v22.22.2), ported: primordials are the methods they
// stand for, Node's errors are built here, and deep equality is internal/comparisons.js. Messages
// match Node's, diffs included, with two differences. Diffs are never colored (Node colors them
// when stderr is a color terminal). And assert.ok(false) without a message says `false == true`:
// Node quotes the call's source text ("The expression evaluated to a falsy value: assert.ok(x)"),
// which it reads from the file at run time, and a compiled program has none.
//
// Node's notice for lib/assert.js:
//
// Originally from narwhal.js (http://narwhaljs.org)
// Copyright (c) 2009 Thomas Robinson <280north.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { utilInspect as inspect } from "visaljs:host";
import { codeError, invalidArgType, invalidArgValue, outOfRange, validateFunction } from "./internal/errors.js";
import { isDeepEqual, isDeepStrictEqual, isError, isPartialStrictEqual } from "./internal/comparisons.js";
import { isPromise, isRegExp } from "./util_types.js";
import { deprecate } from "./util.js";

/* Node's internal/util/colors with no color terminal: every color is "" */
const colors = { blue: "", green: "", white: "", red: "", gray: "", hasColors: false, refresh() {} };

const captureStackTrace = (err, fn) => {
  if (typeof Error.captureStackTrace === "function") Error.captureStackTrace(err, fn);
};

/* ERR_INVALID_ARG_TYPE's "of type function or an instance of Promise", from Node's list of names */
const kTypes = ["string", "function", "number", "object", "Function", "Object", "boolean", "bigint", "symbol"];
function describeTypes(expected) {
  const types = [], instances = [];
  for (const value of expected) {
    if (kTypes.includes(value)) types.push(value.toLowerCase());
    else instances.push(value);
  }
  if (instances.length > 0) {
    const pos = types.indexOf("object");
    if (pos !== -1) {
      types.splice(pos, 1);
      instances.push("Object");
    }
  }
  const list = (items) => items.length > 2 ? `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}` : items.join(" or ");
  let msg = "";
  if (types.length > 0) msg += `${types.length > 1 ? "one of type" : "of type"} ${list(types)}`;
  if (instances.length > 0) msg += `${types.length > 0 ? " or " : ""}an instance of ${list(instances)}`;
  return msg;
}

/* Node's determineSpecificType: how its errors describe a value they got */
function specificType(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "bigint":
      return `type bigint (${value}n)`;
    case "number":
      return `type number (${Object.is(value, -0) ? "-0" : value})`;
    case "boolean":
      return `type boolean (${value})`;
    case "symbol":
      return `type symbol (${String(value)})`;
    case "function":
      return `function ${value.name}`;
    case "object":
      if (value.constructor && "name" in value.constructor) return `an instance of ${value.constructor.name}`;
      return inspect(value, { depth: -1 });
    default:
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      return value.indexOf("'") === -1 ? `type string ('${value}')` : `type string (${JSON.stringify(value)})`;
  }
}

const missingArgs = () => codeError(TypeError, "ERR_MISSING_ARGS", 'The "actual" and "expected" arguments must be specified');

// ---- AssertionError (lib/internal/assert/assertion_error.js) ----------------------------------

const kReadableOperator = {
  deepStrictEqual: "Expected values to be strictly deep-equal:",
  partialDeepStrictEqual: "Expected values to be partially and strictly deep-equal:",
  strictEqual: "Expected values to be strictly equal:",
  strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
  deepEqual: "Expected values to be loosely deep-equal:",
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
  notStrictEqual: 'Expected "actual" to be strictly unequal to:',
  notStrictEqualObject: 'Expected "actual" not to be reference-equal to "expected":',
  notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
  notIdentical: "Values have same structure but are not reference-equal:",
  notDeepEqualUnequal: "Expected values not to be loosely deep-equal:",
};

const kMaxShortStringLength = 12;
const kMaxLongStringLength = 512;

const kMethodsWithCustomMessageDiff = new Set(["deepStrictEqual", "strictEqual", "partialDeepStrictEqual"]);

function copyError(source) {
  const target = Object.assign({ __proto__: Object.getPrototypeOf(source) }, source);
  Object.defineProperty(target, "message", { value: source.message });
  if (Object.prototype.hasOwnProperty.call(source, "cause")) {
    let { cause } = source;

    if (isError(cause)) {
      cause = copyError(cause);
    }

    Object.defineProperty(target, "cause", { value: cause });
  }
  return target;
}

function inspectValue(val) {
  // The util.inspect default values could be changed. This makes sure the
  // error messages contain the necessary information nevertheless.
  return inspect(val, {
    compact: false,
    customInspect: false,
    depth: 1000,
    maxArrayLength: Infinity,
    // Assert compares only enumerable properties (with a few exceptions).
    showHidden: false,
    // Assert does not detect proxies currently.
    showProxy: false,
    sorted: true,
    // Inspect getters as we also check them when comparing entries.
    getters: true,
  });
}

function getErrorMessage(operator, message) {
  return message || kReadableOperator[operator];
}

function checkOperator(actual, expected, operator) {
  // In case both values are objects or functions explicitly mark them as not
  // reference equal for the `strictEqual` operator.
  if (operator === "strictEqual" &&
      ((typeof actual === "object" && actual !== null && typeof expected === "object" && expected !== null) ||
       (typeof actual === "function" && typeof expected === "function"))) {
    operator = "strictEqualObject";
  }

  return operator;
}

// ---- Myers' diff (lib/internal/assert/myers_diff.js) ------------------------------------------

const kNopLinesToCollapse = 5;
const kOperations = { DELETE: -1, NOP: 0, INSERT: 1 };

function areLinesEqual(actual, expected, checkCommaDisparity) {
  if (actual === expected) {
    return true;
  }
  if (checkCommaDisparity) {
    return (actual + ",") === expected || actual === (expected + ",");
  }
  return false;
}

function myersDiff(actual, expected, checkCommaDisparity = false) {
  const actualLength = actual.length;
  const expectedLength = expected.length;
  const max = actualLength + expectedLength;

  if (max > 2 ** 31 - 1) {
    throw outOfRange("myersDiff input size", "< 2^31", max);
  }

  const v = new Int32Array(2 * max + 1);
  const trace = [];

  for (let diffLevel = 0; diffLevel <= max; diffLevel++) {
    trace.push(new Int32Array(v)); // Clone the current state of `v`

    for (let diagonalIndex = -diffLevel; diagonalIndex <= diffLevel; diagonalIndex += 2) {
      const offset = diagonalIndex + max;
      const previousOffset = v[offset - 1];
      const nextOffset = v[offset + 1];
      let x = diagonalIndex === -diffLevel || (diagonalIndex !== diffLevel && previousOffset < nextOffset) ?
        nextOffset :
        previousOffset + 1;
      let y = x - diagonalIndex;

      while (x < actualLength && y < expectedLength && areLinesEqual(actual[x], expected[y], checkCommaDisparity)) {
        x++;
        y++;
      }

      v[offset] = x;

      if (x >= actualLength && y >= expectedLength) {
        return backtrack(trace, actual, expected, checkCommaDisparity);
      }
    }
  }
}

function backtrack(trace, actual, expected, checkCommaDisparity) {
  const actualLength = actual.length;
  const expectedLength = expected.length;
  const max = actualLength + expectedLength;

  let x = actualLength;
  let y = expectedLength;
  const result = [];

  for (let diffLevel = trace.length - 1; diffLevel >= 0; diffLevel--) {
    const v = trace[diffLevel];
    const diagonalIndex = x - y;
    const offset = diagonalIndex + max;

    let prevDiagonalIndex;
    if (diagonalIndex === -diffLevel || (diagonalIndex !== diffLevel && v[offset - 1] < v[offset + 1])) {
      prevDiagonalIndex = diagonalIndex + 1;
    } else {
      prevDiagonalIndex = diagonalIndex - 1;
    }

    const prevX = v[prevDiagonalIndex + max];
    const prevY = prevX - prevDiagonalIndex;

    while (x > prevX && y > prevY) {
      const actualItem = actual[x - 1];
      const value = checkCommaDisparity && !actualItem.endsWith(",") ? expected[y - 1] : actualItem;
      result.push([kOperations.NOP, value]);
      x--;
      y--;
    }

    if (diffLevel > 0) {
      if (x > prevX) {
        result.push([kOperations.INSERT, actual[--x]]);
      } else {
        result.push([kOperations.DELETE, expected[--y]]);
      }
    }
  }

  return result;
}

function printSimpleMyersDiff(diff) {
  let message = "";

  for (let diffIdx = diff.length - 1; diffIdx >= 0; diffIdx--) {
    const { 0: operation, 1: value } = diff[diffIdx];
    let color = colors.white;

    if (operation === kOperations.INSERT) {
      color = colors.green;
    } else if (operation === kOperations.DELETE) {
      color = colors.red;
    }

    message += `${color}${value}${colors.white}`;
  }

  return `\n${message}`;
}

function printMyersDiff(diff, operator) {
  let message = "";
  let skipped = false;
  let nopCount = 0;

  for (let diffIdx = diff.length - 1; diffIdx >= 0; diffIdx--) {
    const { 0: operation, 1: value } = diff[diffIdx];
    const previousOperation = diffIdx < diff.length - 1 ? diff[diffIdx + 1][0] : null;

    // Avoid grouping if only one line would have been grouped otherwise
    if (previousOperation === kOperations.NOP && operation !== previousOperation) {
      if (nopCount === kNopLinesToCollapse + 1) {
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
      } else if (nopCount === kNopLinesToCollapse + 2) {
        message += `${colors.white}  ${diff[diffIdx + 2][1]}\n`;
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
      } else if (nopCount >= kNopLinesToCollapse + 3) {
        message += `${colors.blue}...${colors.white}\n`;
        message += `${colors.white}  ${diff[diffIdx + 1][1]}\n`;
        skipped = true;
      }
      nopCount = 0;
    }

    if (operation === kOperations.INSERT) {
      if (operator === "partialDeepStrictEqual") {
        message += `${colors.gray}${colors.hasColors ? " " : "+"} ${value}${colors.white}\n`;
      } else {
        message += `${colors.green}+${colors.white} ${value}\n`;
      }
    } else if (operation === kOperations.DELETE) {
      message += `${colors.red}-${colors.white} ${value}\n`;
    } else if (operation === kOperations.NOP) {
      if (nopCount < kNopLinesToCollapse) {
        message += `${colors.white}  ${value}\n`;
      }
      nopCount++;
    }
  }

  message = message.trimEnd();

  return { message: `\n${message}`, skipped };
}

function getColoredMyersDiff(actual, expected) {
  const header = `${colors.green}actual${colors.white} ${colors.red}expected${colors.white}`;
  const skipped = false;

  const diff = myersDiff(actual.split(""), expected.split(""));
  let message = printSimpleMyersDiff(diff);

  if (skipped) {
    message += "...";
  }

  return { message, header, skipped };
}

function getStackedDiff(actual, expected) {
  const isStringComparison = typeof actual === "string" && typeof expected === "string";

  let message = `\n${colors.green}+${colors.white} ${actual}\n${colors.red}- ${colors.white}${expected}`;
  const stringsLen = actual.length + expected.length;
  const maxTerminalLength = process.stderr?.isTTY ? process.stderr.columns : 80;
  const showIndicator = isStringComparison && (stringsLen <= maxTerminalLength);

  if (showIndicator) {
    let indicatorIdx = -1;

    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        // Skip the indicator for the first 2 characters because the diff is immediately apparent
        // It is 3 instead of 2 to account for the quotes
        if (i >= 3) {
          indicatorIdx = i;
        }
        break;
      }
    }

    if (indicatorIdx !== -1) {
      message += `\n${" ".repeat(indicatorIdx + 2)}^`;
    }
  }

  return { message };
}

function getSimpleDiff(originalActual, actual, originalExpected, expected) {
  let stringsLen = actual.length + expected.length;
  // Accounting for the quotes wrapping strings
  if (typeof originalActual === "string") {
    stringsLen -= 2;
  }
  if (typeof originalExpected === "string") {
    stringsLen -= 2;
  }
  if (stringsLen <= kMaxShortStringLength && (originalActual !== 0 || originalExpected !== 0)) {
    return { message: `${actual} !== ${expected}`, header: "" };
  }

  const isStringComparison = typeof originalActual === "string" && typeof originalExpected === "string";
  // colored myers diff
  if (isStringComparison && colors.hasColors) {
    return getColoredMyersDiff(actual, expected);
  }

  return getStackedDiff(actual, expected);
}

function isSimpleDiff(actual, inspectedActual, expected, inspectedExpected) {
  if (inspectedActual.length > 1 || inspectedExpected.length > 1) {
    return false;
  }

  return typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null;
}

function createErrDiff(actual, expected, operator, customMessage, diffType = "simple") {
  operator = checkOperator(actual, expected, operator);

  let skipped = false;
  let message;
  const inspectedActual = inspectValue(actual);
  const inspectedExpected = inspectValue(expected);
  const inspectedSplitActual = inspectedActual.split("\n");
  const inspectedSplitExpected = inspectedExpected.split("\n");
  const showSimpleDiff = isSimpleDiff(actual, inspectedSplitActual, expected, inspectedSplitExpected);
  let header = `${colors.green}+ actual${colors.white} ${colors.red}- expected${colors.white}`;

  if (showSimpleDiff) {
    const simpleDiff = getSimpleDiff(actual, inspectedSplitActual[0], expected, inspectedSplitExpected[0]);
    message = simpleDiff.message;
    if (typeof simpleDiff.header !== "undefined") {
      header = simpleDiff.header;
    }
    if (simpleDiff.skipped) {
      skipped = true;
    }
  } else if (inspectedActual === inspectedExpected) {
    // Handles the case where the objects are structurally the same but different references
    operator = "notIdentical";
    if (inspectedSplitActual.length > 50 && diffType !== "full") {
      message = `${inspectedSplitActual.slice(0, 50).join("\n")}\n...}`;
      skipped = true;
    } else {
      message = inspectedSplitActual.join("\n");
    }
    header = "";
  } else {
    const checkCommaDisparity = actual != null && typeof actual === "object";
    const diff = myersDiff(inspectedSplitActual, inspectedSplitExpected, checkCommaDisparity);

    const myersDiffMessage = printMyersDiff(diff, operator);
    message = myersDiffMessage.message;

    if (operator === "partialDeepStrictEqual") {
      header = `${colors.gray}${colors.hasColors ? "" : "+ "}actual${colors.white} ${colors.red}- expected${colors.white}`;
    }

    if (myersDiffMessage.skipped) {
      skipped = true;
    }
  }

  const headerMessage = `${getErrorMessage(operator, customMessage)}\n${header}`;
  const skippedMessage = skipped ? "\n... Skipped lines" : "";

  return `${headerMessage}${skippedMessage}\n${message}\n`;
}

function addEllipsis(string) {
  const lines = string.split("\n", 11);
  if (lines.length > 10) {
    lines.length = 10;
    return `${lines.join("\n")}\n...`;
  } else if (string.length > kMaxLongStringLength) {
    return `${string.slice(kMaxLongStringLength)}...`;
  }
  return string;
}

export class AssertionError extends Error {
  constructor(options) {
    if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
    const {
      message,
      operator,
      stackStartFn,
      details,
      // Compatibility with older versions.
      stackStartFunction,
      diff = "simple",
    } = options;
    let { actual, expected } = options;

    if (message != null) {
      if (kMethodsWithCustomMessageDiff.has(operator)) {
        super(createErrDiff(actual, expected, operator, message, diff));
      } else {
        super(String(message));
      }
    } else {
      // Prevent the error stack from being visible by duplicating the error
      // in a very close way to the original in case both sides are actually
      // instances of Error.
      if (typeof actual === "object" && actual !== null &&
          typeof expected === "object" && expected !== null &&
          "stack" in actual && actual instanceof Error &&
          "stack" in expected && expected instanceof Error) {
        actual = copyError(actual);
        expected = copyError(expected);
      }

      if (kMethodsWithCustomMessageDiff.has(operator)) {
        super(createErrDiff(actual, expected, operator, message, diff));
      } else if (operator === "notDeepStrictEqual" || operator === "notStrictEqual") {
        // In case the objects are equal but the operator requires unequal, show
        // the first object and say A equals B
        let base = kReadableOperator[operator];
        const res = inspectValue(actual).split("\n");

        // In case "actual" is an object or a function, it should not be
        // reference equal.
        if (operator === "notStrictEqual" && ((typeof actual === "object" && actual !== null) || typeof actual === "function")) {
          base = kReadableOperator.notStrictEqualObject;
        }

        // Only remove lines in case it makes sense to collapse those.
        if (res.length > 50 && diff !== "full") {
          res[46] = `${colors.blue}...${colors.white}`;
          while (res.length > 47) {
            res.pop();
          }
        }

        // Only print a single input.
        if (res.length === 1) {
          super(`${base}${res[0].length > 5 ? "\n\n" : " "}${res[0]}`);
        } else {
          super(`${base}\n\n${res.join("\n")}\n`);
        }
      } else {
        let res = inspectValue(actual);
        let other = inspectValue(expected);
        const knownOperator = kReadableOperator[operator];
        if (operator === "notDeepEqual" && res === other) {
          res = `${knownOperator}\n\n${res}`;
          if (res.length > 1024 && diff !== "full") {
            res = `${res.slice(0, 1021)}...`;
          }
          super(res);
        } else {
          if (res.length > kMaxLongStringLength && diff !== "full") {
            res = `${res.slice(0, 509)}...`;
          }
          if (other.length > kMaxLongStringLength && diff !== "full") {
            other = `${other.slice(0, 509)}...`;
          }
          if (operator === "deepEqual") {
            res = `${knownOperator}\n\n${res}\n\nshould loosely deep-equal\n\n`;
          } else {
            const newOp = kReadableOperator[`${operator}Unequal`];
            if (newOp) {
              res = `${newOp}\n\n${res}\n\nshould not loosely deep-equal\n\n`;
            } else {
              other = ` ${operator} ${other}`;
            }
          }
          super(`${res}${other}`);
        }
      }
    }

    this.generatedMessage = !message;
    Object.defineProperty(this, "name", {
      value: "AssertionError [ERR_ASSERTION]",
      enumerable: false,
      writable: true,
      configurable: true,
    });
    this.code = "ERR_ASSERTION";
    if (details) {
      this.actual = undefined;
      this.expected = undefined;
      this.operator = undefined;
      for (let i = 0; i < details.length; i++) {
        this["message " + i] = details[i].message;
        this["actual " + i] = details[i].actual;
        this["expected " + i] = details[i].expected;
        this["operator " + i] = details[i].operator;
        this["stack trace " + i] = details[i].stack;
      }
    } else {
      this.actual = actual;
      this.expected = expected;
      this.operator = operator;
    }
    captureStackTrace(this, stackStartFn || stackStartFunction);
    // Create error message including the error code in the name.
    this.stack; // eslint-disable-line @typescript-eslint/no-unused-expressions
    // Reset the name.
    this.name = "AssertionError";
    this.diff = diff;
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](recurseTimes, ctx) {
    // Long strings should not be fully inspected.
    const tmpActual = this.actual;
    const tmpExpected = this.expected;

    if (typeof this.actual === "string") {
      this.actual = addEllipsis(this.actual);
    }
    if (typeof this.expected === "string") {
      this.expected = addEllipsis(this.expected);
    }

    // This limits the `actual` and `expected` property default inspection to
    // the minimum depth. Otherwise those values would be too verbose compared
    // to the actual error message which contains a combined view of these two
    // input values.
    const result = inspect(this, { ...ctx, customInspect: false, depth: 0 });

    // Reset the properties after inspection.
    this.actual = tmpActual;
    this.expected = tmpExpected;

    return result;
  }
}

// ---- CallTracker (lib/internal/assert/calltracker.js) -----------------------------------------

const noop = () => {};

class CallTrackerContext {
  #expected;
  #calls;
  #name;
  #stackTrace;
  constructor({ expected, stackTrace, name }) {
    this.#calls = [];
    this.#expected = expected;
    this.#stackTrace = stackTrace;
    this.#name = name;
  }

  track(thisArg, args) {
    const argsClone = Object.freeze(args.slice());
    this.#calls.push(Object.freeze({ thisArg, arguments: argsClone }));
  }

  get delta() {
    return this.#calls.length - this.#expected;
  }

  reset() {
    this.#calls = [];
  }
  getCalls() {
    return Object.freeze(this.#calls.slice());
  }

  report() {
    if (this.delta !== 0) {
      const message = `Expected the ${this.#name} function to be ` +
        `executed ${this.#expected} time(s) but was ` +
        `executed ${this.#calls.length} time(s).`;
      return {
        message,
        actual: this.#calls.length,
        expected: this.#expected,
        operator: this.#name,
        stack: this.#stackTrace,
      };
    }
  }
}

class CallTracker {
  #callChecks = new Set();
  #trackedFunctions = new WeakMap();

  #getTrackedFunction(tracked) {
    if (!this.#trackedFunctions.has(tracked)) {
      throw invalidArgValue("tracked", "is not a tracked function", tracked);
    }
    return this.#trackedFunctions.get(tracked);
  }

  reset(tracked) {
    if (tracked === undefined) {
      this.#callChecks.forEach((check) => check.reset());
      return;
    }

    this.#getTrackedFunction(tracked).reset();
  }

  getCalls(tracked) {
    return this.#getTrackedFunction(tracked).getCalls();
  }

  calls(fn, expected = 1) {
    if (process._exiting) throw codeError(Error, "ERR_UNAVAILABLE_DURING_EXIT", "Cannot call function in process exit handler");
    if (typeof fn === "number") {
      expected = fn;
      fn = noop;
    } else if (fn === undefined) {
      fn = noop;
    }

    if (typeof expected !== "number") throw invalidArgType("expected", "of type number", expected);
    if (!Number.isInteger(expected)) throw outOfRange("expected", "an integer", expected);
    if (expected < 1 || expected > 4294967295) throw outOfRange("expected", ">= 1 && <= 4294967295", expected);

    const context = new CallTrackerContext({
      expected,
      stackTrace: new Error(),
      name: fn.name || "calls",
    });
    const tracked = new Proxy(fn, {
      __proto__: null,
      apply(fn, thisArg, argList) {
        context.track(thisArg, argList);
        return Reflect.apply(fn, thisArg, argList);
      },
    });
    this.#callChecks.add(context);
    this.#trackedFunctions.set(tracked, context);
    return tracked;
  }

  report() {
    const errors = [];
    for (const context of this.#callChecks) {
      const message = context.report();
      if (message !== undefined) {
        errors.push(message);
      }
    }
    return errors;
  }

  verify() {
    const errors = this.report();
    if (errors.length === 0) {
      return;
    }
    const message = errors.length === 1 ? errors[0].message : "Functions were not called the expected number of times";
    throw new AssertionError({ message, details: errors });
  }
}

// ---- The assertions (lib/assert.js, lib/internal/assert/utils.js) -----------------------------

const kOptions = Symbol("options");

let warned = false;

const NO_EXCEPTION_SENTINEL = {};

function innerOk(fn, argLen, value, message) {
  if (!value) {
    let generatedMessage = false;

    if (argLen === 0) {
      generatedMessage = true;
      message = "No value argument passed to `assert.ok()`";
    } else if (message == null) {
      /* Node quotes the call's source here, read from the file: a compiled program has none,
         and the message is AssertionError's own (`false == true`) */
      generatedMessage = true;
    } else if (isError(message)) {
      throw message;
    }

    const err = new AssertionError({
      actual: value,
      expected: true,
      message,
      operator: "==",
      stackStartFn: fn,
    });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

/**
 * Assert's options: `diff` ('simple' or 'full': the whole diff in assertion errors), and `strict`
 * (true by default: the non-strict methods are the strict ones).
 */
export function Assert(options) {
  if (!new.target) {
    throw codeError(TypeError, "ERR_CONSTRUCT_CALL_REQUIRED", "Class constructor Assert cannot be invoked without `new`");
  }

  options = Object.assign({ __proto__: null, strict: true }, options);

  const allowedDiffs = ["simple", "full"];
  if (options.diff !== undefined && !allowedDiffs.includes(options.diff)) {
    throw invalidArgValue("options.diff", "must be one of: 'simple', 'full'", options.diff);
  }

  this.AssertionError = AssertionError;
  Object.defineProperty(this, kOptions, { value: options, enumerable: false, configurable: false, writable: false });

  if (options.strict) {
    this.equal = this.strictEqual;
    this.deepEqual = this.deepStrictEqual;
    this.notEqual = this.notStrictEqual;
    this.notDeepEqual = this.notDeepStrictEqual;
  }
}

// All of the following functions must throw an AssertionError
// when a corresponding condition is not met, with a message that
// may be undefined if not provided. All assertion methods provide
// both the actual and expected values to the assertion error for
// display purposes. They read the instance's options with this?.[kOptions]: destructured from an
// Assert instance, they have no `this` and behave as by default.

function innerFail(obj) {
  if (obj.message instanceof Error) throw obj.message;

  throw new AssertionError(obj);
}

Assert.prototype.fail = function fail(actual, expected, message, operator, stackStartFn) {
  const argsLen = arguments.length;

  let internalMessage = false;
  if (actual == null && argsLen <= 1) {
    internalMessage = true;
    message = "Failed";
  } else if (argsLen === 1) {
    message = actual;
    actual = undefined;
  } else {
    if (warned === false) {
      warned = true;
      process.emitWarning(
        "assert.fail() with more than one argument is deprecated. " +
          "Please use assert.strictEqual() instead or only pass a message.",
        "DeprecationWarning",
        "DEP0094",
      );
    }
    if (argsLen === 2) operator = "!=";
  }

  if (message instanceof Error) throw message;

  const errArgs = {
    actual,
    expected,
    operator: operator === undefined ? "fail" : operator,
    stackStartFn: stackStartFn || fail,
    message,
    diff: this?.[kOptions]?.diff,
  };
  const err = new AssertionError(errArgs);
  if (internalMessage) {
    err.generatedMessage = true;
  }
  throw err;
};

/** Pure assertion tests whether a value is truthy, as determined by !!value. */
function ok(...args) {
  innerOk(ok, args.length, ...args);
}

// Duplicated as the other `ok` function is supercharged and exposed as default export.
Assert.prototype.ok = function ok(...args) {
  innerOk(ok, args.length, ...args);
};

/** The equality assertion tests shallow, coercive equality with ==. */
Assert.prototype.equal = function equal(actual, expected, message) {
  if (arguments.length < 2) {
    throw missingArgs();
  }
  if (actual != expected && (!Number.isNaN(actual) || !Number.isNaN(expected))) {
    innerFail({ actual, expected, message, operator: "==", stackStartFn: equal, diff: this?.[kOptions]?.diff });
  }
};

/** The non-equality assertion tests for whether two objects are not equal with !=. */
Assert.prototype.notEqual = function notEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw missingArgs();
  }
  if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
    innerFail({ actual, expected, message, operator: "!=", stackStartFn: notEqual, diff: this?.[kOptions]?.diff });
  }
};

/** The deep equivalence assertion tests a deep equality relation. */
Assert.prototype.deepEqual = function deepEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw missingArgs();
  }
  if (!isDeepEqual(actual, expected)) {
    innerFail({ actual, expected, message, operator: "deepEqual", stackStartFn: deepEqual, diff: this?.[kOptions]?.diff });
  }
};

/** The deep non-equivalence assertion tests for any deep inequality. */
Assert.prototype.notDeepEqual = function notDeepEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw missingArgs();
  }
  if (isDeepEqual(actual, expected)) {
    innerFail({ actual, expected, message, operator: "notDeepEqual", stackStartFn: notDeepEqual, diff: this?.[kOptions]?.diff });
  }
};

/** The deep strict equivalence assertion tests a deep strict equality relation. */
Assert.prototype.deepStrictEqual = function deepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw missingArgs();
  }
  if (!isDeepStrictEqual(actual, expected)) {
    innerFail({ actual, expected, message, operator: "deepStrictEqual", stackStartFn: deepStrictEqual, diff: this?.[kOptions]?.diff });
  }
};

/** The deep strict non-equivalence assertion tests for any deep strict inequality. */
Assert.prototype.notDeepStrictEqual = function notDeepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw missingArgs();
  }
  if (isDeepStrictEqual(actual, expected)) {
    innerFail({ actual, expected, message, operator: "notDeepStrictEqual", stackStartFn: notDeepStrictEqual, diff: this?.[kOptions]?.diff });
  }
};

/** The strict equivalence assertion tests a strict equality relation. */
Assert.prototype.strictEqual = function strictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw missingArgs();
  }
  if (!Object.is(actual, expected)) {
    innerFail({ actual, expected, message, operator: "strictEqual", stackStartFn: strictEqual, diff: this?.[kOptions]?.diff });
  }
};

/** The strict non-equivalence assertion tests for any strict inequality. */
Assert.prototype.notStrictEqual = function notStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw missingArgs();
  }
  if (Object.is(actual, expected)) {
    innerFail({ actual, expected, message, operator: "notStrictEqual", stackStartFn: notStrictEqual, diff: this?.[kOptions]?.diff });
  }
};

/** The strict equivalence assertion test between two objects, `expected` a subset of `actual`. */
Assert.prototype.partialDeepStrictEqual = function partialDeepStrictEqual(actual, expected, message) {
  if (arguments.length < 2) {
    throw missingArgs();
  }
  if (!isPartialStrictEqual(actual, expected)) {
    innerFail({ actual, expected, message, operator: "partialDeepStrictEqual", stackStartFn: partialDeepStrictEqual, diff: this?.[kOptions]?.diff });
  }
};

class Comparison {
  constructor(obj, keys, actual) {
    for (const key of keys) {
      if (key in obj) {
        if (actual !== undefined && typeof actual[key] === "string" && isRegExp(obj[key]) && obj[key].exec(actual[key]) !== null) {
          this[key] = actual[key];
        } else {
          this[key] = obj[key];
        }
      }
    }
  }
}

function compareExceptionKey(actual, expected, key, message, keys, fn) {
  if (!(key in actual) || !isDeepStrictEqual(actual[key], expected[key])) {
    if (!message) {
      // Create placeholder objects to create a nice output.
      const a = new Comparison(actual, keys);
      const b = new Comparison(expected, keys, actual);

      const err = new AssertionError({ actual: a, expected: b, operator: "deepStrictEqual", stackStartFn: fn, diff: this?.[kOptions]?.diff });
      err.actual = actual;
      err.expected = expected;
      err.operator = fn.name;
      throw err;
    }
    innerFail({ actual, expected, message, operator: fn.name, stackStartFn: fn, diff: this?.[kOptions]?.diff });
  }
}

function expectedException(actual, expected, message, fn) {
  let generatedMessage = false;
  let throwError = false;

  if (typeof expected !== "function") {
    // Handle regular expressions.
    if (isRegExp(expected)) {
      const str = String(actual);
      if (expected.exec(str) !== null) return;

      if (!message) {
        generatedMessage = true;
        message = "The input did not match the regular expression " + `${inspect(expected)}. Input:\n\n${inspect(str)}\n`;
      }
      throwError = true;
      // Handle primitives properly.
    } else if (typeof actual !== "object" || actual === null) {
      const err = new AssertionError({ actual, expected, message, operator: "deepStrictEqual", stackStartFn: fn, diff: this?.[kOptions]?.diff });
      err.operator = fn.name;
      throw err;
    } else {
      // Handle validation objects.
      const keys = Object.keys(expected);
      // Special handle errors to make sure the name and the message are
      // compared as well.
      if (expected instanceof Error) {
        keys.push("name", "message");
      } else if (keys.length === 0) {
        throw invalidArgValue("error", "may not be an empty object", expected);
      }
      for (const key of keys) {
        if (typeof actual[key] === "string" && isRegExp(expected[key]) && expected[key].exec(actual[key]) !== null) {
          continue;
        }
        compareExceptionKey.call(this, actual, expected, key, message, keys, fn);
      }
      return;
    }
    // Guard instanceof against arrow functions as they don't have a prototype.
    // Check for matching Error classes.
  } else if (expected.prototype !== undefined && actual instanceof expected) {
    return;
  } else if (Object.prototype.isPrototypeOf.call(Error, expected)) {
    if (!message) {
      generatedMessage = true;
      message = "The error is expected to be an instance of " + `"${expected.name}". Received `;
      if (isError(actual)) {
        const name = (actual.constructor?.name) || actual.name;
        if (expected.name === name) {
          message += "an error with identical name but a different prototype.";
        } else {
          message += `"${name}"`;
        }
        if (actual.message) {
          message += `\n\nError message:\n\n${actual.message}`;
        }
      } else {
        message += `"${inspect(actual, { depth: -1 })}"`;
      }
    }
    throwError = true;
  } else {
    // Check validation functions return value.
    const res = Reflect.apply(expected, {}, [actual]);
    if (res !== true) {
      if (!message) {
        generatedMessage = true;
        const name = expected.name ? `"${expected.name}" ` : "";
        message = `The ${name}validation function is expected to return` + ` "true". Received ${inspect(res)}`;

        if (isError(actual)) {
          message += `\n\nCaught error:\n\n${actual}`;
        }
      }
      throwError = true;
    }
  }

  if (throwError) {
    const err = new AssertionError({ actual, expected, message, operator: fn.name, stackStartFn: fn, diff: this?.[kOptions]?.diff });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

function getActual(fn) {
  validateFunction(fn, "fn");
  try {
    fn();
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function checkIsPromise(obj) {
  // Accept native ES6 promises and promises that are implemented in a similar
  // way. Do not accept thenables that use a function as `obj` and that have no
  // `catch` handler.
  return isPromise(obj) ||
    (obj !== null && typeof obj === "object" && typeof obj.then === "function" && typeof obj.catch === "function");
}

async function waitForActual(promiseFn) {
  let resultPromise;
  if (typeof promiseFn === "function") {
    // Return a rejected promise if `promiseFn` throws synchronously.
    resultPromise = promiseFn();
    // Fail in case no promise is returned.
    if (!checkIsPromise(resultPromise)) {
      throw codeError(TypeError, "ERR_INVALID_RETURN_VALUE",
        `Expected instance of Promise to be returned from the "promiseFn" function but got ${specificType(resultPromise)}.`);
    }
  } else if (checkIsPromise(promiseFn)) {
    resultPromise = promiseFn;
  } else {
    throw invalidArgType("promiseFn", describeTypes(["Function", "Promise"]), promiseFn);
  }

  try {
    await resultPromise;
  } catch (e) {
    return e;
  }
  return NO_EXCEPTION_SENTINEL;
}

function expectsError(stackStartFn, actual, error, message) {
  if (typeof error === "string") {
    if (arguments.length === 4) {
      throw invalidArgType("error", describeTypes(["Object", "Error", "Function", "RegExp"]), error);
    }
    if (typeof actual === "object" && actual !== null) {
      if (actual.message === error) {
        throw codeError(TypeError, "ERR_AMBIGUOUS_ARGUMENT", `The "error/message" argument is ambiguous. The error message "${actual.message}" is identical to the message.`);
      }
    } else if (actual === error) {
      throw codeError(TypeError, "ERR_AMBIGUOUS_ARGUMENT", `The "error/message" argument is ambiguous. The error "${actual}" is identical to the message.`);
    }
    message = error;
    error = undefined;
  } else if (error != null && typeof error !== "object" && typeof error !== "function") {
    throw invalidArgType("error", describeTypes(["Object", "Error", "Function", "RegExp"]), error);
  }

  if (actual === NO_EXCEPTION_SENTINEL) {
    let details = "";
    if (error?.name) {
      details += ` (${error.name})`;
    }
    details += message ? `: ${message}` : ".";
    const fnType = stackStartFn === Assert.prototype.rejects ? "rejection" : "exception";
    innerFail({
      actual: undefined,
      expected: error,
      operator: stackStartFn.name,
      message: `Missing expected ${fnType}${details}`,
      stackStartFn,
      diff: this?.[kOptions]?.diff,
    });
  }

  if (!error) return;

  expectedException.call(this, actual, error, message, stackStartFn);
}

function hasMatchingError(actual, expected) {
  if (typeof expected !== "function") {
    if (isRegExp(expected)) {
      const str = String(actual);
      return expected.exec(str) !== null;
    }
    throw invalidArgType("expected", describeTypes(["Function", "RegExp"]), expected);
  }
  // Guard instanceof against arrow functions as they don't have a prototype.
  if (expected.prototype !== undefined && actual instanceof expected) {
    return true;
  }
  if (Object.prototype.isPrototypeOf.call(Error, expected)) {
    return false;
  }
  return Reflect.apply(expected, {}, [actual]) === true;
}

function expectsNoError(stackStartFn, actual, error, message) {
  if (actual === NO_EXCEPTION_SENTINEL) return;

  if (typeof error === "string") {
    message = error;
    error = undefined;
  }

  if (!error || hasMatchingError(actual, error)) {
    const details = message ? `: ${message}` : ".";
    const fnType = stackStartFn === Assert.prototype.doesNotReject ? "rejection" : "exception";
    innerFail({
      actual,
      expected: error,
      operator: stackStartFn.name,
      message: `Got unwanted ${fnType}${details}\n` + `Actual message: "${actual?.message}"`,
      stackStartFn,
      diff: this?.[kOptions]?.diff,
    });
  }
  throw actual;
}

/** Expects the function `promiseFn` to throw an error. */
Assert.prototype.throws = function throws(promiseFn, ...args) {
  expectsError.call(this, throws, getActual(promiseFn), ...args);
};

/** Expects `promiseFn` function or its value to reject. */
Assert.prototype.rejects = async function rejects(promiseFn, ...args) {
  expectsError.call(this, rejects, await waitForActual(promiseFn), ...args);
};

/** Asserts that the function `fn` does not throw an error. */
Assert.prototype.doesNotThrow = function doesNotThrow(fn, ...args) {
  expectsNoError.call(this, doesNotThrow, getActual(fn), ...args);
};

/** Expects `fn` or its value to not reject. */
Assert.prototype.doesNotReject = async function doesNotReject(fn, ...args) {
  expectsNoError.call(this, doesNotReject, await waitForActual(fn), ...args);
};

/** Throws `AssertionError` if the value is not `null` or `undefined`. */
Assert.prototype.ifError = function ifError(err) {
  if (err !== null && err !== undefined) {
    let message = "ifError got unwanted exception: ";
    if (typeof err === "object" && typeof err.message === "string") {
      if (err.message.length === 0 && err.constructor) {
        message += err.constructor.name;
      } else {
        message += err.message;
      }
    } else {
      message += inspect(err);
    }

    const newErr = new AssertionError({ actual: err, expected: null, operator: "ifError", message, stackStartFn: ifError, diff: this?.[kOptions]?.diff });

    // Make sure we actually have a stack trace!
    const origStack = err.stack;

    if (typeof origStack === "string" && typeof newErr.stack === "string") {
      // This will remove any duplicated frames from the error frames taken
      // from within `ifError` and add the original error frames to the newly
      // created ones.
      const origStackStart = origStack.indexOf("\n    at");
      if (origStackStart !== -1) {
        const originalFrames = origStack.slice(origStackStart + 1).split("\n");
        // Filter all frames existing in err.stack.
        let newFrames = newErr.stack.split("\n");
        for (const errFrame of originalFrames) {
          // Find the first occurrence of the frame.
          const pos = newFrames.indexOf(errFrame);
          if (pos !== -1) {
            // Only keep new frames.
            newFrames = newFrames.slice(0, pos);
            break;
          }
        }
        const stackStart = newFrames.join("\n");
        const stackEnd = originalFrames.join("\n");
        newErr.stack = `${stackStart}\n${stackEnd}`;
      }
    }

    throw newErr;
  }
};

function internalMatch(string, regexp, message, fn) {
  if (!isRegExp(regexp)) {
    throw invalidArgType("regexp", "an instance of RegExp", regexp);
  }
  const match = fn === Assert.prototype.match;
  if (typeof string !== "string" || (regexp.exec(string) !== null) !== match) {
    if (message instanceof Error) {
      throw message;
    }

    const generatedMessage = !message;

    // 'The input was expected to not match the regular expression ' +
    message ||= (typeof string !== "string" ?
      'The "string" argument must be of type string. Received type ' + `${typeof string} (${inspect(string)})` :
      (match ?
        "The input did not match the regular expression " :
        "The input was expected to not match the regular expression ") +
        `${inspect(regexp)}. Input:\n\n${inspect(string)}\n`);
    const err = new AssertionError({ actual: string, expected: regexp, message, operator: fn.name, stackStartFn: fn, diff: this?.[kOptions]?.diff });
    err.generatedMessage = generatedMessage;
    throw err;
  }
}

/** Expects the `string` input to match the regular expression. */
Assert.prototype.match = function match(string, regexp, message) {
  internalMatch.call(this, string, regexp, message, match);
};

/** Expects the `string` input not to match the regular expression. */
Assert.prototype.doesNotMatch = function doesNotMatch(string, regexp, message) {
  internalMatch.call(this, string, regexp, message, doesNotMatch);
};

// ---- The module ---------------------------------------------------------------------------

const assert = ok;
assert.AssertionError = AssertionError;
const DeprecatedCallTracker = deprecate(CallTracker, "assert.CallTracker is deprecated.", "DEP0173");
assert.CallTracker = DeprecatedCallTracker;

/** A strict-only variant of assert. */
function strictAssert(...args) {
  innerOk(strictAssert, args.length, ...args);
}

assert.ok = assert;
for (const name of [
  "fail", "equal", "notEqual", "deepEqual", "notDeepEqual",
  "deepStrictEqual", "notDeepStrictEqual", "strictEqual",
  "notStrictEqual", "partialDeepStrictEqual", "match", "doesNotMatch",
  "throws", "rejects", "doesNotThrow", "doesNotReject", "ifError",
]) {
  Object.defineProperty(assert, name, { value: Assert.prototype[name], writable: true, enumerable: true, configurable: true });
}

assert.strict = Object.assign(strictAssert, assert, {
  equal: assert.strictEqual,
  deepEqual: assert.deepStrictEqual,
  notEqual: assert.notStrictEqual,
  notDeepEqual: assert.notDeepStrictEqual,
});

assert.strict.Assert = Assert;
assert.strict.strict = assert.strict;

assert.Assert = Assert;

export default assert;
export const {
  fail, equal, notEqual, deepEqual, notDeepEqual, deepStrictEqual, notDeepStrictEqual, strictEqual,
  notStrictEqual, partialDeepStrictEqual, match, doesNotMatch, throws, rejects, doesNotThrow, doesNotReject,
  ifError, strict,
} = assert;
export { ok, DeprecatedCallTracker as CallTracker };
