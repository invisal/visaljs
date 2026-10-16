// The GC benchmarks: allocation-heavy programs in bench/gc/, each built
// by visaljs and run against Node running the source. They measure the collector: time, memory,
// and what the collector reports about itself (JS_GC_STATS).
//
//   node bench/gc.ts [name...] [--runs=3] [--json=file]
//
// Prints a markdown table per program: wall time (best of the runs) and peak resident memory,
// visaljs's and Node's; the collections, their total, p99 and longest pause, and the share of the run
// spent collecting (pauses and lazy sweeping). visaljs's output must equal Node's (the run exits
// 1 otherwise, or when a build fails). One thing runs at a time. --json also writes the numbers.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { buildVisaljs } from "./lib/standalone.ts";

const DIR = join(import.meta.dirname, "gc");
const NODE_RSS = join(import.meta.dirname, "lib", "node-rss.cjs");
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: "string", default: "3" }, json: { type: "string" } },
});
const RUNS = Number(options.runs);
const names = positionals.length ? positionals : readdirSync(DIR).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3)).sort();

const OUT = join(tmpdir(), `visaljs-gc-bench-${process.pid}`);
mkdirSync(OUT, { recursive: true });

/** What a visaljs program's collector reports at exit (gc.c, print_stats). */
interface GCStats {
  collections: number;
  pause_ms: number;
  max_pause_ms: number;
  mark_ms: number;
  weak_ms: number;
  finish_ms: number;
  sweep_ms: number;
  blocks_swept: number;
  allocated_bytes: number;
  peak_heap_bytes: number;
  peak_rss_bytes: number;
}

/** `pauses`: each collection's (JS_GC_TRACE), young ones and full ones' final pauses. */
interface Run { ms: number; stdout: string; rss: number; gc: GCStats | null; pauses: number[] }

/** The run with the best wall time of RUNS. */
function best(command: string, args: string[], env: NodeJS.ProcessEnv): Run {
  let result: Run | null = null;
  for (let k = 0; k < RUNS; k++) {
    const start = process.hrtime.bigint();
    const r = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 << 20 });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (r.status !== 0) throw new Error(`${command} exited ${r.status}: ${r.stderr}`);
    const stats = /^\[gc-stats\] (.*)$/m.exec(r.stderr);
    const rss = /^\[rss\] (\d+)$/m.exec(r.stderr);
    const gc = stats ? (JSON.parse(stats[1]!) as GCStats) : null;
    const pauses = [...r.stderr.matchAll(/^\[gc\] #\d+ \w+: pause ([\d.]+) ms/gm)].map((m) => Number(m[1]));
    const run = { ms, stdout: r.stdout, rss: gc ? gc.peak_rss_bytes : Number(rss?.[1] ?? 0), gc, pauses };
    if (!result || run.ms < result.ms) result = run;
  }
  return result!;
}

/** The nearest-rank percentile; 0 for none. */
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

interface Row { program: string; node: { ms: number; rss: number }; visaljs: (Omit<Run, "stdout" | "pauses"> & { p99: number }) | null }
const rows: Row[] = [];
let failed = false;
const nodeVersion = execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim();
for (const name of names) {
  const source = join(DIR, `${name}.js`);
  const binary = join(OUT, name);
  process.stderr.write(`${name}…\n`);
  const node = best(process.execPath, ["-r", NODE_RSS, source], {});
  try {
    buildVisaljs(source, binary);
    const v = best(binary, [], { JS_GC_STATS: "1", JS_GC_TRACE: "1" });
    if (v.stdout !== node.stdout) throw new Error(`output ${JSON.stringify(v.stdout)}, Node's ${JSON.stringify(node.stdout)}`);
    rows.push({ program: name, node: { ms: node.ms, rss: node.rss }, visaljs: { ms: v.ms, rss: v.rss, gc: v.gc, p99: percentile(v.pauses, 99) } });
  } catch (e) {
    process.stderr.write(`${name}: ${(e as Error).message}\n`);
    rows.push({ program: name, node: { ms: node.ms, rss: node.rss }, visaljs: null });
    failed = true;
  }
}

const ms = (n: number) => (n >= 100 ? `${Math.round(n)} ms` : `${n.toFixed(1)} ms`);
const mb = (bytes: number) => `${Math.round(bytes / (1 << 20))} MB`;
console.log(`| Program | visaljs | Node ${nodeVersion} | visaljs / Node | Memory: visaljs, Node | Collections | Pauses: total, p99, longest | Collecting |`);
console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
for (const r of rows) {
  const v = r.visaljs;
  if (!v) {
    console.log(`| ${r.program} | — | ${ms(r.node.ms)} | — | — | — | — | — |`);
    continue;
  }
  const gc = v.gc!;
  const share = (gc.pause_ms + gc.sweep_ms) / v.ms;
  console.log(`| ${r.program} | ${ms(v.ms)} | ${ms(r.node.ms)} | ${(v.ms / r.node.ms).toFixed(1)}× | ${mb(v.rss)}, ${mb(r.node.rss)} | ${gc.collections} | ${ms(gc.pause_ms)}, ${ms(v.p99)}, ${ms(gc.max_pause_ms)} | ${Math.round(share * 100)}% |`);
}
if (options.json) writeFileSync(options.json, `${JSON.stringify(rows, null, 2)}\n`);
process.exit(failed ? 1 : 0);
