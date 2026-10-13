// node:path: Node's both halves, posix and win32, on every platform (node:path/posix and
// node:path/win32 too), against the corner cases of each: devices, UNC roots, reserved names,
// namespaced paths, dots. The default export is the platform's.
import path, { posix, win32, join, parse, format, toNamespacedPath } from "node:path";
import posixModule from "node:path/posix";
import win32Module, { basename as win32Basename } from "node:path/win32";

/* relative paths resolve against the working directory (win32's against its drive's) */
const here = process.cwd().replaceAll("/", "\\").replace(/^[A-Za-z]:/, "");
const inputs = ["", ".", "..", "/", "//", "a/b/../c", "/a/./b//c/", "../../x", "C:\\a\\..\\b", "c:", "C:foo", "\\\\server\\share\\x", "//server/share", "a.txt", ".bashrc", "a/b.tar.gz", "/x/y/", "file.", "\\\\?\\C:\\x", "CON", "a:b", "C:\\..\\..\\x"];
for (const [name, p] of [["posix", posix], ["win32", win32]]) {
  for (const s of inputs) {
    const r = [p.normalize(s || "."), p.isAbsolute(s), p.dirname(s), p.basename(s), p.basename(s, ".gz"), p.extname(s), JSON.stringify(p.parse(s)), p.toNamespacedPath(p.isAbsolute(s) ? s : p.join("deep/er/dir", s)), p.join(s, "q", "..", "r")];
    if (name === "win32") r.push(p.resolve("C:\\base", s));
    else r.push(p.resolve("/base", s));
    console.log(name, JSON.stringify(s), r.join(" | ").replaceAll(here, "<cwd>"));
  }
  console.log(name, p.relative("/a/b/c", "/a/d"), p.relative("C:\\a\\b", "C:\\a\\c\\d"), p.relative("", "x"));
  console.log(name, p.format({ dir: "/x", name: "f", ext: "txt" }), p.format({ root: "/", base: "b" }), p.sep, p.delimiter);
}
console.log(path === (process.platform === "win32" ? win32 : posix), posix.posix === posix, posix.win32 === win32, win32.posix === posix, join("a", "b"), JSON.stringify(parse("/a/b.c")), format({ name: "n", ext: ".e" }), toNamespacedPath("/x"));
console.log(Object.keys(path).sort().join());
for (const bad of [() => path.join(1), () => path.format(null)]) try { bad(); } catch (e) { console.log(e.code, e.message); }
console.log(path.resolve("x") === join(process.cwd(), "x"), posixModule === posix, win32Module === win32, win32Basename("C:\\a\\b.txt"));
