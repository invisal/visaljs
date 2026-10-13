// node:fs: stat and lstat (Stats), readdir (names, Dirents), the callback API, read streams
// (ranges, chunks, a missing file), and node:fs/promises. It writes its files in the working
// directory (empty, from the test runner) and lists tests/programs/data for directories; names
// are sorted, as directories list them in an order that differs by file system.
import fs, { createReadStream, Dirent, lstatSync, readdirSync, statSync, Stats } from "node:fs";
import fsp from "node:fs/promises";
import { join } from "node:path";

const log = (...args) => console.log(...args);
const data = join(import.meta.dirname, "data");
fs.writeFileSync("a.txt", "hello world\n");
fs.writeFileSync("b.bin", Buffer.from([0, 1, 2, 255]));

/* stat */
const s = statSync("a.txt");
log("Stats:", s instanceof Stats, s.isFile(), s.isDirectory(), s.isSymbolicLink(), s.size, typeof s.mtimeMs, s.mtime instanceof Date);
log("directory:", statSync(data).isDirectory(), lstatSync(data).isFile(), "missing:", statSync("nope", { throwIfNoEntry: false }));
try {
  statSync("nope");
} catch (e) {
  log(e.code, e.syscall, e.message);
}

/* readdir */
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
log(readdirSync(data, { withFileTypes: true }).sort(byName).map((d) => [d.name, d.isFile(), d.isDirectory(), d instanceof Dirent]));
log(readdirSync(".").sort(), readdirSync(".", { withFileTypes: true }).every((d) => d.parentPath === "."));
try {
  readdirSync("a.txt");
} catch (e) {
  log(e.code, e.syscall, e.message);
}

/* read streams */
const read = async (stream) => Buffer.concat(await Array.fromAsync(stream));
log("range:", (await read(createReadStream("a.txt", { start: 6, end: 10 }))).toString(), "bytes:", [...(await read(createReadStream("b.bin")))]);
log("chunks:", await Array.fromAsync(createReadStream("a.txt", { encoding: "utf8", highWaterMark: 4 })));
await new Promise((resolve) => createReadStream("missing").on("error", (e) => {
  log("stream error:", e.code, e.syscall);
  resolve();
}));

/* node:fs/promises */
log((await fsp.readFile("a.txt", "utf8")).trim(), (await fsp.stat(data)).isDirectory(), (await fsp.readdir(".")).sort());
await fsp.access("a.txt");
try {
  await fsp.access("x");
} catch (e) {
  log("access:", e.code);
}
log("fs.promises:", fs.promises === fsp);

/* callbacks, on a later tick */
let sync = true;
const statted = new Promise((resolve) => fs.stat("a.txt", (err, st) => {
  log("stat callback:", err, st.size, "later:", !sync);
  resolve();
}));
sync = false;
await statted;
await new Promise((resolve) => fs.readdir(".", (err, names) => {
  log("readdir callback:", err, names.sort());
  resolve();
}));
await new Promise((resolve) => fs.readFile("zzz", (err) => {
  log("readFile callback:", err.code);
  resolve();
}));
