// The apps, each compiled by visaljs and run against Node: a server answers the same requests with
// the same bytes, a command-line program prints the same output (and writes the same files) with
// the same exit status. Two tiers:
//
//   fast  http-hello, express, hono and zod: quick to build, and between them node:http, CommonJS
//         and ES modules, two routers, body parsing, streaming and a regex-heavy library. CI runs
//         them on Linux, macOS and Windows for every pull request that can change a binary.
//   full  every app. Nightly, and for pull requests that change tests/apps.
//
//   node tests/apps/check.ts [--tier=fast|full] [--require-databases] [name...]
//
// Names pick apps (default: the tier's; the tier defaults to fast). Apps without a node_modules
// are installed first. express-postgres and mysql need their database: the one from their
// compose.yaml (`npm run db` in the app), or VISALJS_POSTGRES_URL / VISALJS_MYSQL_URL. Without one
// they're skipped, or fail with --require-databases (CI). Exits 1 when an app fails; a Markdown
// table of the results goes to $GITHUB_STEP_SUMMARY when it's set.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

import { exchange, type Server, start, stop } from "../differential/http.ts";
import { APPS, apps, ensureInstalled } from "./install.ts";

const CLI = join(APPS, "..", "..", "cli", "src", "cli.ts");
const EXE = process.platform === "win32" ? ".exe" : "";

const get = (path: string) => `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
const head = (path: string) => `HEAD ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`;
const send = (method: string, path: string, body: string) =>
  `${method} ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

/** A server: each list of requests goes over one connection. */
interface HttpCheck {
  kind: "http";
  requests: string[][];
  /** The command Node runs the app with (default: its entry). */
  node?: string[];
  /** Applied to both sides' responses: what differs from run to run. */
  normalize?: (response: string) => string;
}

/** A command-line program: each run's exit status, stdout and stderr (and the files it writes
 *  under `outDir`, emptied first) are Node's. */
interface CliCheck {
  kind: "cli";
  runs: string[][];
  outDir?: string;
}

interface App {
  tier: "fast" | "full";
  check: HttpCheck | CliCheck;
  /** What the app keeps its data in: emptied before each side runs, so both start alike. */
  database?: "postgres" | "mysql";
}

/* a timestamp, and the ETag computed from a body that has one */
const timestamps = (r: string) =>
  r.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>").replace(/\r\nETag: [^\r]*/i, "\r\nETag: <etag>");

const APP_CHECKS: Record<string, App> = {
  "http-hello": {
    tier: "fast",
    check: { kind: "http", requests: [[get("/"), get("/anything?x=1"), head("/")]] },
  },
  express: {
    tier: "fast",
    check: {
      kind: "http",
      requests: [
        [get("/"), get("/json"), get("/users/42?q=x&tag=a&tag=b")],
        [send("POST", "/echo", '{"a":[1,2,{"b":"ü"}]}'), get("/api/items/7"), get("/error"), get("/missing")],
      ],
    },
  },
  hono: {
    tier: "fast",
    check: {
      kind: "http",
      requests: [
        [get("/"), get("/json"), get("/users/42?q=x")],
        [send("POST", "/echo", '{"a":[1,2,{"b":"ü"}]}'), get("/stream"), get("/sse"), get("/missing")],
      ],
    },
  },
  zod: {
    tier: "fast",
    check: { kind: "cli", runs: [["orders.json"], ["invalid.json"]] },
  },
  markdown: {
    tier: "full",
    check: { kind: "cli", runs: [["sample.md"]] },
  },
  typescript: {
    tier: "full",
    check: { kind: "cli", runs: [["-p", "sample"]], outDir: "sample/dist" },
  },
  "react-ssr": {
    tier: "full",
    check: { kind: "http", requests: [[get("/"), get("/?n=7"), get("/?n=0"), get("/missing")]] },
  },
  vinext: {
    tier: "full",
    check: {
      kind: "http",
      node: ["node_modules/vinext/dist/cli.js", "start"],
      requests: [[get("/"), get("/posts/3"), get("/api/hello?name=visaljs"), send("POST", "/api/hello", '{"a":1}'), get("/missing")]],
    },
  },
  "express-postgres": {
    tier: "full",
    database: "postgres",
    check: {
      kind: "http",
      normalize: timestamps,
      requests: [[
        send("POST", "/projects", '{"name":"Website","tasks":["Design","Build"]}'),
        send("POST", "/projects/1/tasks", '{"title":"Ship","due":"2026-12-24"}'),
        send("PATCH", "/tasks/1", '{"done":true}'),
        get("/tasks?done=false"),
        get("/projects"),
        get("/projects/1"),
        send("POST", "/projects", '{"name":""}'),
        get("/projects/999"),
        send("DELETE", "/projects/1", ""),
        get("/tasks"),
      ]],
    },
  },
  mysql: {
    tier: "full",
    database: "mysql",
    check: {
      kind: "cli",
      runs: [
        ["add", "Buy milk", "--due", "2026-12-24"],
        ["add", "Walk the dog"],
        ["list"],
        ["done", "1"],
        ["list", "--all"],
        ["clear"],
        ["rm", "9"],
        ["done", "x"],
        ["list"],
      ],
    },
  },
};

const DATABASES = {
  postgres: process.env.VISALJS_POSTGRES_URL || "postgres://app:app@localhost:5432/app",
  mysql: process.env.VISALJS_MYSQL_URL || "mysql://app:app@localhost:3306/app",
};

/** Drops the app's tables, with the app's own client library: why it can't, else undefined. */
async function resetDatabase(name: string, kind: "postgres" | "mysql"): Promise<string | undefined> {
  const require = createRequire(join(APPS, name, "package.json"));
  try {
    if (kind === "postgres") {
      const { Client } = require("pg");
      const client = new Client({ connectionString: DATABASES.postgres, connectionTimeoutMillis: 5000 });
      await client.connect();
      await client.query("DROP TABLE IF EXISTS tasks, projects");
      await client.end();
    } else {
      const mysql = require("mysql2/promise");
      const conn = await mysql.createConnection({ uri: DATABASES.mysql, connectTimeout: 5000 });
      await conn.query("DROP TABLE IF EXISTS todos");
      await conn.end();
    }
    return undefined;
  } catch (e) {
    const { code, message } = e as { code?: string; message?: string };
    return message || code || String(e);
  }
}

let nextPort = 41000 + (process.pid % 1000) * 2;

/** `exchange`, retrying while the server isn't accepting yet (it may print before it listens). */
async function exchangeRetrying(port: number, requests: string[]): Promise<string[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await exchange(port, requests);
    } catch (e) {
      if ((e as { code?: string }).code !== "ECONNREFUSED" || attempt === 20) throw e;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/** Every response of one side, one server run: a list per connection. */
async function serve(command: string, args: string[], cwd: string, check: HttpCheck, env: Record<string, string>): Promise<string[][]> {
  let server: Server | undefined;
  try {
    server = await start(command, args, nextPort++, cwd, env);
    const out: string[][] = [];
    for (const requests of check.requests) {
      const responses = await exchangeRetrying(server.port, requests);
      out.push(check.normalize ? responses.map(check.normalize) : responses);
    }
    return out;
  } finally {
    if (server) await stop(server);
  }
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  files?: Record<string, string>;
}

/** Every file under `dir`, by its path relative to it. */
function readTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = join(dir, entry);
    if (statSync(path).isFile()) files[relative(dir, path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
  }
  return files;
}

/** One side's runs of a command-line program, in order. */
function runCli(command: string, prefix: string[], cwd: string, check: CliCheck, env: Record<string, string>): Run[] {
  const outDir = check.outDir && join(cwd, check.outDir);
  return check.runs.map((args) => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
    const r = spawnSync(command, [...prefix, ...args], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 120000 });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, ...(outDir && { files: readTree(outDir) }) };
  });
}

/** The first place `actual` differs from `expected`, as a few lines to print. */
function firstDifference(label: string, expected: unknown, actual: unknown): string | undefined {
  const e = JSON.stringify(expected, null, 1);
  const a = JSON.stringify(actual, null, 1);
  if (e === a) return undefined;
  let i = 0;
  while (e[i] === a[i]) i++;
  const from = Math.max(0, i - 120);
  return `${label} differs at character ${i}:\n  Node:    …${e.slice(from, i + 200)}\n  visaljs: …${a.slice(from, i + 200)}`;
}

interface Result {
  name: string;
  outcome: "pass" | "fail" | "skip";
  build?: number;
  detail?: string;
}

async function checkApp(name: string, app: App, out: string, requireDatabases: boolean): Promise<Result> {
  const dir = join(APPS, name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const entry = join(dir, pkg.main);
  const env: Record<string, string> = app.database ? { DATABASE_URL: DATABASES[app.database] } : {};

  const unreachable = app.database && (await resetDatabase(name, app.database));
  if (unreachable) {
    const detail = `${app.database} at ${DATABASES[app.database!]}: ${unreachable} (npm run db in tests/apps/${name})`;
    return { name, outcome: requireDatabases ? "fail" : "skip", detail };
  }

  const binary = join(out, name + EXE);
  const started = Date.now();
  const built = spawnSync(process.execPath, [CLI, "build", entry, "-o", binary, "--quiet"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const build = (Date.now() - started) / 1000;
  if (built.status !== 0 || !existsSync(binary)) {
    return { name, outcome: "fail", build, detail: `build failed (${built.error?.message ?? `exit ${built.status}`}):\n${(built.stdout + built.stderr).trim().slice(-4000)}` };
  }

  const check = app.check;
  let detail: string | undefined;
  try {
    if (check.kind === "http") {
      const nodeArgs = check.node ?? [entry];
      const expected = await serve(process.execPath, nodeArgs, dir, check, env);
      if (app.database) await resetDatabase(name, app.database);
      const actual = await serve(binary, [], dir, check, env);
      detail = firstDifference("the responses", expected, actual);
    } else {
      const expected = runCli(process.execPath, [entry], dir, check, env);
      if (app.database) await resetDatabase(name, app.database);
      const actual = runCli(binary, [], dir, check, env);
      detail = firstDifference("the output", expected, actual);
    }
  } catch (e) {
    detail = (e as Error).message;
  } finally {
    if (check.kind === "cli" && check.outDir) rmSync(join(dir, check.outDir), { recursive: true, force: true });
  }
  return { name, outcome: detail ? "fail" : "pass", build, detail };
}

const { values, positionals } = parseArgs({
  options: { tier: { type: "string", default: "fast" }, "require-databases": { type: "boolean", default: false } },
  allowPositionals: true,
});
if (values.tier !== "fast" && values.tier !== "full") throw new Error(`--tier=${values.tier}: expected fast or full`);

const unchecked = apps().filter((name) => !(name in APP_CHECKS));
if (unchecked.length) throw new Error(`no check for ${unchecked.join(", ")}: add one to APP_CHECKS in tests/apps/check.ts`);
for (const name of positionals) if (!(name in APP_CHECKS)) throw new Error(`no app ${name} (tests/apps)`);

const names = positionals.length ? positionals : Object.keys(APP_CHECKS).filter((n) => values.tier === "full" || APP_CHECKS[n]!.tier === "fast");
const out = mkdtempSync(join(tmpdir(), "visaljs-apps-"));
const results: Result[] = [];
for (const name of names) {
  process.stderr.write(`${name}: building…\n`);
  ensureInstalled(name);
  const result = await checkApp(name, APP_CHECKS[name]!, out, values["require-databases"]);
  results.push(result);
  const time = result.build === undefined ? "" : ` (built in ${result.build.toFixed(1)} s)`;
  process.stderr.write(`${name}: ${result.outcome}${time}${result.detail ? `\n${result.detail}` : ""}\n`);
}
rmSync(out, { recursive: true, force: true });

const icon = { pass: "✅", fail: "❌", skip: "⏭️" };
const table = [
  `### Apps (${values.tier}, ${process.platform}-${process.arch})`,
  "",
  "| App | Result | Build |",
  "|---|---|---:|",
  ...results.map((r) => `| ${r.name} | ${icon[r.outcome]} ${r.outcome}${r.outcome === "skip" ? `: ${r.detail}` : ""} | ${r.build === undefined ? "" : `${r.build.toFixed(1)} s`} |`),
  "",
].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
if (results.some((r) => r.outcome === "fail")) process.exit(1);
