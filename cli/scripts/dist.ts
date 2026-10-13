// Builds the publishable `visaljs` package in cli/dist: Node won't strip types from .ts files
// under node_modules, so the CLI and the @visaljs/* libraries are bundled into one cli.js, and
// the C the driver compiles (runtime/, node/) is copied next to it, with the prebuilt libraries
// (prebuilt.ts) in build/prebuilt: build them first, or download the workflow's (prebuilt.yml).
//
//   node cli/scripts/dist.ts && npm publish ./cli/dist
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { rolldown } from "rolldown";

import { prebuiltKey } from "../src/cc.ts";
import { DEFAULT_HOSTS } from "../src/hosts.ts";
import { licensesText } from "../src/licenses.ts";
import { PREBUILT_DIR, prebuiltLibraries, TARGETS } from "./prebuilt.ts";

const CLI = join(import.meta.dirname, "..");
const ROOT = join(CLI, "..");
const DIST = join(CLI, "dist");
const pkg = JSON.parse(readFileSync(join(CLI, "package.json"), "utf8"));
const compiler = JSON.parse(readFileSync(join(ROOT, "compiler", "package.json"), "utf8"));
/** npm dependencies stay external: the published package depends on them. */
const dependencies: Record<string, string> = Object.fromEntries(
  Object.entries({ ...compiler.dependencies, ...pkg.dependencies } as Record<string, string>).filter(([d]) => !d.startsWith("@visaljs/")),
);

/** What each asset package keeps: the C, headers and prelude JS (not its tests or tools). */
const ASSETS: Record<string, string[]> = {
  runtime: ["include", "src", "third_party", "tools/regexp_compile.c"],
  node: ["include", "src", "third_party", "prelude"],
};

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST);

const build = await rolldown({
  input: join(CLI, "src", "cli.ts"),
  platform: "node",
  external: [...Object.keys(dependencies), /^node:/],
  plugins: [{
    /* runtime/index.ts and node/index.ts find their files beside them: in dist, under runtime/ and node/ */
    name: "asset-dirs",
    transform(code, id) {
      for (const dir of Object.keys(ASSETS)) {
        if (id === join(ROOT, dir, "index.ts")) return code.replace("import.meta.dirname", `join(import.meta.dirname, ${JSON.stringify(dir)})`);
      }
      return null;
    },
  }],
});
await build.write({ file: join(DIST, "cli.js"), format: "esm" });
await build.close();

for (const [dir, entries] of Object.entries(ASSETS)) {
  for (const e of entries) cpSync(join(ROOT, dir, e), join(DIST, dir, e), { recursive: true });
}

writeFileSync(join(DIST, "package.json"), `${JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  repository: { type: "git", url: "git+https://github.com/invisal/visaljs.git", directory: "cli" },
  homepage: "https://github.com/invisal/visaljs",
  type: "module",
  bin: { visaljs: "./cli.js" },
  engines: pkg.engines,
  dependencies,
}, null, 2)}\n`);
cpSync(join(CLI, "README.md"), join(DIST, "README.md"));
cpSync(join(ROOT, "LICENSE"), join(DIST, "LICENSE"));
/* the C copied above and the prebuilt libraries are third-party code: their licenses, as `visaljs licenses` prints them */
writeFileSync(join(DIST, "THIRD_PARTY_LICENSES"), licensesText(DEFAULT_HOSTS, pkg.version));

copyPrebuilt();

/** Copies each target's prebuilt libraries into prebuilt/<target>: the archives build/prebuilt has
 *  for these sources (their keys), so a stale one isn't published. A target missing one is left
 *  out (its users build the libraries themselves); says which. */
function copyPrebuilt() {
  const copied: string[] = [];
  const missing: string[] = [];
  for (const t of TARGETS) {
    const archives = prebuiltLibraries(t).map((l) => `${l.name}-${prebuiltKey(l)}.a`);
    if (!archives.every((a) => existsSync(join(PREBUILT_DIR, t.name, a)))) {
      missing.push(t.name);
      continue;
    }
    mkdirSync(join(DIST, "prebuilt", t.name), { recursive: true });
    for (const a of archives) cpSync(join(PREBUILT_DIR, t.name, a), join(DIST, "prebuilt", t.name, a));
    copied.push(t.name);
  }
  console.log(`prebuilt libraries: ${copied.length ? copied.join(", ") : "none"}`);
  if (missing.length) console.warn(`not prebuilt: ${missing.join(", ")} (npm run prebuilt, or download prebuilt.yml's artifact into build/prebuilt)`);
}
