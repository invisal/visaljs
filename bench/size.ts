// Binary sizes of the apps (tests/apps): each built as a standalone binary by visaljs, Node (a single
// executable application) and Bun (`bun build --compile`), written to tests/apps/sizes.json (and
// printed) as a JSON array, one entry per app, sizes in bytes:
//
//   [{ "example": "express", "visaljs": 6512345, "node": 125712345, "bun": 95712345 }, …]
//
//   node bench/size.ts [name...]
//
// Names pick apps (default: all of tests/apps/); their entries replace those already in
// tests/apps/sizes.json, and the others stay. An app's entry is its package.json's
// "main". Apps without a node_modules are installed first. Bun's sizes need bun on the PATH
// (null without it). A build that fails has a null size, and the run exits 1
// when visaljs's did. Progress goes to stderr.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { APPS, ensureInstalled, apps } from "../tests/apps/install.ts";
import { buildBun, buildNodeSea, buildVisaljs } from "./lib/standalone.ts";

const { positionals } = parseArgs({ allowPositionals: true });
const names = positionals.length ? positionals : apps();

const hasBun = !spawnSync("bun", ["--version"], { stdio: "ignore" }).error;
const builders: { name: "visaljs" | "node" | "bun"; build: (entry: string, binary: string) => Promise<void> | void }[] = [
  { name: "visaljs", build: buildVisaljs },
  { name: "node", build: buildNodeSea },
  ...(hasBun ? [{ name: "bun" as const, build: buildBun }] : []),
];

const OUT = join(tmpdir(), `visaljs-size-${process.pid}`);
mkdirSync(OUT, { recursive: true });

interface Sizes {
  example: string;
  visaljs: number | null;
  node: number | null;
  bun: number | null;
}

const results: Sizes[] = [];
for (const example of names) {
  const entry = join(APPS, example, JSON.parse(readFileSync(join(APPS, example, "package.json"), "utf8")).main);
  ensureInstalled(example);
  const sizes: Sizes = { example, visaljs: null, node: null, bun: null };
  for (const b of builders) {
    process.stderr.write(`${example}: ${b.name}…\n`);
    const binary = join(OUT, `${example}-${b.name}`);
    try {
      await b.build(entry, binary);
      sizes[b.name] = statSync(binary).size;
    } catch (e) {
      process.stderr.write(`${example}: ${b.name} failed: ${(e as Error).message.split("\n")[0]}\n`);
    }
  }
  results.push(sizes);
}
rmSync(OUT, { recursive: true, force: true });

const FILE = join(APPS, "sizes.json");
const kept: Sizes[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : [];
const all = [...kept.filter((k) => !names.includes(k.example) && existsSync(join(APPS, k.example, "package.json"))), ...results];
all.sort((a, b) => a.example.localeCompare(b.example));
writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`);
process.stderr.write(`wrote ${FILE}\n`);
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => r.visaljs === null)) process.exit(1);
