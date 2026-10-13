// node:assert/strict: node:assert's strict variant, whose equal, deepEqual,
// notEqual and notDeepEqual are the strict ones.
import assert from "./assert.js";

const strict = assert.strict;
export default strict;
export const {
  AssertionError, Assert, CallTracker, ok, fail, equal, notEqual, deepEqual, notDeepEqual, deepStrictEqual,
  notDeepStrictEqual, strictEqual, notStrictEqual, partialDeepStrictEqual, match, doesNotMatch, throws, rejects,
  doesNotThrow, doesNotReject, ifError,
} = strict;
export { strict };
