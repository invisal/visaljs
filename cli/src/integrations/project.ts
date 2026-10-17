// The entry when no framework set one: the first of these whose file exists.
//
//   1. "bin", when it names one command
//   2. "scripts.start", when it runs `node <file>`
//   3. "main" (npm init writes "index.js" whether or not there's one)
//   4. index.js
//
// The binary is named after the command, else the package without its scope, else the directory.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { IntegrationError } from "../pipeline/errors.ts";
import type { Integration } from "../pipeline/types.ts";

/** The project names no entry, or several. */
export class EntryError extends IntegrationError {}

export interface ProjectEntry {
  file: string;
  /** Where it came from, for the report: `package.json "scripts.start"`, `index.js`. */
  from: string;
  name: string;
  /** The arguments `scripts.start` gives the program, which a binary can't have built in. */
  ignoredArgs: string[];
}

interface PackageJson {
  name?: unknown;
  bin?: unknown;
  main?: unknown;
  scripts?: { start?: unknown };
}

/* Node's options that take their value as the next word: `node -r dotenv/config server.js` */
const NODE_VALUE_OPTIONS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions",
  "--env-file", "--env-file-if-exists", "--input-type", "--stack-size", "--title", "--max-old-space-size"]);

/** The file and arguments of the first `node <file> …` in a start script, else undefined:
 *  `NODE_ENV=production node --enable-source-maps dist/server.js --port 80`. */
export function nodeCommand(script: string): { file: string; args: string[] } | undefined {
  for (const part of script.split(/&&|\|\||[;|]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();  /* VAR=value */
    if (words[0] !== "node") continue;
    let i = 1;
    while (i < words.length && words[i]!.startsWith("-")) i += NODE_VALUE_OPTIONS.has(words[i]!) ? 2 : 1;
    if (i < words.length) return { file: words[i]!, args: words.slice(i + 1) };
  }
  return undefined;
}

/** The file `path` names in `root`, as Node would run it (`node server` runs server.js), if any. */
function existing(root: string, path: string): string | undefined {
  for (const candidate of [path, `${path}.js`, `${path}.mjs`, `${path}.cjs`]) {
    const file = join(root, candidate);
    if (statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
  }
  return undefined;
}

/** The project's name without its scope (`@acme/api` → `api`), else its directory's. */
function projectName(pkg: PackageJson, root: string): string {
  return typeof pkg.name === "string" && pkg.name ? pkg.name.replace(/^@[^/]+\//, "") : basename(root);
}

/** The entry of the project in `root`; EntryError when it names none, or several commands. */
export function projectEntry(root: string): ProjectEntry {
  const pkgFile = join(root, "package.json");
  let pkg: PackageJson = {};
  if (existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as PackageJson;
    } catch (e) {
      throw new EntryError(`cannot read ${pkgFile}: ${(e as Error).message}`);
    }
  }
  const name = projectName(pkg, root);
  /* the files named that aren't there, for the error */
  const missing: string[] = [];
  const found = (path: string, from: string, binName = name, ignoredArgs: string[] = []): ProjectEntry | undefined => {
    const file = existing(root, path);
    if (!file) missing.push(`${from} names ${path}, which isn't there`);
    return file ? { file, from, name: binName, ignoredArgs } : undefined;
  };

  if (typeof pkg.bin === "string") {
    const entry = found(pkg.bin, `package.json "bin"`);
    if (entry) return entry;
  } else if (pkg.bin && typeof pkg.bin === "object") {
    const commands = Object.entries(pkg.bin as Record<string, unknown>).filter((c): c is [string, string] => typeof c[1] === "string");
    if (commands.length > 1) {
      throw new EntryError(`package.json "bin" names ${commands.length} commands: build one of them, ` +
        commands.map(([command, file]) => `visaljs build ${join(relative(process.cwd(), root) || ".", file)} -o ${command}`).join(", or "));
    }
    if (commands.length === 1) {
      const [command, file] = commands[0]!;
      const entry = found(file, `package.json "bin"`, command);
      if (entry) return entry;
    }
  }

  const start = typeof pkg.scripts?.start === "string" ? nodeCommand(pkg.scripts.start) : undefined;
  if (start) {
    const entry = found(start.file, `package.json "scripts.start"`, name, start.args);
    if (entry) return entry;
  }

  if (typeof pkg.main === "string" && pkg.main) {
    const entry = found(pkg.main, `package.json "main"`);
    if (entry) return entry;
  }

  const index = existing(root, "index.js");
  if (index) return { file: index, from: "index.js", name, ignoredArgs: [] };

  const checked = existsSync(pkgFile) ? `package.json's "bin", "scripts.start" and "main", and index.js` : "a package.json and index.js";
  throw new EntryError(`no entry file: checked ${checked}${missing.length ? ` (${missing.join("; ")})` : ""}`);
}

export const project: Integration = {
  id: "project",
  name: "package.json",
  provides: "entry",
  detect: () => true,
  hooks: {
    prepare(ctx) {
      const entry = projectEntry(ctx.root);
      ctx.entryFile = entry.file;
      ctx.output = join(ctx.root, entry.name);
      ctx.note(`Entry: ${relative(ctx.root, entry.file).replaceAll("\\", "/")} (${entry.from})`, "📄");
      if (entry.ignoredArgs.length) ctx.note(`its arguments (${entry.ignoredArgs.join(" ")}) aren't built in: give them when you run the binary`);
    },
  },
};
