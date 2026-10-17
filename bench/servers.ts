// The server benchmarks: HTTP apps from tests/apps (Express, Hono, a bare node:http server, Next.js,
// vinext), each as a standalone binary from visaljs, Bun (`bun build --compile`) and Node (a single
// executable application), measured one after another. (Node and Bun running the source run the
// same engines as their binaries: the same throughput.) Next.js and vinext are projects, not one
// file, and have no Node or Bun binary: Node and Bun run their production servers (`next start`,
// `vinext start`), without a size. For each: binary size, startup (spawn to the first response),
// idle and peak memory, and throughput and latency under wrk.
//
//   node bench/servers.ts [app...] [--duration=10] [--connections=50] [--only=visaljs,bun] [--min-ratio=1] [--gate=express] [--json=file]
//
// Names pick apps (default: all of SERVERS below). --only: targets by name or its first word
// ("node" is "node (SEA)"). --min-ratio: exit 1 when visaljs's req/s on a route is below that
// multiple of Node's or it had errors: the nightly regression check (.github/workflows/nightly.yml);
// --gate: only those apps count (default: all; Next.js and vinext have errors under wrk's load with
// Node too). visaljs failing to build or serve an app exits 1 too; Node or Bun failing leaves their
// row out, with a warning. Every app is measured first, and the report written, before the exit.
// --json: also write the results to a file (the website's bench/servers.json); an app's entry
// replaces the one already there, and the others stay.
//
// Needs wrk on the PATH, and bun for the Bun rows (skipped without it). On Linux the server and
// wrk run on separate cores (taskset). Numbers are for comparing on one machine, not across them.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { APPS, ensureInstalled } from "../tests/apps/install.ts";
import { buildBun, buildNodeSea, buildVisaljs } from "./lib/standalone.ts";

/** The apps measured, the routes wrk loads, and the npm package whose version the report names.
 *  `start`: a project's production server under Node (as tests/apps/check.ts), which Node and Bun
 *  run in place of a binary of theirs. */
interface Server { app: string; routes: string[]; framework?: string; start?: string[] }
const SERVERS: Server[] = [
  { app: "http-hello", routes: ["/"] },
  { app: "express", routes: ["/", "/json", "/users/42?q=x&tag=a&tag=b"], framework: "express" },
  { app: "hono", routes: ["/", "/json", "/users/42?q=x"], framework: "hono" },
  { app: "nextjs", routes: ["/", "/posts/7", "/api/hello?name=visaljs"], framework: "next", start: ["node_modules/next/dist/bin/next", "start"] },
  { app: "vinext", routes: ["/", "/posts/3", "/api/hello?name=visaljs"], framework: "vinext", start: ["node_modules/vinext/dist/cli.js", "start"] },
];

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    duration: { type: "string", default: "10" },
    connections: { type: "string", default: "50" },
    only: { type: "string" },
    "startup-runs": { type: "string", default: "5" },
    "min-ratio": { type: "string" },
    gate: { type: "string" },
    json: { type: "string" },
  },
});
const DURATION = Number(options.duration);
const CONNECTIONS = Number(options.connections);

interface Target {
  name: string;
  /** The command and its arguments; built first by `build`, if any. */
  command: string;
  args: string[];
  /** The standalone binary, whose size is reported. */
  binary?: string;
  build?: () => Promise<void> | void;
}

const OUT = join(tmpdir(), `visaljs-bench-servers-${process.pid}`);
mkdirSync(OUT, { recursive: true });
/* found on the PATH (wrk -v exits 1: only a failure to start counts) */
const has = (cmd: string) => !spawnSync(cmd, ["--version"], { stdio: "ignore" }).error;
const version = (cmd: string) => execFileSync(cmd, ["--version"], { encoding: "utf8" }).trim().split("\n")[0];

function targets(entry: string, server: Server): Target[] {
  const binary = (name: string) => join(OUT, `${server.app}-${name}`);
  const visaljs: Target = { name: "visaljs", command: binary("visaljs"), args: [], binary: binary("visaljs"), build: () => buildVisaljs(entry, binary("visaljs")) };
  if (server.start) {
    const list: Target[] = [visaljs, { name: "node", command: process.execPath, args: server.start }];
    if (has("bun")) list.push({ name: "bun", command: "bun", args: ["--bun", ...server.start] });
    return list;
  }
  const list: Target[] = [
    visaljs,
    { name: "node (SEA)", command: binary("node"), args: [], binary: binary("node"), build: () => buildNodeSea(entry, binary("node")) },
  ];
  if (has("bun")) list.push({ name: "bun (compiled)", command: binary("bun"), args: [], binary: binary("bun"), build: () => buildBun(entry, binary("bun")) });
  return list;
}

/* Linux: the server on the first half of the cores, wrk on the rest */
const cores = availableParallelism();
const pin = process.platform === "linux" && has("taskset") && cores >= 4;
const serverCpus = `0-${cores / 2 - 1}`;
const clientCpus = `${cores / 2}-${cores - 1}`;
const pinned = (cpus: string, command: string, args: string[]): [string, string[]] => (pin ? ["taskset", ["-c", cpus, command, ...args]] : [command, args]);

function ok(port: number, path = "/"): Promise<boolean> {
  return new Promise((resolve) => {
    get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode === 200));
    }).on("error", () => resolve(false));
  });
}

/** Starts the target and resolves once it answers, with the milliseconds that took. */
async function launch(t: Target, cwd: string, port: number) {
  const [command, args] = pinned(serverCpus, t.command, t.args);
  const start = performance.now();
  const child = spawn(command, args, { cwd, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  let exited = false;
  child.on("exit", () => (exited = true));
  while (!(await ok(port))) {
    if (exited) throw new Error(`${t.name} exited before answering`);
    if (performance.now() - start > 20000) throw new Error(`${t.name} didn't answer in 20 s`);
    await new Promise((r) => setTimeout(r, 2));
  }
  return { child, startup: performance.now() - start };
}

function kill(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
  });
}

/** Resident memory in kilobytes, of the server itself (under taskset, the pid is the server's: taskset execs). */
function rss(pid: number): number {
  const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return Number(out) || 0;
}

/** wrk's latency, "1.23ms" / "456.00us" / "1.20s", in milliseconds. */
function ms(text: string): number {
  const m = /([\d.]+)(us|ms|s)/.exec(text);
  if (!m) return NaN;
  return Number(m[1]) * (m[2] === "us" ? 1e-3 : m[2] === "s" ? 1e3 : 1);
}

function wrk(port: number, path: string, seconds: number) {
  const [command, args] = pinned(clientCpus, "wrk", ["-t2", `-c${CONNECTIONS}`, `-d${seconds}s`, "--latency", `http://127.0.0.1:${port}${path}`]);
  return new Promise<{ rps: number; p50: number; p99: number; errors: number }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`wrk exited with ${code}:\n${out}`));
      const errors = /Socket errors: connect (\d+), read (\d+), write (\d+), timeout (\d+)/.exec(out);
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

interface Result {
  name: string;
  size?: number;
  startup: number;
  idle: number;
  peak: number;
  routes: { path: string; rps: number; p50: number; p99: number; errors: number }[];
}

async function measure(t: Target, server: Server, cwd: string, port: number): Promise<Result> {
  /* startup: the median of fresh launches */
  const startups: number[] = [];
  for (let i = 0; i < Number(options["startup-runs"]); i++) {
    const { child, startup } = await launch(t, cwd, port);
    startups.push(startup);
    await kill(child);
  }
  startups.sort((a, b) => a - b);

  const { child } = await launch(t, cwd, port);
  try {
    await new Promise((r) => setTimeout(r, 500));
    const idle = rss(child.pid!);
    let peak = idle;
    const sampler = setInterval(() => (peak = Math.max(peak, rss(child.pid!))), 100);
    const routes = [];
    try {
      for (const path of server.routes) {
        if (!(await ok(port, path))) throw new Error(`${t.name}: GET ${path} isn't 200`);
        await wrk(port, path, Math.min(3, DURATION));  /* warm up: the JITs get to compile */
        routes.push({ path, ...(await wrk(port, path, DURATION)) });
      }
    } finally {
      clearInterval(sampler);
    }
    return { name: t.name, size: t.binary ? statSync(t.binary).size : undefined, startup: startups[startups.length >> 1]!, idle, peak, routes };
  } finally {
    await kill(child);
  }
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const kb = (k: number) => `${(k / 1024).toFixed(1)} MB`;
const thousands = (n: number) => Math.round(n).toLocaleString("en-US");

function table(routes: string[], results: Result[]) {
  const lines = [
    "| | Binary | Startup | RSS idle | RSS peak |",
    "|---|---:|---:|---:|---:|",
    ...results.map((r) => `| ${r.name} | ${r.size ? mb(r.size) : "—"} | ${r.startup.toFixed(0)} ms | ${kb(r.idle)} | ${kb(r.peak)} |`),
    "",
    `| req/s (p50 / p99 ms) | ${routes.map((p) => `\`${p}\``).join(" | ")} |`,
    `|---|${routes.map(() => "---:").join("|")}|`,
    ...results.map((r) => `| ${r.name} | ${r.routes.map((x) => `${thousands(x.rps)} (${x.p50.toFixed(2)} / ${x.p99.toFixed(2)})${x.errors ? ` ⚠ ${x.errors} errors` : ""}`).join(" | ")} |`),
  ];
  return lines.join("\n");
}

if (!has("wrk")) {
  console.error("bench: wrk isn't on the PATH (apt install wrk / brew install wrk)");
  process.exit(1);
}
const unknown = positionals.filter((name) => !SERVERS.some((s) => s.app === name));
if (unknown.length) {
  console.error(`bench: no server app ${unknown.join(", ")} (one of ${SERVERS.map((s) => s.app).join(", ")})`);
  process.exit(1);
}
const only = options.only?.split(",");
const servers = SERVERS.filter((s) => !positionals.length || positionals.includes(s.app));

console.log(`node ${process.version}${has("bun") ? `, bun ${version("bun")}` : ""}, ${process.platform}/${process.arch}, ${cores} cores` +
  `${pin ? ` (server on ${serverCpus}, wrk on ${clientCpus})` : ""}; wrk -t2 -c${CONNECTIONS} for ${DURATION} s per route`);

/** What --json writes: the setup, and each app's results. */
interface Report {
  date: string;
  node: string;
  bun: string | null;
  machine: string;
  wrk: string;
  apps: { app: string; framework?: string; version?: string; routes: string[]; results: Result[] }[];
}
const report: Report = {
  date: new Date().toISOString().slice(0, 10),
  node: process.version,
  bun: has("bun") ? (version("bun") ?? null) : null,
  machine: `${process.platform}/${process.arch}, ${cores} cores${pin ? `: the server on ${cores / 2}, wrk on ${cores / 2}` : ""}`,
  wrk: `wrk -t2 -c${CONNECTIONS}, ${DURATION} s per route`,
  apps: [],
};

const failures: string[] = [];
const gated = options.gate?.split(",");
/** A target that failed to build or serve: a failure of the check when it's visaljs, a warning otherwise. */
function failed(app: string, t: Target, what: string, e: unknown) {
  const message = `${app}: ${t.name} failed to ${what}: ${(e as Error).message.split("\n")[0]}`;
  if (t.name === "visaljs") failures.push(message);
  else console.warn(`bench: ${message}`);
}
let port = 3100;
for (const server of servers) {
  const cwd = join(APPS, server.app);
  const entry = join(cwd, JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).main);
  ensureInstalled(server.app);
  let chosen = targets(entry, server).filter((t) => !only || only.some((o) => t.name === o || t.name.split(" ")[0] === o));
  const built: Target[] = [];
  for (const t of chosen) {
    if (t.build) {
      process.stderr.write(`${server.app}: building ${t.name}…\n`);
      try {
        await t.build();
      } catch (e) {
        failed(server.app, t, "build", e);
        continue;
      }
    }
    built.push(t);
  }
  chosen = built;
  const results: Result[] = [];
  for (const t of chosen) {
    process.stderr.write(`${server.app}: measuring ${t.name}…\n`);
    try {
      results.push(await measure(t, server, cwd, port++));
    } catch (e) {
      failed(server.app, t, "serve", e);
    }
  }
  if (!results.length) continue;

  const frameworkVersion = server.framework
    ? (JSON.parse(readFileSync(join(cwd, "node_modules", server.framework, "package.json"), "utf8")).version as string)
    : undefined;
  const framework = server.framework ? ` (${server.framework} ${frameworkVersion})` : "";
  console.log(`\n### ${server.app}${framework}\n`);
  report.apps.push({ app: server.app, framework: server.framework, version: frameworkVersion, routes: server.routes, results });
  console.log(table(server.routes, results));

  /* the regression check: visaljs against Node, route by route */
  const ours = results.find((r) => r.name === "visaljs");
  const node = results.find((r) => r.name.split(" ")[0] === "node");
  if (options["min-ratio"] !== undefined && ours && node) {
    const min = Number(options["min-ratio"]);
    console.log(`\n| visaljs / ${node.name} | ${server.routes.map((p) => `\`${p}\``).join(" | ")} |\n|---|${server.routes.map(() => "---:").join("|")}|`);
    const ratios = ours.routes.map((r, i) => r.rps / node.routes[i]!.rps);
    console.log(`| req/s | ${ratios.map((x) => `${x.toFixed(2)}×`).join(" | ")} |`);
    if (!gated || gated.includes(server.app)) {
      ours.routes.forEach((r, i) => {
        if (!(ratios[i]! >= min)) failures.push(`${server.app} ${r.path}: ${ratios[i]!.toFixed(2)}× node's req/s, below ${min}×`);
        if (r.errors) failures.push(`${server.app} ${r.path}: ${r.errors} errors`);
      });
    }
  }
}
if (options.json) {
  /* the apps not measured now keep their entries */
  const old = existsSync(options.json) ? (JSON.parse(readFileSync(options.json, "utf8")) as Report).apps : [];
  report.apps = [...old.filter((a) => !report.apps.some((b) => b.app === a.app)), ...report.apps].sort((a, b) => a.app.localeCompare(b.app));
  writeFileSync(options.json, JSON.stringify(report, null, 2) + "\n");
}
if (failures.length) {
  console.error(`bench: visaljs regressed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
