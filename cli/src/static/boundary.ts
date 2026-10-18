// Where the program meets static code. In the program's bundle each static file is a module of
// its own exports, each re-exported from "visaljs:host" (the unit's exports are host primitives):
// the bundler then checks the program's imports per file, as Node would. After lowering, the
// program's calls of those host functions take the typed entries (annotateTypedCalls).
import { readFileSync } from "node:fs";

import { HOST_MODULE } from "@visaljs/compiler";
import type { Instr, ModuleIR, TypedCall } from "@visaljs/ir";
import type { Plugin } from "rolldown";
import ts from "typescript";

import { exportsOf } from "./link.ts";

/** A static file's module in the program's bundle: the file's path, then this suffix (messages
 *  name the file). */
export const STATIC_MODULE = "?static";

export const isStaticModule = (id: string) => id.endsWith(STATIC_MODULE);

/** A file that starts with the "use static" directive (after comments). */
const DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(["'])use static\1/;

function isStaticFile(file: string): boolean {
  return /\.[cm]?tsx?$/.test(file) && DIRECTIVE.test(readFileSync(file, "utf8"));
}

/** The program's bundle: a static file's import resolves to its module of host primitives;
 *  `found` collects the static files. */
export function staticImports(found: Set<string>): Plugin {
  return {
    name: "visaljs-static-imports",
    async resolveId(source, importer, { kind }) {
      if (source === HOST_MODULE || !importer || kind !== "import-statement") return null;
      const r = await this.resolve(source, importer, { skipSelf: true });
      if (!r || r.external || !isStaticFile(r.id)) return null;
      found.add(r.id);
      return r.id + STATIC_MODULE;
    },
    load(id) {
      if (!isStaticModule(id)) return null;
      const file = id.slice(0, -STATIC_MODULE.length);
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const names = exportsOf(sf).map((e) => e.name);
      return names.length ? `export { ${names.join(", ")} } from ${JSON.stringify(HOST_MODULE)};\n` : "";
    },
  };
}

/** The program's calls of static exports: a call whose callee is the export's host import (the
 *  host function, or the module binding one store sets to it). Before optimizing. */
export function annotateTypedCalls(m: ModuleIR, calls: Record<string, TypedCall>) {
  const all = [m.main, ...m.functions];
  const slots = new Map<number, string>();
  const stores = new Map<number, number>();
  for (const fn of all)
    for (const b of fn.blocks)
      for (const i of b.instrs) {
        if (i.op !== "store_global" || i.operands[0]!.op === "empty") continue;
        stores.set(i.index!, (stores.get(i.index!) ?? 0) + 1);
        const v = i.operands[0]!;
        if (v.op === "host_function" && Object.hasOwn(calls, v.target!)) slots.set(i.index!, v.target!);
      }
  const target = (callee: Instr): string | undefined => {
    const v = callee.op === "check_tdz" ? callee.operands[0]! : callee;
    if (v.op === "host_function") return Object.hasOwn(calls, v.target!) ? v.target : undefined;
    if (v.op === "load_global" && stores.get(v.index!) === 1) return slots.get(v.index!);
    return undefined;
  };
  for (const fn of all)
    for (const b of fn.blocks)
      for (const i of b.instrs) {
        const name = i.op === "call" ? target(i.operands[0]!) : undefined;
        if (name) i.typedCall = calls[name]!;
      }
}
