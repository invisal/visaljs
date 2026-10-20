// The IR text dump: `--emit ir` and golden tests. Deterministic:
// values are numbered in print order, and named after their JS variable when
// they have one (%s0, %s1, …).
import { OPS, type Block, type FunctionIR, type Instr, type ModuleIR, type Terminator } from "./ir.ts";
import { Any, typeName, Unknown } from "./types.ts";

export function printFunction(fn: FunctionIR): string {
  const names = new Map<Instr, string>();
  const perName = new Map<string, number>();
  let unnamed = 0;
  const name = (v: Instr): string => {
    let n = names.get(v);
    if (n === undefined) {
      if (v.name) {
        const k = perName.get(v.name) ?? 0;
        perName.set(v.name, k + 1);
        n = `%${v.name}${k}`;
      } else {
        n = `%${unnamed++}`;
      }
      names.set(v, n);
    }
    return n;
  };
  /* number in print order: params, then each block's phis and instructions */
  for (const p of fn.params) name(p);
  for (const b of fn.blocks) for (const i of [...b.phis, ...b.instrs]) if (OPS[i.op].result) name(i);

  const bb = (b: Block) => `bb${b.id}`;
  const lines: string[] = [];
  lines.push(`function ${fn.name}(${fn.params.map(name).join(", ")})${fn.strict ? " strict" : ""}`);
  for (const b of fn.blocks) {
    const notes: string[] = [];
    if (b.preds.length > 1) notes.push(`preds ${b.preds.map(bb).join(", ")}`);
    if (b.handler) notes.push(`handler ${bb(b.handler)}`);
    lines.push(`${bb(b)}:${notes.length ? `  ; ${notes.join("; ")}` : ""}`);
    for (const phi of b.phis) lines.push(`  ${def(phi)}phi ${phi.incoming!.map((i) => `[${bb(i.block)}: ${name(i.value)}]`).join(", ")}`);
    for (const i of b.instrs) {
      if (i.op === "param") continue;
      lines.push(`  ${def(i)}${instr(i)}${i.numberFirst ? "  ?number" : ""}${i.builtin ? `  ?${i.builtin}` : ""}${i.keyedSite ? "  ?keyed" : ""}${i.mayThrow ? "  !mayThrow" : ""}`);
    }
    if (b.term) lines.push(`  ${term(b.term)}`);
  }
  return lines.join("\n") + "\n";

  function def(i: Instr): string {
    if (!OPS[i.op].result) return "";
    const type = i.type !== Any && i.type !== Unknown && i.op !== "const" && i.op !== "empty" ? `: ${typeName(i.type)}` : "";
    return `${name(i)}${type}${i.repr !== "boxed" ? ` (${i.repr})` : ""} = `;
  }

  function instr(i: Instr): string {
    const args = i.operands.map(name).join(", ");
    switch (i.op) {
      case "const":
        return `const ${lit(i.lit!.value)}`;
      case "load_global":
        return `load_global @${i.index}`;
      case "store_global":
        return `store_global @${i.index}, ${args}`;
      case "global_name":
        return `global_name ${JSON.stringify(i.target)}`;
      case "make_function":
        return `make_function ${i.target}${args ? `, ${args}` : ""}`;
      case "env_new":
        return `env_new ${args}, ${i.index} slots`;
      case "env_load":
        return `env_load ${args}, ${i.index}:${i.slot}`;
      case "env_store":
        return `env_store ${args}, ${i.index}:${i.slot}`;
      case "global_typeof_name":
        return `global_typeof_name ${JSON.stringify(i.target)}`;
      case "host_function":
        return `host_function ${i.target}`;
      case "bigint":
        return `bigint ${i.bigint!}n`;
      case "switch_string":
        return `switch_string ${name(i.operands[0]!)}, ${JSON.stringify(i.cases)}`;
      case "regexp":
        return `regexp /${i.regexp!.pattern}/${i.regexp!.flags}`;
      case "array_get": case "array_set": case "array_length": case "array_push":
        return `${i.op} ${i.elem}[] ${args}`;
      case "template_object":
        return `template_object ${JSON.stringify(i.template!.cooked)}, slot ${i.index}`;
      case "import_meta":
        return `import_meta ${JSON.stringify(i.target)}, slot ${i.index}`;
      case "dynamic_import":
        return `dynamic_import ${args}, from ${JSON.stringify(i.target)}`;
      case "call_direct":
      case "call_runtime":
        return `${i.op} ${i.target}(${args})`;
      case "construct_direct":
        return `construct_direct ${i.target}(${args})`;
      case "same_function":
        return `same_function ${args}, ${i.target}`;
      case "i64":
        return `i64 ${i.target} ${args}`;
      case "is_type":
        return `${i.index ? "!" : ""}is_type ${args}, ${JSON.stringify(i.target)}`;
      case "identical":
      case "strict_eq_atom":
      case "strict_eq_num":
        return `${i.index ? "!" : ""}${i.op} ${args}`;
      case "new_instance":
        return `new_instance ${args}, ${i.index} slots`;
      case "get_prop":
      case "set_prop":
      case "delete_prop":
      case "define_prop":
        return `${i.op} ${args}, ${key(i)}`;
      case "super_get":
      case "super_set":
        return `${i.op} ${args}${i.key ? `, ${key(i)}` : ""}`;
      case "declare_global":
        return `${i.op} ${i.index === 1 ? "function" : "var"} ${key(i)}${args ? `, ${args}` : ""}`;
      case "set_global_name":
        return `${i.op} ${key(i)}, ${args}`;
      case "define_field":
        return `${i.op} ${args}${i.key ? `, ${key(i)}` : ""}`;
      case "private_add":
        return `${i.op} ${["field", "method", "get", "set"][i.index!]} ${args}`;
      case "define_class_member":
        return `${i.op} ${["method", "get", "set"][i.index!]} ${args}${i.key ? `, ${key(i)}` : ""}`;
      case "define_accessor":
        return `${i.op} ${i.index === 0 ? "get" : "set"} ${args}${i.key ? `, ${key(i)}` : ""}`;
      default:
        return args ? `${i.op} ${args}` : i.op;
    }
  }

  function term(t: Terminator): string {
    switch (t.kind) {
      case "jump": return `jump ${bb(t.target)}`;
      case "branch": return `branch ${name(t.cond)}, ${bb(t.then)}, ${bb(t.else)}`;
      case "return": return `return ${name(t.value)}`;
      case "throw": return `throw ${name(t.value)}`;
      case "unreachable": return "unreachable";
    }
  }
}

function key(i: Instr): string {
  const k = i.key!;
  return "index" in k ? `[${k.index}]` : `.${JSON.stringify(k.name)}`;
}

function lit(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  return JSON.stringify(v);
}

export function printModule(m: ModuleIR): string {
  const parts: string[] = [];
  if (m.globals.length) parts.push(`globals ${m.globals.map((g) => `@${g.slot} ${g.name}`).join(", ")}\n`);
  for (const fn of [m.main, ...m.functions]) parts.push(printFunction(fn));
  return parts.join("\n");
}
