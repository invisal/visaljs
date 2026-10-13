// node:test/reporters (Node's lib/test/reporters.js and lib/internal/test_runner/reporter/; MIT;
// Node v24.21.0): the reporters a program composes with a stream of test events. tap, dot and junit
// are async generators over the events; spec and lcov are Transforms from events to text. tap and
// spec are the runner's own (internal/test_runner/reporters.js); lcov writes the coverage events,
// which a compiled program doesn't produce.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { hostname } from "./os.js";
import { relative } from "./path.js";
import { Transform } from "./stream.js";
import { SpecReporter, TapReporter, colorsFor, inspectWithNoCustomRetry } from "./internal/test_runner/reporters.js";

/* ---- tap, spec ----------------------------------------------------------------------------------- */

export async function* tap(source) {
  const reporter = new TapReporter();
  yield reporter.start();
  for await (const event of source) {
    const text = reporter.handle(event);
    if (text) yield text;
  }
  const tail = reporter.flush();
  if (tail) yield tail;
}
Object.defineProperty(tap, "name", { value: "tapReporter" });

class SpecTransform extends Transform {
  #reporter = new SpecReporter();

  constructor() {
    super({ writableObjectMode: true });
  }

  _transform({ type, data }, _encoding, callback) {
    callback(null, this.#reporter.handle({ type, data }) || undefined);
  }

  _flush(callback) {
    callback(null, this.#reporter.flush());
  }
}

/** Node's: a function that makes a spec Transform, with or without new. */
export const spec = function value() {
  return new SpecTransform();
};

/* ---- dot (reporter/dot.js) ----------------------------------------------------------------------- */

export async function* dot(source) {
  const colors = colorsFor(process.stderr);
  const lineLength = () => Math.max(process.stdout.columns ?? 20, 20);
  let count = 0;
  let columns = lineLength();
  const failedTests = [];
  for await (const { type, data } of source) {
    if (type === "test:pass") {
      yield `${colors.green}.${colors.reset}`;
    }
    if (type === "test:fail") {
      yield `${colors.red}X${colors.reset}`;
      failedTests.push(data);
    }
    if ((type === "test:fail" || type === "test:pass") && ++count === columns) {
      yield "\n";
      columns = lineLength();  /* again, in case the terminal was resized */
      count = 0;
    }
  }
  yield "\n";
  if (failedTests.length > 0) {
    yield `\n${colors.red}Failed tests:${colors.white}\n\n`;
    const format = new SpecReporter();
    for (const test of failedTests) {
      yield format.formatTestReport("test:fail", test);
    }
  }
}

/* ---- junit (reporter/junit.js) ------------------------------------------------------------------- */

const junitInspectOptions = { __proto__: null, colors: false, breakLength: Infinity };

function escapeAttribute(s = "") {
  return escapeContent(s.replaceAll("\n", "").replaceAll('"', "&quot;"));
}

function escapeContent(s = "") {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function escapeComment(s = "") {
  return s.replaceAll("--", "&#45;&#45;");
}

function treeToXML(tree) {
  if (typeof tree === "string") {
    return `${escapeContent(tree)}\n`;
  }
  const { tag, attrs, nesting, children, comment } = tree;
  const indent = "\t".repeat(nesting + 1);
  if (comment) {
    return `${indent}<!-- ${escapeComment(comment)} -->\n`;
  }
  const attrsString = Object.entries(attrs).map(([key, value]) => `${key}="${escapeAttribute(String(value))}"`).join(" ");
  if (!children?.length) {
    return `${indent}<${tag} ${attrsString}/>\n`;
  }
  const childrenString = (children ?? []).map(treeToXML).join("");
  return `${indent}<${tag} ${attrsString}>\n${childrenString}${indent}</${tag}>\n`;
}

function isFailure(node) {
  return (node?.children && node.children.some((c) => c.tag === "failure")) || node?.attrs?.failures;
}

function isSkipped(node) {
  return (node?.children && node.children.some((c) => c.tag === "skipped")) || node?.attrs?.skipped;
}

export async function* junit(source) {
  const HOSTNAME = hostname();
  yield '<?xml version="1.0" encoding="utf-8"?>\n';
  yield "<testsuites>\n";
  let currentSuite = null;
  const roots = [];

  function startTest(event) {
    const originalSuite = currentSuite;
    currentSuite = { __proto__: null, attrs: { __proto__: null, name: event.data.name }, nesting: event.data.nesting, parent: currentSuite, children: [] };
    if (originalSuite?.children) {
      originalSuite.children.push(currentSuite);
    }
    if (!currentSuite.parent) {
      roots.push(currentSuite);
    }
  }

  for await (const event of source) {
    switch (event.type) {
      case "test:start": {
        startTest(event);
        break;
      }
      case "test:pass":
      case "test:fail": {
        if (!currentSuite) {
          startTest({ __proto__: null, data: { __proto__: null, name: "root", nesting: 0 } });
        }
        if (currentSuite.attrs.name !== event.data.name || currentSuite.nesting !== event.data.nesting) {
          startTest(event);
        }
        const currentTest = currentSuite;
        if (currentSuite?.nesting === event.data.nesting) {
          currentSuite = currentSuite.parent;
        }
        currentTest.attrs.time = (event.data.details.duration_ms / 1000).toFixed(6);
        const nonCommentChildren = currentTest.children.filter((c) => c.comment == null);
        if (nonCommentChildren.length > 0) {
          currentTest.tag = "testsuite";
          currentTest.attrs.disabled = 0;
          currentTest.attrs.errors = 0;
          currentTest.attrs.tests = nonCommentChildren.length;
          currentTest.attrs.failures = currentTest.children.filter(isFailure).length;
          currentTest.attrs.skipped = currentTest.children.filter(isSkipped).length;
          currentTest.attrs.hostname = HOSTNAME;
        } else {
          currentTest.tag = "testcase";
          currentTest.attrs.classname = event.data.classname ?? "test";
          if (event.data.skip) {
            currentTest.children.push({
              __proto__: null, nesting: event.data.nesting + 1, tag: "skipped", attrs: { __proto__: null, type: "skipped", message: event.data.skip },
            });
          }
          if (event.data.todo) {
            currentTest.children.push({
              __proto__: null, nesting: event.data.nesting + 1, tag: "skipped", attrs: { __proto__: null, type: "todo", message: event.data.todo },
            });
          }
          if (event.type === "test:fail") {
            const error = event.data.details?.error;
            currentTest.children.push({
              __proto__: null,
              nesting: event.data.nesting + 1,
              tag: "failure",
              attrs: { __proto__: null, type: error?.failureType || error?.code, message: error?.message ?? "" },
              children: [inspectWithNoCustomRetry(error, junitInspectOptions)],
            });
            currentTest.failures = 1;
            currentTest.attrs.failure = error?.message ?? "";
          }
        }
        break;
      }
      case "test:diagnostic": {
        const parent = currentSuite?.children ?? roots;
        parent.push({ __proto__: null, nesting: event.data.nesting, comment: event.data.message });
        break;
      }
      default:
        break;
    }
  }
  for (const suite of roots) {
    yield treeToXML(suite);
  }
  yield "</testsuites>\n";
}
Object.defineProperty(junit, "name", { value: "junitReporter" });

/* ---- lcov (reporter/lcov.js) --------------------------------------------------------------------- */

/** The coverage events as an LCOV tracefile. */
class LcovReporter extends Transform {
  constructor(options) {
    super({ ...options, writableObjectMode: true, __proto__: null });
  }

  _transform(event, _encoding, callback) {
    if (event.type !== "test:coverage") {
      return callback(null);
    }
    let lcov = "TN:\n";
    const { workingDirectory } = event.data.summary;
    try {
      for (const file of event.data.summary.files) {
        lcov += `SF:${relative(workingDirectory, file.path)}\n`;
        let fnda = "";
        for (let j = 0; j < file.functions.length; j++) {
          const func = file.functions[j];
          const name = func.name || `anonymous_${j}`;
          lcov += `FN:${func.line},${name}\n`;
          fnda += `FNDA:${func.count},${name}\n`;
        }
        lcov += fnda;
        lcov += `FNF:${file.totalFunctionCount}\n`;
        lcov += `FNH:${file.coveredFunctionCount}\n`;
        for (let j = 0; j < file.branches.length; j++) {
          lcov += `BRDA:${file.branches[j].line},${j},0,${file.branches[j].count}\n`;
        }
        lcov += `BRF:${file.totalBranchCount}\n`;
        lcov += `BRH:${file.coveredBranchCount}\n`;
        for (const line of file.lines.toSorted((a, b) => a.line - b.line)) {
          lcov += `DA:${line.line},${line.count}\n`;
        }
        lcov += `LH:${file.coveredLineCount}\n`;
        lcov += `LF:${file.totalLineCount}\n`;
        lcov += "end_of_record\n";
      }
    } catch (error) {
      return callback(error);
    }
    return callback(null, lcov);
  }
}

/** A new reporter on each call, with new or without, as spec. */
export function lcov(options) {
  return new LcovReporter(options);
}

const reporters = { dot, junit, spec, tap, lcov };
export default reporters;
