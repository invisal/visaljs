// Differential testing from the command line: runs each program with Node and
// with visaljs and reports where they differ.
//
//   npm run differential -- app.js tests/differential/   (files, or directories of *.js)
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { differential } from "./diff.ts";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: npm run differential -- <file.js | directory>...");
  process.exit(2);
}
const files = targets.flatMap((t) =>
  statSync(t).isDirectory() ? readdirSync(t).filter((f) => f.endsWith(".js")).sort().map((f) => join(t, f)) : [t]);

const out = mkdtempSync(join(tmpdir(), "visaljs-diff-"));
let failed = 0;
try {
  for (const file of files) {
    const outcome = await differential(file, out);
    if (outcome.differences.length === 0) {
      console.log(`same  ${file}`);
    } else {
      failed++;
      console.log(`DIFF  ${file}`);
      for (const d of outcome.differences) console.log("  " + d.split("\n").join("\n  "));
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
console.log(`\n${files.length - failed} of ${files.length} programs behave the same under Node and visaljs`);
process.exitCode = failed ? 1 : 0;
