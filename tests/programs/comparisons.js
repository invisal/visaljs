// Comparisons the optimizer turns into C tests (specialize): === against undefined, null and
// string literals, == null, typeof x === "…", and === where the operands can't both be
// compared by content, and === a number literal. Each against values that would tell a wrong shortcut.
"use strict";
const values = [
  undefined, null, true, false, 0, -0, 1, 1.5, NaN, "", "error", "err" + "or".repeat(1), "0", 1e20, 1n, 10n ** 20n,
  Symbol.for("s"), {}, [], () => 1, class {}, new Proxy(function () {}, {}), new Proxy({}, {}),
  { valueOf() { throw new Error("valueOf called"); } },
];
const names = (v) => (typeof v === "symbol" ? v.toString() : typeof v === "bigint" ? v + "n" : Object.is(v, -0) ? "-0" : typeof v === "function" ? "fn" : v && typeof v === "object" ? "obj" : String(v));
const rows = [];
for (const v of values) {
  rows.push([
    names(v),
    v === undefined, v !== undefined, v === null, v == null, v != undefined,
    v === "error", v !== "error", "error" === v,
    typeof v === "function", typeof v === "object", typeof v !== "string", typeof v == "number",
    typeof v === "bigint", typeof v === "symbol", typeof v === "boolean", typeof v === "undefined", typeof v === "nope",
    v === 0, v === -0, v !== 1.5, 1 === v, v === 10 ** 20,
  ].map((x) => (x === true ? 1 : x === false ? 0 : x)).join(""));
}
console.log(rows.join("\n"));
// identity of objects and symbols; numbers and strings by content
const o = {};
const s = Symbol("x");
const same = (a, b) => a === b;
console.log(same(o, o), same(o, {}), same(s, s), same(s, Symbol("x")), same(NaN, NaN), same(0, -0), same(1n, 1n), same("ab", "a" + "b".repeat(1)));
