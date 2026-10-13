// Differential testing: the same program run by Node and compiled by visaljs,
// each in an empty working directory; their stdout, stderr and exit status must match.
//
// A first line `// visaljs-flags: --a --b` passes build flags; with --script the program
// is a classic script for both (Node runs it with -e), else an ES module. A program that imports
// node:test has its report compared without durations, test locations and stack frames.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { main } from "visaljs";

export interface Run {
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface Outcome {
  file: string;
  node: Run;
  visaljs: Run;
  /** What differs, empty when the runs match (or why the program couldn't be built). */
  differences: string[];
}

/** The test host's print, for programs written for the end-to-end suite. */
const PRINT_SHIM = "globalThis.print = (x) => console.log(String(x));\n";
const TIMEOUT_MS = 30000;

export function buildFlags(source: string): string[] {
  const m = /^\/\/ visaljs-flags: (.*)$/m.exec(source.split("\n")[0]!);
  return m ? m[1]!.trim().split(/\s+/) : [];
}

function run(command: string, args: string[], cwd: string): Run {
  const r = spawnSync(command, args, { encoding: "utf8", cwd, timeout: TIMEOUT_MS });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

/** Runs the program with Node, in a fresh empty directory. */
export function runNode(file: string): Run {
  const source = readFileSync(file, "utf8");
  const args = buildFlags(source).includes("--script")
    ? ["-e", PRINT_SHIM + source]
    : ["--import", `data:text/javascript,${encodeURIComponent(PRINT_SHIM)}`, resolve(file)];
  const cwd = mkdtempSync(join(tmpdir(), "visaljs-diff-node-"));
  try {
    return run(process.execPath, ["--stack-size=900", ...args], cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Compiles the program with visaljs and runs the binary in a fresh empty directory; the
 *  compiler's messages when it can't be built. */
export async function runVisaljs(file: string, outDir: string): Promise<Run | { error: string }> {
  const binary = join(outDir, basename(file).replace(/\.[cm]?js$/, ""));
  let stderr = "";
  const code = await main(["build", file, "-o", binary, ...buildFlags(readFileSync(file, "utf8"))], {
    stdout: () => {},
    stderr: (t) => (stderr += t),
  });
  if (code !== 0) return { error: stderr || `visaljs build exited with ${code}` };
  const cwd = mkdtempSync(join(tmpdir(), "visaljs-diff-run-"));
  try {
    return run(binary, [], cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** The first line where two outputs differ, shown with both versions. */
function firstDifference(what: string, expected: string, actual: string): string {
  const a = expected.split("\n"), b = actual.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const show = (s: string | undefined) => (s === undefined ? "(end of output)" : JSON.stringify(s));
  return `${what} differs at line ${i + 1}:\n    node:     ${show(a[i])}\n    visaljs: ${show(b[i])}`;
}

/** node:test's report without what can't match: each duration, and Node's test locations
 *  (file:line:column) and V8 stack frames, which a compiled program doesn't know. */
export function normalizeTestReport(text: string): string {
  const out: string[] = [];
  let stackIndent = -1;
  for (const line of text.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (stackIndent >= 0 && indent > stackIndent && line.trim() !== "") continue;
    stackIndent = -1;
    if (/^\s+location: '.*'$/.test(line)) continue;
    const stack = /^(\s+)stack: \|-$/.exec(line);
    if (stack) {
      stackIndent = stack[1]!.length;
      continue;
    }
    out.push(line.replace(/(duration_ms:? )[\d.e+-]+/, "$1…"));
  }
  return out.join("\n");
}

export async function differential(file: string, outDir: string): Promise<Outcome> {
  const node = runNode(file);
  const built = await runVisaljs(file, outDir);
  if ("error" in built) {
    return { file, node, visaljs: { stdout: "", stderr: built.error, status: null }, differences: [`visaljs couldn't build it:\n${built.error}`] };
  }
  /* a node:test program's report is compared without durations, locations and stack frames */
  if (/["']node:test["']/.test(readFileSync(file, "utf8"))) {
    node.stdout = normalizeTestReport(node.stdout);
    built.stdout = normalizeTestReport(built.stdout);
  }
  const differences: string[] = [];
  if (node.stdout !== built.stdout) differences.push(firstDifference("stdout", node.stdout, built.stdout));
  if (node.stderr !== built.stderr) differences.push(firstDifference("stderr", node.stderr, built.stderr));
  if (node.status !== built.status) differences.push(`exit status differs: node ${node.status}, visaljs ${built.status}`);
  return { file, node, visaljs: built, differences };
}
