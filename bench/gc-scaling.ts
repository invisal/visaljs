// The GC scaling benchmarks: the programs in bench/gc-scaling/, each built by visaljs once and run
// at several sizes (env SIZE). They measure how the collector's pauses grow with what is live: the
// live heap itself, and the runtime's tables that every collection sweeps (atoms, shapes, WeakMap
// entries). A young collection should cost the same whatever the size; a full one, about what is
// live. live-heap also runs with the collector's optional features turned off (JS_GC_INCREMENTAL=0,
// JS_GC_THREADS=0), which says what incremental and parallel marking buy.
//
//   node bench/gc-scaling.ts [name...] [--runs=1] [--json=file]
//
// Each run's output must equal Node's (the run exits 1 otherwise, or when a build fails). Pause
// percentiles come from JS_GC_TRACE (a line per collection: young, or a full one's final pause);
// the longest pause comes from JS_GC_STATS, and counts incremental marking's slices too.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { buildVisaljs } from "./lib/standalone.ts";

const DIR = join(import.meta.dirname, "gc-scaling");
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: "string", default: "1" }, json: { type: "string" } },
});
const RUNS = Number(options.runs);

/** Each program's sizes (its SIZE: megabytes live for live-heap, entries for the others). */
const PROGRAMS: Record<string, { unit: string; sizes: number[]; features?: boolean }> = {
  "live-heap": { unit: "MB", sizes: [10, 100, 500], features: true },
  atoms: { unit: "atoms", sizes: [10_000, 100_000, 1_000_000] },
  shapes: { unit: "shapes", sizes: [10_000, 100_000, 1_000_000] },
  weakmap: { unit: "entries", sizes: [10_000, 100_000, 1_000_000] },
};
const FEATURES: Record<string, NodeJS.ProcessEnv> = {
  default: {},
  "no incremental": { JS_GC_INCREMENTAL: "0" },
  "no helper threads": { JS_GC_THREADS: "0" },
  neither: { JS_GC_INCREMENTAL: "0", JS_GC_THREADS: "0" },
};
const names = positionals.length ? positionals : Object.keys(PROGRAMS);
for (const name of names) if (!PROGRAMS[name]) throw new Error(`no program ${name} (${Object.keys(PROGRAMS).join(", ")})`);

const OUT = join(tmpdir(), `visaljs-gc-scaling-${process.pid}`);
mkdirSync(OUT, { recursive: true });

interface Measure {
  ms: number;
  rss: number;
  live: number;            // bytes the last full collection found live
  young: number[];         // young collections' pauses, ms
  full: number[];          // full collections' final pauses, ms
  maxPause: number;        // any pause, slices included
  pauseMs: number;
  sweepMs: number;
}

/** The [gc] lines (gc.c, trace_collection) and the [gc-stats] line of a run's stderr. */
function parse(stderr: string, ms: number): Measure {
  const m: Measure = { ms, rss: 0, live: 0, young: [], full: [], maxPause: 0, pauseMs: 0, sweepMs: 0 };
  for (const line of stderr.matchAll(/^\[gc\] #\d+ (\w+): pause ([\d.]+) ms .*?-> live (\d+) KiB/gm)) {
    if (line[1] === "young") m.young.push(Number(line[2]));
    else {
      m.full.push(Number(line[2]));
      m.live = Number(line[3]) * 1024;
    }
  }
  const stats = /^\[gc-stats\] (.*)$/m.exec(stderr);
  if (!stats) throw new Error(`no [gc-stats] line:\n${stderr.slice(-2000)}`);
  const s = JSON.parse(stats[1]!);
  Object.assign(m, { rss: s.peak_rss_bytes, maxPause: s.max_pause_ms, pauseMs: s.pause_ms, sweepMs: s.sweep_ms });
  return m;
}

/** The run with the best wall time of RUNS. */
function best(binary: string, env: NodeJS.ProcessEnv, expected: string): Measure {
  let result: Measure | null = null;
  for (let k = 0; k < RUNS; k++) {
    const start = process.hrtime.bigint();
    const r = spawnSync(binary, [], {
      encoding: "utf8",
      env: { ...process.env, ...env, JS_GC_TRACE: "1", JS_GC_STATS: "1" },
      maxBuffer: 256 << 20,
    });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (r.status !== 0) throw new Error(`${binary} exited ${r.status}: ${r.stderr.slice(-2000)}`);
    if (r.stdout !== expected) throw new Error(`output ${JSON.stringify(r.stdout)}, Node's ${JSON.stringify(expected)}`);
    const m = parse(r.stderr, ms);
    if (!result || m.ms < result.ms) result = m;
  }
  return result!;
}

/** The nearest-rank percentile; 0 for none. */
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const ms = (n: number) => (n >= 100 ? `${Math.round(n)} ms` : n >= 1 ? `${n.toFixed(1)} ms` : `${n.toFixed(2)} ms`);
const mb = (bytes: number) => `${Math.round(bytes / (1 << 20))} MB`;
const count = (n: number) => n.toLocaleString("en-US");

interface Row { program: string; size: number; feature: string; node: { ms: number }; visaljs: Measure | null }
const rows: Row[] = [];
let failed = false;

for (const name of names) {
  const program = PROGRAMS[name]!;
  const source = join(DIR, `${name}.js`);
  const binary = join(OUT, name);
  process.stderr.write(`${name}…\n`);
  try {
    buildVisaljs(source, binary);
    // a new binary's first launch is slower (macOS checks it): not the collector's time
    spawnSync(binary, [], { env: { ...process.env, SIZE: String(program.sizes[0]) }, stdio: "ignore" });
  } catch (e) {
    process.stderr.write(`${name}: ${(e as Error).message}\n`);
    failed = true;
    continue;
  }
  for (const size of program.sizes) {
    const env = { SIZE: String(size) };
    const start = process.hrtime.bigint();
    const node = spawnSync(process.execPath, [source], { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 << 20 });
    const nodeMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (node.status !== 0) throw new Error(`node ${source} exited ${node.status}: ${node.stderr}`);
    for (const feature of program.features ? Object.keys(FEATURES) : ["default"]) {
      process.stderr.write(`  ${count(size)} ${program.unit}, ${feature}…\n`);
      let v: Measure | null = null;
      try {
        v = best(binary, { ...env, ...FEATURES[feature] }, node.stdout);
      } catch (e) {
        process.stderr.write(`${name} ${size}: ${(e as Error).message}\n`);
        failed = true;
      }
      rows.push({ program: name, size, feature, node: { ms: nodeMs }, visaljs: v });
    }
  }
}

for (const name of names) {
  const program = PROGRAMS[name]!;
  const mine = rows.filter((r) => r.program === name && r.feature === "default");
  if (!mine.length) continue;
  console.log(`### ${name}`);
  console.log();
  console.log(`| Size | Live | visaljs | Node | Young pauses: count, p50, p99, longest | Full pauses: count, longest | Longest pause | Collecting | Memory |`);
  console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of mine) {
    const v = r.visaljs;
    const size = `${count(r.size)} ${program.unit}`;
    if (!v) {
      console.log(`| ${size} | — | — | ${ms(r.node.ms)} | — | — | — | — | — |`);
      continue;
    }
    const young = `${v.young.length}, ${ms(percentile(v.young, 50))}, ${ms(percentile(v.young, 99))}, ${ms(Math.max(0, ...v.young))}`;
    const full = `${v.full.length}, ${ms(Math.max(0, ...v.full))}`;
    const share = (v.pauseMs + v.sweepMs) / v.ms;
    console.log(`| ${size} | ${mb(v.live)} | ${ms(v.ms)} | ${ms(r.node.ms)} | ${young} | ${full} | ${ms(v.maxPause)} | ${Math.round(share * 100)}% | ${mb(v.rss)} |`);
  }
  console.log();
  if (!program.features) continue;
  const features = Object.keys(FEATURES);
  console.log(`What the optional features buy (${name}): longest pause, and wall time`);
  console.log();
  console.log(`| Size | ${features.join(" | ")} |`);
  console.log(`|---:|${features.map(() => "---:").join("|")}|`);
  for (const size of program.sizes) {
    const cells = features.map((f) => {
      const v = rows.find((r) => r.program === name && r.size === size && r.feature === f)?.visaljs;
      return v ? `${ms(v.maxPause)}, ${ms(v.ms)}` : "—";
    });
    console.log(`| ${count(size)} ${program.unit} | ${cells.join(" | ")} |`);
  }
  console.log();
}

if (options.json) {
  const slim = rows.map((r) => ({
    ...r,
    visaljs: r.visaljs && {
      ...r.visaljs,
      young: { count: r.visaljs.young.length, p50: percentile(r.visaljs.young, 50), p99: percentile(r.visaljs.young, 99), max: Math.max(0, ...r.visaljs.young) },
      full: { count: r.visaljs.full.length, max: Math.max(0, ...r.visaljs.full) },
    },
  }));
  writeFileSync(options.json, `${JSON.stringify(slim, null, 2)}\n`);
}
process.exit(failed ? 1 : 0);
