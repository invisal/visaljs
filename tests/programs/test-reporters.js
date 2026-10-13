// node:test/reporters: tap, dot and junit over a stream of test events, spec and lcov as Transforms,
// each given the same events (a suite with a passing, a failing, a skipped and a todo test, and the
// runner's diagnostics) and an lcov coverage event.
import { hostname } from "node:os";
import { Readable } from "node:stream";
import reporters, { dot, junit, lcov, spec, tap } from "node:test/reporters";

const failure = new Error("boom & <bang>");
failure.stack = "Error: boom & <bang>";
const details = (duration_ms, error) => ({ duration_ms, ...(error ? { error } : {}) });
const events = [
  { type: "test:start", data: { name: "suite", nesting: 0 } },
  { type: "test:start", data: { name: "passes", nesting: 1 } },
  { type: "test:pass", data: { name: "passes", nesting: 1, testNumber: 1, details: details(1.5) } },
  { type: "test:start", data: { name: "fails", nesting: 1 } },
  { type: "test:fail", data: { name: "fails", nesting: 1, testNumber: 2, details: details(2, failure) } },
  { type: "test:start", data: { name: "skipped", nesting: 1 } },
  { type: "test:pass", data: { name: "skipped", nesting: 1, testNumber: 3, skip: "not now", details: details(0) } },
  { type: "test:start", data: { name: "todo", nesting: 1 } },
  { type: "test:pass", data: { name: "todo", nesting: 1, testNumber: 4, todo: true, details: details(0) } },
  { type: "test:plan", data: { nesting: 1, count: 4 } },
  { type: "test:fail", data: { name: "suite", nesting: 0, testNumber: 1, details: details(5, Object.assign(new Error("1 subtest failed"), { failureType: "subtestsFailed", stack: "" })) } },
  { type: "test:plan", data: { nesting: 0, count: 1 } },
  { type: "test:diagnostic", data: { nesting: 0, message: "tests 4 -- done" } },
];
const coverage = {
  type: "test:coverage",
  data: {
    nesting: 0,
    summary: {
      workingDirectory: "/work",
      files: [{
        path: "/work/src/a.js", functions: [{ name: "f", line: 1, count: 2 }, { name: "", line: 5, count: 0 }], totalFunctionCount: 2,
        coveredFunctionCount: 1, branches: [{ line: 2, count: 1 }], totalBranchCount: 1, coveredBranchCount: 1,
        lines: [{ line: 2, count: 1 }, { line: 1, count: 2 }], coveredLineCount: 2, totalLineCount: 3,
      }],
    },
  },
};

const clean = (text) => text.replaceAll(hostname(), "HOST");
async function collect(generator) {
  let out = "";
  for await (const chunk of generator(Readable.from(events))) out += chunk;
  return clean(out);
}
async function piped(transform, input) {
  let out = "";
  for await (const chunk of Readable.from(input).pipe(transform)) out += chunk;
  return clean(out);
}

print("names: " + [dot.name, junit.name, spec.name, tap.name] + " " + Object.keys(reporters) + " " + typeof lcov);
print("--- tap\n" + (await collect(tap)));
print("--- dot\n" + (await collect(dot)));
print("--- junit\n" + (await collect(junit)));
print("--- spec\n" + (await piped(spec(), events)));
print("--- spec with new: " + (new spec() !== spec()));
print("--- lcov\n" + (await piped(reporters.lcov, [...events, coverage])));
print("lcov getter: " + (reporters.lcov !== reporters.lcov));
