// Runtime code evaluation: a compiled program has no parser, so calling
// eval with source text or Function / new Function throws a TypeError at run time. The build
// still succeeds (code that only names eval works, as get-intrinsic's does under Express); these
// are the calls to warn about.
import type { analyze } from "@visaljs/compiler";
import type * as A from "@visaljs/compiler/ast";

export interface EvalCall {
  kind: "eval" | "Function";
  loc: A.Loc;
}

/** Calls of the global eval that may get source text, and of the global Function (with or
 *  without new), in source order. Aliases (`const F = Function`) aren't followed. */
export function evalCalls(program: A.Program, info: ReturnType<typeof analyze>): EvalCall[] {
  const out: EvalCall[] = [];
  const global = (callee: A.Expression, name: string): callee is A.Identifier =>
    callee.type === "Identifier" && callee.name === name && info.references.get(callee)?.binding === null;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as A.Node;
    if (n.type === "CallExpression" || n.type === "NewExpression") {
      if (global(n.callee, "Function")) out.push({ kind: "Function", loc: n.loc });
      /* eval returns anything but a string as is: only a possible string throws */
      else if (n.type === "CallExpression" && global(n.callee, "eval") && mayBeString(n.arguments[0])) out.push({ kind: "eval", loc: n.loc });
    }
    for (const [key, value] of Object.entries(node)) if (key !== "loc" && value !== null && typeof value === "object") walk(value);
  };
  walk(program.body);
  return out;
}

function mayBeString(arg: A.Argument | undefined): boolean {
  if (!arg) return false;
  switch (arg.type) {
    case "Literal":
      return typeof arg.value === "string";
    case "BigIntLiteral":
    case "ObjectExpression":
    case "ArrayExpression":
    case "FunctionExpression":
      return false;
    default:
      return true;
  }
}

/** The warning's message (null: no calls), and with `verbose` a line per call. */
export function evalWarning(calls: readonly EvalCall[], verbose: boolean): string | null {
  if (calls.length === 0) return null;
  const n = (kind: EvalCall["kind"]) => calls.filter((c) => c.kind === kind).length;
  const places = (k: number) => `${k} ${k === 1 ? "place" : "places"}`;
  const parts = [];
  if (n("eval")) parts.push(`eval() of source text in ${places(n("eval"))}`);
  if (n("Function")) parts.push(`new Function() in ${places(n("Function"))}`);
  const owners = [...new Set(calls.map((c) => packageOf(c.loc.file) ?? "your code"))];
  let text = `the program uses ${parts.join(" and ")} (in ${owners.join(", ")}): `
    + `compiled code can't evaluate source text, so ${calls.length === 1 ? "it throws" : "they throw"} a TypeError if reached`;
  if (verbose) text += calls.map((c) => `\n  ${c.loc.file}:${c.loc.line}:${c.loc.column}: ${c.kind === "eval" ? "eval()" : "new Function()"}`).join("");
  else text += "\n  (--verbose lists them)";
  return text;
}

/** The npm package a file belongs to: the last node_modules/<name> (or @scope/name) in its path. */
function packageOf(file: string): string | null {
  const parts = file.split(/[\\/]/);
  const i = parts.lastIndexOf("node_modules");
  if (i < 0 || i + 1 >= parts.length) return null;
  const name = parts[i + 1]!;
  return name.startsWith("@") && i + 2 < parts.length ? `${name}/${parts[i + 2]}` : name;
}
