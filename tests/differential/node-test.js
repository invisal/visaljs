// node:test: suites, tests and subtests, hooks in Node's order, skip / todo, failures of every
// kind (assertion, thrown value, rejected promise, callback error, timeout, plan, hook), mocks,
// t.assert, diagnostics, and the TAP report (durations, locations and stack frames aside)
import { after, afterEach, before, beforeEach, describe, it, mock, suite, test } from "node:test";
import assert from "node:assert/strict";

const log = (...args) => console.log(...args);

before(() => log("global before"));
after(() => log("global after"));

describe("hooks", () => {
  before(() => log("  suite before"));
  after(() => log("  suite after"));
  beforeEach((t) => log(`    beforeEach ${t.name}`));
  afterEach((t) => log(`    afterEach ${t.name}`));

  it("first", () => log("      first"));
  it("second", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    log("      second");
  });

  describe("nested", () => {
    beforeEach(() => log("    nested beforeEach"));
    it("inner", () => log("      inner"));
  });
});

suite("results", () => {
  test("passes");
  test("assertion fails", () => {
    assert.deepStrictEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] });
  });
  test("throws a value", () => {
    throw new TypeError("not a number");
  });
  test("throws a string", () => {
    throw "a string";
  });
  test("rejects", async () => {
    await Promise.reject(new RangeError("out of range"));
  });
  test("callback passes", (t, done) => {
    setTimeout(done, 1);
  });
  test("callback fails", (t, done) => {
    setTimeout(() => done(new Error("from the callback")), 1);
  });
  test("times out", { timeout: 20 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  test.skip("skipped");
  test("skipped with a reason", { skip: "not on this platform" }, () => {});
  test.todo("todo");
  test("todo that fails", { todo: "not done yet" }, () => {
    throw new Error("expected for now");
  });
  test("skips itself", (t) => {
    t.skip("decided at run time");
  });
  test("plan met", (t) => {
    t.plan(2);
    t.assert.equal(1, 1);
    t.assert.ok(true);
  });
  test("plan missed", (t) => {
    t.plan(3);
    t.assert.equal(1, 1);
  });
  test("diagnostics", (t) => {
    t.diagnostic("a note from the test");
    t.diagnostic("another # with a hash");
  });
  test("name with # and \\ and\nnewline", () => {});
});

describe("hook failures", () => {
  beforeEach(() => {
    throw new Error("beforeEach broke");
  });
  it("never runs its body", () => log("unreachable"));
});

test("subtests", async (t) => {
  await t.test("one", () => {});
  await t.test("two", async (t) => {
    await t.test("deep", () => {});
  });
  await t.test("three fails", () => assert.equal(1, 2));
});

test("context", (t) => {
  log("name:", t.name, "full name:", t.fullName, "signal:", typeof t.signal.aborted);
});

describe("mocks", () => {
  it("records calls", (t) => {
    const add = t.mock.fn((a, b) => a + b);
    assert.equal(add(1, 2), 3);
    assert.equal(add.call("this", 3, 4), 7);
    assert.equal(add.mock.callCount(), 2);
    assert.deepEqual(add.mock.calls.map((c) => c.arguments), [[1, 2], [3, 4]]);
    log("results:", add.mock.calls.map((c) => c.result).join(","), "this:", add.mock.calls[1].this);
  });

  it("replaces implementations", (t) => {
    const fn = t.mock.fn(() => "original", () => "replacement");
    fn.mock.mockImplementationOnce(() => "once");
    log("calls:", fn(), fn(), fn());
    fn.mock.mockImplementation(() => "new");
    log("after:", fn());
    fn.mock.resetCalls();
    log("reset:", fn.mock.callCount());
  });

  it("limits times", (t) => {
    const fn = t.mock.fn(() => "original", () => "mocked", { times: 2 });
    log("times:", fn(), fn(), fn());
  });

  it("tracks thrown errors", (t) => {
    const fn = t.mock.fn(() => { throw new Error("thrown inside"); });
    assert.throws(() => fn());
    log("error:", fn.mock.calls[0].error.message, "result:", fn.mock.calls[0].result);
  });

  it("mocks methods and restores them", (t) => {
    const obj = { value: 2, double() { return this.value * 2; } };
    const m = t.mock.method(obj, "double", function () { return this.value * 10; });
    log("mocked:", obj.double(), m.mock.callCount());
    m.mock.restore();
    log("restored:", obj.double());
  });

  it("mocks getters and setters", (t) => {
    const obj = { get answer() { return 42; }, set answer(v) { this.stored = v; } };
    t.mock.getter(obj, "answer", () => 7);
    log("getter:", obj.answer);
    const setter = t.mock.setter(obj, "answer", function (v) { this.stored = v * 2; });
    obj.answer = 5;
    log("setter:", obj.stored, setter.mock.callCount());
  });

  it("mocks properties", (t) => {
    const config = { level: "info" };
    const mocked = t.mock.property(config, "level", "debug");
    log("property:", config.level, mocked.mock.accessCount());
    mocked.mock.mockImplementationOnce("trace");
    log("once:", config.level, config.level);
  });

  it("restores a test's mocks after it", () => {
    log("console.log is the real one:", typeof console.log, console.log.mock === undefined);
  });

  it("uses the module's mock", () => {
    const fn = mock.fn(() => 1);
    fn();
    log("module mock:", fn.mock.callCount());
    mock.restoreAll();
  });

  it("checks arguments", (t) => {
    assert.throws(() => t.mock.method({}, "missing"), { code: "ERR_INVALID_ARG_VALUE" });
    assert.throws(() => t.mock.fn("x"), { code: "ERR_INVALID_ARG_TYPE" });
  });
});

describe.skip("a skipped suite", () => {
  it("is not run", () => log("unreachable"));
});

describe("only without --test-only", () => {
  it.only("warns", () => {});
});

log("module code done");
