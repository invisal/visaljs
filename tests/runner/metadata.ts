// test262 frontmatter: the YAML between `/*---` and `---*/`.
import { parse as parseYaml } from "yaml";

export type Flag =
  | "onlyStrict"
  | "noStrict"
  | "module"
  | "raw"
  | "async"
  | "generated"
  | "CanBlockIsFalse"
  | "CanBlockIsTrue"
  | "non-deterministic";

export interface Negative {
  phase: "parse" | "resolution" | "runtime";
  type: string;
}

export interface TestMetadata {
  description: string;
  includes: string[];
  flags: Set<Flag>;
  features: string[];
  negative: Negative | null;
}

const FRONTMATTER = /\/\*---([\s\S]*?)---\*\//;
const PHASES = new Set(["parse", "resolution", "runtime"]);

export class MetadataError extends Error {}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new MetadataError(`'${field}' must be a list of strings`);
  }
  return value;
}

export function parseMetadata(source: string): TestMetadata {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new MetadataError("missing /*--- ---*/ frontmatter");

  let raw: unknown;
  try {
    raw = parseYaml(match[1]!.replace(/\r\n?/g, "\n"));
  } catch (e) {
    throw new MetadataError(`bad YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  if (typeof raw !== "object" || raw === null) throw new MetadataError("frontmatter is not a mapping");
  const doc = raw as Record<string, unknown>;

  let negative: Negative | null = null;
  if (doc.negative !== undefined) {
    const n = doc.negative as Record<string, unknown>;
    if (typeof n.phase !== "string" || !PHASES.has(n.phase) || typeof n.type !== "string") {
      throw new MetadataError("'negative' needs a phase (parse/resolution/runtime) and a type");
    }
    negative = { phase: n.phase as Negative["phase"], type: n.type };
  }

  return {
    description: typeof doc.description === "string" ? doc.description.trim() : "",
    includes: stringList(doc.includes, "includes"),
    flags: new Set(stringList(doc.flags, "flags") as Flag[]),
    features: stringList(doc.features, "features"),
    negative,
  };
}
