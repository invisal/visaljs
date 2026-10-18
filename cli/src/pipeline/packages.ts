// What integrations read from a project: its package.json, and the packages installed in it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { IntegrationError } from "./errors.ts";

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** The project's package.json, or {} without one. */
export function packageJson(root: string): PackageJson {
  const file = join(root, "package.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
  } catch (e) {
    throw new IntegrationError(`cannot read ${file}: ${(e as Error).message}`);
  }
}

export function dependencies(root: string): Record<string, string> {
  const pkg = packageJson(root);
  return { ...pkg.devDependencies, ...pkg.dependencies };
}

/** Whether `name` is installed for the project in `root`: in node_modules here or in a directory
 *  above (a workspace's), as Node finds it, or in pnpm's store there (node_modules/.pnpm/<name>@…),
 *  where a dependency's dependencies are. */
export function installed(root: string, name: string): boolean {
  const store = `${name.replace("/", "+")}@`;
  for (let dir = root; ; dir = dirname(dir)) {
    const modules = join(dir, "node_modules");
    if (existsSync(join(modules, name, "package.json"))) return true;
    const pnpm = join(modules, ".pnpm");
    if (existsSync(pnpm) && readdirSync(pnpm).some((d) => d.startsWith(store))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** The script a package installed in the project runs as `name` (its package.json's "bin"). */
export function packageBin(root: string, pkg: string, name: string): string {
  let manifest: string;
  try {
    manifest = createRequire(join(root, "package.json")).resolve(`${pkg}/package.json`);
  } catch {
    throw new IntegrationError(`${pkg} isn't installed in ${root}: run npm install first`);
  }
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> };
  const script = typeof bin === "string" ? bin : bin?.[name];
  if (!script) throw new IntegrationError(`${pkg} has no ${name} command`);
  return join(dirname(manifest), script);
}
