// Node API coverage, one level deep: for each Node built-in module, which of its exports visaljs
// implements, which it stubs (a function whose body throws ERR_VISALJS_UNSUPPORTED), and which
// are missing. Writes node/compat.json; node/compat.notes.json adds what a list of names can't say
// ("server only"). Don't edit compat.json by hand.
//
//   node tests/compat/node.ts             regenerate, with Node's export lists from compat.json
//   node tests/compat/node.ts --refresh   re-read Node's export lists from the running Node
//   node tests/compat/node.ts --check     exit 1 when compat.json is out of date
//
// An export is what `require("node:x")` gives: the module's named exports and the own enumerable
// keys of its default export (what the bundler merges, cli/src/bundle.ts), less those that are
// undefined. Names starting with `_` are Node internals and don't count. visaljs's side comes
// from a compiled program that imports every provided module (some re-export the runtime's own
// globals: process, Buffer, URL), built with --embed-source so a stub's body can be read.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { modules } from "@visaljs/node";
import { main } from "visaljs";

const NODE_DIR = join(import.meta.dirname, "..", "..", "node");
const OUT = join(NODE_DIR, "compat.json");
const NOTES = join(NODE_DIR, "compat.notes.json");

type Status = "complete" | "partial" | "stub" | "missing";

interface ModuleCoverage {
  status: Status;
  implemented: string[];
  stubbed: string[];
  missing: string[];
  /** Exports Node doesn't have. */
  extra?: string[];
  notes?: string;
}

interface Compat {
  generatedBy: string;
  /** The Node whose export lists these are. */
  node: string;
  summary: {
    modules: Record<Status, number> & { total: number };
    exports: { implemented: number; stubbed: number; missing: number; total: number };
  };
  modules: Record<string, ModuleCoverage>;
}

/** A module's exports as require() sees them, and which are stubs. Runs in Node and, as source
 *  text, in the probe program. */
function exportsOf(ns: Record<string, unknown>): { names: string[]; stubs: string[] } {
  const all = new Map<string, unknown>();
  for (const k of Object.keys(ns)) if (k !== "default") all.set(k, ns[k]);
  const d = ns.default;
  if (d !== null && (typeof d === "object" || typeof d === "function")) {
    for (const k of Object.keys(d)) if (!all.has(k)) all.set(k, (d as Record<string, unknown>)[k]);
  }
  const names: string[] = [];
  const stubs: string[] = [];
  for (const [k, v] of all) {
    if (k.startsWith("_") || v === undefined) continue;
    names.push(k);
    /* a function or class whose body (or constructor) starts by throwing notSupported() (the
     * bundler may have renamed it notSupported$1: two modules define one) */
    if (typeof v === "function" && /^[^{]*\{\s*(?:constructor\s*\([^)]*\)\s*\{\s*)?throw notSupported(?:\$\d+)?\(/.test(Function.prototype.toString.call(v))) stubs.push(k);
  }
  return { names: names.sort(), stubs };
}

/** Node's export lists, from the running Node. */
async function nodeExports(): Promise<Record<string, string[]>> {
  process.removeAllListeners("warning");  /* importing punycode, wasi… warns */
  const out: Record<string, string[]> = {};
  /* and the ones only named with the node: scheme: Node 22's builtinModules leaves them out, Node
     24's lists them with it */
  const names = [...new Set([...builtinModules.map((m) => m.replace(/^node:/, "")).filter((m) => !m.startsWith("_")), "sea", "sqlite", "test", "test/reporters"])];
  for (const name of names.sort()) out[name] = exportsOf(await import(`node:${name}`)).names;
  return out;
}

/** Node's export lists, as a compat.json records them. */
function recordedNodeExports(compat: Compat): Record<string, string[]> {
  return Object.fromEntries(Object.entries(compat.modules).map(([name, m]) => [name, [...m.implemented, ...m.stubbed, ...m.missing].sort()]));
}

/** visaljs's exports: a program importing every provided module, compiled and run. */
async function visaljsExports(): Promise<Record<string, ReturnType<typeof exportsOf>>> {
  const names = Object.keys(modules).filter((name) => !name.startsWith("_")).sort();
  const dir = mkdtempSync(join(tmpdir(), "visaljs-compat-"));
  try {
    const probe = join(dir, "probe.mjs");
    /* node:module goes before rolldown's helpers (rolldown's runtime imports it), so its namespace
     * object would be built before __exportAll exists: a default import needs none, and its
     * default export has every named one */
    writeFileSync(probe, [
      ...names.map((name, i) => (name === "module" ? `import d${i} from "node:${name}"; const m${i} = { default: d${i} };` : `import * as m${i} from "node:${name}";`)),
      `const exportsOf = ${exportsOf.toString()};`,
      `const out = {};`,
      ...names.map((name, i) => `out[${JSON.stringify(name)}] = exportsOf(m${i});`),
      `console.log(JSON.stringify(out));`,
      `process.exit(0);`,
      "",
    ].join("\n"));
    const binary = join(dir, "probe");
    let errors = "";
    const status = await main(["build", probe, "-o", binary, "--embed-source", "--quiet"], { stdout: () => {}, stderr: (t) => void (errors += t) });
    if (status !== 0) throw new Error(`the probe program doesn't build:\n${errors}`);
    /* node:sys warns as it loads (DEP0025), as Node's does: not what the probe is about */
    return JSON.parse(execFileSync(binary, { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function coverage(node: Record<string, string[]>, ours: Record<string, ReturnType<typeof exportsOf>>, notes: Record<string, string>, version: string): Compat {
  /* the legacy _stream_* names are left out, as Node's other `_` modules are */
  for (const name of Object.keys(ours)) if (!name.startsWith("_") && !node[name]) throw new Error(`node:${name} is provided but Node ${version} has no such module`);
  for (const name of Object.keys(notes)) if (!node[name]) throw new Error(`compat.notes.json: no module ${name}`);
  const result: Compat["modules"] = {};
  const summary: Compat["summary"] = {
    modules: { complete: 0, partial: 0, stub: 0, missing: 0, total: 0 },
    exports: { implemented: 0, stubbed: 0, missing: 0, total: 0 },
  };
  for (const name of Object.keys(node).sort()) {
    const theirs = node[name]!;
    const mine = ours[name];
    const has = new Set(mine?.names);
    const stub = new Set(mine?.stubs);
    const implemented = theirs.filter((k) => has.has(k) && !stub.has(k));
    const stubbed = theirs.filter((k) => stub.has(k));
    const missing = theirs.filter((k) => !has.has(k));
    const extra = (mine?.names ?? []).filter((k) => !theirs.includes(k));
    const status: Status = !mine ? "missing" : implemented.length === theirs.length ? "complete" : implemented.length ? "partial" : "stub";
    result[name] = { status, implemented, stubbed, missing, ...(extra.length ? { extra } : {}), ...(notes[name] ? { notes: notes[name] } : {}) };
    summary.modules[status]++;
    summary.modules.total++;
    summary.exports.implemented += implemented.length;
    summary.exports.stubbed += stubbed.length;
    summary.exports.missing += missing.length;
    summary.exports.total += theirs.length;
  }
  return { generatedBy: "node tests/compat/node.ts", node: version, summary, modules: result };
}

const { values } = parseArgs({ options: { refresh: { type: "boolean" }, check: { type: "boolean" } } });
const previous = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Compat) : undefined;
if (values.check && !previous) {
  console.error("node/compat.json is missing: run node tests/compat/node.ts --refresh");
  process.exit(1);
}
const refresh = values.refresh === true || !previous;
const node = refresh ? await nodeExports() : recordedNodeExports(previous);
const notes = existsSync(NOTES) ? (JSON.parse(readFileSync(NOTES, "utf8")) as Record<string, string>) : {};
const compat = coverage(node, await visaljsExports(), notes, refresh ? process.version : previous!.node);

if (values.check) {
  if (!isDeepStrictEqual(compat, previous)) {
    console.error("node/compat.json is out of date: run node tests/compat/node.ts");
    process.exit(1);
  }
} else {
  writeFileSync(OUT, JSON.stringify(compat, null, 2) + "\n");
  const { modules: m, exports: e } = compat.summary;
  console.log(`node/compat.json (Node ${compat.node}): ${m.complete} complete, ${m.partial} partial, ${m.stub} stub, ${m.missing} missing of ${m.total} modules; ` +
    `${e.implemented} / ${e.total} exports implemented, ${e.stubbed} stubbed`);
}
