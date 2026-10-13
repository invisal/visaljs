// node:fs's other system calls (rename, links, copyFile, access, chmod, chown, fstat, fsync,
// truncate, futimes, mkdtemp, rmdir, rm), their callback and promise forms, read/write callbacks,
// exists, and write streams. Runs in an empty temporary directory.
import fs from "node:fs";
import fsp from "node:fs/promises";

function show(label, f) {
  try { const r = f(); console.log(label, r === undefined ? "ok" : r); } catch (e) {
    console.log(label, e.name, e.code, e.message, e.dest === undefined ? "" : "dest " + e.dest);
  }
}

fs.writeFileSync("a.txt", "hello world");
show("rename", () => fs.renameSync("a.txt", "b.txt"));
show("rename missing", () => fs.renameSync("a.txt", "c.txt"));
show("link", () => fs.linkSync("b.txt", "hard.txt"));
show("nlink", () => fs.statSync("b.txt").nlink);
show("symlink", () => fs.symlinkSync("b.txt", "soft.txt"));
show("readlink", () => fs.readlinkSync("soft.txt"));
show("readlink buffer", () => fs.readlinkSync("soft.txt", "buffer").length);
show("readlink file", () => fs.readlinkSync("b.txt"));
show("symlink exists", () => fs.symlinkSync("b.txt", "soft.txt"));
show("symlink type", () => fs.symlinkSync("b.txt", "x", "folder"));
show("lstat link", () => fs.lstatSync("soft.txt").isSymbolicLink());
show("copyFile", () => fs.copyFileSync("b.txt", "copy.txt"));
show("copy content", () => fs.readFileSync("copy.txt", "utf8"));
show("copyFile excl", () => fs.copyFileSync("b.txt", "copy.txt", fs.constants.COPYFILE_EXCL));
show("access", () => fs.accessSync("b.txt", fs.constants.R_OK | fs.constants.W_OK));
show("access missing", () => fs.accessSync("nope.txt"));
show("chmod", () => fs.chmodSync("copy.txt", 0o600));
show("mode", () => (fs.statSync("copy.txt").mode & 0o777).toString(8));
show("chmod string", () => fs.chmodSync("copy.txt", "644"));
show("mode", () => (fs.statSync("copy.txt").mode & 0o777).toString(8));
show("chown self", () => fs.chownSync("copy.txt", process.getuid(), process.getgid()));
show("chown bad", () => fs.chownSync("copy.txt", "0", 0));

const fd = fs.openSync("copy.txt", "r+");
show("fstat size", () => fs.fstatSync(fd).size);
show("fstat file", () => fs.fstatSync(fd).isFile());
show("fchmod", () => fs.fchmodSync(fd, 0o640));
show("fsync", () => fs.fsyncSync(fd));
show("fdatasync", () => fs.fdatasyncSync(fd));
show("ftruncate", () => fs.ftruncateSync(fd, 5));
show("futimes", () => fs.futimesSync(fd, 1000, 2000));
show("mtime", () => fs.fstatSync(fd).mtimeMs);
fs.closeSync(fd);
show("after ftruncate", () => fs.readFileSync("copy.txt", "utf8"));
show("truncate", () => fs.truncateSync("copy.txt", 2));
show("after truncate", () => fs.readFileSync("copy.txt", "utf8"));
show("truncate missing", () => fs.truncateSync("nope.txt"));
show("lutimes", () => fs.lutimesSync("soft.txt", 3000, 4000));
show("lutimes mtime", () => fs.lstatSync("soft.txt").mtimeMs);

const tmp = fs.mkdtempSync("tmp-");
show("mkdtemp", () => /^tmp-[A-Za-z0-9]{6}$/.test(tmp) && fs.statSync(tmp).isDirectory());
show("mkdtemp missing", () => fs.mkdtempSync("no/such/dir-"));
fs.mkdirSync("tree/a/b", { recursive: true });
fs.writeFileSync("tree/a/b/f.txt", "x");
fs.writeFileSync("tree/top.txt", "y");
show("rmdir not empty", () => fs.rmdirSync("tree"));
show("rmdir", () => fs.rmdirSync(tmp));
show("rmdir missing", () => fs.rmdirSync("tmp-missing"));
show("rm dir", () => fs.rmSync("tree"));
show("rm missing", () => fs.rmSync("nope"));
show("rm force", () => fs.rmSync("nope", { force: true }));
show("rm recursive", () => fs.rmSync("tree", { recursive: true }));
show("gone", () => fs.existsSync("tree"));
show("rm file", () => fs.rmSync("hard.txt"));
show("readdir", () => fs.readdirSync(".").sort().join(" "));
try { fs.rmSync("."); } catch (e) { console.log(e.name, e.code, e.info.code, e.info.syscall, e.syscall); }

fs.rename("b.txt", "c.txt", (err) => {
  console.log("rename cb", err);
  fs.copyFile("c.txt", "d.txt", (err) => {
    console.log("copyFile cb", err);
    fs.access("nope", (err) => {
      console.log("access cb", err.code);
      fs.exists("c.txt", (yes) => {
        console.log("exists cb", yes);
        fs.mkdtemp("cb-", (err, dir) => {
          console.log("mkdtemp cb", err, dir.length);
          fs.rm(dir, { recursive: true }, (err) => {
            console.log("rm cb", err, fs.existsSync(dir));
            fs.appendFile("c.txt", "!", (err) => {
              console.log("appendFile cb", err, fs.readFileSync("c.txt", "utf8"));
              next();
            });
          });
        });
      });
    });
  });
});

function next() {
  const fd = fs.openSync("c.txt", "r+");
  const buf = Buffer.alloc(5);
  fs.read(fd, buf, 0, 5, 0, (err, n, b) => {
    console.log("read cb", err, n, b === buf, buf.toString());
    fs.write(fd, "HELLO", 0, (err, n, s) => {
      console.log("write cb", err, n, s);
      fs.write(fd, Buffer.from("__"), 0, 2, 5, (err, n) => {
        console.log("write buffer cb", err, n, fs.readFileSync("c.txt", "utf8"));
        fs.closeSync(fd);
        promises();
      });
    });
  });
}

async function promises() {
  await fsp.rename("c.txt", "e.txt");
  await fsp.copyFile("e.txt", "f.txt");
  await fsp.symlink("e.txt", "g.txt");
  console.log("promises", await fsp.readlink("g.txt"), fs.readFileSync("f.txt", "utf8"));
  await fsp.chmod("f.txt", 0o600);
  await fsp.truncate("f.txt", 1);
  const dir = await fsp.mkdtemp("p-");
  await fsp.rmdir(dir);
  await fsp.rm("f.txt");
  try { await fsp.access("f.txt"); } catch (e) { console.log("access", e.code); }
  try { await fsp.rm("nope"); } catch (e) { console.log("rm", e.code, e.syscall); }
  console.log(fs.readdirSync(".").sort().join(" "));
  streams();
}

function streams() {
  const w = fs.createWriteStream("out.txt");
  console.log("pending", w.pending, w.path, w.bytesWritten, w instanceof fs.WriteStream);
  w.on("open", (fd) => console.log("open", typeof fd));
  w.on("ready", () => console.log("ready"));
  w.write("abc");
  w.write(Buffer.from("def"));
  w.end("ghi", () => console.log("finish", w.bytesWritten));
  w.on("close", () => {
    console.log("close", fs.readFileSync("out.txt", "utf8"));
    const a = fs.createWriteStream("out.txt", { flags: "a" });
    a.end("+more");
    a.on("close", () => {
      const s = fs.WriteStream("out.txt", { flags: "r+", start: 1 });
      s.end("XY");
      s.on("close", () => {
        console.log("start", fs.readFileSync("out.txt", "utf8"));
        const bad = fs.createWriteStream("no/such/dir/x.txt");
        bad.on("error", (e) => console.log("error", e.code, e.syscall));
        bad.on("close", () => console.log("bad closed"));
        function Patched(path, options) { return fs.WriteStream.apply(this, arguments), this; }
        Patched.prototype = Object.create(fs.WriteStream.prototype);
        const p = new Patched("patched.txt");
        p.end("patched", () => console.log("patched", fs.readFileSync("patched.txt", "utf8"), p instanceof fs.WriteStream));
      });
    });
  });
}
