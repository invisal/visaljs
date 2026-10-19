// Copies Node's own tests into tests/nodejs/test/parallel, unchanged, with the fixtures they use:
// from the Node whose export lists node/compat.json has, so the tests and the coverage report
// describe the same Node.
//
//   node tests/nodejs/sync.ts test-path test-events-   copy the tests these file names start with
//   node tests/nodejs/sync.ts --refresh                copy again every test already here
//
// Node's repository is cloned once (shallow, only test/) into build/nodejs/node-<version>. A
// copied test keeps its name; tests/nodejs/test/common is ours (Node's needs its internals), so
// it is never copied. NODE_VERSION records which Node the copies are from.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dirname, "..", "..");
const HERE = import.meta.dirname;
const TESTS = join(HERE, "test");
const VERSION_FILE = join(HERE, "NODE_VERSION");

const { values, positionals } = parseArgs({ allowPositionals: true, options: { refresh: { type: "boolean" } } });

/** The Node compat.json describes: the tests come from the same one. */
function nodeVersion(): string {
  return (JSON.parse(readFileSync(join(ROOT, "node", "compat.json"), "utf8")) as { node: string }).node;
}

/** A sparse, shallow clone of Node at `version`, with test/ only (about 90 MB). */
function checkout(version: string): string {
  const dir = join(ROOT, "build", "nodejs", `node-${version}`);
  if (existsSync(join(dir, "test", "parallel"))) return dir;
  mkdirSync(dirname(dir), { recursive: true });
  console.log(`cloning nodejs/node ${version} (test/ only) into ${dir}`);
  execFileSync("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth=1", "--filter=blob:none", "--sparse", `--branch=${version}`,
    "https://github.com/nodejs/node.git", dir], { stdio: "inherit" });
  execFileSync("git", ["-C", dir, "sparse-checkout", "set", "--no-cone", "/test/common/", "/test/parallel/", "/test/fixtures/"], { stdio: "inherit" });
  return dir;
}

/** The fixtures a test names: fixtures.path('a', 'b.js'), fixtures.readSync('x'),
 *  fixtures.fileURL(...), require('../fixtures/x'). Only literal names: a test that builds one
 *  at run time needs it copied by hand. */
const ENCODINGS = new Set(["utf8", "utf-8", "ascii", "latin1", "binary", "base64", "base64url", "hex", "ucs2", "utf16le"]);

function fixturesOf(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/fixtures\.(?:path|readSync|fileURL|readKey)\(\s*((?:['"][^'"]+['"]\s*,?\s*)+)/g)) {
    let parts = [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((p) => p[1]!);
    if (/fixtures\.readKey/.test(m[0])) parts = ["keys", parts[0]!];  /* readKey(name, encoding) */
    else if (/fixtures\.readSync/.test(m[0]) && parts.length > 1 && ENCODINGS.has(parts.at(-1)!)) parts.pop();  /* readSync(name, encoding) */
    out.add(join(...parts));
  }
  for (const m of source.matchAll(/require\(\s*['"]\.\.\/fixtures\/([^'"]+)['"]\s*\)/g)) out.add(m[1]!);
  return [...out];
}

const version = nodeVersion();
const src = checkout(version);
const parallel = join(src, "test", "parallel");

const prefixes = values.refresh && existsSync(join(TESTS, "parallel")) ? readdirSync(join(TESTS, "parallel")) : positionals;
if (prefixes.length === 0) {
  console.error("usage: node tests/nodejs/sync.ts <test-file-prefix>... | --refresh");
  process.exit(2);
}
const files = readdirSync(parallel).filter((f) => /\.m?js$/.test(f) && prefixes.some((p) => f.startsWith(p))).sort();

mkdirSync(join(TESTS, "parallel"), { recursive: true });
let fixtures = 0;
const missing: string[] = [];
for (const file of files) {
  cpSync(join(parallel, file), join(TESTS, "parallel", file));
  for (const fixture of fixturesOf(readFileSync(join(parallel, file), "utf8"))) {
    let from = join(src, "test", "fixtures", fixture);
    if (!existsSync(from) && existsSync(from + ".js")) from += ".js";  /* require('../fixtures/crypto/kmac') */
    if (!existsSync(from)) {
      missing.push(`${file}: ${fixture}`);
      continue;
    }
    cpSync(from, join(TESTS, "fixtures", from.endsWith(".js") && !fixture.endsWith(".js") ? fixture + ".js" : fixture), { recursive: statSync(from).isDirectory() });
    fixtures++;
  }
}
writeFileSync(VERSION_FILE, version + "\n");
console.log(`${files.length} tests from Node ${version}, ${fixtures} fixtures`);
for (const m of missing) console.log(`  no such fixture: ${m}`);
