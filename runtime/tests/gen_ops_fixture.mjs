// Generates ops_fixture.txt: Node's results for every JS operator over a
// matrix of primitives, as ground truth for runtime/src/ops.c.
//
//   node runtime/tests/gen_ops_fixture.mjs > runtime/tests/ops_fixture.txt
//
// Tokens as in gen_console_fixture.mjs (u n t f d:<bits> s:<units>). Lines:
//   B <op> <a> <b> <result>      binary
//   U <op> <a> <result>          unary
import process from "node:process";

const buf = new DataView(new ArrayBuffer(8));
const hex = (s) => [...Array(s.length).keys()].map((i) => s.charCodeAt(i).toString(16).padStart(4, "0")).join("");
function token(v) {
  if (v === undefined) return "u";
  if (v === null) return "n";
  if (v === true) return "t";
  if (v === false) return "f";
  if (typeof v === "number") {
    buf.setFloat64(0, v);
    return `d:${buf.getBigUint64(0).toString(16).padStart(16, "0")}`;
  }
  return `s:${hex(v)}`;
}

const binaryValues = [
  undefined, null, true, false, 0, -0, 1, -1, 3, 0.5, -7.5, 2147483647, -2147483648, 2 ** 32 + 5, NaN, Infinity, -Infinity,
  "", "7", " 12 ", "0x10", "abc", "-0", "é",
];
const unaryValues = [...binaryValues, 2 ** 31, 2 ** 53 + 2, 1e21, -1e-7, "Infinity", "1e3", " ", "Ā", "b"];

const binary = {
  add: (a, b) => a + b, sub: (a, b) => a - b, mul: (a, b) => a * b, div: (a, b) => a / b, mod: (a, b) => a % b,
  exp: (a, b) => a ** b, shl: (a, b) => a << b, sar: (a, b) => a >> b, shr: (a, b) => a >>> b,
  bitand: (a, b) => a & b, bitor: (a, b) => a | b, bitxor: (a, b) => a ^ b,
  eq: (a, b) => a == b, ne: (a, b) => a != b, strict_eq: (a, b) => a === b, strict_ne: (a, b) => a !== b,
  lt: (a, b) => a < b, le: (a, b) => a <= b, gt: (a, b) => a > b, ge: (a, b) => a >= b,
};
const unary = {
  neg: (a) => -a, bitnot: (a) => ~a, to_number: (a) => +a, not: (a) => !a, to_boolean: (a) => !!a, typeof: (a) => typeof a,
  inc: (a) => +a + 1, dec: (a) => +a - 1, is_nullish: (a) => a == null,
};

const lines = [];
for (const [op, f] of Object.entries(binary))
  for (const a of binaryValues) for (const b of binaryValues) lines.push(`B\t${op}\t${token(a)}\t${token(b)}\t${token(f(a, b))}`);
for (const [op, f] of Object.entries(unary)) for (const a of unaryValues) lines.push(`U\t${op}\t${token(a)}\t${token(f(a))}`);
process.stdout.write(lines.join("\n") + "\n");
