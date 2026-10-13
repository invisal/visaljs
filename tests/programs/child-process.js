// node:child_process: spawnSync / execSync / execFileSync (input, errors, timeout, maxBuffer), spawn with
// piped stdio and its events, exec, execFile, kill, and a missing executable
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
const log = (...a) => console.log(...a);
const r = spawnSync("sh", ["-c", "echo out; echo err >&2; exit 3"]);
log("spawnSync:", r.status, r.signal, JSON.stringify(r.stdout.toString()), JSON.stringify(r.stderr.toString()), r.output[0]);
log("input:", spawnSync("cat", { input: "piped in", encoding: "utf8" }).stdout);
log("execSync:", execSync("echo hello | tr a-z A-Z", { encoding: "utf8" }).trim());
log("execFileSync:", execFileSync("echo", ["a", "b"]).toString().trim());
try { execSync("exit 2", { stdio: "pipe" }); } catch (e) { log("execSync error:", e.status, e.message.split("\n")[0]); }
const missing = spawnSync("/nonexistent/definitely-not-a-command");
log("missing:", missing.error.code, missing.error.syscall, missing.error.message, missing.status);
const t = spawnSync("sleep", ["5"], { timeout: 50 });
log("timeout:", t.error.code, t.signal, t.status);
const big = spawnSync("sh", ["-c", "head -c 5000 /dev/zero"], { maxBuffer: 100 });
log("maxBuffer:", big.error?.code);
const child = spawn("sh", ["-c", "read line; echo got $line; echo to-err >&2"]);
log("pid:", typeof child.pid);
child.on("spawn", () => log("event: spawn"));
let out = "";
child.stdout.on("data", (d) => (out += d));
let err = "";
child.stderr.on("data", (d) => (err += d));
child.on("exit", (code, signal) => log("exit:", code, signal));
child.on("close", (code) => {
  log("close:", code, JSON.stringify(out), JSON.stringify(err));
  exec("echo $FOO", { env: { FOO: "bar", PATH: process.env.PATH } }, (err, stdout, stderr) => {
    log("exec:", err, JSON.stringify(stdout), JSON.stringify(stderr));
    execFile("sh", ["-c", "exit 7"], (err) => {
      log("execFile error:", err.code, err.killed, err.signal, err.cmd);
      const k = spawn("sleep", ["10"]);
      k.on("exit", (code, signal) => log("killed:", code, signal, k.killed));
      setTimeout(() => k.kill(), 20);
      const bad = spawn("/nonexistent/no-such-binary-xyz");
      bad.on("error", (e) => log("spawn error:", e.code, e.syscall, e.path, JSON.stringify(e.spawnargs)));
    });
  });
});
child.stdin.end("world\n");
const shape = spawnSync("/nonexistent/definitely-not-a-command");
log("failed spawn result:", Object.keys(shape).join(","), shape.output, shape.pid);
log("ok result:", Object.keys(spawnSync("true")).join(","));
