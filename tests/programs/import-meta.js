// import.meta and import(): one import.meta per original file, as in Node,
// and import() of a specifier the bundler couldn't resolve rejects like Node's.
import { where, meta as libMeta } from "./import-meta/where.js";

const dir = import.meta.dirname;
let cut = dir.length - 1;
while (dir.charAt(cut) !== "/") cut--;
const parent = dir.slice(0, cut);
function strip(s) {  /* paths relative to this file's directory, so the output doesn't depend on it */
  for (const [sub, by] of [[import.meta.filename, "<file>"], [dir, "<dir>"], [parent, "<parent>"]])
    for (let i = s.indexOf(sub); i !== -1; i = s.indexOf(sub)) s = s.slice(0, i) + by + s.slice(i + sub.length);
  return s;
}

const d = (k) => { const x = Object.getOwnPropertyDescriptor(import.meta, k); return x.writable + "/" + x.enumerable + "/" + x.configurable; };
print(Object.keys(import.meta).join(",") + " " + (Object.getPrototypeOf(import.meta) === null) + " " + d("url") + " " + (import.meta === import.meta));
print(strip(import.meta.url) + " " + strip(import.meta.filename) + " " + (import.meta.url === "file://" + import.meta.filename));
print(import.meta.main + " " + libMeta.main + " " + (libMeta === import.meta) + " " + strip(libMeta.dirname) + " " + where());

const r = import.meta.resolve;
print(r.name + " " + r.length);
for (const s of ["./x.js", "../up/y.js", "/abs/z.js", "./a b/ü.js", "./q.js?v=1#h", "node:fs", "fs", "file:///x/../y",
                 "https://e.com/a/../b", ".", "./", "..", "./a//b/./c/..", "x/../../y", "@scope/pkg/sub", 1]) {
  try { print(s + " -> " + strip(r(s))); } catch (e) { print(s + " -> " + e.name + " " + e.code + ": " + strip(e.message)); }
}

const spec = ["./import-meta", "missing.js"].join("/");
const show = (e) => print("import() rejected: " + e.name + " " + e.code + ": " + strip(e.message));
const pkg = (n) => import("not-a-package-" + n);
await import(spec).then(() => print("loaded?"), show);
await pkg(1).then(() => print("loaded?"), show);
await import(spec, 5).then(() => print("loaded?"), show);
await import(spec, { with: 5 }).then(() => print("loaded?"), show);
await import(spec, { with: { type: 1 } }).then(() => print("loaded?"), show);
await import({ toString() { throw new RangeError("bad specifier"); } }).then(() => print("loaded?"), show);
