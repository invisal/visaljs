// node:assert and node:assert/strict: each assertion passing and failing, the AssertionError's
// message (Node's diffs), code, operator, actual / expected and generatedMessage; throws and
// rejects with every kind of expectation; deep equality's corners; util.isDeepStrictEqual
import assert, { AssertionError, deepStrictEqual, strictEqual } from "node:assert";
import strict from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

process.noDeprecation = true;  /* Node's warnings name the process id */
const log = (...args) => console.log(...args);

log("exports:", Object.keys(assert).sort().join(", "));
log("strict exports:", Object.keys(strict).sort().join(", "));
log("same:", assert.ok === assert, assert.strict === strict, strict.strict === strict, strictEqual === assert.strictEqual,
  strict.equal === assert.strictEqual, strict.deepEqual === assert.deepStrictEqual, deepStrictEqual === strict.deepStrictEqual);

/* an assertion's failure, as a test runner shows it */
function failure(name, fn) {
  try {
    fn();
    log(`${name}: passed`);
  } catch (e) {
    log(`${name}: ${e.name} [${e.code}] ${e instanceof AssertionError ? `operator=${e.operator} generated=${e.generatedMessage}` : ""}`);
    log(e.message);
    log("--");
  }
}

/* passing */
assert(1);
assert.ok("x", "a message");
assert.equal(1, "1");
assert.equal(NaN, NaN);
assert.notEqual(1, 2);
assert.strictEqual(NaN, NaN);
assert.notStrictEqual(0, -0);
assert.deepEqual({ a: [1, 2], b: "3" }, { a: [1, 2], b: 3 });
assert.deepStrictEqual({ a: [1, { b: new Map([[1, new Set([2])]]) }] }, { a: [1, { b: new Map([[1, new Set([2])]]) }] });
assert.notDeepStrictEqual({ a: 1 }, { a: "1" });
assert.notDeepEqual({ a: 1 }, { a: 2 });
assert.match("abc", /b/);
assert.doesNotMatch("abc", /x/);
assert.ifError(null);
assert.ifError(undefined);
assert.partialDeepStrictEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } });
log("passing assertions: ok");

/* failing, with Node's messages */
failure("ok(0, message)", () => assert.ok(0, "zero is falsy"));
failure("ok()", () => assert.ok());
failure("ok(false, Error)", () => assert.ok(false, new TypeError("my own")));
failure("equal", () => assert.equal(1, 2));
failure("equal message", () => assert.equal(1, 2, "one is not two"));
failure("notEqual", () => assert.notEqual("1", 1));
failure("strictEqual numbers", () => assert.strictEqual(1, 2));
failure("strictEqual 0 and -0", () => assert.strictEqual(0, -0));
failure("strictEqual strings", () => assert.strictEqual("hello world, this is long", "hello there, this is long"));
failure("strictEqual multiline", () => assert.strictEqual("a\nb\nc", "a\nB\nc"));
failure("strictEqual objects", () => assert.strictEqual({ a: 1 }, { a: 1 }));
failure("strictEqual types", () => assert.strictEqual(1, "1"));
failure("notStrictEqual", () => assert.notStrictEqual(5, 5));
failure("notStrictEqual object", () => { const o = { a: 1 }; assert.notStrictEqual(o, o); });
failure("deepEqual", () => assert.deepEqual({ a: 1 }, { a: 2 }));
failure("notDeepEqual", () => assert.notDeepEqual({ a: 1 }, { a: 1 }));
failure("deepStrictEqual objects", () => assert.deepStrictEqual({ a: 1, b: [1, 2, 3], c: { d: "e" } }, { a: 1, b: [1, 2, 4], c: { d: "e" } }));
failure("deepStrictEqual long", () => assert.deepStrictEqual(
  Array.from({ length: 20 }, (_, i) => i), Array.from({ length: 20 }, (_, i) => (i === 15 ? -1 : i))));
failure("deepStrictEqual types", () => assert.deepStrictEqual([1, 2], ["1", 2]));
failure("deepStrictEqual prototypes", () => assert.deepStrictEqual(Object.create(null), {}));
failure("deepStrictEqual same shape", () => assert.deepStrictEqual(new (class A {})(), new (class A {})()));
failure("deepStrictEqual message", () => assert.deepStrictEqual([1], [2], "arrays differ"));
failure("notDeepStrictEqual", () => assert.notDeepStrictEqual({ a: [1] }, { a: [1] }));
failure("partialDeepStrictEqual", () => assert.partialDeepStrictEqual({ a: 1, b: 2 }, { a: 1, c: 3 }));
failure("match", () => assert.match("abc", /x/));
failure("match non-string", () => assert.match(123, /x/));
failure("doesNotMatch", () => assert.doesNotMatch("abc", /b/));
failure("ifError", () => assert.ifError(new Error("from a callback")));
failure("ifError value", () => assert.ifError("oops"));
failure("fail()", () => assert.fail());
failure("fail(message)", () => assert.fail("boom"));
failure("fail(Error)", () => assert.fail(new RangeError("as is")));
failure("missing args", () => assert.strictEqual(1));
failure("strict.equal", () => strict.equal(1, "1"));
failure("strict.deepEqual", () => strict.deepEqual({ a: 1 }, { a: "1" }));

/* throws: no throw, classes, regular expressions, validation objects and functions */
failure("throws: none", () => assert.throws(() => {}));
failure("throws: none with message", () => assert.throws(() => {}, TypeError, "should have thrown"));
assert.throws(() => { throw new TypeError("bad thing"); }, TypeError);
assert.throws(() => { throw new TypeError("bad thing"); }, /bad/);
assert.throws(() => { throw new TypeError("bad thing"); }, { name: "TypeError", message: "bad thing" });
assert.throws(() => { throw new TypeError("bad thing"); }, { message: /bad/ });
assert.throws(() => { throw new TypeError("bad thing"); }, (e) => e instanceof TypeError && /thing/.test(e.message));
assert.throws(() => { throw new TypeError("bad thing"); }, new TypeError("bad thing"));
log("throws: ok");
failure("throws: wrong class", () => assert.throws(() => { throw new TypeError("bad"); }, RangeError));
failure("throws: wrong regexp", () => assert.throws(() => { throw new Error("bad"); }, /good/));
failure("throws: wrong object", () => assert.throws(() => { throw Object.assign(new Error("bad"), { code: "E1" }); }, { code: "E2", message: "bad" }));
failure("throws: validation false", () => assert.throws(() => { throw new Error("bad"); }, function check() { return false; }));
failure("throws: empty object", () => assert.throws(() => { throw new Error("x"); }, {}));
failure("throws: not a function", () => assert.throws("nope"));
failure("throws: primitive thrown", () => assert.throws(() => { throw "a string"; }, { message: "x" }));
failure("doesNotThrow", () => assert.doesNotThrow(() => { throw new Error("thrown"); }));
failure("doesNotThrow message", () => assert.doesNotThrow(() => { throw new Error("thrown"); }, "it threw"));
failure("doesNotThrow other class", () => assert.doesNotThrow(() => { throw new TypeError("rethrown"); }, RangeError));
failure("ambiguous", () => assert.throws(() => { throw new Error("same"); }, "same"));

/* deep equality's corners */
const cyclic1 = { name: "a" }; cyclic1.self = cyclic1;
const cyclic2 = { name: "a" }; cyclic2.self = cyclic2;
const sym = Symbol("s");
const sparse = [1, , 3];
const cases = [
  ["NaN", NaN, NaN],
  ["0 / -0", 0, -0],
  ["cycles", cyclic1, cyclic2],
  ["dates", new Date(0), new Date(0)],
  ["dates differ", new Date(0), new Date(1)],
  ["regexps", /a/gi, /a/gi],
  ["regexp flags", /a/g, /a/i],
  ["boxed", new Number(1), new Number(1)],
  ["boxed vs primitive", new String("a"), "a"],
  ["errors", new Error("x"), new Error("x")],
  ["error messages", new Error("x"), new Error("y")],
  ["typed arrays", new Uint8Array([1, 2]), new Uint8Array([1, 2])],
  ["typed array kinds", new Uint8Array([1]), new Int8Array([1])],
  ["array buffers", new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer],
  ["sets of objects", new Set([{ a: 1 }, { b: 2 }]), new Set([{ b: 2 }, { a: 1 }])],
  ["maps with object keys", new Map([[{ k: 1 }, "v"]]), new Map([[{ k: 1 }, "v"]])],
  ["symbol keys", { [sym]: 1 }, { [sym]: 1 }],
  ["symbol keys differ", { [sym]: 1 }, { [sym]: 2 }],
  ["sparse", sparse, [1, , 3]],
  ["sparse vs undefined", sparse, [1, undefined, 3]],
  ["array extra keys", Object.assign([1], { x: 1 }), [1]],
  ["key order", { a: 1, b: 2 }, { b: 2, a: 1 }],
  ["URLs", new URL("https://a.example/x"), new URL("https://a.example/x")],
  ["weak maps", new WeakMap(), new WeakMap()],
];
for (const [name, a, b] of cases) log(`${name}: strict ${isDeepStrictEqual(a, b)}, loose ${(() => { try { assert.deepEqual(a, b); return true; } catch { return false; } })()}`);
failure("deepStrictEqual cyclic", () => assert.deepStrictEqual(cyclic1, { name: "b", self: cyclic1 }));
failure("deepStrictEqual sets", () => assert.deepStrictEqual(new Set([1, 2, 3]), new Set([1, 2, 4])));
failure("deepStrictEqual maps", () => assert.deepStrictEqual(new Map([["a", 1]]), new Map([["a", 2]])));
failure("deepStrictEqual getters", () => assert.deepStrictEqual({ get x() { return 1; } }, { x: 2 }));

/* AssertionError itself */
const made = new AssertionError({ actual: 1, expected: 2, operator: "strictEqual" });
log("constructed:", made.name, made.code, made.message.split("\n")[0], made.actual, made.expected, made.operator, made.generatedMessage, String(made));
failure("AssertionError without options", () => new AssertionError());
const custom = new AssertionError({ message: "custom", actual: [1], expected: [2], operator: "deepEqual" });
log("custom:", custom.message, custom.generatedMessage);

/* an Assert instance: strict by default, or loose */
const loose = new assert.Assert({ strict: false });
loose.equal(1, "1");
const byDefault = new assert.Assert();
failure("Assert strict equal", () => byDefault.equal(1, "1"));
failure("Assert without new", () => assert.Assert());
failure("Assert bad diff", () => new assert.Assert({ diff: "huge" }));

/* CallTracker */
const tracker = new assert.CallTracker();
const twice = tracker.calls((x) => x * 2, 2);
log("tracked call:", twice(4));
log("calls:", JSON.stringify(tracker.getCalls(twice)));
log("report:", JSON.stringify(tracker.report().map((r) => r.message)));
failure("verify", () => tracker.verify());
twice(1);
tracker.verify();
log("verified");

/* rejects and doesNotReject */
await assert.rejects(Promise.reject(new TypeError("async bad")), TypeError);
await assert.rejects(async () => { throw new Error("async"); }, /async/);
await assert.doesNotReject(Promise.resolve(1));
for (const [name, run] of [
  ["rejects: resolved", () => assert.rejects(Promise.resolve(1))],
  ["rejects: wrong class", () => assert.rejects(Promise.reject(new TypeError("x")), RangeError)],
  ["rejects: not a promise", () => assert.rejects(() => 5)],
  ["rejects: bad argument", () => assert.rejects(5)],
  ["doesNotReject", () => assert.doesNotReject(Promise.reject(new Error("rejected")))],
]) {
  try {
    await run();
    log(`${name}: passed`);
  } catch (e) {
    log(`${name}: ${e.name} [${e.code}]`);
    log(e.message);
    log("--");
  }
}
log("done");
