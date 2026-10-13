// Regular expression literals at build time: every literal in the program goes
// through the regexp-compile tool (QuickJS's libregexp). An invalid one is a SyntaxError at
// the literal, as early errors are (§13.2.7.1); a valid one's bytecode goes into the C file.
import { spawnSync } from "node:child_process";

import { CompileError, encodePattern, flagBits, regexpKey } from "@visaljs/compiler";
import type * as A from "@visaljs/compiler/ast";

import { regexpCompiler } from "./cc.ts";

/** The program's regex literals, in source order. */
export function regexpLiterals(program: A.Program): A.RegExpLiteral[] {
  const out: A.RegExpLiteral[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if ((node as { type?: string }).type === "RegExpLiteral") out.push(node as A.RegExpLiteral);
    for (const [key, value] of Object.entries(node)) if (key !== "loc" && value !== null && typeof value === "object") walk(value);
  };
  walk(program.body);
  return out;
}

/** Compiles literals with the tool: their bytecode by regexpKey. The first invalid one throws
 *  its SyntaxError, located at the literal. */
export function compileRegExps(cc: string, literals: readonly A.RegExpLiteral[]): Map<string, Uint8Array> {
  const bytecode = new Map<string, Uint8Array>();
  const todo = new Map<string, A.RegExpLiteral>();
  for (const lit of literals) {
    const flags = flagBits(lit.flags);
    if (flags === null) throw new CompileError("SyntaxError", "Invalid regular expression flags", lit.loc);
    if (!todo.has(regexpKey(lit.pattern, lit.flags))) todo.set(regexpKey(lit.pattern, lit.flags), lit);
  }
  if (todo.size === 0) return bytecode;
  const input = [...todo.values()]
    .map((lit) => {
      const flags = flagBits(lit.flags)!;
      return `${flags} ${Buffer.from(encodePattern(lit.pattern, (flags & ((1 << 4) | (1 << 8))) !== 0)).toString("hex")}\n`;
    })
    .join("");
  const run = spawnSync(regexpCompiler(cc), [], { input, encoding: "utf8", maxBuffer: 1 << 30 });
  if (run.status !== 0) throw new Error(`regexp-compile failed: ${run.stderr || run.error?.message}`);
  const lines = run.stdout.split(/\r?\n/);  /* the tool writes text mode on Windows */
  let i = 0;
  for (const [key, lit] of todo) {
    const line = lines[i++] ?? "";
    if (line.startsWith("ok ")) {
      bytecode.set(key, Buffer.from(line.slice(3), "hex"));
    } else {
      const message = line.startsWith("error ") ? line.slice(6) : "Invalid regular expression";
      throw new CompileError("SyntaxError", `Invalid regular expression: /${lit.pattern}/${lit.flags}: ${message}`, lit.loc);
    }
  }
  return bytecode;
}
