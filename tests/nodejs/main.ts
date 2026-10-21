// Node's own tests (tests/nodejs/test/parallel, copied by sync.ts) compiled by visaljs: a test
// passes when its binary exits 0, as it does under Node. Each test first runs under Node with
// the same stand-in for test/common (test/common), so a test that fails there needs more of the
// stand-in, and says nothing about visaljs.
//
//   node tests/nodejs/main.ts [--failures] [--update] [--shard=I/N] [--jobs=N] [test-file-prefix...]
//
// Tests are compiled in batches: a generated entry file (in a temporary directory, never
// committed) that requires the one test VISALJS_NODEJS_TEST names, so a batch is one build and
// each test still runs in its own process. The tests themselves are Node's, unchanged. A batch
// that doesn't build is built again one test at a time. A test isn't compiled exactly as it would
// be alone (the bundle and the preludes it reaches are the batch's), so a result that would
// change node.results is confirmed with the test built alone.
//
// Passing tests are compared with the snapshot node.results: a test that passed there and fails
// now is a regression (exit 1). --update records newly passing tests, and what each test took
// (node.timings). --timings-out=FILE writes what each test took (CI merges them into node.timings:
// timings.ts). --failures prints why each test failed. --shard=I/N runs the I-th of N parts
// (1-based), for CI: whole modules, balanced by node.timings. --jobs=N builds N batches at once
// (default: a third of the cores), each compiling its C --build-jobs=M files at a time (default 3).
// A build of the crypto or TLS tests compiles ~77k lines of C: on a machine with little memory,
// --jobs=1 --build-jobs=2.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { parseArgs } from "node:util";

import { moduleOf } from "./modules.ts";
import { mergeTimings, readTimings, writeTimings } from "./timings.ts";

const HERE = import.meta.dirname;
const PARALLEL = join(HERE, "test", "parallel");
const FIXTURES = join(HERE, "test", "fixtures");
const RESULTS = join(HERE, "node.results");
const SKIP = join(HERE, "node.skip");
const CLI = join(HERE, "..", "..", "cli", "src", "cli.ts");
const BATCH_SIZE = 20;
const TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 900_000;
/** A test binary's heap limit (the runtime's JS_HEAP_LIMIT_MB): a test whose memory grows without
 *  bound stops there and fails, instead of taking the machine's memory for its whole timeout. */
const HEAP_LIMIT_MB = process.env.JS_HEAP_LIMIT_MB ?? "1024";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    failures: { type: "boolean", default: false },
    update: { type: "boolean", default: false },
    shard: { type: "string" },
    jobs: { type: "string" },
    "build-jobs": { type: "string" },
    "timings-out": { type: "string" },
  },
});
const cores = availableParallelism();
const jobs = Math.max(1, Number(values.jobs ?? Math.floor(cores / 3)));
const buildJobs = Math.max(1, Number(values["build-jobs"] ?? 3));

/** --shard=I/N, as [I, N]; undefined without it. */
function shardArg(): [number, number] | undefined {
  if (!values.shard) return undefined;
  const m = /^(\d+)\/(\d+)$/.exec(values.shard);
  if (!m || +m[1]! < 1 || +m[1]! > +m[2]!) {
    console.error(`--shard=I/N, 1 <= I <= N: not ${values.shard}`);
    process.exit(2);
  }
  return [+m[1]!, +m[2]!];
}

/** Which of `n` shards each file is in (0-based). A module's tests stay together, so they share
 *  their batches' builds: the C a module brings (TLS's, crypto's) is compiled in one shard, not
 *  in every one. A module heavier than half a shard is cut into pieces, in file order. The pieces
 *  go, heaviest first, to the lightest shard so far, weighed by node.timings (a test it doesn't
 *  have weighs the median). The same files and timings give every shard the same plan. */
function planShards(files: string[], n: number, timings: Map<string, number>): { shard: Map<string, number>; loads: number[] } {
  const known = [...timings.values()].sort((a, b) => a - b);
  const median = known.length ? known[known.length >> 1]! : 1;
  const weight = (f: string) => timings.get(f) ?? median;
  const total = files.reduce((sum, f) => sum + weight(f), 0);
  const modules = new Map<string, string[]>();
  for (const f of files) modules.set(moduleOf(f), [...(modules.get(moduleOf(f)) ?? []), f]);
  const pieces: { files: string[]; weight: number }[] = [];
  for (const tests of modules.values()) {
    let piece: { files: string[]; weight: number } = { files: [], weight: 0 };
    for (const f of tests) {
      if (piece.files.length && piece.weight + weight(f) > total / n / 2) {
        pieces.push(piece);
        piece = { files: [], weight: 0 };
      }
      piece.files.push(f);
      piece.weight += weight(f);
    }
    pieces.push(piece);
  }
  pieces.sort((a, b) => b.weight - a.weight || a.files[0]!.localeCompare(b.files[0]!));
  const loads = new Array<number>(n).fill(0);
  const shard = new Map<string, number>();
  for (const piece of pieces) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest]! += piece.weight;
    for (const f of piece.files) shard.set(f, lightest);
  }
  return { shard, loads };
}

type Outcome = "pass" | "fail" | "build" | "timeout" | "shim" | "skip";

interface Result {
  file: string;
  outcome: Outcome;
  detail: string;
  /** What it took: its run, and its share of its build (node.timings). */
  seconds?: number;
  /** The outcome in its batch, when the test built alone differs. */
  inBatch?: Outcome;
}

/** node.skip: `test-file.js  reason`, one a line; # starts a comment. */
function skipList(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(SKIP)) return out;
  for (const line of readFileSync(SKIP, "utf8").split("\n")) {
    const text = line.replace(/#.*/, "").trim();
    if (!text) continue;
    const [file, ...reason] = text.split(/\s+/);
    out.set(file!, reason.join(" "));
  }
  return out;
}

/** Why a test can't run outside Node at all, or undefined. */
function cannotRun(source: string): string | undefined {
  const flags = /^\/\/ Flags: (.*)$/m.exec(source);
  if (flags) return `needs Node flags: ${flags[1]}`;
  if (/require\(['"]internal\//.test(source)) return "needs Node's internals";
  return undefined;
}

function run(command: string, args: string[], cwd: string, timeout: number, env?: Record<string, string>) {
  return new Promise<{ status: number | null; output: string; seconds: number }>((resolve) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout, killSignal: "SIGKILL", env: { ...process.env, ...env } });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (status) => resolve({ status, output, seconds: (performance.now() - started) / 1000 }));
  });
}

/** Runs fn on every item, `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const out = mkdtempSync(join(tmpdir(), "visaljs-nodejs-"));
let built = 0;
/* the same path for the same batch on every run: its C names it, and ccache ($CC) then compiles it
 * once (out is new each run) */
const ENTRIES = join(tmpdir(), "visaljs-nodejs-entries");

/** Compiles `entry` into a binary; its path and how long it took, or the compiler's messages. */
async function build(entry: string): Promise<{ binary: string; seconds: number } | { error: string; seconds: number }> {
  const binary = join(out, `bin-${built++}`);
  const r = await run(process.execPath, [CLI, "build", entry, "-o", binary, "--quiet", `--jobs=${buildJobs}`], out, BUILD_TIMEOUT_MS);
  return r.status === 0 ? { binary, seconds: r.seconds } : { error: r.output, seconds: r.seconds };
}

/** The entry file of a batch: the test VISALJS_NODEJS_TEST names, required (imported for an
 *  ES module) only when it is the one, so no other test's code runs.
 *
 *  A test that starts process.execPath expects Node, and gets this binary, which can't run any
 *  script it is given: it would run the test again, which starts it again, without end. So the
 *  binary marks its environment, which children inherit, and a child exits at once with an
 *  error: the test fails, as one that needs Node should. Except a test that runs itself again
 *  (`execPath, [__filename, ...args]`, the usual way to test in a fresh process): its child runs
 *  that test, with process.argv as Node's, [execPath, the file, ...args]; the test's own argv[1]
 *  is its file too, as under Node, so `[process.argv[1], ...args]` starts it again as well. */
function batchEntry(files: string[]): string {
  const cases = files.map((f) => {
    const path = JSON.stringify(join(PARALLEL, f));
    return `  case ${JSON.stringify(f)}: ${f.endsWith(".mjs") ? `import(${path})` : `require(${path})`}; break;`;
  });
  const fixtures = [...new Set(files.flatMap((f) => fixtureRequires(readFileSync(join(PARALLEL, f), "utf8"))))];
  const text = ["// Generated by tests/nodejs/main.ts: runs the test VISALJS_NODEJS_TEST names.",
    `const parallel = ${JSON.stringify(PARALLEL + sep)};`,
    ...(fixtures.length ? [
      'const requireTable = Symbol.for("visaljs.requireTable");',
      "const required = globalThis[requireTable] ?? Object.defineProperty(globalThis, requireTable, { value: new Map() })[requireTable];",
      ...fixtures.map((path) => `required.set(${JSON.stringify(path)}, () => require(${JSON.stringify(existsSync(path) ? path : path + ".js")}));`),
    ] : []),
    "if (process.env.VISALJS_NODEJS_CHILD) {",
    "  const script = process.argv[2];",
    "  if (typeof script === \"string\" && script.startsWith(parallel) && !script.slice(parallel.length).includes(\"/\")) {",
    "    process.env.VISALJS_NODEJS_TEST = script.slice(parallel.length);",
    "    process.argv.splice(1, 2, script);",
    "  } else {",
    '    console.error("a compiled test started as a child process: it can\'t run another program as Node does");',
    "    process.exit(1);",
    "  }",
    "} else if (process.env.VISALJS_NODEJS_TEST) {",
    "  process.argv[1] = parallel + process.env.VISALJS_NODEJS_TEST;  // as Node's: the script, which a child started with it runs",
    "}",
    'process.env.VISALJS_NODEJS_CHILD = "1";',
    "switch (process.env.VISALJS_NODEJS_TEST) {", ...cases, "}", ""].join("\n");
  const entry = join(ENTRIES, `batch-${createHash("sha256").update(text).digest("hex").slice(0, 16)}.cjs`);
  /* written whole, then renamed: another run may be building from the same entry */
  mkdirSync(ENTRIES, { recursive: true });
  const tmp = `${entry}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, entry);
  return entry;
}

/** The fixture modules a test requires by a path it builds at run time, `require(fixtures.path('tls-connect'))`:
 *  the paths it will ask for, which the batch puts in the require table, as the bundler can't follow them. */
function fixtureRequires(source: string): string[] {
  return Array.from(source.matchAll(/require\(\s*fixtures\.path\(\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)\s*\)/g),
    (m) => join(FIXTURES, ...Array.from(m[1]!.matchAll(/['"]([^'"]+)['"]/g), (p) => p[1]!)))
    .filter((path) => existsSync(path) || existsSync(path + ".js"));
}

/** Runs one test from a binary, in an empty directory (tests may write files). */
async function runTest(file: string, binary: string): Promise<Result> {
  const cwd = mkdtempSync(join(out, "cwd-"));
  /* NODE_TEST_DIR: test/common/tmpdir.js's root, the test's own directory */
  const r = await run(binary, [], cwd, TIMEOUT_MS, { VISALJS_NODEJS_TEST: file, JS_HEAP_LIMIT_MB: HEAP_LIMIT_MB, NODE_TEST_DIR: cwd });
  rmSync(cwd, { recursive: true, force: true });
  if (r.status === null) return { file, outcome: "timeout", detail: r.output, seconds: r.seconds };
  return { file, outcome: r.status === 0 ? "pass" : "fail", detail: r.output, seconds: r.seconds };
}

/** Builds the test alone and runs it. */
async function alone(file: string): Promise<Result> {
  const b = await build(batchEntry([file]));
  if ("error" in b) return { file, outcome: "build", detail: b.error, seconds: b.seconds };
  const r = await runTest(file, b.binary);
  return { ...r, seconds: b.seconds + r.seconds! };
}

const timings = readTimings();
const candidates = readdirSync(PARALLEL)
  .filter((f) => /\.m?js$/.test(f) && (positionals.length === 0 || positionals.some((p) => f.startsWith(p))))
  .sort();
const shardOpt = shardArg();
const plan = shardOpt && planShards(candidates, shardOpt[1], timings);
const files = plan ? candidates.filter((f) => plan.shard.get(f) === shardOpt![0] - 1) : candidates;
if (plan) {
  const loads = plan.loads.map((l) => `${Math.round(l)} s`).join(", ");
  console.log(`shard ${values.shard}: ${files.length} of ${candidates.length} tests (estimated, by node.timings: ${loads})\n`);
}
const skip = skipList();
const snapshot = new Set(existsSync(RESULTS) ? readFileSync(RESULTS, "utf8").split("\n").filter(Boolean) : []);
const results = new Map<string, Result>();
const report = (r: Result) => {
  results.set(r.file, r);
  console.log(`${r.outcome.padEnd(7)}  ${r.file}${r.inBatch ? `  (${r.inBatch} in its batch)` : ""}`);
  if (values.failures && r.outcome !== "pass" && r.outcome !== "skip" && r.detail.trim()) {
    console.log("         " + r.detail.trim().split("\n").slice(0, 12).join("\n         "));
  }
};

try {
  /* 1. skipped, and those that fail under Node */
  const runnable: string[] = [];
  await pool(files, cores, async (file) => {
    const reason = skip.get(file) ?? cannotRun(readFileSync(join(PARALLEL, file), "utf8"));
    if (reason !== undefined) return report({ file, outcome: "skip", detail: reason, seconds: 0 });
    const cwd = mkdtempSync(join(out, "cwd-"));
    const node = await run(process.execPath, [join(PARALLEL, file)], cwd, TIMEOUT_MS, { NODE_TEST_DIR: cwd });
    rmSync(cwd, { recursive: true, force: true });
    if (node.status !== 0) return report({ file, outcome: "shim", detail: node.output, seconds: node.seconds });
    runnable.push(file);
  });
  runnable.sort();

  /* 2. built in batches (one that doesn't build, one test at a time), each test run on its own */
  const batches: string[][] = [];
  for (let i = 0; i < runnable.length; i += BATCH_SIZE) batches.push(runnable.slice(i, i + BATCH_SIZE));
  const firstResults: Result[] = [];
  await pool(batches, jobs, async (batch) => {
    let b = await build(batchEntry(batch));
    /* the compiler names the test it can't build: it is a build failure, and the batch is built
     * again without it; when it names none, each test is built alone */
    while ("error" in b) {
      const error = b.error;
      /* only its errors: a warning names a test too ("Import x will always be undefined"). The
       * front end's are `file:line:column: SyntaxError: …` or `…: not supported yet: …`; without
       * them, a batch with a test using unsupported syntax was built again one test at a time */
      const errors = error.split("\n").filter((line) => /error|not supported yet/i.test(line) && !/\bwarning\b/i.test(line)).join("\n");
      const named = batch.filter((f) => errors.includes(join(PARALLEL, f)));
      if (named.length === 0 || named.length === batch.length) {
        for (const file of batch) firstResults.push(await alone(file));
        return;
      }
      for (const file of named) firstResults.push({ file, outcome: "build", detail: error, seconds: b.seconds / batch.length });
      batch = batch.filter((f) => !named.includes(f));
      b = await build(batchEntry(batch));
    }
    /* each test's share of the build, and its run */
    const share = b.seconds / batch.length;
    const ran = await pool(batch, Math.max(1, Math.floor(cores / jobs)), (file) => runTest(file, b.binary));
    firstResults.push(...ran.map((r) => ({ ...r, seconds: share + r.seconds! })));
    rmSync(b.binary, { force: true });
  });

  /* 3. a result that would change node.results, confirmed with the test built alone */
  const toConfirm = firstResults.filter((r) => (snapshot.has(r.file) ? r.outcome !== "pass" : values.update && r.outcome === "pass"));
  const confirmed = new Map((await pool(toConfirm, jobs, (r) => alone(r.file))).map((r) => [r.file, r]));
  for (const r of firstResults.sort((a, b) => a.file.localeCompare(b.file))) {
    const c = confirmed.get(r.file);
    /* its time is its batch's: what it costs in a shard */
    report(c && c.outcome !== r.outcome ? { ...c, inBatch: r.outcome, seconds: r.seconds } : r);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

/* by module: passed of those that ran */
const byModule = new Map<string, Record<Outcome, number>>();
for (const r of results.values()) {
  const m = moduleOf(r.file);
  if (!byModule.has(m)) byModule.set(m, { pass: 0, fail: 0, build: 0, timeout: 0, shim: 0, skip: 0 });
  byModule.get(m)![r.outcome]++;
}
console.log("\nmodule               passed   ran  (fail, build, timeout; skipped, need more of test/common)");
for (const [m, c] of [...byModule].sort(([a], [b]) => a.localeCompare(b))) {
  const ran = c.pass + c.fail + c.build + c.timeout;
  console.log(`${m.padEnd(20)} ${String(c.pass).padStart(6)} ${String(ran).padStart(5)}  (${c.fail}, ${c.build}, ${c.timeout}; ${c.skip}, ${c.shim})`);
}

const all = [...results.values()];
const passing = new Set(all.filter((r) => r.outcome === "pass").map((r) => r.file));
const regressions = all.filter((r) => snapshot.has(r.file) && !passing.has(r.file)).map((r) => r.file);
const newlyPassing = [...passing].filter((f) => !snapshot.has(f));
const differ = all.filter((r) => r.inBatch);
const ran = all.filter((r) => r.outcome !== "skip" && r.outcome !== "shim").length;
console.log(`\n${passing.size} of ${ran} pass under visaljs${values.shard ? ` (shard ${values.shard})` : ""}`);
if (differ.length) {
  console.log(`\n${differ.length} differ in a batch from built alone (the result is alone's):`);
  for (const r of differ) console.log(`  ${r.file}: ${r.inBatch} in its batch, ${r.outcome} alone`);
}
if (regressions.length) {
  console.log(`\n${regressions.length} regressions (passed in node.results):`);
  for (const f of regressions) console.log(`  ${f}`);
  process.exitCode = 1;
} else if (newlyPassing.length) {
  if (values.update) {
    /* the tests run now replace their old entries; the others' stay */
    const next = [...[...snapshot].filter((f) => !results.has(f)), ...passing].sort();
    writeFileSync(RESULTS, next.join("\n") + "\n");
    console.log(`node.results: ${newlyPassing.length} newly passing`);
  } else {
    console.log(`${newlyPassing.length} newly passing: --update records them in node.results`);
  }
}

/* what each test took, for the shards: --timings-out writes it as measured (CI's, merged by
 * timings.ts), --update merges it into node.timings */
const measured = new Map([...results.values()].filter((r) => r.seconds !== undefined).map((r) => [r.file, Math.round(r.seconds! * 10) / 10]));
if (values["timings-out"]) writeTimings(measured, values["timings-out"]);
if (values.update) {
  const next = mergeTimings(timings, measured);
  if (next.size) writeTimings(next);
}
