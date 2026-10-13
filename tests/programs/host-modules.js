// Host modules: node:fs and node:path come from the host prelude,
// bundled with the program. Runs in an empty temporary directory.
import fs, { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { join, basename } from "path";

const file = join(".", "notes.txt");
writeFileSync(file, "héllo ✓\n");
fs.appendFileSync(file, "second line\n");
print(readFileSync(file, "utf8").length + " " + JSON_like(readFileSync(file, { encoding: "utf-8" })));
print(fs.existsSync(file) + " " + fs.existsSync("missing.txt") + " " + fs.existsSync(42));

function JSON_like(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) out += s.charAt(i) === "\n" ? "\\n" : s.charAt(i);
  return out;
}

function show(f) {
  try { f(); print("no error"); } catch (e) {
    print(e.name + " [" + e.code + "] " + e.message + (e.syscall ? " | errno " + e.errno + " syscall " + e.syscall + " path " + e.path : ""));
  }
}
show(() => readFileSync("missing.txt", "utf8"));
show(() => readFileSync(".", "utf8"));
show(() => fs.unlinkSync("missing.txt"));
show(() => writeFileSync("no/such/dir.txt", "x"));
show(() => readFileSync(null, "utf8"));
show(() => writeFileSync(file, 5));
show(() => path.join("a", {}));
fs.unlinkSync(file);
print(fs.existsSync(file));

print(path.join("/a/b", "../c", "./d.txt") + " " + path.join() + " " + path.join("", "") + " " + path.join("a/", "/b/"));
print(path.normalize("a//b/../../..") + " " + path.normalize("/../x/./y/") + " " + path.normalize("./"));
print(basename("/x/y.js", ".js") + " " + basename("/x/y/") + " [" + basename("a.js", "a.js") + "] " + basename("aaa/bbb", "bbb") + " " + basename("/a/b.js//", ".js") + " " + basename("/", "x") + " " + path.dirname("/a/b/c") + " " + path.dirname("a") + " " + path.dirname("/"));
print(path.extname("a.tar.gz") + "|" + path.extname(".bashrc") + "|" + path.extname("a.") + "|" + path.extname("a..") + "|" + path.extname("x/.y.z"));
print(path.relative("/data/a/b", "/data/c") + " " + path.relative("/a", "/a/b/c") + " " + path.relative("/a/b", "/a") + " [" + path.relative("/a", "/a") + "]");
print(path.resolve("/root", "x", "../y") + " " + path.resolve("/a", "/b", "c/") + " " + path.isAbsolute("/x") + " " + path.isAbsolute("x"));
print(path.resolve("rel") === path.join(path.resolve("."), "rel"));
print(path.sep + " " + path.delimiter + " " + (path.posix === path.default) + " " + (path.default.posix.join === join));

/* Buffers: read without an encoding, written as they are, and Buffer's encodings */
writeFileSync("b.bin", Buffer.from([0, 1, 2, 255]));
fs.appendFileSync("b.bin", new Uint8Array([7]));
console.log(readFileSync("b.bin"), readFileSync("b.bin", "hex"), readFileSync("b.bin", { encoding: "base64" }));
writeFileSync("t.txt", "68690a", "hex");
console.log(JSON.stringify(readFileSync("t.txt", "utf8")), readFileSync("t.txt", "latin1").length);
for (const f of [() => readFileSync("t.txt", "foo"), () => writeFileSync("t.txt", "x", "foo"), () => writeFileSync("t.txt", 1)]) {
  try {
    f();
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}
