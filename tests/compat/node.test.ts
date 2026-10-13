// node/compat.json is what tests/compat/node.ts generates from the preludes as they are.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { expect, it } from "vitest";

it("node/compat.json is up to date (node tests/compat/node.ts)", () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "node.ts"), "--check"], { encoding: "utf8" });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
}, 300_000);
