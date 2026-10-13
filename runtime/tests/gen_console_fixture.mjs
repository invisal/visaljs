// Generates console_fixture.txt: Node's util.format (what console.log prints)
// and parseInt/parseFloat, as ground truth for the bootstrap console.
//
//   node runtime/tests/gen_console_fixture.mjs > runtime/tests/console_fixture.txt
//
// One case per line, tab-separated. Values are tokens:
//   u  n  t  f       undefined, null, true, false
//   d:<16 hex>       a number, by its bits
//   s:<hex units>    a string, 4 hex digits per UTF-16 code unit
// Lines:
//   F <args, comma-separated tokens> <expected, hex units>     util.format(...args)
//   P <string token> <d: token>                                 parseFloat(s)
//   I <radix> <string token> <d: token>                         parseInt(s, radix)
import process from "node:process";
import { format } from "node:util";

const buf = new DataView(new ArrayBuffer(8));
const hexUnits = (s) => [...Array(s.length).keys()].map((i) => s.charCodeAt(i).toString(16).padStart(4, "0")).join("");
function token(v) {
  if (v === undefined) return "u";
  if (v === null) return "n";
  if (v === true) return "t";
  if (v === false) return "f";
  if (typeof v === "number") {
    buf.setFloat64(0, v);
    return `d:${buf.getBigUint64(0).toString(16).padStart(16, "0")}`;
  }
  if (typeof v === "string") return `s:${hexUnits(v)}`;
  throw new Error(`no token for ${typeof v}`);
}

const numbers = [0, -0, 1, -1, 42, 1.5, -2.25, NaN, Infinity, -Infinity, 1e21, 1e-7, 5e-7, 2 ** 31, 0.1 + 0.2, 123456789];
const strings = [
  "", "abc", "it's", 'say "hi"', "both ' and \"", "all ' \" `", "${x} '\"", "tab\there", "nl\nx",
  "\x00\x08\x0b\x1b\x7f\x85\x9f\xa0", "\\back", "é", "αβ", "😀", "\ud800", "x\udc00", "\udbff\udbff",
  "  42  ", "0x1f", "0X10", "12px", "-0", "+7", "1e3", "1e", ".5", "-.5e-3x", "Infinity", "-Infinityx", "   ﻿3.5",
  "100%", "%", "%%", "%s", "%d%", "0b11", "1_000", "٣",
];
const primitives = [undefined, null, true, false, ...numbers, ...strings];

const lines = [];
const F = (...args) => lines.push(`F\t${args.map(token).join(",")}\t${hexUnits(format(...args))}`);

for (const p of primitives) F(p);
for (const spec of ["%s", "%d", "%i", "%f", "%j", "%o", "%O", "%c"]) {
  for (const p of primitives) F(spec, p);
  F(`<${spec}>`);                 // no argument left: kept as is
  F(`a${spec}b${spec}c`, 1);      // one argument for two specifiers
}
F("%%");
F("%%", 1);
F("100%", 1);
F("%", 1);
F("%x %s %", 1, 2);
F("%%s %s", "a", "b");
F("a%sb%dc", "x", 5, "extra", 7, null, "q'");
F(1, "a", 2, "b", -0, "it's");
F("", "");
F(undefined, "x");
for (let i = 0; i < primitives.length; i += 3) F(primitives[i], primitives[(i * 7 + 5) % primitives.length]);

const parseInputs = [...strings, "123456789012345678901234567890", "0x", "0xg", "-0x10", "  -12.9e3", "z", "ZZ", "1010102", "0.0000001"];
for (const s of parseInputs) {
  lines.push(`P\t${token(s)}\t${token(Number.parseFloat(s))}`);
  for (const r of [0, 10, 16, 2, 36, 8, 1, 37])
    lines.push(`I\t${r}\t${token(s)}\t${token(Number.parseInt(s, r))}`);
}

process.stdout.write(lines.join("\n") + "\n");
