// node:test: Node's test runner in a compiled program (lib/test.js; the runner
// is internal/test_runner/). test / it, describe / suite, the hooks, test contexts (subtests,
// plan, skip, todo, diagnostic, t.mock, t.assert, waitFor), mocks, and the tap and spec
// reporters. Not here: run() (a process per test file), snapshots, mock.timers and mock.module.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { notSupported } from "./internal/errors.js";
import { MockTracker } from "./internal/test_runner/mock.js";
import { hook, registerAssertion, run, runInParentContext, Suite, Test } from "./internal/test_runner/test.js";

const test = runInParentContext(Test);
const suite = runInParentContext(Suite);
const before = hook("before");
const after = hook("after");
const beforeEach = hook("beforeEach");
const afterEach = hook("afterEach");

let lazyMock;
const testAssert = { __proto__: null, register: registerAssertion };

Object.assign(test, {
  after,
  afterEach,
  before,
  beforeEach,
  describe: suite,
  it: test,
  run,
  suite,
  test,
});

Object.defineProperty(test, "mock", {
  configurable: true,
  enumerable: true,
  get() {
    lazyMock ??= new MockTracker();
    return lazyMock;
  },
});

const snapshot = {
  __proto__: null,
  setDefaultSnapshotSerializers() {
    throw notSupported("node:test's snapshots");
  },
  setResolveSnapshotPath() {
    throw notSupported("node:test's snapshots");
  },
};
Object.defineProperty(test, "snapshot", { configurable: true, enumerable: true, value: snapshot });

Object.defineProperty(test, "assert", { configurable: true, enumerable: true, value: testAssert });

export default test;
export { after, afterEach, before, beforeEach, suite as describe, test as it, run, snapshot, suite, test, testAssert as assert };
export const mock = test.mock;
