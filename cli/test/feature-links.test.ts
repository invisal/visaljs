// The rules that link the Node modules' optional parts (implicitModules in node/index.ts): each one
// links its module for the uses programs and packages typically make, as the bundler leaves them
// (it may rename a binding: Readable$1.from), and a plain program links none.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { implicitModules } from "@visaljs/node";
import { describe, expect, it } from "vitest";

import { bundle } from "../src/bundle.ts";
import { DEFAULT_HOSTS } from "../src/hosts.ts";

const dir = mkdtempSync(join(tmpdir(), "visaljs-feature-links-"));
const FEATURES = new Set(implicitModules.map((m) => m.file.replace(/^.*[\\/]/, "").replace(/\.js$/, "")));

/** The implicit modules (by file name) a program's bundle links. */
async function linked(name: string, source: string): Promise<string[]> {
  const entry = join(dir, name);
  writeFileSync(entry, source);
  const b = await bundle(entry, DEFAULT_HOSTS, () => {});
  return [...b.code.matchAll(/^\/\/#region .*node\/prelude\/internal\/([\w]+)\.js$/gm)].map((m) => m[1]!).filter((m) => FEATURES.has(m));
}

/* each feature module, and code that uses it as programs and packages do */
const CASES: [string, string, string][] = [
  ["process_events", "a.cjs", 'process.on("exit", () => console.log("bye"));'],
  ["process_signals", "a.cjs", 'process.on("SIGINT", () => process.exit(1));'],
  ["process_stdio", "a.cjs", 'const fs = require("fs");\nfs.createReadStream(__filename).pipe(process.stdout);'],
  ["process_stdin", "a.cjs", 'process.stdin.on("data", (d) => console.log(d));'],
  ["tty_read_stream", "a.cjs", 'const tty = require("tty");\nnew tty.ReadStream(0);'],
  ["parse_args", "a.mjs", 'import { parseArgs } from "node:util";\nconsole.log(parseArgs({ options: { v: { type: "boolean" } } }));'],
  ["mime", "a.cjs", 'const util = require("util");\nconsole.log(new util.MIMEType("text/plain"));'],
  ["dotenv", "a.cjs", 'console.log(require("util").parseEnv("A=1"));'],
  ["system_errors", "a.cjs", 'console.log(require("util").getSystemErrorName(-2));'],
  ["util_styles", "a.mjs", 'import { styleText } from "node:util";\nconsole.log(styleText("red", "x"));'],
  ["util_diff", "a.cjs", 'const util = require("util");\nconsole.log(util.diff("a", "b"));'],
  ["util_debuglog", "a.cjs", 'const debug = require("util").debuglog("app");\ndebug("x");'],
  ["util_more", "a.cjs", 'const { callbackify } = require("util");\ncallbackify(async () => 1)(() => {});'],
  ["buffer_transcode", "a.cjs", 'const { transcode } = require("buffer");\ntranscode(Buffer.from("a"), "utf8", "latin1");'],
  ["events_on", "a.mjs", 'import { on, EventEmitter } from "node:events";\nconst e = new EventEmitter();\nfor await (const x of on(e, "x")) console.log(x);'],
  ["stream_compose", "a.cjs", 'const { compose, PassThrough } = require("stream");\ncompose(new PassThrough(), new PassThrough());'],
  ["stream_compose", "b.cjs", 'const { Duplex } = require("stream");\nDuplex.from(async function* (s) { yield* s; });'],
  ["stream_operators", "a.cjs", 'const { Readable } = require("stream");\nReadable.from([1, 2]).map((x) => x * 2).toArray().then(console.log);'],
  ["stream_from", "a.cjs", 'const { Readable } = require("stream");\nReadable.from(["a"]).on("data", console.log);'],
  ["stream_from", "b.mjs", 'import { Readable } from "node:stream";\nimport { Readable as R2 } from "stream";\nReadable.from(["a"]).pipe(process.stdout);\nvoid R2;'],
  ["stream_from", "c.cjs", 'const stream = require("stream");\nstream.Readable.from(["a"]).resume();'],
  ["stream_pipeline", "a.cjs", 'const { pipeline, Readable, Writable } = require("stream");\npipeline(new Readable({ read() {} }), new Writable({ write(c, e, cb) { cb(); } }), () => {});'],
  ["stream_pipeline", "b.mjs", 'import { pipeline } from "node:stream/promises";\nimport fs from "node:fs";\nawait pipeline(fs.createReadStream("a"), fs.createWriteStream("b"));'],
  ["stream_transform", "a.cjs", 'const { Transform } = require("stream");\nclass Up extends Transform { _transform(c, e, cb) { cb(null, c); } }\nnew Up();'],
  ["stream_transform", "b.cjs", 'const stream = require("stream");\nconst util = require("util");\nfunction T() { stream.Transform.call(this); }\nutil.inherits(T, stream.Transform);'],
  ["stream_web_adapters", "a.cjs", 'const { Readable } = require("stream");\nReadable.toWeb(new Readable({ read() {} }));'],
  ["events_extras", "a.cjs", 'const { setMaxListeners } = require("events");\nsetMaxListeners(20);'],
  ["source_map", "a.cjs", 'const { SourceMap } = require("module");\nconsole.log(SourceMap);'],
  ["net_onread", "a.cjs", 'const net = require("net");\nnet.connect({ port: 80, onread: { buffer: Buffer.alloc(16), callback: (n) => console.log(n) } });'],
  ["net_tos", "a.cjs", 'const s = require("net").connect(80, () => s.setTypeOfService(0x10));'],
  ["net_bound", "a.cjs", 'const { BoundSocket } = require("net");\nconsole.log(new BoundSocket({ port: 0 }).address());'],
  ["perf_observe", "a.cjs", 'const { PerformanceObserver } = require("perf_hooks");\nnew PerformanceObserver(() => {}).observe({ entryTypes: ["mark"] });'],
  ["perf_histogram", "a.cjs", 'const { monitorEventLoopDelay } = require("perf_hooks");\nmonitorEventLoopDelay().enable();'],
  ["fs_streams", "a.cjs", 'require("fs").createReadStream("a").on("error", console.log);'],
  ["fs_bigint_stats", "a.cjs", 'console.log(require("fs").statSync(".", { bigint: true }).size);'],
  ["fs_statfs", "a.cjs", 'require("fs").statfs("/", console.log);'],
  ["fs_dir", "a.cjs", 'const fs = require("fs");\nfs.opendirSync(".").closeSync();'],
  ["fs_cp", "a.mjs", 'import { cp } from "node:fs/promises";\nawait cp("a", "b", { recursive: true });'],
  ["fs_glob", "a.mjs", 'import { glob } from "node:fs/promises";\nfor await (const f of glob("*.js")) console.log(f);'],
  ["fs_glob", "a.cjs", 'require("fs").watch(".", { ignore: "*.log" }).close();'],  /* a watch's ignore patterns */
  ["fs_watch", "a.cjs", 'const fs = require("fs");\nfs.watch(".", () => {});'],
  ["fs_blob", "a.mjs", 'import { openAsBlob } from "node:fs";\nconsole.log(await openAsBlob("a"));'],
  ["fs_filehandle", "a.mjs", 'import fs from "node:fs/promises";\nconst h = await fs.open("a");\nawait h.close();'],
  ["fs_filehandle", "a.mjs", 'import { open, writeFile } from "node:fs/promises";\nawait writeFile("a", "");\nawait (await open("a")).close();'],
  ["process_more", "a.cjs", 'console.log(process.uptime());'],
  ["process_memory", "a.cjs", 'console.log(process.memoryUsage().rss);'],
  ["timers_global", "a.cjs", 'setTimeout(() => {}, 1000).unref();'],
  ["timers_global", "b.cjs", 'const timer = setTimeout(() => {}, 10);\ntimer[Symbol.dispose]();'],
  ["performance_global", "a.cjs", 'console.log(performance.now());'],
  ["form_data", "a.cjs", 'const body = new FormData();\nbody.append("a", "1");\nfetch("http://x", { method: "POST", body });'],
  ["form_data", "b.mjs", 'const fd = await new Response("a=1", { headers: { "content-type": "application/x-www-form-urlencoded" } }).formData();\nconsole.log(fd);'],
  ["structured_clone", "a.cjs", 'console.log(structuredClone({ a: new Map() }));'],
  ["compression_streams", "a.cjs", 'const r = new Response("x").body.pipeThrough(new CompressionStream("gzip"));\nconsole.log(r);'],
  ["fetch", "a.mjs", 'const res = await fetch("https://example.com");\nconsole.log(await res.text());'],
  ["zlib_brotli", "a.cjs", 'const zlib = require("zlib");\nzlib.brotliCompressSync("x");'],
  ["zlib_zstd", "a.mjs", 'import { zstdCompressSync } from "node:zlib";\nzstdCompressSync("x");'],
  ["crypto_x509", "a.cjs", 'const { X509Certificate } = require("crypto");\nconsole.log(new X509Certificate(process.argv[2]).subject);'],
  ["crypto_x509", "b.mjs", 'import tls from "node:tls";\ntls.connect(443, "example.com", function () { console.log(this.getPeerX509Certificate()); });'],
];

describe("the rules that link the Node modules' optional parts", () => {
  it("have a case each", () => {
    expect([...FEATURES].filter((f) => !CASES.some(([module]) => module === f))).toEqual([]);
  });

  it("link none for a plain program", async () => {
    expect(await linked("plain.mjs", 'const items = [3, 1, 2].map((x) => x * 2).filter((x) => x > 2);\nconsole.log(JSON.stringify(items));')).toEqual([]);
  });

  for (const [module, name, source] of CASES) {
    it(`link ${module} (${name})`, async () => {
      expect(await linked(`${module}-${name}`, source)).toContain(module);
    }, 30_000);
  }
});
