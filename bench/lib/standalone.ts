import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { rolldown } from "rolldown";

const POSTJECT = "postject@1.0.0-alpha.6";
const NEXTJS_BUILD_HEAP_MB = 4096;

export async function buildNodeSea(entry: string, binary: string) {
  const bundle = `${binary}.sea.cjs`;
  try {
    await (await rolldown({ input: entry, platform: "node", logLevel: "silent" })).write({ file: bundle, format: "cjs", codeSplitting: false });
  } catch {
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

export function buildBun(entry: string, binary: string) {
  execFileSync("bun", ["build", "--compile", entry, "--outfile", binary], { stdio: "ignore" });
}

export function buildVisaljs(entry: string, binary: string) {
  execFileSync(process.execPath, [`--max-old-space-size=${NEXTJS_BUILD_HEAP_MB}`, join(import.meta.dirname, "..", "..", "cli", "src", "cli.ts"), "build", entry, "-o", binary, "--quiet"], { stdio: "inherit" });
}
