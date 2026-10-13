// node:fs's and node:fs/promises' rest: the access constants and stream aliases, readv/writev,
// statfs, recursive readdir, opendir and Dir, cp, glob and path.matchesGlob, openAsBlob, FileHandle,
// watch and watchFile. Run in an empty directory; lists sorted where the file system's order shows.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const show = (label, f) => {
  try {
    print(label + ": " + JSON.stringify(f()));
  } catch (e) {
    print(label + ": " + e.name + " " + e.code + " " + e.message.replaceAll(process.cwd(), "CWD"));
  }
};
const showAsync = async (label, f) => {
  try {
    print(label + ": " + JSON.stringify(await f()));
  } catch (e) {
    print(label + ": " + e.name + " " + e.code + " " + e.message.replaceAll(process.cwd(), "CWD"));
  }
};

/* a tree to work on */
fs.mkdirSync("tree/lib/deep", { recursive: true });
fs.mkdirSync("tree/.hidden");
fs.writeFileSync("tree/a.js", "a");
fs.writeFileSync("tree/b.ts", "bb");
fs.writeFileSync("tree/lib/c.js", "ccc");
fs.writeFileSync("tree/lib/deep/d.txt", "dddd");
fs.writeFileSync("tree/.hidden/h.js", "h");
fs.symlinkSync("a.js", "tree/link.js");

print("constants: " + [fs.F_OK, fs.R_OK, fs.W_OK, fs.X_OK] + " " + (fs.FileReadStream === fs.ReadStream) + " " + (fs.FileWriteStream === fs.WriteStream));

/* readv, writev */
{
  const fd = fs.openSync("vec.txt", "w+");
  print("writev: " + fs.writevSync(fd, [Buffer.from("hello "), Buffer.from("world")]));
  const a = Buffer.alloc(3), b = Buffer.alloc(20);
  print("readv: " + fs.readvSync(fd, [a, b], 0) + " " + a + " " + b.toString().replace(/\0+$/, ""));
  fs.closeSync(fd);
}

/* statfs */
{
  const s = fs.statfsSync(".");
  print("statfs: " + Object.keys(s).join(",") + " " + (s.bsize > 0) + " " + s.constructor.name);
  show("statfs missing", () => fs.statfsSync("missing-dir"));
}

/* readdir recursive */
show("readdir recursive", () => fs.readdirSync("tree", { recursive: true }).sort());
show("readdir recursive types", () => fs.readdirSync("tree", { recursive: true, withFileTypes: true }).map((d) => `${d.parentPath}|${d.name}|${d.isDirectory()}`).sort());

/* opendir */
{
  const dir = fs.opendirSync("tree");
  const names = [];
  for (let d = dir.readSync(); d !== null; d = dir.readSync()) names.push(d.name + (d.isDirectory() ? "/" : ""));
  print("opendirSync: " + names.sort().join(" ") + " path " + dir.path + " " + (dir instanceof fs.Dir));
  dir.closeSync();
  show("read closed", () => dir.readSync());
  const recursive = [];
  for await (const d of await fsp.opendir("tree", { recursive: true })) recursive.push(path.join(d.parentPath, d.name));
  print("opendir recursive: " + recursive.sort().join(" "));
  const busy = fs.opendirSync("tree");
  const pending = busy.read();
  show("concurrent", () => busy.readSync());
  await pending;
  await busy.close();
  show("opendir missing", () => fs.opendirSync("missing-dir"));
  await new Promise((resolve) => fs.opendir("tree", (err, d) => {
    print("opendir callback: " + err + " " + d.path);
    d.closeSync();
    resolve();
  }));
}

/* cp */
{
  show("cp dir without recursive", () => fs.cpSync("tree", "copy"));
  show("cp same", () => fs.cpSync("tree/a.js", "tree/a.js"));
  show("cp into itself", () => fs.cpSync("tree", "tree/lib/inner", { recursive: true }));
  show("cp dir onto file", () => fs.cpSync("tree/lib", "tree/a.js", { recursive: true }));
  show("cp file onto dir", () => fs.cpSync("tree/a.js", "tree/lib"));
  fs.cpSync("tree", "copy", { recursive: true, filter: (src) => !src.endsWith(".ts") });
  print("cp: " + fs.readdirSync("copy", { recursive: true }).sort().join(" ") + " link " + fs.readlinkSync("copy/link.js").replaceAll(process.cwd(), "CWD"));
  fs.writeFileSync("existing.txt", "keep");
  fs.cpSync("tree/a.js", "existing.txt", { force: false });
  print("cp no force: " + fs.readFileSync("existing.txt", "utf8"));
  show("cp errorOnExist", () => fs.cpSync("tree/a.js", "existing.txt", { force: false, errorOnExist: true }));
  show("cp async filter in cpSync", () => fs.cpSync("tree/a.js", "x.js", { filter: async () => true }));
  await fsp.cp("tree/lib", "copy2", { recursive: true, filter: async (src) => !src.endsWith("d.txt") });
  print("promises cp: " + fs.readdirSync("copy2", { recursive: true }).sort().join(" "));
  await new Promise((resolve) => fs.cp("tree/a.js", "copied.js", (err) => {
    print("cp callback: " + err + " " + fs.readFileSync("copied.js", "utf8"));
    resolve();
  }));
}

/* glob and matchesGlob */
{
  for (const pattern of ["tree/*.js", "tree/**/*.js", "tree/**", "**/d.txt", "tree/*/", "tree/{a,b}.*", "tree/lib/../a.js", "./tree/?.js", "tree/.*", "tree/*.+(js|ts)"]) {
    show("glob " + pattern, () => fs.globSync(pattern).sort());
  }
  show("glob exclude", () => fs.globSync("tree/**/*.js", { exclude: (p) => p.includes("lib") }).sort());
  show("glob exclude patterns", () => fs.globSync("tree/**/*.js", { exclude: ["tree/lib/**"] }).sort());
  show("glob cwd", () => fs.globSync("*.js", { cwd: "tree" }).sort());
  show("glob types", () => fs.globSync("tree/lib/*", { withFileTypes: true }).map((d) => `${d.parentPath}|${d.name}|${d.isDirectory()}`).sort());
  const iterated = [];
  for await (const p of fsp.glob("tree/**/*.ts")) iterated.push(p);
  print("promises glob: " + iterated.join(" "));
  await new Promise((resolve) => fs.glob("tree/*.ts", (err, matches) => {
    print("glob callback: " + err + " " + matches);
    resolve();
  }));
  print("matchesGlob: " + [path.matchesGlob("src/lib/d.js", "src/**/*.js"), path.matchesGlob(".rc", "*"), path.matchesGlob("a/b", "a/*"), path.matchesGlob("x.ts", "*.{js,ts}")]);
}

/* openAsBlob */
{
  const blob = await fs.openAsBlob("tree/b.ts", { type: "text/plain" });
  print("openAsBlob: " + blob.size + " " + blob.type + " " + (await blob.text()));
}

/* FileHandle */
{
  const fh = await fsp.open("handle.txt", "w+");
  print("open: " + typeof fh.fd + " " + (await fh.write("hello handle")).bytesWritten);
  await fh.write(Buffer.from("!"), 0, 1, 12);
  const { bytesRead, buffer } = await fh.read(Buffer.alloc(5), 0, 5, 0);
  print("read: " + bytesRead + " " + buffer);
  print("stat: " + (await fh.stat()).size);
  await fh.truncate(5);
  print("readFile: " + (await fh.readFile({ encoding: "utf8" })) + "|" + (await fsp.readFile("handle.txt", "utf8")));
  await fh.writeFile(" more");
  await fh.sync();
  let closed = false;
  fh.on("close", () => (closed = true));
  await fh.close();
  print("closed: " + closed + " fd " + fh.fd + " file " + (await fsp.readFile("handle.txt", "utf8")));
  await showAsync("after close", () => fh.read());
  const lines = await fsp.open("lines.txt", "w");
  await lines.writeFile("one\ntwo\nthree\n");
  await lines.close();
  const reader = await fsp.open("lines.txt");
  const seen = [];
  for await (const line of reader.readLines()) seen.push(line);
  print("readLines: " + seen.join(","));
  await reader.close();
  await showAsync("open missing", () => fsp.open("missing-file.txt"));
}

/* fs/promises' others */
print("promises: " + (fsp.constants.O_RDONLY === fs.constants.O_RDONLY) + " " + Object.keys(await fsp.statfs(".")).length);
await showAsync("lchmod", () => fsp.lchmod("tree/a.js", 0o644));

/* watch: a change to a file */
{
  fs.writeFileSync("watched.txt", "1");
  const event = await new Promise((resolve) => {
    const watcher = fs.watch("watched.txt", (eventType, filename) => {
      watcher.close();
      resolve(eventType + " " + filename);
    });
    setTimeout(() => fs.writeFileSync("watched.txt", "22"), 50);
  });
  print("watch: " + event);
  show("watch missing", () => fs.watch("missing-file.txt"));
  const polled = await new Promise((resolve) => {
    const listener = (curr, prev) => {
      fs.unwatchFile("polled.txt", listener);
      resolve(`${prev.size} -> ${curr.size} ${curr instanceof fs.Stats}`);
    };
    fs.writeFileSync("polled.txt", "x");
    fs.watchFile("polled.txt", { interval: 20 }, listener);
    setTimeout(() => fs.writeFileSync("polled.txt", "xyz"), 100);
  });
  print("watchFile: " + polled);
}
