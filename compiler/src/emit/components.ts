// Optional built-ins: which components a program can reach, decided from the names
// in it. The runtime lists its components (@visaljs/runtime/components).
import { COMPONENTS, type Component } from "@visaljs/runtime/components";

import type * as A from "../frontend/ast.ts";

export { COMPONENTS, type Component };

/** Every identifier name and string literal in the program: the names it can reach built-ins by.
 *  Syntax adds the names of what it needs: an async function or `await` adds `Promise`, a
 *  generator `function*`, an async generator or `for await` `async function*`. */
export function programNames(program: A.Program): Set<string> {
  const names = new Set<string>();
  namesIn(program.body, names);
  return names;
}

function namesIn(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const x of node) namesIn(x, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const n = node as { type?: string; name?: unknown; value?: unknown; async?: boolean; generator?: boolean; await?: boolean };
  if (n.type === "Identifier" && typeof n.name === "string") out.add(n.name);
  else if (n.type === "RegExpLiteral") out.add("RegExp");
  else if (n.type === "BigIntLiteral") out.add("BigInt");
  else if (n.type === "Literal" && typeof n.value === "string") out.add(n.value);
  /* syntax that needs a component (runtime/components.ts): a promise, a generator's prototypes */
  else if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") {
    if (n.async) out.add("Promise");
    if (n.generator) out.add(n.async ? "async function*" : "function*");
  } else if (n.type === "AwaitExpression" || n.type === "ImportCall") out.add("Promise");
  else if (n.type === "ForOfStatement" && n.await) out.add("async function*").add("Promise");
  for (const [key, value] of Object.entries(node)) {
    if (key !== "loc" && value !== null && typeof value === "object") namesIn(value, out);
  }
}

/** The optional components the program can reach, and those they need, in COMPONENTS order. */
export function reachableComponents(names: ReadonlySet<string>): Component[] {
  const wanted = new Set(COMPONENTS.filter((c) => c.names.some((n) => names.has(n))).map((c) => c.name));
  for (const c of [...COMPONENTS].reverse()) if (wanted.has(c.name)) for (const n of c.needs ?? []) wanted.add(n);
  return COMPONENTS.filter((c) => wanted.has(c.name));
}
