// Generates <program>.expected with Node: the ground truth for the end-to-end
// tests. print(x) is the test host's: String(x) and a newline. A program is an
// ES module (run as a file, so its imports resolve: the repository is "type": "module"), unless
// its first line is `// visaljs-flags: --script`, which makes it a classic script. Programs run
// in the Europe/Lisbon time zone, so Date's local times don't depend on the machine.
//
//   node tests/programs/gen_expected.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const dir = import.meta.dirname;
const shim = "globalThis.print = (x) => console.log(String(x));\n";
for (const f of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
  const source = readFileSync(join(dir, f), "utf8");
  const script = /^\/\/ visaljs-flags: .*--script/.test(source);
  const args = script ? ["-e", shim + source] : ["--import", `data:text/javascript,${encodeURIComponent(shim)}`, join(dir, f)];
  const cwd = mkdtempSync(join(tmpdir(), "visaljs-expected-"));  /* programs may write files */
  const run = spawnSync(process.execPath, ["--stack-size=900", ...args], { encoding: "utf8", cwd, env: { ...process.env, TZ: "Europe/Lisbon" } });
  rmSync(cwd, { recursive: true, force: true });
  if (run.status !== 0) throw new Error(f + " failed under Node:\n" + run.stderr);
  writeFileSync(join(dir, f.replace(/\.js$/, ".expected")), run.stdout);
  /* what it writes to stderr (console.error), when it writes anything */
  const stderrFile = join(dir, f.replace(/\.js$/, ".stderr"));
  if (run.stderr) writeFileSync(stderrFile, run.stderr);
  else rmSync(stderrFile, { force: true });
}
