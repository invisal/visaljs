// Standalone binaries of a JavaScript program from Node and Bun, to compare visaljs's against.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { rolldown } from "rolldown";

const POSTJECT = "postject@1.0.0-alpha.6";

/** Node's single executable application: the program bundled into one CommonJS file, its blob
 *  injected into a copy of the node binary. Scratch files go next to `binary`. */
export async function buildNodeSea(entry: string, binary: string) {
  const bundle = `${binary}.sea.cjs`;
  try {
    await (await rolldown({ input: entry, platform: "node", logLevel: "silent" })).write({ file: bundle, format: "cjs", codeSplitting: false });
  } catch {
    /* top-level await has no CommonJS form, and Node 22's SEA main must be CommonJS: an ES module
       bundle instead, which the main imports from a data: URL */
    const esm = `${binary}.sea.mjs`;
    await (await rolldown({ input: entry, platform: "node", logLevel: "silent" })).write({ file: esm, format: "esm", codeSplitting: false });
    writeFileSync(bundle, `import(${JSON.stringify(`data:text/javascript;base64,${readFileSync(esm).toString("base64")}`)});\n`);
  }
  const config = `${binary}.sea-config.json`;
  const blob = `${binary}.sea.blob`;
  writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
  execFileSync(process.execPath, ["--experimental-sea-config", config], { cwd: dirname(binary), stdio: "ignore" });
  copyFileSync(process.execPath, binary);
  const mac = process.platform === "darwin";
  if (mac) execFileSync("codesign", ["--remove-signature", binary]);
  execFileSync("npx", ["--yes", POSTJECT, binary, "NODE_SEA_BLOB", blob,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(mac ? ["--macho-segment-name", "NODE_SEA"] : [])], { stdio: "ignore" });
  if (mac) execFileSync("codesign", ["--sign", "-", binary]);
}

/** Bun's compiled binary (`bun build --compile`). */
export function buildBun(entry: string, binary: string) {
  execFileSync("bun", ["build", "--compile", entry, "--outfile", binary], { stdio: "ignore" });
}

/** visaljs's binary, from the repository's CLI. */
export function buildVisaljs(entry: string, binary: string) {
  execFileSync(process.execPath, [join(import.meta.dirname, "..", "..", "cli", "src", "cli.ts"), "build", entry, "-o", binary, "--quiet"], { stdio: "inherit" });
}
