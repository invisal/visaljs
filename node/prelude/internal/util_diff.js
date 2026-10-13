// util.diff: the edits between two strings or arrays, by Myers's algorithm. Linked into programs
// that name it (internal/features.js).
import { invalidArgType } from "./errors.js";
import { features } from "./features.js";

/** The edits from expected to actual (strings by character, or arrays by element): [op, value],
 *  op 0 for both, 1 for actual's, -1 for expected's. Myers's algorithm, as node:assert's. */
function diff(actual, expected) {
  if (actual === expected) return [];
  if (typeof actual !== "string" && !Array.isArray(actual)) throw invalidArgType("actual", "of type string or an instance of Array", actual);
  if (typeof expected !== "string" && !Array.isArray(expected)) throw invalidArgType("expected", "of type string or an instance of Array", expected);
  const n = actual.length;
  const m = expected.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 1);
  const trace = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    trace.push(new Int32Array(v));
    for (let k = -d; k <= d; k += 2) {
      const offset = k + max;
      let x = k === -d || (k !== d && v[offset - 1] < v[offset + 1]) ? v[offset + 1] : v[offset - 1] + 1;
      let y = x - k;
      while (x < n && y < m && actual[x] === expected[y]) {
        x++;
        y++;
      }
      v[offset] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
  }
  /* back from the end */
  const result = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const tv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && tv[k - 1 + max] < tv[k + 1 + max]) ? k + 1 : k - 1;
    const prevX = tv[prevK + max];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      result.push([0, actual[x - 1]]);
      x--;
      y--;
    }
    if (d > 0) {
      if (x > prevX) {
        result.push([1, actual[x - 1]]);
        x--;
      } else {
        result.push([-1, expected[y - 1]]);
        y--;
      }
    }
  }
  return result.reverse();
}

features.diff = diff;
