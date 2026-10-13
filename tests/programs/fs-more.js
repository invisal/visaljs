// node:fs: realpath, mkdir (recursive), utimes, and file descriptors (open, write, read, close)
import fs from "node:fs";
import { mkdirSync as mkdirNamed, promises } from "node:fs";
import path from "node:path";

const here = fs.realpathSync(".");
const show = (v) => (typeof v === "string" ? v.split(here).join("<cwd>") : v);
const t = (label, f) => {
  try {
    console.log(label, show(f()));
  } catch (e) {
    console.log(label, e.code, e.syscall, show(e.message));
  }
};

fs.writeFileSync("file", "contents");
// realpath: Node's JS walk (lstat errors) and .native (realpath errors)
t("realpath", () => fs.realpathSync("file") === path.join(here, "file"));
t("realpath missing", () => fs.realpathSync("nope/deeper"));
t("realpath.native", () => fs.realpathSync.native("./file"));
t("realpath.native missing", () => fs.realpathSync.native("nope"));
t("realpath buffer", () => Buffer.isBuffer(fs.realpathSync("file", "buffer")));

// mkdir: one directory, or with recursive its parents, returning the first one created
t("mkdir", () => fs.mkdirSync("one"));
t("mkdir again", () => fs.mkdirSync("one"));
t("mkdir file", () => fs.mkdirSync("file"));
t("mkdir no parent", () => mkdirNamed("q/r"));
t("mkdir recursive", () => fs.mkdirSync("a/b/c", { recursive: true }));
t("mkdir recursive again", () => fs.mkdirSync("a/b/c", { recursive: true }));
t("mkdir recursive through a file", () => fs.mkdirSync("file/x", { recursive: true }));
t("mkdir recursive onto a file", () => fs.mkdirSync("file", { recursive: true }));
t("mkdir made", () => fs.statSync("a/b/c").isDirectory());

// file descriptors
t("open bad flags", () => fs.openSync("file", "zz"));
t("open missing", () => fs.openSync("nope"));
t("open exclusive", () => fs.openSync("file", "wx"));
t("close bad fd", () => fs.closeSync(9999));
t("close not a number", () => fs.closeSync("x"));
const fd = fs.openSync("out", "w");
t("write string", () => fs.writeSync(fd, "héllo"));
t("write bytes", () => fs.writeSync(fd, Buffer.from("abcdef"), 1, 3));
t("write at", () => fs.writeSync(fd, "X", 0));
fs.closeSync(fd);
t("written", () => JSON.stringify(fs.readFileSync("out", "utf8")));
t("write closed", () => fs.writeSync(fd, "x"));
const r = fs.openSync("out", "r");
const b = Buffer.alloc(4);
t("read", () => fs.readSync(r, b, 0, 4, null) + " " + b.toString());
t("read at", () => fs.readSync(r, b, { position: 1 }) + " " + b.toString());
fs.closeSync(r);
const a = fs.openSync("out", "a");
fs.writeSync(a, "!");
fs.closeSync(a);
t("appended", () => fs.readFileSync("out", "utf8").endsWith("!"));

// utimes: seconds, numeric strings or Dates
t("utimes", () => fs.utimesSync("file", 1000, new Date(2000000)));
t("utimes mtime", () => fs.statSync("file").mtimeMs + " " + fs.statSync("file").atimeMs);
t("utimes string", () => fs.utimesSync("file", "5", 6) ?? fs.statSync("file").mtimeMs);
t("utimes missing", () => fs.utimesSync("nope", 1, 1));

// the callback and promise forms (one after another: Node's run on its thread pool, in any order)
await new Promise((done) => fs.realpath("file", (err, p) => done(console.log("realpath cb", err, show(p)))));
await new Promise((done) => fs.realpath.native("nope", (err) => done(console.log("realpath.native cb", err.code))));
await new Promise((done) => fs.mkdir("cb/d", { recursive: true }, (err, first) => done(console.log("mkdir cb", err, show(first)))));
await new Promise((done) => fs.open("file", "r", (err, fd) => fs.close(fd, (err2) => done(console.log("open/close cb", err, typeof fd, err2)))));
await promises.mkdir("p/q", { recursive: true }).then((first) => console.log("mkdir promise", first));
await promises.realpath("p/q").then((p) => console.log("realpath promise", show(p)));
await promises.utimes("file", 1, 2).then(() => console.log("utimes promise", fs.statSync("file").mtimeMs));
