// What the framework plugins read from a project: its package.json, and the packages installed in it.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { FrameworkError } from "./error.ts";

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

/** The project's package.json, or {} without one. */
export function packageJson(root: string): PackageJson {
  const file = join(root, "package.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PackageJson) : {};
}

/** The project's package.json's dependencies and devDependencies. */
export function dependencies(root: string): Record<string, string> {
  const pkg = packageJson(root);
  return { ...pkg.devDependencies, ...pkg.dependencies };
}

/** The script a package installed in the project runs as `name` (its package.json's "bin"). */
export function packageBin(root: string, pkg: string, name: string): string {
  let manifest: string;
  try {
    manifest = createRequire(join(root, "package.json")).resolve(`${pkg}/package.json`);
  } catch {
    throw new FrameworkError(`${pkg} isn't installed in ${root}: run npm install first`);
  }
  const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> };
  const script = typeof bin === "string" ? bin : bin?.[name];
  if (!script) throw new FrameworkError(`${pkg} has no ${name} command`);
  return join(dirname(manifest), script);
}
