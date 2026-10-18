// Typed arrays a function makes and only indexes: `const a = new Uint8Array(n)` whose every use
// is `a[i]` or `a[i] = v`. Nothing else can reach it, so nothing can detach or resize its
// buffer: its elements' address and its length, taken once after `new`, hold for its life.
// A typed function's ("use static") typed array parameter too: other code can reach that one,
// so its C takes the view again after anything that may run code.
// Each access then checks the index against that length and reads or writes the element
// (Instr.taView, a JSTAView in C), the generic path covering the rest: an index out of
// bounds, or a constructor that isn't the built-in any more (the view is empty).
import { type Instr, type ModuleIR } from "@visaljs/ir";

import { functionsOf, pauses } from "./cfg.ts";
import type { Count, Pass } from "./index.ts";

type Kind = NonNullable<Instr["taView"]>;

/** The element types with an inline view, by constructor. */
const KINDS: Record<string, Kind> = {
  Int8Array: "i8", Uint8Array: "u8", Int32Array: "i32", Float64Array: "f64",
};

export const typedArrays: Pass = {
  name: "typed-arrays",
  run(m: ModuleIR, count: Count) {
    for (const fn of functionsOf(m)) {
      if (pauses(fn)) continue;  /* a generator's values live across its pauses, not in C locals */
      const made = new Map<Instr, Kind>();
      /* a typed function's typed array parameters (checked at its entries); the C takes their
         view at the start and again after anything that may run code */
      fn.meta?.declaredViews?.forEach((kind, k) => {
        if (kind) made.set(fn.params[k]!, kind);
      });
      for (const b of fn.blocks)
        for (const i of b.instrs) {
          const ctor = i.operands[0];
          if (i.op === "new" && i.operands.length === 2 && ctor?.op === "global_name" && Object.hasOwn(KINDS, ctor.target!)) made.set(i, KINDS[ctor.target!]!);
        }
      if (!made.size) continue;
      /* any use but indexing it lets it out */
      const accesses = new Map<Instr, Instr[]>();
      const escape = (v: Instr) => made.delete(v);
      for (const b of fn.blocks) {
        for (const phi of b.phis) for (const inc of phi.incoming!) escape(inc.value);
        for (const i of b.instrs)
          i.operands.forEach((o, k) => {
            if (!made.has(o)) return;
            const indexed = (i.op === "get_elem" || i.op === "set_elem") && k === 0 && i.operands[1] !== o && i.operands[2] !== o;
            if (indexed) accesses.set(o, [...(accesses.get(o) ?? []), i]);
            else escape(o);
          });
        const t = b.term;
        if (t?.kind === "branch") escape(t.cond);
        if (t?.kind === "return" || t?.kind === "throw") escape(t.value);
      }
      for (const [array, kind] of made) {
        array.taView = kind;
        for (const a of accesses.get(array) ?? []) a.taView = kind;
        count("viewed", "typed array");
      }
    }
    return m;
  },
};
