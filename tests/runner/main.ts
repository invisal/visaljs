// test262 runner.
//
//   node tests/runner/main.ts [--json] [--update] [--failures] [--shard=I/N] [--jobs=N] [path-prefix...]
//   node tests/runner/main.ts --merge shard-file...
//
// Discovers tests, applies the skip list and builds compile units, then runs
// them in batches on a pool of worker threads (worker.ts, batch.ts). Passing
// units are compared with the snapshot tests/test262.results: a unit that
// passed there and fails now is a regression (exit 1). --update rewrites the
// snapshot when there are none, and saves the run's Summary (build/test262-summary.json)
// so later tools can use it instead of running the suite again. --json prints a
// Summary. --failures lists every failing unit with its reason.
//
// --shard=I/N runs the I-th of N parts (1-based; files assigned by a hash of their path)
// and checks it against the matching part of the snapshot, so CI can split the suite
// into separate jobs. With --update, a shard doesn't touch the snapshot: it saves its Summary
// (build/test262-shard-I.json), and --merge combines every shard's file into the snapshot and
// the run's Summary, as one --update of the full suite would. --jobs=N caps the worker threads
// (default: one per core).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join, relative, sep } from "node:path";
import { Worker } from "node:worker_threads";

import type { Item, Reason, Result } from "./batch.ts";
import { MetadataError, parseMetadata } from "./metadata.ts";
import { parseSkipList, skipReason } from "./skip.ts";
import { testHost } from "./batch.ts";
import { compileUnits, type Mode } from "./units.ts";

const ROOT = join(import.meta.dirname, "..");
const TEST_DIR = join(ROOT, "test262", "test");
const RESULTS = join(ROOT, "test262.results");
/** The last --update run's Summary (lists left out), and the snapshot it wrote. */
export const SUMMARY_FILE = join(ROOT, "..", "build", "test262-summary.json");
/** A shard's Summary, saved by --shard=I/N --update for --merge. */
export const shardFile = (shard: Shard) => join(ROOT, "..", "build", `test262-shard-${shard.index + 1}.json`);

/** A snapshot's identity: a saved Summary is only reused with the snapshot it produced. */
export function snapshotHash(): string {
  return createHash("sha256").update(existsSync(RESULTS) ? readFileSync(RESULTS) : "").digest("hex");
}
const BATCH_SIZE = 100;

export interface Shard { index: number; count: number }  // index is 0-based

/** "I/N" (1-based) → Shard. */
export function parseShard(text: string): Shard {
  const m = /^(\d+)\/(\d+)$/.exec(text);
  const index = Number(m?.[1]), count = Number(m?.[2]);
  if (!m || count < 1 || index < 1 || index > count) throw new Error(`--shard=${text}: expected I/N with 1 <= I <= N`);
  return { index: index - 1, count };
}

/** Whether a test file belongs to the shard: every compile unit of a file stays together. */
export function inShard(path: string, shard: Shard | null): boolean {
  return !shard || createHash("sha1").update(path).digest().readUInt32BE(0) % shard.count === shard.index;
}

/** What doesn't run yet; null once the runner executes every unit. */
const BLOCKED: string | null = null;

export interface Counts {
  files: number;
  skipped: number;   // files not compiled: test262.skip
  units: number;     // compile units of the remaining files
  run: number;
  passed: number;
  failed: number;
}

export interface Summary extends Counts {
  badMetadata: number;
  byMode: Partial<Record<Mode, number>>;
  byDir: Record<string, Counts>;  // top-level directory under test/
  blocked: string | null;
  /** Why units didn't pass: unsupported syntax, failed assertions, crashes… */
  byReason: Partial<Record<Reason, number>>;
  passing: string[];    // "path mode" of every passing unit, sorted
  failures: { unit: string; reason: Reason; detail?: string }[];
}

const zero = (): Counts => ({ files: 0, skipped: 0, units: 0, run: 0, passed: 0, failed: 0 });

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith(".js") && !entry.name.includes("_FIXTURE")) yield full;
  }
}

/** Runs batches on a pool of worker threads; resolves with each batch's results. */
class Pool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: { items: Item[]; resolve: (r: Result[]) => void }[] = [];
  private readonly pending = new Map<number, (r: Result[]) => void>();
  private nextId = 0;
  private waiters: (() => void)[] = [];

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      /* each worker's C compiles get its share of the memory: a few huge batches at once
         otherwise run the machine out of it (a CI runner has 8 GB for 4 workers) */
      const w = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { ccMemory: Math.floor(totalmem() / size) } });
      w.on("message", ({ id, results }: { id: number; results: Result[] }) => {
        this.pending.get(id)!(results);
        this.pending.delete(id);
        this.idle.push(w);
        this.next();
        for (const wake of this.waiters.splice(0)) wake();
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run(items: Item[]): Promise<Result[]> {
    return new Promise((resolve) => {
      this.queue.push({ items, resolve });
      this.next();
    });
  }

  /** Resolves once at most `limit` batches wait for a worker: the scan doesn't read ahead of the pool. */
  async drain(limit: number) {
    while (this.queue.length > limit) await new Promise<void>((r) => this.waiters.push(r));
  }

  private next() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      const id = this.nextId++;
      this.pending.set(id, job.resolve);
      w.postMessage({ id, items: job.items });
    }
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

export async function scan(prefixes: string[], jobs = availableParallelism(), shard: Shard | null = null): Promise<Summary> {
  const skip = parseSkipList(readFileSync(join(ROOT, "test262.skip"), "utf8"));
  const summary: Summary = { ...zero(), badMetadata: 0, byMode: {}, byDir: {}, blocked: BLOCKED, byReason: {}, passing: [], failures: [] };
  testHost();  /* build it once, before the workers race to */
  const pool = new Pool(jobs);
  const batches: Promise<void>[] = [];
  let batch: Item[] = [];

  const record = (items: Item[], results: Result[]) => {
    results.forEach((r, i) => {
      const unit = items[i]!.unit;
      const dir = summary.byDir[unit.path.split("/")[0]!]!;
      summary.byReason[r.reason] = (summary.byReason[r.reason] ?? 0) + 1;
      if (r.outcome === "not-run") return;
      summary.run++;
      dir.run++;
      if (r.outcome === "pass") {
        summary.passed++;
        dir.passed++;
        summary.passing.push(`${unit.path} ${unit.mode}`);
      } else {
        summary.failed++;
        dir.failed++;
        summary.failures.push({ unit: `${unit.path} ${unit.mode}`, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) });
      }
    });
  };
  const flush = async () => {
    if (!batch.length) return;
    const items = batch;
    batch = [];
    batches.push(pool.run(items).then((results) => record(items, results)));
    await pool.drain(jobs);
  };

  try {
    for (const full of walk(TEST_DIR)) {
      const path = relative(TEST_DIR, full).split(sep).join("/");
      if (prefixes.length && !prefixes.some((p) => path.startsWith(p))) continue;
      if (!inShard(path, shard)) continue;
      const dir = (summary.byDir[path.split("/")[0]!] ??= zero());
      summary.files++;
      dir.files++;
      try {
        const source = readFileSync(full, "utf8");
        const meta = parseMetadata(source);
        if (skipReason(skip, path, meta)) {
          summary.skipped++;
          dir.skipped++;
          continue;
        }
        for (const unit of compileUnits(path, meta)) {
          summary.units++;
          dir.units++;
          summary.byMode[unit.mode] = (summary.byMode[unit.mode] ?? 0) + 1;
          batch.push({ unit, source });
          if (batch.length === BATCH_SIZE) await flush();
        }
      } catch (e) {
        if (!(e instanceof MetadataError)) throw e;
        summary.badMetadata++;
        console.error(`${path}: ${e.message}`);
      }
    }
    await flush();
    await Promise.all(batches);
  } finally {
    await pool.close();
  }
  summary.passing.sort();
  summary.failures.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  return summary;
}

const addCounts = (a: Counts, b: Counts): Counts => ({
  files: a.files + b.files, skipped: a.skipped + b.skipped, units: a.units + b.units,
  run: a.run + b.run, passed: a.passed + b.passed, failed: a.failed + b.failed,
});

/** The full suite's Summary from every shard's, checking that none is missing or repeated. */
export function mergeShards(parts: { shard: Shard; summary: Summary }[]): Summary {
  const count = parts[0]?.shard.count ?? 0;
  const indices = parts.map((p) => p.shard.index).sort((a, b) => a - b);
  if (!count || parts.some((p) => p.shard.count !== count) || indices.some((i, n) => i !== n) || indices.length !== count)
    throw new Error(`--merge: expected one file for each of the N shards, got ${parts.map((p) => `${p.shard.index + 1}/${p.shard.count}`).join(", ") || "none"}`);
  const sum = (records: Partial<Record<string, number>>[]) => {
    const out: Record<string, number> = {};
    for (const r of records) for (const [k, n] of Object.entries(r)) out[k] = (out[k] ?? 0) + n!;
    return out;
  };
  const byDir: Record<string, Counts> = {};
  for (const { summary } of parts) for (const [dir, c] of Object.entries(summary.byDir)) byDir[dir] = addCounts(byDir[dir] ?? zero(), c);
  return {
    ...parts.map((p) => p.summary as Counts).reduce(addCounts, zero()),
    badMetadata: parts.reduce((n, p) => n + p.summary.badMetadata, 0),
    byMode: sum(parts.map((p) => p.summary.byMode)),
    byDir,
    blocked: parts[0]!.summary.blocked,
    byReason: sum(parts.map((p) => p.summary.byReason)),
    passing: parts.flatMap((p) => p.summary.passing).sort(),
    failures: parts.flatMap((p) => p.summary.failures).sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0)),
  };
}

/** Units that passed in the snapshot but not now, and the ones newly passing. */
export function compareWithSnapshot(passing: string[], snapshot: string[]) {
  const now = new Set(passing), before = new Set(snapshot);
  return {
    regressions: snapshot.filter((u) => !now.has(u)),
    newlyPassing: passing.filter((u) => !before.has(u)),
  };
}

function readSnapshot(): string[] {
  if (!existsSync(RESULTS)) return [];
  return readFileSync(RESULTS, "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
}

async function main(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const update = args.includes("--update");
  /* regressions that are intended (tests that passed by accident), listed in the output: still updates */
  const accept = args.includes("--accept-regressions");
  const prefixes = args.filter((a) => !a.startsWith("--"));
  const option = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  let shard: Shard | null = null;
  let jobs = availableParallelism();
  try {
    const s = option("shard"), j = option("jobs");
    if (s) shard = parseShard(s);
    if (j !== undefined && !(Number.isInteger((jobs = Number(j))) && jobs > 0)) throw new Error(`--jobs=${j}: expected a positive integer`);
    if (shard && update && prefixes.length) throw new Error("--update needs the whole shard: drop the path prefixes");
  } catch (e) {
    console.error(`test262 runner: ${(e as Error).message}`);
    return 2;
  }
  if (args.includes("--merge")) {
    /* the arguments are shard files: the full suite's Summary, compared and written as by --update */
    let summary: Summary;
    try {
      summary = mergeShards(prefixes.map((f) => JSON.parse(readFileSync(f, "utf8")) as { shard: Shard; summary: Summary }));
    } catch (e) {
      console.error(`test262 runner: ${(e as Error).message}`);
      return 2;
    }
    console.log(`merged:         ${prefixes.length} shards`);
    return report(summary, null, { update: true, accept, failures: false, partial: false });
  }
  let summary: Summary;
  try {
    summary = await scan(prefixes, jobs, shard);
  } catch (e) {
    console.error(`test262 runner: ${(e as Error).message}\n(run: git submodule update --init)`);
    return 2;
  }

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return summary.badMetadata ? 1 : 0;
  }
  return report(summary, shard, { update, accept, failures: args.includes("--failures"), partial: prefixes.length > 0 });
}

/** Prints the Summary and compares it with the snapshot (a shard: with its part); --update writes the
 * snapshot, or a shard's file for --merge. */
function report(summary: Summary, shard: Shard | null, opts: { update: boolean; accept: boolean; failures: boolean; partial: boolean }): number {
  const { update, accept } = opts;
  if (shard) console.log(`shard:          ${shard.index + 1} of ${shard.count}`);
  const pct = summary.units ? ((100 * summary.passed) / summary.units).toFixed(1) : "0.0";
  console.log(`test files:     ${summary.files}`);
  console.log(`skipped:        ${summary.skipped}`);
  console.log(`bad metadata:   ${summary.badMetadata}`);
  console.log(`compile units:  ${summary.units} (${Object.entries(summary.byMode).map(([m, n]) => `${m} ${n}`).join(", ")})`);
  console.log(`run:            ${summary.run}${summary.blocked ? ` (${summary.blocked})` : ""}`);
  console.log(`passed:         ${summary.passed} of ${summary.units} units (${pct}%), ${summary.failed} failed`);
  console.log(`by reason:      ${Object.entries(summary.byReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", ")}`);
  if (opts.failures)
    for (const f of summary.failures) console.log(`  ${f.reason.padEnd(14)} ${f.unit}${f.detail ? `  :: ${f.detail}` : ""}`);
  if (summary.badMetadata) return 1;
  if (opts.partial) return 0;  // a partial run can't be compared with the full snapshot

  /* a shard is compared with its part of the snapshot */
  const snapshot = readSnapshot().filter((u) => inShard(u.slice(0, u.lastIndexOf(" ")), shard));
  const { regressions, newlyPassing } = compareWithSnapshot(summary.passing, snapshot);
  if (newlyPassing.length) console.log(`newly passing:  ${newlyPassing.length}${update ? "" : " (refresh the snapshot: npm run test262 -- --update)"}`);
  if (regressions.length) {
    console.log(`REGRESSIONS:    ${regressions.length} units passed in tests/test262.results and fail now:`);
    for (const r of regressions.slice(0, 50)) console.log(`  ${r}`);
    if (!accept) {
      if (update) console.log("snapshot not updated");
      return 1;
    }
  }
  if (update && shard) {
    const file = shardFile(shard);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ shard, summary }));
    console.log(`wrote ${file} (combine the shards: npm run test262 -- --merge build/test262-shard-*.json)`);
  } else if (update) {
    /* the new snapshot, and its Summary */
    writeFileSync(RESULTS, `# Passing test262 compile units ("path mode"). Generated by: npm run test262 -- --update\n${summary.passing.join("\n")}\n`);
    const { passing: _p, failures: _f, ...counts } = summary;
    mkdirSync(join(SUMMARY_FILE, ".."), { recursive: true });
    writeFileSync(SUMMARY_FILE, JSON.stringify({ snapshot: snapshotHash(), summary: counts }));
    console.log(`wrote ${RESULTS} and ${SUMMARY_FILE}`);
  }
  return 0;
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) process.exitCode = await main(process.argv.slice(2));
