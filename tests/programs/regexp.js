// RegExp (§22.2): literals (compiled when the program is built) and new RegExp, every flag,
// exec's result (groups, indices), lastIndex, the String methods that take a RegExp, the
// replacement patterns, subclasses, and how console.log prints them.
const t = (f) => {
  try {
    console.log(f());
  } catch (e) {
    console.log(`${e.constructor.name}: ${e.message}`);
  }
};

// Literals and the constructor
const date = /(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/u;
console.log(date.source, date.flags, date.unicode, date.global, String(date));
console.log(new RegExp("a/b", "gi").source, new RegExp("\n").source, String(new RegExp("")), RegExp("x", "y").sticky);
console.log(new RegExp(date).flags, new RegExp(date, "g").flags, RegExp(date) === date, new RegExp(/a/gimsuyd).flags);
for (const f of ["d", "g", "i", "m", "s", "u", "v", "y"]) console.log(f, new RegExp(".", f).flags);

// exec: captures, named groups, indices, lastIndex
const m = date.exec("on 2024-02-29!");
console.log(m, m.index, m.groups.year, m.length);
console.log(/(a)|(b)/.exec("b"), /a(?<x>z)?/d.exec("xa").indices);
const g = /o/g;
console.log(g.exec("foo").index, g.lastIndex, g.exec("foo").index, g.lastIndex, g.exec("foo"), g.lastIndex);
const sticky = /a/y;
console.log(sticky.test("ba"), sticky.lastIndex, (sticky.lastIndex = 1, sticky.test("ba")), sticky.lastIndex);

// Flags in action
console.log(/abc/i.test("ABC"), /^b/m.test("a\nb"), /a.b/s.test("a\nb"), /a.b/.test("a\nb"));
console.log(/^.$/u.test("😀"), /^.$/.test("😀"), /\p{Lu}+/u.exec("abcDEF")[0], /[\p{L}--[a-z]]/v.test("A"));
console.log(/\bfoo\b/.test("a foo b"), /(\w)\1/.exec("abccd")[0], /a{2,}/.exec("caaat")[0], /[^]/.test("\n"));
console.log(/(?<=\$)\d+/.exec("cost: $42")[0], /\d+(?!px)/.exec("12px 34em")[0], /(?<a>x)|y/.exec("y").groups.a);

// String methods
console.log("a1b22c333".match(/\d+/g), "a1b22".match(/(\d)(\d)?/), "abc".match(/z/g), "x".match("x").index);
console.log([..."a1b22c333".matchAll(/(?<n>\d+)/g)].map((r) => `${r.index}:${r.groups.n}`));
console.log("2024-02-29".replace(date, "$<day>/$<month>/$<year>"), "John Smith".replace(/(\w+)\s(\w+)/, "$2, $1"));
console.log("aaa".replace(/a/g, "$&$&"), "abc".replace(/b/, "[$`|$'|$$]"), "abc".replace(/(b)/, "$01$2$11"));
console.log("a-b_c".replace(/[-_](\w)/g, (_, c, i) => c.toUpperCase() + i), "aaa".replaceAll(/a/g, "b"));
console.log("one, two,three".split(/\s*,\s*/), "a1b2c3".split(/\d/, 2), "abc".split(/(b)/), "".split(/x/), "".split(/(?:)/));
console.log("Hello world".search(/o/), "abc".search(/z/), "😀😀".split(/(?:)/u).length, "😀😀".split(/(?:)/).length);
console.log("x".replace(/(?:)/g, "-"), "😀".replace(/(?:)/gu, "-"), "abc".replace(/$/, "!"));
t(() => "a".matchAll(/a/));
t(() => "a".replaceAll(/a/, ""));

// Errors
t(() => new RegExp("("));
t(() => new RegExp("a", "gg"));
t(() => new RegExp("[b-a]"));
t(() => new RegExp("\\p{Nope}", "u"));
t(() => RegExp.prototype.exec.call({}, "a"));
t(() => Object.getOwnPropertyDescriptor(RegExp.prototype, "global").get.call({}));

// Protocol: subclasses, custom exec, Symbol.replace on an object
class Words extends RegExp {
  exec(s) {
    const r = super.exec(s);
    if (r) r[0] = r[0].toUpperCase();
    return r;
  }
}
console.log("hello big world".replace(new Words("\\w+", "g"), (w) => `<${w}>`), new Words("a") instanceof Words);
console.log("abc".replace({ [Symbol.replace]: (s, r) => `${s}:${r}` }, "X"), Object.prototype.toString.call(/x/));
console.log(RegExp.prototype.source, RegExp.prototype.flags, RegExp.prototype.global, RegExp[Symbol.species] === RegExp);

// console.log
const tagged = /a/g;
tagged.note = 1;
console.log(/a\/b/g, [/x/], { r: /y/m }, tagged, new Words("w", "y"), new RegExp("\n"));
