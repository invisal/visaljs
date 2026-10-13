// tests/test262.skip: features and paths that aren't compiled at all.
import type { TestMetadata } from "./metadata.ts";

export interface SkipList {
  features: Set<string>;
  paths: RegExp[];
}

/** `**` matches across directories, `*` within one path segment. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function parseSkipList(text: string): SkipList {
  const list: SkipList = { features: new Set(), paths: [] };
  text.split(/\r?\n/).forEach((line, i) => {
    const body = line.replace(/#.*/, "").trim();
    if (!body) return;
    const [kind, value, extra] = body.split(/\s+/);
    if (!value || extra !== undefined) throw new Error(`test262.skip:${i + 1}: expected '<kind> <value>'`);
    if (kind === "feature") list.features.add(value);
    else if (kind === "path") list.paths.push(globToRegExp(value));
    else throw new Error(`test262.skip:${i + 1}: unknown kind '${kind}'`);
  });
  return list;
}

/** Returns why a test is skipped, or null if it should run. */
export function skipReason(list: SkipList, path: string, meta: TestMetadata): string | null {
  for (const re of list.paths) if (re.test(path)) return `path ${re.source}`;
  for (const f of meta.features) if (list.features.has(f)) return `feature ${f}`;
  return null;
}
