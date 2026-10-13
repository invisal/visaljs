// Long substrings share their parent's characters (slices): every string operation
// must see them like any other string
const base = "The quick brown fox jumps over the lazy dog, again and again.";
const wide = "Ünïcødé — “quotes” and emoji 😀 in a UTF-16 parent string";
const a = base.slice(4), b = base.substring(4, 40), c = a.slice(6, 30);  // a slice of a slice
console.log(a, "|", b, "|", c, a.length, b.length, c.length);
console.log(c === base.slice(10, 34), c == "brown fox jumps over the", [c].includes(base.substr(10, 24)));
const w = wide.slice(2), w2 = w.slice(1, 30), latinPart = wide.slice(8, 40);
console.log(w, "|", w2, "|", latinPart, latinPart === " — “quotes” and emoji 😀 in a U".slice(0, 32));
console.log(w.charCodeAt(0), w.codePointAt(w.indexOf("😀")), latinPart.toUpperCase(), [...w2].length);
// as property keys (atomized), in Maps and Sets (hashed), concatenated (ropes over slices)
const o = {}, key = base.slice(4, 30);
o[key] = 1;
o["quick brown fox jumps over"] += 1;
const m = new Map([[base.slice(0, 20), "x"]]);
console.log(o, Object.keys(o)[0] === key, m.get("The quick brown fox "), new Set([a, base.slice(4)]).size);
const joined = a + "|" + b + "|" + w;
console.log(joined.length, joined.slice(50, 70), (b + c).split(" ").length, JSON.stringify(c), `${w2}!`);
console.log(a < b, b.localeCompare(c) !== 0, a.startsWith("quick"), a.endsWith("again."), a.trim() === a, a.at(-1));
// a tokenizer cutting its input from the front: linear, not quadratic
let src = base.repeat(20000), tokens = 0;
while (src.length) {
  const m = /^\S+\s*/.exec(src) ?? /^\s+/.exec(src);
  src = src.substring(m[0].length);
  tokens++;
}
console.log(tokens);
// `^` without m only matches at index 0, whatever lastIndex says
const show = (re, s, li) => {
  if (li !== undefined) re.lastIndex = li;
  const r = re.exec(s);
  console.log(String(re), JSON.stringify(s), li, r && [r.index, r[0]], re.lastIndex);
};
show(/^a/, "xa"); show(/^a/, "ab"); show(/^a/g, "aa", 1); show(/^a/g, "aa", 0); show(/^a/y, "aa", 1);
show(/^a|b/, "xb"); show(/^(?:a|b)c/, "bc"); show(/^(?:a|b)c/, "xbc"); show(/^a/m, "x\na"); show(/(?=^)a/, "a");
show(/^$/, ""); show(/^/g, "abc", 2); show(new RegExp("^\\s*x", "i"), "  X"); show(new RegExp("^\\s*x"), "y  x");
console.log("a\nb".replace(/^/gm, ">"), "aaa".replace(/^a/g, "b"), "x".split(/^/), "abc".match(/^b/), "ab".search(/^b/));
