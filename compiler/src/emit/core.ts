// Core methods: the methods of the large core objects (Object, Array, String, Number)
// and the global functions on numbers, which a program installs only when it names them.
// runtime/include/js_core.def lists them, in V8's order; the generated C file gets the entries the program names, as a JSCoreEntry table.
import { readFileSync } from "node:fs";
import { CORE_DEF } from "@visaljs/runtime";

export interface CoreEntry {
  /** The object it goes on: `ARRAY_PROTO` (JSCoreTarget). */
  target: string;
  /** The property name, or null for a well-known-symbol key (always installed). */
  name: string | null;
  /** For an alias, the entry it shares a function with, and that entry's target. */
  alias: string | null;
  aliasTarget: string;
  /** The table line for the program's C file: `JS_CORE_ENTRY_FN(ARRAY_PROTO, "push", array_proto_push, 1)`. */
  c: string;
}

export { CORE_DEF };

/** Names every program keeps, because the runtime calls them itself: ToPrimitive (`toString`,
 *  `valueOf`, also of String and Number wrappers), Array.prototype.toString (`join`), array
 *  iteration (`values`). */
const IMPLICIT = new Set([
  "OBJECT_PROTO.toString", "OBJECT_PROTO.valueOf", "ARRAY_PROTO.join", "ARRAY_PROTO.values", "ARRAY_PROTO.toString",
  "STRING_PROTO.toString", "STRING_PROTO.valueOf", "NUMBER_PROTO.toString", "NUMBER_PROTO.valueOf",
]);

export function parseCoreDef(text: string): CoreEntry[] {
  const entries: CoreEntry[] = [];
  for (const line of text.split("\n")) {
    const m = /^JS_CORE_(\w+)\((\w+), ("[^"]*"|\w+), (.*)\)$/.exec(line);
    if (!m) continue;
    const [, kind, target, key, rest] = m as unknown as [string, string, string, string, string];
    const of = kind === "ALIAS_OF" ? /^(\w+), ("[^"]*")$/.exec(rest) : null;
    entries.push({
      target,
      name: kind.startsWith("SYMBOL_") ? null : JSON.parse(key) as string,
      alias: of ? JSON.parse(of[2]!) as string : kind.endsWith("ALIAS") ? JSON.parse(rest) as string : null,
      aliasTarget: of ? of[1]! : target,
      c: line.replace(/^JS_CORE_/, "JS_CORE_ENTRY_"),
    });
  }
  return entries;
}

let catalog: CoreEntry[] | undefined;

/** js_core.def's entries. */
export function coreCatalog(): CoreEntry[] {
  return (catalog ??= parseCoreDef(readFileSync(CORE_DEF, "utf8")));
}

/** The entries a program with these names installs, in the catalog's order: those it names,
 *  the implicit ones, symbol keys, and what an alias it keeps shares a function with. */
export function namedCore(names: ReadonlySet<string>, entries: readonly CoreEntry[] = coreCatalog()): CoreEntry[] {
  const keep = new Set(entries.filter((e) => e.name === null || names.has(e.name) || IMPLICIT.has(`${e.target}.${e.name}`)));
  for (const e of [...keep]) {
    if (e.alias !== null) for (const f of entries) if (f.target === e.aliasTarget && f.name === e.alias) keep.add(f);
  }
  return entries.filter((e) => keep.has(e));
}
