import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_HOSTS } from "../src/hosts.ts";
import { licensesText, notices, VISALJS_LICENSE } from "../src/licenses.ts";
import { main, VERSION } from "../src/main.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const all = notices(DEFAULT_HOSTS);
const files = all.flatMap((n) => n.files);

/** Every file under `dir`, recursively. */
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

describe("third-party licenses", () => {
  it("names every license file that exists", () => {
    for (const f of [VISALJS_LICENSE, ...files]) expect(existsSync(f), relative(ROOT, f)).toBe(true);
  });

  it("covers every directory of vendored code", () => {
    for (const dir of ["runtime/third_party", "node/third_party"]) {
      for (const entry of readdirSync(join(ROOT, dir))) {
        const path = join(ROOT, dir, entry);
        expect(files.some((f) => f.startsWith(path + "/") || f.startsWith(path + "\\")), `${dir}/${entry}: no notice`).toBe(true);
      }
    }
  });

  it("points every ported file at a license that exists", () => {
    const sources = ["runtime/src", "node/src", "node/prelude"].flatMap((d) => walk(join(ROOT, d)));
    let ported = 0;
    for (const f of sources) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:runtime|node)\/third_party\/[\w.-]+(?:\/[\w.-]+)*/g)) {
        expect(existsSync(join(ROOT, m[0].replace(/\.$/, ""))), `${relative(ROOT, f)}: ${m[0]}`).toBe(true);
        ported++;
      }
    }
    expect(ported).toBeGreaterThan(30);
  });

  it("prints visaljs's license, then each notice's, each text once", async () => {
    let stdout = "";
    const code = await main(["licenses"], { stdout: (t) => (stdout += t), stderr: () => {} });
    expect(code).toBe(0);
    expect(stdout).toBe(licensesText(DEFAULT_HOSTS, VERSION));
    expect(stdout.indexOf(readFileSync(VISALJS_LICENSE, "utf8").trimEnd())).toBeGreaterThan(0);
    for (const n of all) expect(stdout).toContain(`\n${n.name}: ${n.what}\nLicense: ${n.license}\n`);
    /* Node.js comes from the runtime and the node host: one notice, its text once */
    expect(all.filter((n) => n.name === "Node.js")).toHaveLength(1);
    expect(stdout.split("Copyright Node.js contributors. All rights reserved.")).toHaveLength(2);
  });
});
