// Installs each app's dependencies. The apps aren't npm workspaces: each has its own
// package-lock.json and node_modules, so adding one doesn't touch the root lockfile.
//
//   node tests/apps/install.ts [--missing] [name...]
//
// --missing: only the apps without a node_modules yet. Names pick apps (default: all).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const APPS = import.meta.dirname;

/** The apps' directory names: those with a package.json. */
export function apps(): string[] {
  return readdirSync(APPS).filter((d) => existsSync(join(APPS, d, "package.json"))).sort();
}

/** `npm ci` in the app (`npm install` when it has no lockfile yet, which writes one). */
export function install(name: string) {
  const dir = join(APPS, name);
  const command = existsSync(join(dir, "package-lock.json")) ? "ci" : "install";
  process.stderr.write(`tests/apps/${name}: npm ${command}\n`);
  execFileSync("npm", [command, "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir, stdio: ["ignore", 2, 2], shell: process.platform === "win32" });
}

/** Installs the app's dependencies unless it has none or has a node_modules already. */
export function ensureInstalled(name: string) {
  const dir = join(APPS, name);
  const { dependencies = {} } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (Object.keys(dependencies).length && !existsSync(join(dir, "node_modules"))) install(name);
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ options: { missing: { type: "boolean" } }, allowPositionals: true });
  for (const name of positionals.length ? positionals : apps()) {
    if (values.missing) ensureInstalled(name);
    else install(name);
  }
}
