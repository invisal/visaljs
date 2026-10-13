// visaljs-flags: --all-builtins
// String and String.prototype: every method but the RegExp ones (with a RegExp: the
// RegExp component), Unicode case mapping and normalization, compared with Node.
const s = "Hello, World";
console.log(s.at(-1), s.charAt(4), s.charCodeAt(0), "😀x".codePointAt(0), "😀".codePointAt(1), s.concat("!", 1, null));
console.log(s.endsWith("World"), s.endsWith("Hello", 5), s.startsWith("World", 7), s.includes("o, W"), s.indexOf("o"), s.lastIndexOf("o"), s.lastIndexOf("o", 5), "aaa".lastIndexOf("a", NaN));
try { s.startsWith({ [Symbol.match]: true }); } catch (e) { console.log(e.name); }
console.log("ab\ud800".isWellFormed(), "ab\ud800c".toWellFormed(), "x".padStart(4, "ab"), "x".padEnd(3), "abc".padStart(2), "ab".repeat(3), "".repeat(5));
try { "a".repeat(-1); } catch (e) { console.log(e.name, e.message); }
console.log("a-b-c".replace("-", "+"), "a-b-c".replaceAll("-", "+"), "abc".replace("b", "[$&|$`|$'|$$]"), "abc".replace("b", (m, i, str) => m.toUpperCase() + i + str));
console.log("aaa".replaceAll("", "_"), "x".replace("y", "z"), "a.b.c".split("."), "abc".split(""), "a,b,c".split(",", 2), "".split(","), "".split(""), "abc".split(), "abc".split(undefined, 0));
console.log(s.slice(-5, -1), s.substring(5, 1), s.substr(-5, 3), s.substr(2));
console.log("ÄÖÜ ß ǅ İ ŉ".toLowerCase(), "äöü ß ǆ ﬁ ŉ".toUpperCase(), "ΑΣ ΑΣΣ Σ ΑΣ.".toLowerCase(), "Straße".toLocaleUpperCase());
console.log("Å".normalize("NFD").length, "Å".normalize("NFC").length, "ﬁ".normalize("NFKC"), "é".normalize() === "é");
try { "x".normalize("bad"); } catch (e) { console.log(e.name, e.message); }
console.log("  \t\n x  ﻿".trim() + "|", " x ".trimStart() + "|", " x ".trimEnd() + "|", String.prototype.trimLeft === String.prototype.trimStart, String.prototype.trimRight.name);
console.log(String.fromCharCode(72, 105, 0x10041), String.fromCodePoint(128512, 65), String.raw`a\n${1}b`, String.raw({ raw: ["x", "y"] }, 0, 1));
try { String.fromCodePoint(-1); } catch (e) { console.log(e.name, e.message); }
console.log("x".anchor('"q"'), "x".bold(), "x".fontcolor("red"), "x".link("u"), "x".sub(), "x".big());
console.log("a".localeCompare("b"), "b".localeCompare("a"), "a".localeCompare("a"));
const splitter = { [Symbol.split](str, limit) { return ["custom", str, limit]; } };
const replacer = { [Symbol.replace](str, rep) { return str + "->" + rep; } };
console.log("x".split(splitter, 3), "y".replace(replacer, "z"), "q".match({ [Symbol.match](str) { return "matched " + str; } }));
console.log(Object.getOwnPropertyNames(String).join(), Object.getOwnPropertyNames(String.prototype).concat(Object.getOwnPropertySymbols(String.prototype).map(String)).join());
