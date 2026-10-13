// Word statistics over a text: generators, closures, destructuring, labeled loops and switch.
const text = "The quick brown fox jumps over the lazy dog. The dog sleeps; the fox runs!\n" +
  "A quick brown dog? No - a quick red fox. It's 2026, and the fox is still quick.";

function* words(s) {
  let start = -1;
  for (let i = 0; i <= s.length; i++) {
    const c = i < s.length ? s.charCodeAt(i) : 32;
    const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 39 || (c >= 48 && c <= 57);
    if (letter && start < 0) start = i;
    else if (!letter && start >= 0) {
      yield s.slice(start, i);
      start = -1;
    }
  }
}

function lower(w) {
  let out = "";
  for (let i = 0; i < w.length; i++) {
    const c = w.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : w.charAt(i);
  }
  return out;
}

const counts = Object.create(null);
let total = 0, longest = "";
for (const w of words(text)) {
  const key = lower(w);
  counts[key] = (counts[key] || 0) + 1;
  total++;
  if (w.length > longest.length) longest = w;
}

/* the top entries, by a selection pass (no Array.prototype.sort needed) */
const entries = Object.keys(counts).map((k) => [k, counts[k]]);
const top = [];
outer: for (let n = 0; n < 5; n++) {
  let best = -1;
  for (let i = 0; i < entries.length; i++) {
    if (top.indexOf(entries[i]) !== -1) continue;
    if (best < 0 || entries[i][1] > entries[best][1]) best = i;
  }
  if (best < 0) break outer;
  top.push(entries[best]);
}
console.log({ total, distinct: entries.length, longest });
console.table(top.map(([word, count]) => ({ word, count })));

function classify(w) {
  switch (lower(w).charAt(0)) {
    case "a": case "e": case "i": case "o": case "u": return "vowel";
    case "": return "empty";
    default:
      return w.charCodeAt(0) >= 48 && w.charCodeAt(0) <= 57 ? "number" : "consonant";
  }
}
const kinds = { vowel: 0, consonant: 0, number: 0 };
for (const w of words(text)) kinds[classify(w)]++;
console.log(kinds);

const makeCounter = (start = 0, step = 1) => {
  let n = start;
  return { next: () => (n += step), reset() { n = start; } };
};
const c = makeCounter(10, 5);
console.log([c.next(), c.next(), (c.reset(), c.next())]);
const [first, , third = "none", ...rest] = [...words("one two")];
console.log(first, third, rest, [..."héllo"].length);
