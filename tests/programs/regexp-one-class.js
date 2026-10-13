// Patterns of one character or one class of characters (matched without the regexp engine), and
// their near neighbours that keep it: every RegExp and String method, against Node
const patterns = [
  /["'&<>]/, /["'&<>]/g, /[,;]/, /,/, /a/g, /[^a-z]/, /[^a-z]/g, /[a-c-]/, /[-x]/, /[\d]/, /\d/g, /\w/, /[^\w]/g,
  /[\n\r\t]/g, /[\x41-\x43]/, /\x2c/, /\./, /[.]/g, /[\]\]/g, /[]/, /[^]/g, /[\b]/, /\0/, /[é]/, /[^é]/g, /\//,
  /x/y, /[xy]/gy, /[&<]/d, /[ab]/m, /[ab]/s,
  /[A-Z]/i, /[a]/u, /[^a]/u, /a|b/, /[ab]+/, /^a/, /\bx/, /(a)/, /[日本]/, /[\d-z]/,
];
const strings = ["", "plain text", "<a href=\"x\">Tom & Jerry's</a>", "a,b;c", "ABC abc 123", "x.y/z\]", "é日本😀é", "\0\b\n", "xxy"];
for (const re of patterns) {
  const out = [];
  for (const s of strings) {
    re.lastIndex = 0;
    const m = re.exec(s);
    out.push(m === null ? "-" : `${m.index}:${JSON.stringify(m[0])}${m.indices ? `@${m.indices[0]}` : ""}/${re.lastIndex}`);
    re.lastIndex = 0;
    out.push(re.test(s) ? "T" : "F", s.search(re), JSON.stringify(s.replace(re, "#")), s.split(re).length);
    if (re.global) out.push(JSON.stringify(s.match(re)), JSON.stringify(s.replaceAll(re, (c) => `[${c}]`)), [...s.matchAll(re)].map((x) => x.index).join(","));
  }
  console.log(String(re), out.join(" "));
}
/* lastIndex: a global regexp continues from it, a sticky one only matches there */
const g = /[<>]/g, y = /[<>]/y, s = "a<b>c";
const steps = [];
for (let i = 0; i < 4; i++) steps.push(`${g.exec(s)?.index ?? null}/${g.lastIndex}`);
for (const at of [0, 1, 3, 9]) { y.lastIndex = at; steps.push(`${y.exec(s)?.index ?? null}/${y.lastIndex}`); }
console.log(steps.join(" "));
/* new RegExp and compile() set the matcher again */
const r = new RegExp("[;]", "g");
console.log("a;b;c".split(r), r.compile("[b]").exec("abc").index, r.compile("b+").exec("abbc")[0], new RegExp(/[&]/g).exec("x&y").index);
/* React's escape, as React writes it */
const matchHtmlRegExp = /["'&<>]/;
function escape(text) {
  const match = matchHtmlRegExp.exec(text);
  if (!match) return text;
  let html = "", last = 0, i;
  for (i = match.index; i < text.length; i++) {
    let rep;
    switch (text.charCodeAt(i)) { case 34: rep = "&quot;"; break; case 38: rep = "&amp;"; break; case 39: rep = "&#x27;"; break; case 60: rep = "&lt;"; break; case 62: rep = "&gt;"; break; default: continue; }
    if (last !== i) html += text.slice(last, i);
    last = i + 1;
    html += rep;
  }
  return last !== i ? html + text.slice(last, i) : html;
}
console.log(strings.map(escape).join(" | "));
