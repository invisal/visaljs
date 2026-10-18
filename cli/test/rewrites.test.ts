// The integrations' rewrites that must match, against the framework versions tests/apps installs
// (npm run apps:install): an upgrade that moves the code fails here, not in a user's build.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LOADS } from "../src/integrations/next.ts";
import { BUILD_IMPORT } from "../src/integrations/vinext.ts";
import type { Rewrite } from "../src/pipeline/types.ts";

const APPS = join(import.meta.dirname, "..", "..", "tests", "apps");

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".js")).map((f) => join(dir, f));
}

/* next build writes the Turbopack runtime: there's nothing to check before a build */
const nextLoads = LOADS.filter((r) => !r.file.source.includes("turbopack"));

describe.each<[string, string, Pick<Rewrite, "file" | "find">[]]>([
  ["next", join(APPS, "nextjs", "node_modules", "next"), nextLoads],
  ["vinext", join(APPS, "vinext", "node_modules", "vinext"), [BUILD_IMPORT]],
])("%s's rewrites", (_, dir, rewrites) => {
  it.skipIf(!existsSync(dir))("each finds its code in the installed package", () => {
    const files = jsFiles(dir);
    for (const r of rewrites) {
      const matched = files.filter((f) => r.file.test(f));
      expect(matched, String(r.file)).not.toEqual([]);
      expect(matched.some((f) => readFileSync(f, "utf8").includes(r.find as string)), `${String(r.file)}: ${String(r.find)}`).toBe(true);
    }
  });
});
