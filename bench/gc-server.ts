// The GC server benchmark: bench/gc-server/server.js built by
// visaljs, against Node running it, under load and then idle. It measures what a server's users
// and its host see of the collector: latency (p50, p99) and memory over time.
//
//   node bench/gc-server.ts [--duration=10] [--connections=50] [--json=file]
//
// For each server, one after another:
//   1. steady: wrk on "/" for --duration seconds (a small JSON page; a cache of 20,000 entries,
//      replaced in turn, is the live heap);
//   2. spike: wrk on "/big" for 5 s (a megabyte buffer and a large JSON body per request);
//   3. idle: nothing for 5 s.
// Resident memory is sampled every 100 ms: at the start, its peak, and at the end of the idle
// phase. visaljs's server runs with JS_GC_TRACE=1: its collections, longest pause, and its idle
// collections are counted from the trace.
//
// Needs wrk on the PATH. On Linux the server and wrk run on separate cores (taskset).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { buildVisaljs } from "./lib/standalone.ts";

const SOURCE = join(import.meta.dirname, "gc-server", "server.js");
const { values: options } = parseArgs({
  options: {
    duration: { type: "string", default: "10" },
    connections: { type: "string", default: "50" },
    json: { type: "string" },
  },
});
const DURATION = Number(options.duration);
const CONNECTIONS = Number(options.connections);
const SPIKE_S = 5;
const IDLE_S = 5;

const OUT = join(tmpdir(), `visaljs-gc-server-${process.pid}`);
mkdirSync(OUT, { recursive: true });

const has = (cmd: string) => !spawnSync(cmd, ["--version"], { stdio: "ignore" }).error;
const cores = availableParallelism();
const pin = process.platform === "linux" && has("taskset") && cores >= 4;
const pinned = (cpus: string, command: string, args: string[]): [string, string[]] => (pin ? ["taskset", ["-c", cpus, command, ...args]] : [command, args]);
const SERVER_CPUS = `0-${cores / 2 - 1}`;
const CLIENT_CPUS = `${cores / 2}-${cores - 1}`;

function ok(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    get({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200));
    }).on("error", () => resolve(false));
  });
}

/** Resident memory in bytes: /proc on Linux, else ps. (Under taskset, the pid is the server's: taskset execs.) */
function rss(pid: number): number {
  const status = `/proc/${pid}/status`;
  if (existsSync(status)) {
    const m = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(status, "utf8"));
    return m ? Number(m[1]) * 1024 : 0;
  }
  return Number(spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()) * 1024 || 0;
}

/** wrk's latency, "1.23ms" / "456.00us" / "1.20s", in milliseconds. */
function ms(text: string): number {
  const m = /([\d.]+)(us|ms|s)/.exec(text);
  if (!m) return NaN;
  return Number(m[1]) * (m[2] === "us" ? 1e-3 : m[2] === "s" ? 1e3 : 1);
}

interface Load { rps: number; p50: number; p99: number; errors: number }

function wrk(port: number, path: string, seconds: number, connections: number): Promise<Load> {
  const [command, args] = pinned(CLIENT_CPUS, "wrk", ["-t2", `-c${connections}`, `-d${seconds}s`, "--timeout", "10s", "--latency", `http://127.0.0.1:${port}${path}`]);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`wrk exited with ${code}:\n${out}`));
      /* not wrk's timeouts: with a timeout longer than the run, they're the requests in flight when it ends */
      const errors = /Socket errors: connect (\d+), read (\d+), write (\d+)/.exec(out);
      const non2xx = /Non-2xx or 3xx responses: (\d+)/.exec(out);
      resolve({
        rps: Number(/Requests\/sec:\s+([\d.]+)/.exec(out)?.[1]),
        p50: ms(/\s50%\s+(\S+)/.exec(out)?.[1] ?? ""),
        p99: ms(/\s99%\s+(\S+)/.exec(out)?.[1] ?? ""),
        errors: (errors ? errors.slice(1).reduce((a, b) => a + Number(b), 0) : 0) + Number(non2xx?.[1] ?? 0),
      });
    });
  });
}

interface GCTrace { collections: number; full: number; idle: number; maxPause: number; totalPause: number }

/** Counts the [gc] lines (gc.c, trace_collection) of visaljs's stderr. */
function parseTrace(stderr: string): GCTrace {
  const t: GCTrace = { collections: 0, full: 0, idle: 0, maxPause: 0, totalPause: 0 };
  for (const m of stderr.matchAll(/^\[gc\] #\d+ (\w+): pause ([\d.]+) ms/gm)) {
    const pause = Number(m[2]);
    t.collections++;
    if (m[1] !== "young") t.full++;
    if (m[1] === "idle") t.idle++;
    t.totalPause += pause;
    t.maxPause = Math.max(t.maxPause, pause);
  }
  return t;
}

interface Result {
  name: string;
  steady: Load;
  spike: Load;
  memory: { start: number; peak: number; idle: number };
  gc?: GCTrace;
}

async function measure(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, port: number): Promise<Result> {
  const [cmd, cmdArgs] = pinned(SERVER_CPUS, command, args);
  const child = spawn(cmd, cmdArgs, { env: { ...process.env, ...env, PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  let exited = false;
  child.on("exit", () => (exited = true));
  const started = performance.now();
  while (!(await ok(port))) {
    if (exited) throw new Error(`${name} exited before answering:\n${stderr}`);
    if (performance.now() - started > 20000) throw new Error(`${name} didn't answer in 20 s`);
    await new Promise((r) => setTimeout(r, 5));
  }
  try {
    await new Promise((r) => setTimeout(r, 500));
    const start = rss(child.pid!);
    let peak = start;
    const sampler = setInterval(() => (peak = Math.max(peak, rss(child.pid!))), 100);
    let steady: Load, spike: Load;
    try {
      await wrk(port, "/", 2, CONNECTIONS);  /* warm up: Node's JIT compiles */
      steady = await wrk(port, "/", DURATION, CONNECTIONS);
      spike = await wrk(port, "/big", SPIKE_S, CONNECTIONS);
    } finally {
      clearInterval(sampler);
    }
    await new Promise((r) => setTimeout(r, IDLE_S * 1000));
    const idle = rss(child.pid!);
    const errors = steady.errors + spike.errors;
    if (errors) throw new Error(`${name}: ${errors} failed requests`);
    return { name, steady, spike, memory: { start, peak, idle }, gc: env.JS_GC_TRACE ? parseTrace(stderr) : undefined };
  } finally {
    await new Promise<void>((resolve) => {
      if (exited) return resolve();
      child.once("exit", () => resolve());
      child.kill();
    });
  }
}

const binary = join(OUT, "server");
buildVisaljs(SOURCE, binary);
const results = [
  await measure("visaljs", binary, [], { JS_GC_TRACE: "1" }, 3471),
  await measure(`Node ${process.version}`, process.execPath, [SOURCE], {}, 3472),
];

const mb = (bytes: number) => `${Math.round(bytes / (1 << 20))} MB`;
const lat = (m: number) => (m >= 10 ? `${Math.round(m)} ms` : `${m.toFixed(2)} ms`);
const thousands = (n: number) => Math.round(n).toLocaleString("en-US");
console.log(`| Server | Steady: req/s, p50, p99 | Spike: req/s, p50, p99 | Memory: start, peak, after ${IDLE_S} s idle |`);
console.log("|---|---:|---:|---:|");
for (const r of results) {
  console.log(`| ${r.name} | ${thousands(r.steady.rps)}, ${lat(r.steady.p50)}, ${lat(r.steady.p99)} | ${thousands(r.spike.rps)}, ${lat(r.spike.p50)}, ${lat(r.spike.p99)} | ${mb(r.memory.start)}, ${mb(r.memory.peak)}, ${mb(r.memory.idle)} |`);
}
const gc = results[0]!.gc!;
console.log();
console.log(`visaljs's collector: ${gc.collections} collections (${gc.full} full, ${gc.idle} when idle); pauses ${Math.round(gc.totalPause)} ms in total, longest ${gc.maxPause.toFixed(1)} ms.`);
if (options.json) writeFileSync(options.json, `${JSON.stringify(results, null, 2)}\n`);
