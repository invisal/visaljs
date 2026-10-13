// The compute kernels: small CPU-bound programs in bench/kernels/, each built by visaljs and
// timed against Node running the source. They measure the optimizer: the generated C, not the
// server platform (that is bench/servers.ts).
//
//   node bench/kernels.ts [name...] [--runs=3] [--json=file]
//
// The kernels: bench/kernels/*.js, ours, run without arguments; and the suites, a folder each
// (awfy/, benchmarks-game/) whose kernels.json lists its kernels, `<name>.js` in the folder:
//
//   { "n-body": { "args": ["5000000"] },
//     "k-nucleotide": { "stdin": { "kernel": "fasta", "args": ["250000"] } },
//     "pidigits": { "args": ["2000"], "unsupported": "why visaljs can't build or run it yet" } }
//
// stdin: the input is that kernel's output under Node, made once into a file that is the program's
// stdin (a file, as the Benchmarks Game gives it: programs may read /dev/stdin, which a pipe from
// spawnSync's input isn't). unsupported: the kernel is
// reported but doesn't fail the run (one that works again says so, to drop the entry).
//
// Names pick kernels: "fib", "awfy/richards", or a whole suite, "awfy". Prints a markdown table
// per suite: each kernel's best wall time over the runs, visaljs's and Node's, their ratio, and
// the ratios' geometric mean. visaljs's output must equal Node's, byte for byte (the run exits 1
// otherwise, or when a build fails). One thing runs at a time. --json also writes the times, in
// milliseconds.
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { buildVisaljs } from "./lib/standalone.ts";

const DIR = join(import.meta.dirname, "kernels");
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: "string", default: "3" }, json: { type: "string" } },
});
const RUNS = Number(options.runs);

interface Spec { args?: string[]; stdin?: { kernel: string; args?: string[] }; unsupported?: string }
interface Kernel { name: string; suite: string; source: string; spec: Spec }

/** Ours (suite ""), then each suite's, in the order of their kernels.json. */
function kernels(): Kernel[] {
  const list: Kernel[] = readdirSync(DIR).filter((f) => f.endsWith(".js")).sort()
    .map((f) => ({ name: f.slice(0, -3), suite: "", source: join(DIR, f), spec: {} }));
  for (const suite of readdirSync(DIR).sort()) {
    const manifest = join(DIR, suite, "kernels.json");
    if (!existsSync(manifest)) continue;
    const specs = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Spec>;
    for (const [name, spec] of Object.entries(specs)) list.push({ name: `${suite}/${name}`, suite, source: join(DIR, suite, `${name}.js`), spec });
  }
  return list;
}

const all = kernels();
const unknown = positionals.filter((p) => !all.some((k) => k.name === p || k.suite === p));
if (unknown.length) {
  console.error(`bench: no kernel or suite ${unknown.join(", ")}`);
  process.exit(1);
}
const chosen = positionals.length ? all.filter((k) => positionals.includes(k.name) || positionals.includes(k.suite)) : all;

const OUT = join(tmpdir(), `visaljs-kernels-${process.pid}`);
mkdirSync(OUT, { recursive: true });

/** A kernel's input file: another kernel's output under Node, made once. */
const inputs = new Map<string, string>();
function input(k: Kernel): string | undefined {
  const stdin = k.spec.stdin;
  if (!stdin) return undefined;
  const source = join(DIR, k.suite, `${stdin.kernel}.js`);
  const args = stdin.args ?? [];
  const key = [source, ...args].join("\0");
  if (!inputs.has(key)) {
    const file = join(OUT, `input-${inputs.size}`);
    writeFileSync(file, execFileSync(process.execPath, [source, ...args], { maxBuffer: 1 << 30 }));
    inputs.set(key, file);
  }
  return inputs.get(key);
}

/** The best of RUNS wall times (ms), and the program's output. */
function time(command: string, args: string[], stdin: string | undefined): { ms: number; stdout: Buffer } {
  let best = Infinity;
  let stdout = Buffer.alloc(0);
  for (let k = 0; k < RUNS; k++) {
    const fd = stdin === undefined ? "ignore" : openSync(stdin, "r");
    const start = process.hrtime.bigint();
    const r = spawnSync(command, args, { stdio: [fd, "pipe", "pipe"], maxBuffer: 1 << 30 });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (typeof fd === "number") closeSync(fd);
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`${command} exited ${r.status ?? r.signal}: ${r.stderr.toString().trim().slice(0, 500)}`);
    best = Math.min(best, ms);
    stdout = r.stdout;
  }
  return { ms: best, stdout };
}

/** Where two outputs first differ, for the message. */
function difference(ours: Buffer, node: Buffer): string {
  let i = 0;
  while (i < ours.length && i < node.length && ours[i] === node[i]) i++;
  const at = (b: Buffer) => JSON.stringify(b.subarray(Math.max(0, i - 20), i + 40).toString("latin1"));
  return `output differs from Node's at byte ${i} (${ours.length} and ${node.length} bytes): ${at(ours)}, Node's ${at(node)}`;
}

interface Row { kernel: string; visaljs: number | null; node: number; unsupported?: string; error?: string }
const rows: Row[] = [];
let failed = false;
for (const k of chosen) {
  const args = k.spec.args ?? [];
  const binary = join(OUT, k.name.replaceAll("/", "-"));
  process.stderr.write(`${k.name}…\n`);
  const stdin = input(k);
  const node = time(process.execPath, [k.source, ...args], stdin);
  try {
    buildVisaljs(k.source, binary);
    const v = time(binary, args, stdin);
    if (!v.stdout.equals(node.stdout)) throw new Error(difference(v.stdout, node.stdout));
    rows.push({ kernel: k.name, visaljs: v.ms, node: node.ms });
    if (k.spec.unsupported) process.stderr.write(`${k.name}: works now: drop its "unsupported" from kernels.json\n`);
  } catch (e) {
    const error = (e as Error).message;
    rows.push({ kernel: k.name, visaljs: null, node: node.ms, unsupported: k.spec.unsupported, error });
    if (!k.spec.unsupported) {
      process.stderr.write(`${k.name}: ${error}\n`);
      failed = true;
    }
  }
}

const nodeVersion = execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim();
const ms = (n: number) => `${Math.round(n)} ms`;
const ratio = (x: number) => `${x.toFixed(2)}×`;
const SUITES: Record<string, string> = {
  "": "Kernels",
  awfy: "[Are We Fast Yet](https://github.com/smarr/are-we-fast-yet)",
  "benchmarks-game": "[The Benchmarks Game](https://benchmarksgame-team.pages.debian.net/benchmarksgame/)",
};
for (const suite of [...new Set(chosen.map((k) => k.suite))]) {
  const prefix = suite ? `${suite}/` : "";
  const suiteRows = rows.filter((r) => chosen.find((k) => k.name === r.kernel)!.suite === suite);
  console.log(`\n### ${SUITES[suite] ?? suite}\n`);
  console.log(`| Kernel | visaljs | Node ${nodeVersion} | visaljs / Node |`);
  console.log("|---|---:|---:|---:|");
  /* the reasons a kernel is unsupported, as notes under the table: one per reason */
  const reasons: string[] = [];
  for (const r of suiteRows) {
    const name = r.kernel.slice(prefix.length);
    if (r.visaljs !== null) console.log(`| ${name} | ${ms(r.visaljs)} | ${ms(r.node)} | ${ratio(r.visaljs / r.node)} |`);
    else if (r.unsupported) {
      if (!reasons.includes(r.unsupported)) reasons.push(r.unsupported);
      console.log(`| ${name} | unsupported (${reasons.indexOf(r.unsupported) + 1}) | ${ms(r.node)} | — |`);
    } else console.log(`| ${name} | **failed** | ${ms(r.node)} | — |`);
  }
  /* the geometric mean: each kernel counts the same, however long it runs */
  const ran = suiteRows.filter((r) => r.visaljs !== null);
  if (ran.length > 1) {
    const mean = Math.exp(ran.reduce((s, r) => s + Math.log(r.visaljs! / r.node), 0) / ran.length);
    console.log(`| **geometric mean** (${ran.length} of ${suiteRows.length}) | | | **${ratio(mean)}** |`);
  }
  if (reasons.length) console.log(`\nUnsupported: ${reasons.map((r, i) => `(${i + 1}) ${r}`).join("; ")}.`);
}
if (options.json) writeFileSync(options.json, `${JSON.stringify(rows, null, 2)}\n`);
process.exit(failed ? 1 : 0);
