import { describe, expect, it } from "vitest";

import { FunctionBuilder } from "../src/index.ts";
import type { FunctionIR } from "../src/index.ts";
import { printFunction } from "../src/index.ts";
import { verify, VerifyError } from "../src/index.ts";

/** Variables are keyed by objects (lowering uses sema Bindings); `name` names the SSA values. */
const v = (name: string) => ({ name });

/** The running example: function sumTo(n) { let s = 0; for (let i = 0; i < n; i++) s += i; return s; } */
function sumTo(): FunctionIR {
  const b = new FunctionBuilder("sumTo", ["n"], false, null);
  const n = v("n"), s = v("s"), i = v("i");
  b.writeVariable(n, b.fn.params[0]!);
  b.writeVariable(s, b.const(0));
  b.writeVariable(i, b.const(0));
  const header = b.newBlock(), body = b.newBlock(), exit = b.newBlock();
  b.jump(header);
  b.setBlock(header);  // not sealed: the back edge comes later
  const c = b.emit("lt", [b.readVariable(i), b.readVariable(n)]);
  b.terminate({ kind: "branch", cond: c, then: body, else: exit });
  b.seal(body);
  b.setBlock(body);
  b.writeVariable(s, b.emit("add", [b.readVariable(s), b.readVariable(i)], { name: "s" }));
  b.writeVariable(i, b.emit("inc", [b.readVariable(i)], { name: "i" }));
  b.jump(header);
  b.seal(header);
  b.seal(exit);
  b.setBlock(exit);
  b.terminate({ kind: "return", value: b.readVariable(s) });
  return b.finish();
}

describe("builder: SSA construction", () => {
  it("builds loop phis, and none for variables the loop doesn't change", () => {
    const fn = sumTo();
    verify(fn);
    expect(printFunction(fn)).toBe(`function sumTo(%n0)
bb0:
  %0 = const 0
  %1 = const 0
  jump bb1
bb1:  ; preds bb0, bb2
  %i0 = phi [bb0: %1], [bb2: %i1]
  %s0 = phi [bb0: %0], [bb2: %s1]
  %2 = lt %i0, %n0  !mayThrow
  branch %2, bb2, bb3
bb2:
  %s1 = add %s0, %i0  !mayThrow
  %i1 = inc %i0  !mayThrow
  jump bb1
bb3:
  return %s0
`);
  });

  it("splits at throwing instructions in a try, so handlers see values from before the throw", () => {
    const b = new FunctionBuilder("f", [], false, null);
    const x = v("x");
    b.writeVariable(x, b.const(1));
    const handler = b.newBlock(null);
    const body = b.newBlock(handler);
    b.jump(body);
    b.seal(body);
    b.setBlock(body);
    b.writeVariable(x, b.const(2));
    const r = b.emit("call_direct", [], { target: "g" });  // x is still 2 if g throws
    b.writeVariable(x, r);
    b.emit("call_direct", [], { target: "h" });            // x is g's result if h throws
    const after = b.newBlock(null);
    b.jump(after);
    b.seal(handler);
    b.setBlock(handler);
    b.emit("take_exception", []);
    b.jump(after);
    b.seal(after);
    b.setBlock(after);
    b.terminate({ kind: "return", value: b.readVariable(x) });
    const fn = b.finish();
    verify(fn);
    /* the handler's phi: 2 if g throws (bb2), g's result if h throws (bb3) */
    expect(printFunction(fn)).toBe(`function f()
bb0:
  %0 = const 1
  jump bb2
bb1:  ; preds bb2, bb3
  %x0 = phi [bb2: %2], [bb3: %3]
  %1 = take_exception
  jump bb5
bb2:  ; handler bb1
  %2 = const 2
  %3 = call_direct g()  !mayThrow
  jump bb3
bb3:  ; handler bb1
  %4 = call_direct h()  !mayThrow
  jump bb4
bb4:  ; handler bb1
  jump bb5
bb5:  ; preds bb4, bb1
  %x1 = phi [bb4: %3], [bb1: %x0]
  return %x1
`);
  });

  it("drops unreachable blocks", () => {
    const b = new FunctionBuilder("dead", [], false, null);
    b.terminate({ kind: "return", value: b.const(undefined) });
    const dead = b.newBlock();
    b.seal(dead);
    b.setBlock(dead);
    b.terminate({ kind: "return", value: b.const("never") });
    const fn = b.finish();
    expect(fn.blocks).toHaveLength(1);
    verify(fn);
  });
});

describe("verifier", () => {
  const problems = (fn: FunctionIR) => {
    try {
      verify(fn);
    } catch (e) {
      if (e instanceof VerifyError) return e.problems.join("\n");
      throw e;
    }
    return "";
  };

  it("rejects a use that its definition doesn't dominate", () => {
    const fn = sumTo();
    const [body, header] = [fn.blocks[2]!, fn.blocks[1]!];
    header.instrs[0]!.operands[0] = body.instrs[1]!;  // lt uses i1 from the loop body
    expect(problems(fn)).toMatch(/doesn't dominate/);
  });

  it("rejects a use before the definition in the same block", () => {
    const fn = sumTo();
    const body = fn.blocks[2]!;
    body.instrs[0]!.operands[1] = body.instrs[1]!;  // add uses inc, defined after it
    expect(problems(fn)).toMatch(/before its definition/);
  });

  it("rejects a phi without an input for every predecessor", () => {
    const fn = sumTo();
    fn.blocks[1]!.phis[0]!.incoming!.pop();
    expect(problems(fn)).toMatch(/has inputs from \[bb0\], preds are \[bb0, bb2\]/);
  });

  it("rejects a block without a terminator, and inconsistent predecessors", () => {
    const fn = sumTo();
    fn.blocks[3]!.term = null;
    expect(problems(fn)).toMatch(/bb3 has no terminator/);
    const fn2 = sumTo();
    fn2.blocks[3]!.preds = [];
    expect(problems(fn2)).toMatch(/bb3 preds \[\] != \[bb1\]/);
  });

  /** try { x = g(); h(); } catch { use x }: the handler merges x from two throw points. */
  function twoThrowPoints(): FunctionIR {
    const b = new FunctionBuilder("f", [], false, null);
    const x = v("x");
    b.writeVariable(x, b.const(0));
    const handler = b.newBlock(null);
    const body = b.newBlock(handler);
    b.jump(body);
    b.seal(body);
    b.setBlock(body);
    b.writeVariable(x, b.emit("call_direct", [], { target: "g" }));
    b.emit("call_direct", [], { target: "h" });
    b.terminate({ kind: "return", value: b.const(1) });
    b.seal(handler);
    b.setBlock(handler);
    b.emit("take_exception", []);
    b.terminate({ kind: "return", value: b.readVariable(x) });
    const fn = b.finish();
    verify(fn);
    return fn;
  }

  it("rejects values that don't exist on an exception edge", () => {
    const fn = twoThrowPoints();
    const phi = fn.blocks.find((bl) => bl.phis.length)!.phis[0]!;
    const fromG = phi.incoming!.find((i) => i.block.instrs.at(-1)?.target === "g")!;
    fromG.value = fromG.block.instrs.at(-1)!;  // g's result, along the edge taken when g throws
    expect(problems(fn)).toMatch(/along its own exception edge/);
  });

  it("requires handlers to take the exception first", () => {
    const fn = twoThrowPoints();
    const handler = fn.blocks.find((bl) => bl.phis.length)!;
    handler.instrs.shift();
    expect(problems(fn)).toMatch(/doesn't start with take_exception/);
  });

  it("rejects a throwing instruction that isn't last in a protected block", () => {
    const fn = twoThrowPoints();
    const handler = fn.blocks.find((bl) => bl.phis.length)!;
    const [a, bBlock] = handler.preds as [typeof handler, typeof handler];  // the blocks ending with g() and h()
    /* move g() in front of h(): both now throw from one block */
    const g = a.instrs.pop()!;
    g.block = bBlock;
    bBlock.instrs.unshift(g);
    handler.preds = [bBlock];
    handler.phis = [];
    handler.term = { kind: "return", value: g, loc: null };
    expect(problems(fn)).toMatch(/may throw to bb\d+ but isn't last/);
  });
});
