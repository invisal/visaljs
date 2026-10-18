// Element access whose key doesn't change: `obj[key]` takes the generic path (ToPropertyKey,
// then a lookup without a site cache) where `obj.name` has an inline cache.
//
// - A string literal key that isn't an array index (often one inlining brought in:
//   `events[type]` in an inlined `this.emit("finish")`) is a named access: get_elem becomes
//   get_prop, set_elem set_prop, with the key as Instr.key.
// - A key read from a module binding that one store sets, besides its TDZ's EMPTY (Node's
//   `state[kState]`, `this[kCapture]`: symbols made once at the top level), is most likely the
//   same at every run: the access becomes a keyed site (Instr.keyedSite). Its C remembers the
//   key it sees and, while the key is that one, is a named access with its own inline cache
//   (js_get_keyed). It's a guess, checked at run time: another key still works.
import { propKey, type Instr, type ModuleIR } from "@visaljs/ir";

import { functionsOf } from "./cfg.ts";
import type { Count, Pass } from "./index.ts";

export const constantKeys: Pass = {
  name: "constant-keys",
  run(m: ModuleIR, count: Count) {
    const stores = new Map<number, number>();
    for (const fn of functionsOf(m))
      for (const b of fn.blocks)
        for (const i of b.instrs)  /* not the TDZ's EMPTY a `const` or `let` starts with */
          if (i.op === "store_global" && i.operands[0]!.op !== "empty") stores.set(i.index!, (stores.get(i.index!) ?? 0) + 1);
    /* a binding's value: the load, through its TDZ check */
    const storedOnce = (key: Instr) => {
      const load = key.op === "check_tdz" ? key.operands[0]! : key;
      return load.op === "load_global" && stores.get(load.index!) === 1;
    };
    for (const fn of functionsOf(m))
      for (const b of fn.blocks)
        for (const i of b.instrs) {
          if (i.op !== "get_elem" && i.op !== "set_elem") continue;
          const key = i.operands[1]!;
          if (key.op === "const" && typeof key.lit!.value === "string") {
            const k = propKey(key.lit!.value);
            if (!("name" in k)) continue;
            i.op = i.op === "get_elem" ? "get_prop" : "set_prop";
            i.key = k;
            i.operands.splice(1, 1);
            count("named", "element access", 1, "element accesses");
          } else if (storedOnce(key)) {
            i.keyedSite = true;
            count("cached", "keyed site");
          }
        }
    return m;
  },
};
