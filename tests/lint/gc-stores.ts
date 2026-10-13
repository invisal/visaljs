// The write barrier's lint: runtime C stores a cell into a traced field
// only through js_store, js_store_ptr, js_store_range or js_init_slot. A raw store into one of
// the fields below must say why it needs no barrier, in a `barrier:` comment on its line: a fresh
// cell, a move within the same owner, a value that's never a cell, a barrier just after it.
// A heuristic, not a proof: the barrier verifier (JS_GC_VERIFY) catches what it misses.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DIRS = ["runtime/src", "runtime/include", "node/src"];
const FIELDS = "values|vars|data|list|queue|listeners|entries|cells";
const POINTERS = "shape|elements|ool|env|parent|proto";
const STORE = new RegExp(`->(?:(?:${FIELDS})\\[[^\\]]*\\]|(?:${POINTERS}))\\s*=[^=]`);

const problems: string[] = [];
for (const dir of DIRS) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (!/\.[ch]$/.test(name)) continue;
    const path = `${dir}/${name}`;
    readFileSync(join(ROOT, path), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (STORE.test(line) && !/js_store|js_init_slot|barrier:/.test(line)) problems.push(`${path}:${i + 1}: ${line.trim()}`);
      });
  }
}
if (problems.length) {
  console.error(`Raw stores into traced fields without a barrier (use js_store, or say why with a "barrier:" comment):\n${problems.join("\n")}`);
  process.exit(1);
}
