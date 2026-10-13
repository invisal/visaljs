// node:test's runner: Node's lib/internal/test_runner/test.js, harness.js and
// tests_stream.js (MIT; Node v22.22.2), ported. Tests, suites and hooks run as Node runs them: a
// suite's tests are collected first, tests run one after another (or `concurrency` at a time),
// hooks in Node's order, results reported in declaration order, and the summary when the event
// loop is done ('beforeExit'). What differs:
// - The current test is the AsyncLocalStorage store the test runs in (visaljs carries it through
//   promises, timers and I/O), where Node maps async_hooks ids to tests.
// - A test has no location (Node's file:line:column of the test() call): a compiled program
//   doesn't know it.
// - The reporter is the default one, tap (spec when stdout is a terminal): a compiled program has
//   no node --test-* options. Its text goes to stdout as the events come, a turn of the event loop
//   later, as Node's reporter stream writes it.
// - run(), the test runner that starts a process per test file, isn't provided.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { AsyncLocalStorage } from "../../async_hooks.js";
import assert from "../../assert.js";
import { EventEmitter } from "../../events.js";
import { codeError, invalidArgType, invalidArgValue, outOfRange, validateFunction } from "../errors.js";
import { MockTracker } from "./mock.js";
import { SpecReporter, TapReporter } from "./reporters.js";
import { isPromise } from "../../util_types.js";
import { utilInspect as inspect } from "visaljs:host";

const kCallbackAndPromisePresent = "callbackAndPromisePresent";
export const kCancelledByParent = "cancelledByParent";
const kAborted = "testAborted";
const kParentAlreadyFinished = "parentAlreadyFinished";
const kSubtestsFailed = "subtestsFailed";
const kTestCodeFailure = "testCodeFailure";
const kTestTimeoutFailure = "testTimeoutFailure";
const kHookFailure = "hookFailed";
const kMultipleCallbackInvocations = "multipleCallbackInvocations";
const kDefaultTimeout = null;
const noop = () => {};
const kShouldAbort = Symbol("kShouldAbort");
const kHookNames = Object.seal(["before", "after", "beforeEach", "afterEach"]);
const kDispose = Symbol("kDispose");
const kIsTestFailure = Symbol("kIsTestFailure");
const TIMEOUT_MAX = 2 ** 31 - 1;
const kGenericUserError = 1;

/* the test (or hook) whose code is running: Node's executionAsyncId() → test map */
const testStorage = new AsyncLocalStorage();

/* milliseconds, as a high-resolution time */
function hrtime() {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
}

// ---- Node's errors and validators ---------------------------------------------------------

/** ERR_TEST_FAILURE: an error (or a message) and why the test failed. */
class TestFailure extends Error {
  constructor(error, failureType) {
    let msg = error?.message ?? error;
    if (typeof msg !== "string") {
      msg = inspectWithNoCustomRetry(msg);
    }
    super(msg);
    this.failureType = failureType;
    this.cause = error;
    Object.defineProperty(this, "code", { value: "ERR_TEST_FAILURE", enumerable: true, writable: true, configurable: true });
    Object.defineProperty(this, kIsTestFailure, { value: true });
  }

  toString() {
    return `Error [ERR_TEST_FAILURE]: ${this.message}`;
  }
}

function inspectWithNoCustomRetry(obj, options) {
  try {
    return inspect(obj, options);
  } catch {
    return inspect(obj, { ...options, customInspect: false });
  }
}

function isTestFailureError(err) {
  return err?.code === "ERR_TEST_FAILURE" && err?.[kIsTestFailure] === true;
}

class AbortError extends Error {
  constructor(message = "The operation was aborted", options = undefined) {
    super(message, options);
    this.code = "ABORT_ERR";
    this.name = "AbortError";
  }
}

function validateObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidArgType(name, "of type object", value);
}

function validateNumber(value, name, min, max) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (value < min || value > max || Number.isNaN(value)) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
}

function validateUint32(value, name, positive = false) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  const min = positive ? 1 : 0;
  if (value < min || value > 4294967295) throw outOfRange(name, `>= ${min} && <= 4294967295`, value);
}

function validateOneOf(value, name, oneOf) {
  if (!oneOf.includes(value)) {
    throw invalidArgValue(name, `must be one of: ${oneOf.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ")}`, value);
  }
}

function validateAbortSignal(signal, name) {
  if (signal !== undefined && (signal === null || typeof signal !== "object" || !("aborted" in signal))) {
    throw invalidArgType(name, "an instance of AbortSignal", signal);
  }
}

/** Node's internal/util once(), preserving the first call's return value. */
function runOnce(fn) {
  let called = false;
  let value;
  return function (...args) {
    if (called) return value;
    called = true;
    value = Reflect.apply(fn, this, args);
    return value;
  };
}

function createDeferredCallback() {
  let calledCount = 0;
  const { promise, resolve, reject } = Promise.withResolvers();
  const cb = (err) => {
    calledCount++;

    // If the callback is called a second time, let the user know, but
    // don't let them know more than once.
    if (calledCount > 1) {
      if (calledCount === 2) {
        throw new TestFailure("callback invoked multiple times", kMultipleCallbackInvocations);
      }

      return;
    }

    if (err) {
      return reject(err);
    }

    resolve();
  };

  return { __proto__: null, promise, cb };
}

function countCompletedTest(test, harness = test.root.harness) {
  if (test.nesting === 0) {
    harness.counters.topLevel++;
  }
  if (test.reportedType === "suite") {
    harness.counters.suites++;
    return;
  }
  // Check SKIP and TODO tests first, as those should not be counted as
  // failures.
  if (test.skipped) {
    harness.counters.skipped++;
  } else if (test.isTodo) {
    harness.counters.todo++;
  } else if (test.cancelled) {
    harness.counters.cancelled++;
    harness.success = false;
  } else if (!test.passed) {
    harness.counters.failed++;
    harness.success = false;
  } else {
    harness.counters.passed++;
  }
  harness.counters.tests++;
}

// ---- The event stream (lib/internal/test_runner/tests_stream.js) --------------------------

/** The tests' events, as Node's TestsStream emits them; a reporter writes them to stdout. */
class TestsStream extends EventEmitter {
  #reporter = null;
  #pending = [];
  #scheduled = false;
  #ended = false;

  /** Starts writing the events with a reporter: tap, or spec. */
  attach(reporter) {
    this.#reporter = reporter;
    const head = reporter.start();
    if (head) this.#pending.push(head);
    this.#schedule();
  }

  #schedule() {
    if (this.#scheduled || this.#reporter === null) return;
    this.#scheduled = true;
    setImmediate(() => this.#flush());
  }

  #flush() {
    this.#scheduled = false;
    const text = this.#pending.join("");
    this.#pending = [];
    if (text) process.stdout.write(text);
  }

  #emitMessage(type, data) {
    this.emit(type, data);
    if (this.#reporter === null || this.#ended) return;
    const text = this.#reporter.handle({ type, data });
    if (text) {
      this.#pending.push(text);
      this.#schedule();
    }
  }

  fail(nesting, loc, testNumber, name, details, directive) {
    this.#emitMessage("test:fail", { __proto__: null, name, nesting, testNumber, details, ...loc, ...directive });
  }

  ok(nesting, loc, testNumber, name, details, directive) {
    this.#emitMessage("test:pass", { __proto__: null, name, nesting, testNumber, details, ...loc, ...directive });
  }

  complete(nesting, loc, testNumber, name, details, directive) {
    this.#emitMessage("test:complete", { __proto__: null, name, nesting, testNumber, details, ...loc, ...directive });
  }

  plan(nesting, loc, count) {
    this.#emitMessage("test:plan", { __proto__: null, nesting, count, ...loc });
  }

  getSkip(reason = undefined) {
    return { __proto__: null, skip: reason ?? true };
  }

  getTodo(reason = undefined) {
    return { __proto__: null, todo: reason ?? true };
  }

  enqueue(nesting, loc, name, type) {
    this.#emitMessage("test:enqueue", { __proto__: null, nesting, name, type, ...loc });
  }

  dequeue(nesting, loc, name, type) {
    this.#emitMessage("test:dequeue", { __proto__: null, nesting, name, type, ...loc });
  }

  start(nesting, loc, name) {
    this.#emitMessage("test:start", { __proto__: null, nesting, name, ...loc });
  }

  diagnostic(nesting, loc, message, level = "info") {
    this.#emitMessage("test:diagnostic", { __proto__: null, nesting, message, level, ...loc });
  }

  summary(nesting, file, success, counts, duration_ms) {
    this.#emitMessage("test:summary", { __proto__: null, success, counts, duration_ms, file });
  }

  end() {
    if (this.#reporter !== null) {
      const tail = this.#reporter.flush();
      if (tail) this.#pending.push(tail);
      this.#schedule();
    }
    this.#ended = true;
  }
}

/* a filtered test's reporter: its events go nowhere */
let noopTestStream;

// ---- Tests (lib/internal/test_runner/test.js) ---------------------------------------------

function stopTest(timeout, signal) {
  const deferred = Promise.withResolvers();
  const onAbort = () => deferred.resolve();
  signal.addEventListener("abort", onAbort, { once: true });
  let timer;
  let disposeFunction;

  if (timeout === kDefaultTimeout) {
    disposeFunction = () => signal.removeEventListener("abort", onAbort);
  } else {
    timer = setTimeout(() => deferred.resolve(), timeout);
    timer?.unref?.();

    deferred.promise = deferred.promise.then(() => {
      throw new TestFailure(`test timed out after ${timeout}ms`, kTestTimeoutFailure);
    });

    disposeFunction = () => {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
  }

  deferred.promise[kDispose] = disposeFunction;
  return deferred.promise;
}

class TestPlan {
  #waitIndefinitely = false;
  #planPromise = null;
  #timeoutId = null;

  constructor(count, options = {}) {
    validateUint32(count, "count");
    validateObject(options, "options");
    this.expected = count;
    this.actual = 0;

    const { wait } = options;
    if (typeof wait === "boolean") {
      this.wait = wait;
      this.#waitIndefinitely = wait;
    } else if (typeof wait === "number") {
      validateNumber(wait, "options.wait", 0, TIMEOUT_MAX);
      this.wait = wait;
    } else if (wait !== undefined) {
      throw invalidArgType("options.wait", "of type boolean or number", wait);
    }
  }

  #planMet() {
    return this.actual === this.expected;
  }

  #createTimeout(reject) {
    return setTimeout(() => {
      const err = new TestFailure(
        `plan timed out after ${this.wait}ms with ${this.actual} assertions when expecting ${this.expected}`,
        kTestTimeoutFailure,
      );
      reject(err);
    }, this.wait);
  }

  check() {
    if (this.#planMet()) {
      if (this.#timeoutId) {
        clearTimeout(this.#timeoutId);
        this.#timeoutId = null;
      }
      if (this.#planPromise) {
        const { resolve } = this.#planPromise;
        resolve();
        this.#planPromise = null;
      }
      return;
    }

    if (!this.#shouldWait()) {
      throw new TestFailure(`plan expected ${this.expected} assertions but received ${this.actual}`, kTestCodeFailure);
    }

    if (!this.#planPromise) {
      const { promise, resolve, reject } = Promise.withResolvers();
      this.#planPromise = { __proto__: null, promise, resolve, reject };

      if (!this.#waitIndefinitely) {
        this.#timeoutId = this.#createTimeout(reject);
      }
    }

    return this.#planPromise.promise;
  }

  count() {
    this.actual++;
    if (this.#planPromise) {
      this.check();
    }
  }

  #shouldWait() {
    return this.wait !== undefined && this.wait !== false;
  }
}

/* t.assert's methods: node:assert's (internal/test_runner/assert.js), and register()'s */
const assertMap = new Map([
  "deepEqual", "deepStrictEqual", "doesNotMatch", "doesNotReject", "doesNotThrow", "equal", "fail", "ifError",
  "match", "notDeepEqual", "notDeepStrictEqual", "notEqual", "notStrictEqual", "partialDeepStrictEqual",
  "rejects", "strictEqual", "throws",
].map((name) => [name, assert[name]]));

/** test.assert.register(name, fn): a method every test context's t.assert has. */
export function registerAssertion(name, fn) {
  if (typeof name !== "string") throw invalidArgType("name", "of type string", name);
  validateFunction(fn, "fn");
  assertMap.set(name, fn);
}

class TestContext {
  #assert;
  #test;

  constructor(test) {
    this.#test = test;
  }

  get signal() {
    return this.#test.signal;
  }

  get name() {
    return this.#test.name;
  }

  get filePath() {
    return this.#test.entryFile;
  }

  get fullName() {
    return getFullName(this.#test);
  }

  get error() {
    return this.#test.error;
  }

  get passed() {
    return this.#test.passed;
  }

  diagnostic(message) {
    this.#test.diagnostic(message);
  }

  plan(count, options = {}) {
    if (this.#test.plan !== null) {
      throw new TestFailure("cannot set plan more than once", kTestCodeFailure);
    }

    this.#test.plan = new TestPlan(count, options);
  }

  get assert() {
    if (this.#assert === undefined) {
      const { plan } = this.#test;
      const assertObj = { __proto__: null };

      this.#assert = assertObj;
      assertMap.forEach((method, name) => {
        assertObj[name] = (...args) => {
          if (plan !== null) {
            plan.count();
          }
          return Reflect.apply(method, this, args);
        };
      });

      if (!assertMap.has("ok")) {
        assertObj.ok = (...args) => {
          if (plan !== null) {
            plan.count();
          }
          Reflect.apply(assert.ok, undefined, args);
        };
      }
    }
    return this.#assert;
  }

  get mock() {
    this.#test.mock ??= new MockTracker();
    return this.#test.mock;
  }

  runOnly(value) {
    this.#test.runOnlySubtests = !!value;
  }

  skip(message) {
    this.#test.skip(message);
  }

  todo(message) {
    this.#test.todo(message);
  }

  test(name, options, fn) {
    const { plan } = this.#test;
    if (plan !== null) {
      plan.count();
    }

    const subtest = this.#test.createSubtest(Test, name, options, fn, { __proto__: null });

    return subtest.start();
  }

  before(fn, options) {
    this.#test.createHook("before", fn, { __proto__: null, ...options, parent: this.#test, hookType: "before" });
  }

  after(fn, options) {
    this.#test.createHook("after", fn, { __proto__: null, ...options, parent: this.#test, hookType: "after" });
  }

  beforeEach(fn, options) {
    this.#test.createHook("beforeEach", fn, { __proto__: null, ...options, parent: this.#test, hookType: "beforeEach" });
  }

  afterEach(fn, options) {
    this.#test.createHook("afterEach", fn, { __proto__: null, ...options, parent: this.#test, hookType: "afterEach" });
  }

  waitFor(condition, options = {}) {
    validateFunction(condition, "condition");
    validateObject(options, "options");

    const { interval = 50, timeout = 1000 } = options;

    validateNumber(interval, "options.interval", 0, TIMEOUT_MAX);
    validateNumber(timeout, "options.timeout", 0, TIMEOUT_MAX);

    const { promise, resolve, reject } = Promise.withResolvers();
    const noError = Symbol();
    let cause = noError;
    let pollerId;
    let timeoutId = undefined;
    const done = (err, result) => {
      clearTimeout(pollerId);
      clearTimeout(timeoutId);

      if (err === noError) {
        resolve(result);
      } else {
        reject(err);
      }
    };

    timeoutId = setTimeout(() => {
      const err = new Error("waitFor() timed out");

      if (cause !== noError) {
        err.cause = cause;
      }

      done(err);
    }, timeout);

    const poller = async () => {
      try {
        const result = await condition();

        done(noError, result);
      } catch (err) {
        cause = err;
        pollerId = setTimeout(poller, interval);
      }
    };

    poller();
    return promise;
  }
}

class SuiteContext {
  #suite;

  constructor(suite) {
    this.#suite = suite;
  }

  get signal() {
    return this.#suite.signal;
  }

  get name() {
    return this.#suite.name;
  }

  get filePath() {
    return this.#suite.entryFile;
  }

  get fullName() {
    return getFullName(this.#suite);
  }
}

export class Test {
  reportedType = "test";
  abortController;
  outerSignal;
  #reportedSubtest;

  constructor(options) {
    let { fn, name, parent } = options;
    const { concurrency, entryFile, loc, only, timeout, todo, skip, signal, plan } = options;

    if (typeof fn !== "function") {
      fn = noop;
    }

    if (typeof name !== "string" || name === "") {
      name = fn.name || "<anonymous>";
    }

    if (!(parent instanceof Test)) {
      parent = null;
    }

    this.name = name;
    this.parent = parent;
    this.testNumber = 0;
    this.outputSubtestCount = 0;
    this.diagnostics = [];
    this.filtered = false;
    this.filteredByName = false;
    this.hasOnlyTests = false;

    if (parent === null) {
      this.root = this;
      this.harness = options.harness;
      this.config = this.harness.config;
      this.concurrency = 1;
      this.nesting = 0;
      this.only = this.config.only;
      this.reporter = new TestsStream();
      this.runOnlySubtests = this.only;
      this.childNumber = 0;
      this.timeout = kDefaultTimeout;
      this.entryFile = entryFile;
    } else {
      const nesting = parent.parent === null ? parent.nesting : parent.nesting + 1;

      this.root = parent.root;
      this.harness = null;
      this.config = this.root.harness.config;
      this.concurrency = parent.concurrency;
      this.nesting = nesting;
      this.only = only;
      this.reporter = parent.reporter;
      this.runOnlySubtests = false;
      this.childNumber = parent.subtests.length + 1;
      this.timeout = parent.timeout;
      this.entryFile = parent.entryFile;

      if (only || this.parent.runOnlySubtests) {
        const warning = "'only' and 'runOnly' require the --test-only command-line option.";
        this.diagnostic(warning);
      }
    }

    switch (typeof concurrency) {
      case "number":
        validateUint32(concurrency, "options.concurrency", true);
        this.concurrency = concurrency;
        break;

      case "boolean":
        if (concurrency) {
          this.concurrency = parent === null ? Math.max((globalThis.navigator?.hardwareConcurrency ?? 1) - 1, 1) : Infinity;
        } else {
          this.concurrency = 1;
        }
        break;

      default:
        if (concurrency != null) throw invalidArgType("options.concurrency", "of type boolean or number", concurrency);
    }

    if (timeout != null && timeout !== Infinity) {
      validateNumber(timeout, "options.timeout", 0, TIMEOUT_MAX);
      this.timeout = timeout;
    }

    if (skip) {
      fn = noop;
    }

    this.abortController = new AbortController();
    this.outerSignal = signal;
    this.signal = this.abortController.signal;

    validateAbortSignal(signal, "options.signal");

    this.outerSignal?.addEventListener("abort", this.#abortHandler);

    this.fn = fn;
    this.mock = null;
    this.plan = null;
    this.expectedAssertions = plan;
    this.cancelled = false;
    this.skipped = skip !== undefined && skip !== false;
    this.isTodo = (todo !== undefined && todo !== false) || this.parent?.isTodo;
    this.startTime = null;
    this.endTime = null;
    this.passed = false;
    this.error = null;
    this.message = typeof skip === "string" ? skip : typeof todo === "string" ? todo : null;
    this.activeSubtests = 0;
    this.pendingSubtests = [];
    this.readySubtests = new Map();
    this.subtests = [];
    this.waitingOn = 0;
    this.finished = false;
    this.hooks = {
      __proto__: null,
      before: [],
      after: [],
      beforeEach: [],
      afterEach: [],
      ownAfterEachCount: 0,
    };

    this.loc = loc;
  }

  /** Runs fn(...args) with this test as the current one (Node's AsyncResource.runInAsyncScope). */
  runInAsyncScope(fn, thisArg, ...args) {
    return testStorage.run(this, () => Reflect.apply(fn, thisArg, args));
  }

  applyFilters() {}

  /** The name of the test after its ancestors' names, each after a space. */
  getTestNameWithAncestors() {
    if (!this.parent) return "";

    return `${this.parent.getTestNameWithAncestors()} ${this.name}`;
  }

  hasConcurrency() {
    return this.concurrency > this.activeSubtests;
  }

  addPendingSubtest(deferred) {
    this.pendingSubtests.push(deferred);
  }

  async processPendingSubtests() {
    while (this.pendingSubtests.length > 0 && this.hasConcurrency()) {
      const deferred = this.pendingSubtests.shift();
      const test = deferred.test;
      test.reporter.dequeue(test.nesting, test.loc, test.name, this.reportedType);
      await test.run();
      deferred.resolve();
    }
  }

  addReadySubtest(subtest) {
    this.readySubtests.set(subtest.childNumber, subtest);
  }

  processReadySubtestRange(canSend) {
    const start = this.waitingOn;
    const end = start + this.readySubtests.size;

    for (let i = start; i < end; i++) {
      const subtest = this.readySubtests.get(i);

      // Check if the specified subtest is in the map. If it is not, return
      // early to avoid trying to process any more tests since they would be
      // out of order.
      if (subtest === undefined) {
        return;
      }

      // Call isClearToSend() in the loop so that it is:
      // - Only called if there are results to report in the correct order.
      // - Guaranteed to only be called a maximum of once per call to
      //   processReadySubtestRange().
      canSend ||= this.isClearToSend();

      if (!canSend) {
        return;
      }

      // Report the subtest's results and remove it from the ready map.
      subtest.finalize();
      this.readySubtests.delete(i);
    }
  }

  createSubtest(Factory, name, options, fn, overrides) {
    if (typeof name === "function") {
      fn = name;
    } else if (name !== null && typeof name === "object") {
      fn = options;
      options = name;
    } else if (typeof options === "function") {
      fn = options;
    }

    if (options === null || typeof options !== "object") {
      options = {};
    }

    // If this test has already ended, attach this test to the root test so
    // that the error can be properly reported.
    const preventAddingSubtests = this.finished || this.buildPhaseFinished;
    const parent = preventAddingSubtests ? this.root : this;

    const test = new Factory({ __proto__: null, fn, name, parent, ...options, ...overrides });

    if (parent.waitingOn === 0) {
      parent.waitingOn = test.childNumber;
    }

    if (preventAddingSubtests) {
      test.fail(new TestFailure("test could not be started because its parent finished", kParentAlreadyFinished));
    }

    parent.subtests.push(test);
    return test;
  }

  #abortHandler = () => {
    const error = this.outerSignal?.reason || new AbortError("The test was aborted");
    error.failureType = kAborted;
    this.#cancel(error);
  };

  #cancel(error) {
    if (this.endTime !== null || this.error !== null) {
      return;
    }

    this.fail(error || new TestFailure("test did not finish before its parent and was cancelled", kCancelledByParent));
    this.cancelled = true;
    this.abortController.abort();
  }

  computeInheritedHooks() {
    if (this.parent.hooks.beforeEach.length > 0) {
      this.hooks.beforeEach.unshift(...this.parent.hooks.beforeEach.slice());
    }

    if (this.parent.hooks.afterEach.length > 0) {
      this.hooks.afterEach.push(...this.parent.hooks.afterEach.slice());
    }
  }

  createHook(name, fn, options) {
    validateOneOf(name, "hook name", kHookNames);
    const hook = new TestHook(fn, options);
    if (name === "before" || name === "after") {
      hook.run = runOnce(hook.run);
    }
    if (name === "before" && this.startTime !== null) {
      // Test has already started, run the hook immediately
      hook.run(this.getRunArgs()).then(() => {
        if (hook.error != null) {
          this.fail(hook.error);
        }
      });
    }
    if (name === "afterEach") {
      // afterEach hooks for the current test should run in the order that they
      // are created. However, the current test's afterEach hooks should run
      // prior to any ancestor afterEach hooks.
      this.hooks[name].splice(this.hooks.ownAfterEachCount, 0, hook);
      this.hooks.ownAfterEachCount++;
    } else {
      this.hooks[name].push(hook);
    }
  }

  fail(err) {
    if (this.error !== null) {
      return;
    }

    this.passed = false;
    this.error = err;
  }

  pass() {
    if (this.error !== null) {
      return;
    }

    this.passed = true;
  }

  skip(message) {
    this.skipped = true;
    this.message = message;
  }

  todo(message) {
    this.isTodo = true;
    this.message = message;
  }

  diagnostic(message) {
    this.diagnostics.push(message);
  }

  start() {
    this.applyFilters();

    if (this.filtered) {
      noopTestStream ??= new TestsStream();
      this.reporter = noopTestStream;
      this.run = this.filteredRun;
    } else {
      this.testNumber = ++this.parent.outputSubtestCount;
    }

    // If there is enough available concurrency to run the test now, then do
    // it. Otherwise, return a Promise to the caller and mark the test as
    // pending for later execution.
    this.reporter.enqueue(this.nesting, this.loc, this.name, this.reportedType);
    if (this.root.harness.buildPromise || !this.parent.hasConcurrency()) {
      const deferred = Promise.withResolvers();

      deferred.test = this;
      this.parent.addPendingSubtest(deferred);
      return deferred.promise;
    }

    this.reporter.dequeue(this.nesting, this.loc, this.name, this.reportedType);
    return this.run();
  }

  [kShouldAbort]() {
    if (this.signal.aborted || this.outerSignal?.aborted) {
      this.#abortHandler();
      return true;
    }
  }

  getRunArgs() {
    const ctx = new TestContext(this);
    return { __proto__: null, ctx, args: [ctx] };
  }

  async runHook(hook, args) {
    validateOneOf(hook, "hook name", kHookNames);
    try {
      const hooks = this.hooks[hook];
      for (let i = 0; i < hooks.length; ++i) {
        const hook = hooks[i];
        await hook.run(args);
        if (hook.error) {
          throw hook.error;
        }
      }
    } catch (err) {
      const error = new TestFailure(`failed running ${hook} hook`, kHookFailure);
      error.cause = isTestFailureError(err) ? err.cause : err;
      throw error;
    }
  }

  async filteredRun() {
    this.pass();
    this.subtests = [];
    this.report = noop;
    queueMicrotask(() => this.postRun());
  }

  async run() {
    if (this.parent !== null) {
      this.parent.activeSubtests++;
      this.computeInheritedHooks();
    }
    this.startTime ??= hrtime();

    if (this[kShouldAbort]()) {
      this.postRun();
      return;
    }

    const hookArgs = this.getRunArgs();
    const { args, ctx } = hookArgs;

    if (this.plan === null && this.expectedAssertions) {
      ctx.plan(this.expectedAssertions);
    }

    const after = async () => {
      if (this.hooks.after.length > 0) {
        await this.runHook("after", hookArgs);
      }
    };
    const afterEach = runOnce(async () => {
      if (this.parent?.hooks.afterEach.length > 0 && !this.skipped) {
        await this.parent.runHook("afterEach", hookArgs);
      }
    });

    let stopPromise;

    try {
      if (this.parent?.hooks.before.length > 0) {
        // This hook usually runs immediately, we need to wait for it to finish
        await this.parent.runHook("before", this.parent.getRunArgs());
      }
      if (this.parent?.hooks.beforeEach.length > 0 && !this.skipped) {
        await this.parent.runHook("beforeEach", hookArgs);
      }
      stopPromise = stopTest(this.timeout, this.signal);
      const runArgs = args.slice();
      runArgs.unshift(this.fn, ctx);

      const promises = [];
      if (this.fn.length === runArgs.length - 1) {
        // This test is using legacy Node.js error-first callbacks.
        const { promise, cb } = createDeferredCallback();
        runArgs.push(cb);

        const ret = Reflect.apply(this.runInAsyncScope, this, runArgs);

        if (isPromise(ret)) {
          this.fail(new TestFailure("passed a callback but also returned a Promise", kCallbackAndPromisePresent));
          promises.push(ret);
        } else {
          promises.push(Promise.resolve(promise));
        }
      } else {
        // This test is synchronous or using Promises.
        const promise = Reflect.apply(this.runInAsyncScope, this, runArgs);
        promises.push(Promise.resolve(promise));
      }

      promises.push(stopPromise);

      // Wait for the race to finish
      await Promise.race(promises);

      this[kShouldAbort]();
      this.plan?.check();

      if (this.plan !== null) {
        const planPromise = this.plan?.check();
        // If the plan returns a promise, it means that it is waiting for more assertions to be made before
        // continuing.
        if (planPromise) {
          await Promise.race([planPromise, stopPromise]);
        }
      }

      this.pass();
      await afterEach();
      await after();
    } catch (err) {
      if (isTestFailureError(err)) {
        if (err.failureType === kTestTimeoutFailure) {
          this.#cancel(err);
        } else {
          this.fail(err);
        }
      } else {
        this.fail(new TestFailure(err, kTestCodeFailure));
      }
      try { await afterEach(); } catch { /* test is already failing, let's ignore the error */ }
      try { await after(); } catch { /* Ignore error. */ }
    } finally {
      stopPromise?.[kDispose]();

      // Do not abort hooks and the root test as hooks instance are shared between tests suite so aborting them will
      // cause them to not run for further tests.
      if (this.parent !== null) {
        this.abortController.abort();
      }
    }

    if (this.parent !== null || typeof this.hookType === "string") {
      // Clean up the test. Then, try to report the results and execute any
      // tests that were pending due to available concurrency.
      //
      // The root test is skipped here because it is a special case. Its
      // postRun() method is called when the process is getting ready to exit.
      // This helps catch any asynchronous activity that occurs after the tests
      // have finished executing.
      this.postRun();
    }
  }

  postRun(pendingSubtestsError) {
    // If the test was cancelled before it started, then the start and end
    // times need to be corrected.
    this.endTime ??= hrtime();
    this.startTime ??= this.endTime;

    // The test has run, so recursively cancel any outstanding subtests and
    // mark this test as failed if any subtests failed.
    this.pendingSubtests = [];
    let failed = 0;
    for (let i = 0; i < this.subtests.length; i++) {
      const subtest = this.subtests[i];

      if (!subtest.finished) {
        subtest.#cancel(pendingSubtestsError);
        subtest.postRun(pendingSubtestsError);
      }
      if (!subtest.passed && !subtest.isTodo) {
        failed++;
      }
    }

    if ((this.passed || this.parent === null) && failed > 0) {
      const subtestString = `subtest${failed > 1 ? "s" : ""}`;
      const msg = `${failed} ${subtestString} failed`;

      this.fail(new TestFailure(msg, kSubtestsFailed));
    }

    this.outerSignal?.removeEventListener("abort", this.#abortHandler);
    this.mock?.reset();

    if (this.parent !== null) {
      if (!this.filtered) {
        const report = this.getReportDetails();
        report.details.passed = this.passed;
        this.testNumber ||= ++this.parent.outputSubtestCount;
        this.reporter.complete(this.nesting, this.loc, this.testNumber, this.name, report.details, report.directive);
        this.parent.activeSubtests--;
      }

      this.parent.addReadySubtest(this);
      this.parent.processReadySubtestRange(false);
      this.parent.processPendingSubtests();
    } else if (!this.reported) {
      const { diagnostics, harness, loc, nesting, reporter } = this;

      this.reported = true;
      reporter.plan(nesting, loc, harness.counters.topLevel);

      for (let i = 0; i < diagnostics.length; i++) {
        reporter.diagnostic(nesting, loc, diagnostics[i]);
      }

      const duration = this.duration();
      reporter.diagnostic(nesting, loc, `tests ${harness.counters.tests}`);
      reporter.diagnostic(nesting, loc, `suites ${harness.counters.suites}`);
      reporter.diagnostic(nesting, loc, `pass ${harness.counters.passed}`);
      reporter.diagnostic(nesting, loc, `fail ${harness.counters.failed}`);
      reporter.diagnostic(nesting, loc, `cancelled ${harness.counters.cancelled}`);
      reporter.diagnostic(nesting, loc, `skipped ${harness.counters.skipped}`);
      reporter.diagnostic(nesting, loc, `todo ${harness.counters.todo}`);
      reporter.diagnostic(nesting, loc, `duration_ms ${duration}`);

      reporter.summary(nesting, loc?.file, harness.success, harness.counters, duration);
      reporter.end();
    }
  }

  isClearToSend() {
    return this.parent === null || (this.parent.waitingOn === this.childNumber && this.parent.isClearToSend());
  }

  finalize() {
    // By the time this function is called, the following can be relied on:
    // - The current test has completed or been cancelled.
    // - All of this test's subtests have completed or been cancelled.
    // - It is the current test's turn to report its results.

    // Report any subtests that have not been reported yet. Since all of the
    // subtests have finished, it's safe to pass true to
    // processReadySubtestRange(), which will finalize all remaining subtests.
    this.processReadySubtestRange(true);

    // Output this test's results and update the parent's waiting counter.
    this.report();
    this.parent.waitingOn++;
    this.finished = true;

    if (this.parent === this.root && this.root.waitingOn > this.root.subtests.length) {
      // At this point all of the tests have finished running. However, there
      // might be ref'ed handles keeping the event loop alive. This gives the
      // global after() hook a chance to clean them up.
      this.root.run();
    }
  }

  duration() {
    return this.endTime - this.startTime;
  }

  getReportDetails() {
    let directive;
    const details = { __proto__: null, duration_ms: this.duration() };

    if (this.skipped) {
      directive = this.reporter.getSkip(this.message);
    } else if (this.isTodo) {
      directive = this.reporter.getTodo(this.message);
    }

    if (this.reportedType) {
      details.type = this.reportedType;
    }
    if (!this.passed) {
      details.error = this.error;
    }
    return { __proto__: null, details, directive };
  }

  report() {
    countCompletedTest(this);
    if (this.outputSubtestCount > 0) {
      this.reporter.plan(this.subtests[0].nesting, this.loc, this.outputSubtestCount);
    } else {
      this.reportStarted();
    }
    const report = this.getReportDetails();

    if (this.passed) {
      this.reporter.ok(this.nesting, this.loc, this.testNumber, this.name, report.details, report.directive);
    } else {
      this.reporter.fail(this.nesting, this.loc, this.testNumber, this.name, report.details, report.directive);
    }

    for (let i = 0; i < this.diagnostics.length; i++) {
      this.reporter.diagnostic(this.nesting, this.loc, this.diagnostics[i]);
    }
  }

  reportStarted() {
    if (this.#reportedSubtest || this.parent === null) {
      return;
    }
    this.#reportedSubtest = true;
    this.parent.reportStarted();
    this.reporter.start(this.nesting, this.loc, this.name);
  }
}

class TestHook extends Test {
  reportedType = "hook";
  #args;
  constructor(fn, options) {
    const { hookType, loc, parent, timeout, signal } = options;
    super({ __proto__: null, fn, loc, timeout, signal, harness: parent.root.harness });
    this.parentTest = parent;
    this.hookType = hookType;
  }

  run(args) {
    if (this.error && !this.outerSignal?.aborted) {
      this.passed = false;
      this.error = null;
      this.abortController.abort();
      this.abortController = new AbortController();
      this.signal = this.abortController.signal;
    }

    this.#args = args;
    return super.run();
  }

  getRunArgs() {
    return this.#args;
  }

  postRun() {
    const { error, loc, parentTest: parent } = this;

    // Report failures in the root test's after() hook.
    if (error && parent === parent.root && this.hookType === "after") {
      if (isTestFailureError(error)) {
        error.failureType = kHookFailure;
      }

      this.endTime ??= hrtime();
      parent.reporter.fail(0, loc, parent.subtests.length + 1, loc?.file ?? parent.entryFile, {
        __proto__: null,
        duration_ms: this.duration(),
        error,
      }, undefined);
    }
  }
}

export class Suite extends Test {
  reportedType = "suite";
  constructor(options) {
    super(options);

    this.buildSuite = this.createBuild();
    this.fn = noop;
  }

  async createBuild() {
    try {
      const { ctx, args } = this.getRunArgs();
      const runArgs = [this.fn, ctx];
      runArgs.push(...args);
      await Reflect.apply(this.runInAsyncScope, this, runArgs);
    } catch (err) {
      this.fail(new TestFailure(err, kTestCodeFailure));
    }

    this.buildPhaseFinished = true;
  }

  getRunArgs() {
    const ctx = new SuiteContext(this);
    return { __proto__: null, ctx, args: [ctx] };
  }

  async run() {
    this.computeInheritedHooks();
    const hookArgs = this.getRunArgs();

    let stopPromise;
    const after = runOnce(() => this.runHook("after", hookArgs));
    try {
      this.parent.activeSubtests++;
      await this.buildSuite;
      this.startTime = hrtime();

      if (this[kShouldAbort]()) {
        this.subtests = [];
        this.postRun();
        return;
      }

      if (this.parent.hooks.before.length > 0) {
        await this.parent.runHook("before", this.parent.getRunArgs());
      }

      await this.runHook("before", hookArgs);

      stopPromise = stopTest(this.timeout, this.signal);
      const subtests = this.skipped || this.error ? [] : this.subtests;
      const promise = Promise.all(subtests.map((subtest) => subtest.start()));

      await Promise.race([promise, stopPromise]);
      await after();

      this.pass();
    } catch (err) {
      try { await after(); } catch { /* suite is already failing */ }
      if (isTestFailureError(err)) {
        this.fail(err);
      } else {
        this.fail(new TestFailure(err, kTestCodeFailure));
      }
    } finally {
      stopPromise?.[kDispose]();
    }

    this.postRun();
  }
}

function getFullName(test) {
  if (test === test.root) return test.name;

  let fullName = test.name;

  for (let t = test.parent; t !== t.root; t = t.parent) {
    fullName = `${t.name} > ${fullName}`;
  }

  return fullName;
}

// ---- The harness (lib/internal/test_runner/harness.js) ------------------------------------

let globalRoot;

function createTestTree(rootTestOptions, globalOptions) {
  const buildPhaseDeferred = Promise.withResolvers();
  const harness = {
    __proto__: null,
    buildPromise: buildPhaseDeferred.promise,
    buildSuites: [],
    isWaitingForBuildPhase: false,
    bootstrapPromise: Promise.resolve(),
    config: globalOptions,
    resetCounters() {
      harness.counters = {
        __proto__: null,
        tests: 0,
        failed: 0,
        passed: 0,
        cancelled: 0,
        skipped: 0,
        todo: 0,
        topLevel: 0,
        suites: 0,
      };
    },
    success: true,
    counters: null,
    teardown: null,
    async waitForBuildPhase() {
      if (harness.buildSuites.length > 0) {
        await Promise.all(harness.buildSuites);
      }

      buildPhaseDeferred.resolve();
    },
  };

  harness.resetCounters();
  globalRoot = new Test({ __proto__: null, ...rootTestOptions, harness, name: "<root>" });
  setupProcessState(globalRoot, globalOptions, harness);
  globalRoot.startTime = hrtime();
  return globalRoot;
}

function createProcessEventHandler(eventName, rootTest) {
  return (err) => {
    if (rootTest.harness.bootstrapPromise) {
      // Something went wrong during the asynchronous portion of bootstrapping
      // the test runner. Since the test runner is not setup properly, we can't
      // do anything but throw the error.
      throw err;
    }

    const test = testStorage.getStore();

    // Check if this error is coming from a test or test hook. If it is, fail the test.
    if (!test || test.finished || test.hookType) {
      // If the test is already finished or the resource that created the error
      // is not mapped to a Test, report this as a top level diagnostic.
      let msg;

      if (test) {
        const name = test.hookType ? `Test hook "${test.hookType}"` : `Test "${test.name}"`;
        msg = `Error: ${name} generated asynchronous ` +
          "activity after the test ended. This activity created the error " +
          `"${err}" and would have caused the test to fail, but instead ` +
          `triggered an ${eventName} event.`;
      } else {
        msg = "Error: A resource generated asynchronous activity after " +
          `the test ended. This activity created the error "${err}" which ` +
          `triggered an ${eventName} event, caught by the test runner.`;
      }

      rootTest.diagnostic(msg);
      rootTest.harness.success = false;
      process.exitCode = kGenericUserError;
      return;
    }

    test.fail(new TestFailure(err, eventName));
    test.abortController.abort();
  };
}

function setupProcessState(root) {
  const exceptionHandler = createProcessEventHandler("uncaughtException", root);
  const rejectionHandler = createProcessEventHandler("unhandledRejection", root);
  const exitHandler = async () => {
    if (root.subtests.length === 0 && (root.hooks.before.length > 0 || root.hooks.after.length > 0)) {
      // Run global before/after hooks in case there are no tests
      await root.run();
    }
    root.postRun(new TestFailure("Promise resolution is still pending but the event loop has already resolved", kCancelledByParent));

    process.removeListener("uncaughtException", exceptionHandler);
    process.removeListener("unhandledRejection", rejectionHandler);
    process.removeListener("beforeExit", exitHandler);
  };

  process.on("uncaughtException", exceptionHandler);
  process.on("unhandledRejection", rejectionHandler);
  process.on("beforeExit", exitHandler);

  root.harness.teardown = exitHandler;
}

function lazyBootstrapRoot() {
  if (!globalRoot) {
    // This is where the test runner is bootstrapped when node:test is used
    // without the --test flag or the run() API.
    const entryFile = process.argv?.[1];
    const globalOptions = { __proto__: null, only: false };
    createTestTree({ __proto__: null, entryFile }, globalOptions);
    globalRoot.reporter.on("test:summary", (data) => {
      if (!data.success) {
        process.exitCode = kGenericUserError;
      }
    });
    globalRoot.reporter.attach(process.stdout.isTTY ? new SpecReporter() : new TapReporter());
  }
  return globalRoot;
}

async function startSubtestAfterBootstrap(subtest) {
  if (subtest.root.harness.buildPromise) {
    if (subtest.root.harness.bootstrapPromise) {
      await subtest.root.harness.bootstrapPromise;
      subtest.root.harness.bootstrapPromise = null;
    }

    if (subtest.buildSuite) {
      subtest.root.harness.buildSuites.push(subtest.buildSuite);
    }

    if (!subtest.root.harness.isWaitingForBuildPhase) {
      subtest.root.harness.isWaitingForBuildPhase = true;
      queueMicrotask(() => {
        subtest.root.harness.waitForBuildPhase();
      });
    }

    await subtest.root.harness.buildPromise;
    subtest.root.harness.buildPromise = null;
  }

  await subtest.start();
}

/** test() or describe(): a test of the current test (or suite), or a top-level one. */
export function runInParentContext(Factory) {
  function run(name, options, fn, overrides) {
    const parent = testStorage.getStore() || lazyBootstrapRoot();
    const subtest = parent.createSubtest(Factory, name, options, fn, overrides);
    if (parent instanceof Suite) {
      return Promise.resolve();
    }

    return startSubtestAfterBootstrap(subtest);
  }

  const test = (name, options, fn) => run(name, options, fn, { __proto__: null });
  for (const keyword of ["skip", "todo", "only"]) {
    test[keyword] = (name, options, fn) => run(name, options, fn, { __proto__: null, [keyword]: true });
  }
  return test;
}

/** before(), after(), beforeEach() or afterEach() of the current test (or suite), or the root. */
export function hook(hook) {
  return (fn, options) => {
    const parent = testStorage.getStore() || lazyBootstrapRoot();
    parent.createHook(hook, fn, { __proto__: null, ...options, parent, hookType: hook });
  };
}

/** run(): Node's runner of test files, each in its own process. */
export function run() {
  throw codeError(Error, "ERR_VISALJS_UNSUPPORTED", "run() is not supported by visaljs yet: a compiled program runs its own tests");
}
