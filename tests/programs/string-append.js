// Append buffers: a string appended to in a loop continues in a buffer with room to
// grow, and each result is a slice of it. Older strings, other appends to them, reads, substrings
// and keys must all see the characters they had.
"use strict";

function build(n, unit) {
  let s = "";
  for (let i = 0; i < n; i++) s += unit(i);
  return s;
}
const letter = (i) => String.fromCharCode(97 + (i % 26));

/* a long append loop: in place, growing past several capacities */
const long = build(100000, letter);
console.log(long.length, long.slice(0, 30), long.slice(-5), long.charCodeAt(99999), long[50000]);

/* every older string keeps its characters */
let s = "";
const seen = [];
for (let i = 0; i < 60; i++) {
  s += letter(i);
  seen.push(s);
}
console.log(seen.map((x) => x.length).join(","), seen[20], seen[59]);

/* appending to an older string: a copy, never a write into the newer one's units */
const old = seen[30];
const fork1 = old + "X";
const fork2 = old + "YZ";
const newest = seen[59] + "!";
console.log(fork1.slice(-3), fork2.slice(-4), newest.slice(-3), seen[59].slice(-3), seen[31].slice(-2));

/* two appends to the same newest string */
let base = build(40, letter);
const a = base + "first";
const b = base + "second";
console.log(a.slice(-8), b.slice(-8), a.length, b.length);

/* appending a string to itself, and multi-unit appends */
let doubling = build(20, letter);
for (let i = 0; i < 6; i++) doubling += doubling;
console.log(doubling.length, doubling.slice(1275, 1285));
let words = "";
for (let i = 0; i < 50; i++) words += "word" + i + " ";
console.log(words.length, words.slice(0, 24), words.slice(-9));

/* Latin-1 then UTF-16 part way, and UTF-16 throughout */
let mixed = build(30, letter);
mixed += "日本";
for (let i = 0; i < 20; i++) mixed += i % 2 ? "é" : "語";
console.log(mixed.length, mixed.slice(28, 40), mixed.charCodeAt(30), mixed.charCodeAt(32));
const wide = build(40, (i) => String.fromCharCode(0x3040 + i));
console.log(wide.length, wide.slice(0, 5), wide.charCodeAt(39).toString(16));
const emoji = build(20, () => "😀");
console.log(emoji.length, [...emoji].length, emoji.codePointAt(38).toString(16));

/* prepending stays a rope; both sides */
let front = "";
for (let i = 0; i < 40; i++) front = letter(i) + front;
let both = "";
for (let i = 0; i < 40; i++) both = i % 2 ? both + letter(i) : letter(i) + both;
console.log(front.slice(0, 5), both.slice(0, 5), both.slice(-5));

/* substrings of a buffer string, equality, comparison, hashing and keys */
const t = build(64, letter);
const u = build(64, letter);
console.log(t === u, t < t + "a", t.slice(10, 40) === u.slice(10, 40), t.indexOf("xyz"), t.substring(26, 52) === t.substring(0, 26));
const obj = {};
obj[t] = 1;
obj[t.slice(0, 32)] = 2;
const map = new Map([[u, "found"]]);
console.log(obj[u], obj[u.slice(0, 32)], map.get(t), Object.keys(obj).length, JSON.stringify(t.slice(0, 15)));
const sub = t.slice(0, 64);
console.log(sub === t, (sub + "-").slice(-3), t.slice(-2));

/* a substring that is a whole prefix, then appended to */
let grow = build(50, letter);
const prefix = grow.substring(0, 50);
grow += "A";
const prefix2 = prefix + "B";
console.log(grow.slice(-3), prefix2.slice(-3), prefix.slice(-2));

/* through the generic paths: template literals, concat, join, replace, String() */
let generic = build(30, letter);
generic = `${generic}!`;
generic = generic.concat("?", "~");
generic += [1, 2, 3].join("");
console.log(generic.slice(-8), generic.replace(/a/g, "A").slice(0, 30), String(generic).length);

/* many buffers alive across garbage collections */
const kept = [];
for (let k = 0; k < 200; k++) {
  let x = "";
  for (let i = 0; i < 300; i++) x += letter(i + k);
  kept.push(x);
}
let check = 0;
for (const x of kept) for (let i = 0; i < x.length; i += 7) check = (check * 31 + x.charCodeAt(i)) | 0;
console.log(kept.length, kept[199].slice(0, 6), check);

/* ToInt32 of doubles past 2^31 */
console.log([2 ** 31, 2 ** 32 + 5, -(2 ** 33) - 1, 2 ** 62 + 2 ** 40, 2 ** 63, -(2 ** 63), 2 ** 70 + 2 ** 20, 1e300, -1.5e10, NaN, Infinity].map((d) => d | 0).join(","));
