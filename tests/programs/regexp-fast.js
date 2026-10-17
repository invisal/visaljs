// RegExp's fast paths (runtime/src/regexp.c): the prefilter that skips positions where no match
// can start (literals, alternatives, classes, case folding, zero-width ops, UTF-16 subjects), and
// test, match, replace, search and split on unmodified RegExps: lastIndex as the spec leaves it,
// replacement patterns and functions, split's limits and captures, and the spec's path when
// exec, a flag getter, @@species or lastIndex has been changed. A section runs alone when named.
const pad = "-".repeat(100);  // long subjects: the prefilter starts at 64 units
const long = (s) => pad + s + pad;
const log = (...a) => console.log(a.map(x => JSON.stringify(x)).join(" "));

const sections = {
  prefilter() {
    for (const [re, s] of [
      [/needle/g, long("needle xneedle needl")],
      [/foo|bar|baz/g, long("foo bar baz fob")],
      [/HELLO/gi, long("hello HeLLo hellO")],
      [/k/gi, long("k K K")],
      [/k/giu, long("k K K")],
      [/s/gi, long("s S ſ")],
      [/s/giu, long("s S ſ")],
      [/µ/gi, long("µ μ Μ")],
      [/µ/giu, long("µ μ Μ")],
      [/ÿ/gi, long("ÿ Ÿ")],
      [/[cgt]gggtaaa|tttaccc[acg]/gi, long("cgggtaaa TTTACCCG xgggtaaa")],
      [/^>.*\n|\n/mg, long(">head\nline\n>x\n")],
      [/\bab\b/g, long("ab xab ab_ ab.")],
      [/\Bab/g, long("ab xab ab")],
      [/\s+/g, long("a  b c d﻿e")],
      [/[^-]x/g, long("ax-x")],
      [/a.c/g, long("abc a\nc a c")],
      [/a.c/gs, long("abc a\nc")],
      [/(?<=x)y/g, long("xy zy")],
      [/(?=a)ab/g, long("ab ab")],
      [/(a)\1/g, long("aa ab")],
      [/\u{1F600}x/gu, long("\u{1F600}x \u{1F601}x")],
      [/x\u{1F600}/gu, long("x\u{1F600} x")],
      [/\ud83d/g, long("\u{1F600} \ud83d")],
      [/[Ā-Ȁ]z/g, long("Őz az")],
      [/é/gi, long("É é e")],
      [/ab/g, "ā" + long("ab āab")],
      [/[ab]c/gi, "ā" + long("AC bc āc")],
      [/a|/g, long("bab")],
      [/x*/g, long("axxb")],
      [/$/g, long("end")],
      [/(?:)/g, "abc"],
    ]) {
      log(String(re), s.match(re), s.replace(re, "[$&]"), s.split(re).length, s.search(re));
    }
  },
  lastIndex() {
    const re = /a/g; re.lastIndex = 5;
    log(re.test("aaaaaaa"), re.lastIndex, re.test("aaaaaaa"), re.lastIndex);
    re.lastIndex = 100; log(re.test("aaa"), re.lastIndex);
    const y = /a/y; y.lastIndex = 1; log(y.test("ba"), y.lastIndex, y.test("ba"), y.lastIndex);
    const n = /a/; n.lastIndex = 3; log(n.test("a"), n.lastIndex);
    const g = /b/g; g.lastIndex = 2; log("abcb".match(g), g.lastIndex);
    const s1 = /b/g; s1.lastIndex = 3; log("abcb".search(s1), s1.lastIndex);
    log("abc".search(/z/), "abc".search(/z/g), long("abc").search(/needle/), "".search(/x/));
    const s2 = /b/y; s2.lastIndex = -0; log("bb".search(s2), Object.is(s2.lastIndex, -0));
    const r1 = /b/y; r1.lastIndex = 1; log("abb".replace(r1, "X"), r1.lastIndex, "abb".replace(r1, "X"), r1.lastIndex, "abb".replace(r1, "X"), r1.lastIndex);
    const r2 = /b/g; r2.lastIndex = 2; log("abb".replace(r2, "X"), r2.lastIndex);
    const r3 = /b/; r3.lastIndex = 7; log("abb".replace(r3, "X"), r3.lastIndex);
    const gy = /a/gy; log("aaba".match(gy), "aaba".replace(gy, "-"), gy.lastIndex);
    const li = /a/g; li.lastIndex = 1.7; log(li.test("aa"), li.lastIndex);
    const lo = /a/g; lo.lastIndex = { valueOf() { log("valueOf"); return 0; } }; log(lo.test("a"), lo.lastIndex);
  },
  replace() {
    log(long("John Smith; Jane Doe").replace(/(\w+) (\w+)/g, "$2, $1 [$$]"));
    log("abc".replace(/b/, "$`|$'|$&|$$|$0|$1|$01"));
    log("abc".replace(/(b)/, "$1$01$10$2"));
    log("aXbXc".replace(/(X)|(Y)/g, (...a) => JSON.stringify(a)));
    const re = /x/g; const seen = [];
    log("xxx".replace(re, (m, i) => { seen.push(re.lastIndex); re.lastIndex = 0; return i; }), seen);
    log("abc".replace(/(?<l>b)/, "[$<l>]"), "abc".replace(/(?<l>b)/g, (...a) => JSON.stringify(a[a.length - 1])));
    log("aaa".replace(/a*?/g, "-"));
    log("\u{1F600}\u{1F600}".replace(/(?:)/gu, "-"));
    log("\u{1F600}".replace(/(?:)/g, "-").length);
    log("abc".replace(/b/g, { toString() { return "$&$&"; } }));
  },
  split() {
    log("a1b2c3".split(/(\d)/), "a1b2c3".split(/(\d)/, 3), "a1b2c3".split(/\d/, 0), "a,b".split(/,/, -1));
    log("".split(/x/), "".split(/(?:)/), "abc".split(/(?:)/), "abc".split(/$/), "abc".split(/^/));
    log("abc".split(/(b)|(z)/), "a  b".split(/ */), "abab".split(/(?=b)/), "ab".split(/a*?/));
    log("x\u{1F600}y".split(/(?:)/u), "x\u{1F600}y".split(/(?:)/));
    log("a,b,c".split(/,/y), "a,b".split(/,/i), long("q,w").split(/,/).length);
    log("abc".split(/b/, 2.9), "abc".split(/b/, 4294967297), "a1b".split(/\d/, { valueOf() { return 1; } }));
  },
  modified() {
    const re = /a/g; re.exec = function (s) { log("own exec"); return null; };
    log(re.test("a"), "a".replace(re, "b"), "a".match(re), "a".split(re), "a".search(re));
    const orig = RegExp.prototype.exec;
    RegExp.prototype.exec = function (s) { log("proto exec", this.source); return orig.call(this, s); };
    log(/b/.test("abc"), "abc".replace(/b/g, "x"), "abc".split(/b/), "abc".search(/c/));
    RegExp.prototype.exec = orig;
    const glob = Object.getOwnPropertyDescriptor(RegExp.prototype, "global");
    Object.defineProperty(RegExp.prototype, "global", { get() { log("global getter"); return false; }, configurable: true });
    log("aXa".replace(/a/g, "-"), "aXa".match(/a/g));
    Object.defineProperty(RegExp.prototype, "global", glob);
    class R extends RegExp { exec(s) { log("subclass exec"); return super.exec(s); } }
    log(new R("b").test("abc"), "abc".replace(new R("b", "g"), "x"));
    const sp = Object.getOwnPropertyDescriptor(RegExp, Symbol.species);
    Object.defineProperty(RegExp, Symbol.species, { get() { log("species"); return RegExp; }, configurable: true });
    log("a,b".split(/,/));
    Object.defineProperty(RegExp, Symbol.species, sp);
    const ro = /a/g; Object.defineProperty(ro, "lastIndex", { writable: false, value: 0 });
    try { log(ro.test("a")); } catch (e) { log(e.constructor.name); }
    try { log("a".replace(ro, "b")); } catch (e) { log(e.constructor.name); }
    log("a,b,c".split(/,/, { valueOf() { RegExp.prototype.exec = function () { log("late exec"); return null; }; return 5; } }));
    RegExp.prototype.exec = orig;
    log("a,b".split(/,/), /x/.test("x"));
  },
  other() {
    const s = long("ab ab");
    log([...s.matchAll(/a(b)/g)].map(m => [m.index, m[1]]));
    const re = /ab/g; log(re.exec(s).index, re.lastIndex, re.exec(s).index);
    re.compile("b-", "g"); log(s.match(re));
    const c = new RegExp(re); log(s.replace(c, "_").length, new RegExp("AB", "gi").exec(s).index);
  },
};

const only = process.argv[2];
for (const [name, f] of Object.entries(sections)) {
  if (only && name !== only) continue;
  console.log(`## ${name}`);
  f();
}
