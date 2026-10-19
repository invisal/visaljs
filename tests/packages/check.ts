// Popular npm packages, each compiled by visaljs with a small test of its own (test.js) that talks
// to a real server: the test's exit status, stdout and stderr compiled must be Node's. Records
// whether the package compiles, how long that takes, the binary's size and the test's result.
//
//   node tests/packages/check.ts [--json=file] [--require-services] [--list] [name...]
//
// Names pick packages (default: all). Packages without a node_modules are installed first. Each
// needs its server from compose.yaml (`docker compose up -d --wait` here), or VISALJS_POSTGRES_URL,
// VISALJS_MYSQL_URL, VISALJS_REDIS_URL. Without one its test is skipped, or fails with
// --require-services (CI). --json writes the report (the website's packages.json); entries for
// packages not run this time are kept from the file, so runs split by package fill one report.
// --list prints the packages and their servers as JSON (nightly's matrix). Exits 1 when a package
// fails; a Markdown table of the results goes to $GITHUB_STEP_SUMMARY when it's set.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const PACKAGES_DIR = import.meta.dirname;
const CLI = join(PACKAGES_DIR, "..", "..", "cli", "src", "cli.ts");
const EXE = process.platform === "win32" ? ".exe" : "";
const RUN_TIMEOUT_MS = 120_000;

type Service = "postgres" | "mysql" | "redis";

const PACKAGES: Record<string, Service> = {
  pg: "postgres",
  postgres: "postgres",
  mysql2: "mysql",
  redis: "redis",
  ioredis: "redis",
};

const SERVICES: Record<Service, { url: string; env: string }> = {
  postgres: { url: process.env.VISALJS_POSTGRES_URL || "postgres://app:app@localhost:55432/app", env: "DATABASE_URL" },
  mysql: { url: process.env.VISALJS_MYSQL_URL || "mysql://app:app@localhost:53306/app", env: "DATABASE_URL" },
  redis: { url: process.env.VISALJS_REDIS_URL || "redis://localhost:56379", env: "REDIS_URL" },
};

/** Whether something accepts connections at the URL's host and port. */
function reachable(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port), timeout: 3000 });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string, env: Record<string, string>): Run {
  const r = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: RUN_TIMEOUT_MS });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The first place `actual` differs from `expected`, as a few lines to print. */
function firstDifference(expected: Run, actual: Run): string | undefined {
  const e = JSON.stringify(expected, null, 1);
  const a = JSON.stringify(actual, null, 1);
  if (e === a) return undefined;
  let i = 0;
  while (e[i] === a[i]) i++;
  const from = Math.max(0, i - 120);
  return `the output differs at character ${i}:\n  Node:    …${e.slice(from, i + 200)}\n  visaljs: …${a.slice(from, i + 200)}`;
}

/** One package's entry in the report. */
interface Result {
  name: string;
  version: string;
  service: Service;
  build: "pass" | "fail";
  /** Seconds. */
  buildTime: number;
  /** Bytes; null when the build failed. */
  size: number | null;
  test: "pass" | "fail" | "skip";
  detail?: string;
}

interface Report {
  date: string;
  node: string;
  platform: string;
  commit: string | null;
  packages: Result[];
}

async function checkPackage(name: string, out: string, requireServices: boolean): Promise<Result> {
  const dir = join(PACKAGES_DIR, name);
  if (!existsSync(join(dir, "node_modules"))) {
    execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: ["ignore", 2, 2], shell: process.platform === "win32" });
  }
  const service = PACKAGES[name]!;
  const version: string = JSON.parse(readFileSync(join(dir, "node_modules", name, "package.json"), "utf8")).version;
  const entry = join(dir, JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).main);

  const binary = join(out, name + EXE);
  const started = Date.now();
  const built = spawnSync(process.execPath, [CLI, "build", entry, "-o", binary, "--quiet"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const buildTime = (Date.now() - started) / 1000;
  const result: Result = { name, version, service, build: "pass", buildTime, size: null, test: "skip" };
  if (built.status !== 0 || !existsSync(binary)) {
    const detail = `build failed (${built.error?.message ?? `exit ${built.status}`}):\n${(built.stdout + built.stderr).trim().slice(-4000)}`;
    return { ...result, build: "fail", detail };
  }
  result.size = statSync(binary).size;

  const { url, env: variable } = SERVICES[service];
  if (!(await reachable(url))) {
    const detail = `${service} at ${url} isn't reachable (docker compose up -d --wait ${service} in tests/packages)`;
    return { ...result, test: requireServices ? "fail" : "skip", detail };
  }
  const env = { [variable]: url };
  try {
    const expected = run(process.execPath, [entry], dir, env);
    if (expected.status !== 0) return { ...result, test: "fail", detail: `under Node, exit ${expected.status}:\n${expected.stderr.slice(-4000)}` };
    const actual = run(binary, [], dir, env);
    const detail = firstDifference(expected, actual);
    return { ...result, test: detail ? "fail" : "pass", ...(detail && { detail }) };
  } catch (e) {
    return { ...result, test: "fail", detail: (e as Error).message };
  }
}

const { values, positionals } = parseArgs({
  options: { json: { type: "string" }, "require-services": { type: "boolean", default: false }, list: { type: "boolean", default: false } },
  allowPositionals: true,
});

const dirs = readdirSync(PACKAGES_DIR).filter((d) => existsSync(join(PACKAGES_DIR, d, "package.json")));
const unchecked = dirs.filter((d) => !(d in PACKAGES));
if (unchecked.length) throw new Error(`no server for ${unchecked.join(", ")}: add it to PACKAGES in tests/packages/check.ts`);
for (const name of positionals) if (!(name in PACKAGES)) throw new Error(`no package ${name} (tests/packages)`);

if (values.list) {
  console.log(JSON.stringify(Object.entries(PACKAGES).map(([name, service]) => ({ name, service }))));
  process.exit(0);
}

const names = positionals.length ? positionals : Object.keys(PACKAGES);
const out = mkdtempSync(join(tmpdir(), "visaljs-packages-"));
const results: Result[] = [];
for (const name of names) {
  process.stderr.write(`${name}: building…\n`);
  const result = await checkPackage(name, out, values["require-services"]);
  results.push(result);
  process.stderr.write(`${name}: build ${result.build} (${result.buildTime.toFixed(1)} s), test ${result.test}${result.detail ? `\n${result.detail}` : ""}\n`);
}
rmSync(out, { recursive: true, force: true });

if (values.json) {
  const kept = existsSync(values.json) ? (JSON.parse(readFileSync(values.json, "utf8")) as Report).packages : [];
  const report: Report = {
    date: new Date().toISOString().slice(0, 10),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    commit: process.env.GITHUB_SHA ?? null,
    packages: [...kept.filter((k) => !names.includes(k.name)), ...results].sort((a, b) => a.name.localeCompare(b.name)),
  };
  writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
}

const icon = { pass: "✅", fail: "❌", skip: "⏭️" };
const mb = (bytes: number | null) => (bytes === null ? "" : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const table = [
  `### Packages (${process.platform}-${process.arch})`,
  "",
  "| Package | Version | Build | Build time | Size | Test |",
  "|---|---|---|---:|---:|---|",
  ...results.map((r) => `| ${r.name} | ${r.version} | ${icon[r.build]} | ${r.buildTime.toFixed(1)} s | ${mb(r.size)} | ${icon[r.test]} ${r.test} |`),
  "",
].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
if (results.some((r) => r.build === "fail" || r.test === "fail")) process.exit(1);
