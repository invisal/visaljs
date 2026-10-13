// The React server-rendering benchmark: tests/apps/react-ssr/render.js (renderToString of a store
// page, timed inside the program, so startup isn't counted) built by visaljs and run against
// Node, both with React's production build (NODE_ENV=production). Their HTML must be the same.
//
//   node bench/react-ssr.ts [--products=200] [--renders=200] [--runs=3]
//
// Prints each one's best time per render over the runs, and the ratio.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { ensureInstalled } from "../tests/apps/install.ts";
import { buildVisaljs } from "./lib/standalone.ts";

const { values: options } = parseArgs({
  options: {
    products: { type: "string", default: "200" },
    renders: { type: "string", default: "200" },
    runs: { type: "string", default: "3" },
  },
});
const APP = join(import.meta.dirname, "..", "tests", "apps", "react-ssr");
const ENTRY = join(APP, "render.js");
const ARGS = [options.products, options.renders];
const env = { ...process.env, NODE_ENV: "production" };

/** The best ms per render over the runs, and the program's stdout (the HTML's checksum). */
function measure(command: string, args: string[]): { ms: number; stdout: string } {
  let best = Infinity;
  let stdout = "";
  for (let k = 0; k < Number(options.runs); k++) {
    const r = spawnSync(command, [...args, ...ARGS], { encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`${command} exited ${r.status}: ${r.stderr}`);
    const ms = Number(/([\d.]+) ms per render/.exec(r.stderr)?.[1]);
    if (!(ms >= 0)) throw new Error(`no time in ${JSON.stringify(r.stderr)}`);
    best = Math.min(best, ms);
    stdout = r.stdout;
  }
  return { ms: best, stdout };
}

ensureInstalled("react-ssr");
const out = join(tmpdir(), `visaljs-react-ssr-${process.pid}`);
mkdirSync(out, { recursive: true });
const binary = join(out, process.platform === "win32" ? "render.exe" : "render");
buildVisaljs(ENTRY, binary);

const node = measure(process.execPath, [ENTRY]);
const visaljs = measure(binary, []);
if (visaljs.stdout !== node.stdout) {
  process.stderr.write(`visaljs's output ${JSON.stringify(visaljs.stdout)}, Node's ${JSON.stringify(node.stdout)}\n`);
  process.exit(1);
}
const nodeVersion = execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim();
console.log(`renderToString, ${options.products} products, best of ${options.runs} runs of ${options.renders} renders`);
console.log("");
console.log(`| | ms per render |`);
console.log(`|---|---:|`);
console.log(`| visaljs | ${visaljs.ms.toFixed(2)} |`);
console.log(`| Node ${nodeVersion} | ${node.ms.toFixed(2)} |`);
console.log(`| ratio | ${(visaljs.ms / node.ms).toFixed(1)}× |`);
