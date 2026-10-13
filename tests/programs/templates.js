// Template literals and tagged templates (§13.2.8): ToString of substitutions, per-site frozen
// template objects with raw strings, `this` for method tags.
const name = "world", n = 3;
const obj = { toString() { return "TS"; }, valueOf() { return "VO"; } };
console.log(`hello ${name}!`, `${n * 2}${n}`, `a${obj}b`, "" + obj, `${""}`, `x`, ``);
console.log(`multi
line ${[1, 2]} ${null} ${undefined} ${{ a: 1 }}`);
try { `${Symbol("s")}`; } catch (e) { console.log(e.name); }
function tag(strings, ...values) { return { strings, raw: strings.raw, values }; }
function site() { const t = (s) => s; return t`a${1}b`; }
const s1 = site(), s2 = site();
console.log(s1 === s2, s1, s1.raw, Object.getOwnPropertyDescriptor(s1, "raw").enumerable, Object.isExtensible(s1), Object.getOwnPropertyDescriptor(s1, 0).writable);
console.log(tag`x\ty${1}\n${2}`.raw, tag`\unicode bad`.strings);
const o = { prefix: ">", fmt(strings, ...v) { return this.prefix + strings.join("|") + v.join(","); } };
console.log(o.fmt`a${1}b${2}c`);
console.log(`nested ${`inner ${n}`} done`);
