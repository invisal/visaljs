// node.timings: `test-file seconds`, one a line: what each test of tests/nodejs took (its share of
// its batch's build, and its run), which the runner balances the CI shards by (main.ts --shard).
// The times come from CI, whose runners are what the shards run on: each shard writes what it
// measured (main.ts --timings-out), and this merges those files in.
//
//   node tests/nodejs/timings.ts <measured…>   merge measured times into node.timings
//
// A time within a third (or a second) of the recorded one is kept, so the file changes when a
// test's cost does, not with a runner's noise; a test no longer copied loses its line.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dirname;
export const TIMINGS = join(HERE, "node.timings");
const PARALLEL = join(HERE, "test", "parallel");

/** A timings file (node.timings, or one main.ts --timings-out wrote) as file → seconds. */
export function readTimings(path = TIMINGS): Map<string, number> {
  const out = new Map<string, number>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [file, seconds] = line.trim().split(/\s+/);
    if (file && seconds) out.set(file, Number(seconds));
  }
  return out;
}

export function writeTimings(timings: Map<string, number>, path = TIMINGS): void {
  writeFileSync(path, [...timings].sort(([a], [b]) => a.localeCompare(b)).map(([f, t]) => `${f} ${t}`).join("\n") + "\n");
}

/** The recorded times with the measured ones in: a measured time replaces a recorded one only when
 *  they differ by more than a third (or a second); the tests no longer copied go. */
export function mergeTimings(recorded: Map<string, number>, measured: Map<string, number>): Map<string, number> {
  const next = new Map([...recorded].filter(([f]) => existsSync(join(PARALLEL, f))));
  for (const [file, seconds] of measured) {
    if (!existsSync(join(PARALLEL, file))) continue;
    const old = recorded.get(file);
    if (old === undefined || Math.abs(seconds - old) > Math.max(1, old / 3)) next.set(file, Math.round(seconds * 10) / 10);
  }
  return next;
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node tests/nodejs/timings.ts <measured…>   (the files main.ts --timings-out wrote, CI's node-timings artifacts)");
    process.exit(2);
  }
  const measured = new Map<string, number>();
  for (const f of files) for (const [file, seconds] of readTimings(f)) measured.set(file, seconds);
  const recorded = readTimings();
  const next = mergeTimings(recorded, measured);
  writeTimings(next);
  const changed = [...next].filter(([f, t]) => recorded.get(f) !== t).length;
  console.log(`node.timings: ${next.size} tests, ${changed} times changed, from ${measured.size} measured`);
}
