// A runner worker thread: runs the batches main.ts hands it (batch.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { runBatch, setCcMemory, type Item } from "./batch.ts";

const HARNESS_DIR = join(import.meta.dirname, "..", "test262", "harness");
const harness = new Map<string, string>();
const readHarness = (f: string) => {
  let text = harness.get(f);
  if (text === undefined) harness.set(f, (text = readFileSync(join(HARNESS_DIR, f), "utf8")));
  return text;
};

setCcMemory((workerData as { ccMemory: number }).ccMemory);

parentPort!.on("message", ({ id, items }: { id: number; items: Item[] }) => {
  let results;
  try {
    results = runBatch(items, readHarness);
  } catch (e) {
    /* a runner bug: report the batch as crashed instead of hanging the pool */
    results = items.map(() => ({ outcome: "fail" as const, reason: "compiler-crash" as const, detail: String(e) }));
  }
  parentPort!.postMessage({ id, results });
});
