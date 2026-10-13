// Generates jsnum_fixture.txt: Node's number <-> string conversions as ground truth.
//
//   node runtime/tests/gen_jsnum_fixture.mjs > runtime/tests/jsnum_fixture.txt
//
// Deterministic (seeded). One case per line, tab-separated, doubles as 16 hex digits of their bits:
//   S <bits> <String(x)>
//   R <bits> <radix> <x.toString(radix)>
//   F <bits> <digits> <x.toFixed(digits)>
//   P <bits> <digits> <x.toPrecision(digits)>
//   E <bits> <digits|-1> <x.toExponential(digits)>      -1 means toExponential()
//   N <utf16 code units as hex, 4 digits each> <bits of Number(s)>

import process from "node:process";

const buf = new DataView(new ArrayBuffer(8));
const bitsOf = (d) => (buf.setFloat64(0, d), buf.getBigUint64(0).toString(16).padStart(16, "0"));
const fromBits = (b) => (buf.setBigUint64(0, b), buf.getFloat64(0));

// splitmix64
let state = 0x6a736e6174697665n;
const M64 = (1n << 64n) - 1n;
function next64() {
  state = (state + 0x9e3779b97f4a7c15n) & M64;
  let z = state;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  return z ^ (z >> 31n);
}
const randInt = (n) => Number(next64() % BigInt(n));
const pick = (xs) => xs[randInt(xs.length)];

// ---- doubles ----
const doubles = [
  0, -0, NaN, Infinity, -Infinity, 1, -1, 0.1, 0.2, 0.3, 1 / 3, 2 / 3, Math.PI, Math.E,
  5e-324, -5e-324, 2.2250738585072014e-308, 2.225073858507201e-308, Number.MAX_VALUE, -Number.MAX_VALUE,
  Number.EPSILON, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 2 ** 53 + 2,
  2 ** 31 - 1, -(2 ** 31), 2 ** 31, -(2 ** 31) - 1, 2 ** 32, 2 ** 32 - 1,
  1e21, 1e21 - 65536, 999999999999999900000, 1e-6, 1e-7, 0.000001234, 1.234e-7,
  123456789012345680000, 1.7976931348623157e308, 4.35, 1.005, 1.45, 2.5, 0.5, 1.5, -2.5, 1.255, 8.345,
  1e100, 1e-100, 123.456, -123.456, 25, 255, 0.0625, 1 / 1024,
];
for (let e = -330; e <= 310; e += 7) doubles.push(10 ** e, 2 ** Math.max(-1074, Math.min(1023, e * 3)));
for (let i = 0; i < 400; i++) {
  const d = fromBits(next64()); // uniform bit patterns: every exponent, subnormals, NaNs
  doubles.push(d);
}
for (let i = 0; i < 400; i++) {
  // "human" numbers: few significant digits, moderate exponents, halfway cases
  const digits = 1 + randInt(17);
  let m = "";
  for (let j = 0; j < digits; j++) m += randInt(10);
  const e = randInt(60) - 30;
  const d = Number(`${pick(["", "-"])}${m}e${e}`);
  doubles.push(d, d + 0.5, Math.round(d));
}
for (let i = 0; i < 150; i++) doubles.push(randInt(2 ** 31) - 2 ** 30, randInt(2 ** 53));

const lines = [];
const digitChoices = () => [randInt(21), pick([0, 1, 2, 3, 5, 10, 20, 50, 100])];
for (const d of doubles) {
  const b = bitsOf(d);
  lines.push(`S\t${b}\t${String(d)}`);
  for (const r of [pick([2, 3, 7, 8, 12, 16, 20, 32, 36])]) lines.push(`R\t${b}\t${r}\t${d.toString(r)}`);
  for (const f of new Set(digitChoices())) lines.push(`F\t${b}\t${f}\t${d.toFixed(f)}`);
  for (const p of new Set(digitChoices().map((p) => Math.max(1, p)))) lines.push(`P\t${b}\t${p}\t${d.toPrecision(p)}`);
  lines.push(`E\t${b}\t-1\t${d.toExponential()}`);
  const x = randInt(21);
  lines.push(`E\t${b}\t${x}\t${d.toExponential(x)}`);
}

// Every power of two: the asymmetric-gap case (dtoa.c patch 3).
for (let e = -1074; e <= 1023; e++) lines.push(`S\t${bitsOf(2 ** e)}\t${String(2 ** e)}`);

// ---- strings ----
const hex = (s) => [...Array(s.length).keys()].map((i) => s.charCodeAt(i).toString(16).padStart(4, "0")).join("");
const strings = [
  "", " ", "\t\n\v\f\r         　﻿", "0", "-0", "+0", "00", "010",
  "1", "-1", "+1", "1.", ".5", "-.5", "+.5", ".", "-", "+", "e5", "1e", "1e+", "1e-5", "1E5", "1e400", "-1e400",
  "1e-400", "0x10", "0X1f", "-0x10", "+0x10", "0x", "0xg", "0o17", "0O8", "0b101", "0B2", "0b", "0o",
  "Infinity", "+Infinity", "-Infinity", "infinity", "Inf", "INFINITY", "Infinityx", "NaN", "1_000", "1n",
  "12abc", "  42  ", " 42﻿", "4 2", "٠", "１", "0.1", "0.30000000000000004",
  "9007199254740993", "179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497791",
  "2.4703282292062327e-324", "2.4703282292062328e-324", "4.9406564584124654e-324", "0x1fffffffffffff", "0x20000000000001",
  "1".repeat(400), "0." + "0".repeat(300) + "1", "00000000000000000000000000000000000000001.5",
];
for (let i = 0; i < 600; i++) {
  const d = doubles[randInt(doubles.length)];
  strings.push(pick([String(d), d.toExponential(), d.toPrecision(1 + randInt(21)), String(d).toUpperCase(), ` ${d}\n`]));
}
for (const s of strings) lines.push(`N\t${hex(s)}\t${bitsOf(Number(s))}`);

process.stdout.write(lines.join("\n") + "\n");
