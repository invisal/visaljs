import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMPONENTS, programNames, reachableComponents } from "../src/emit/components.ts";
import { coreCatalog, namedCore } from "../src/emit/core.ts";
import { parseModule } from "../src/frontend/adapter.ts";

const RUNTIME = join(import.meta.dirname, "..", "..", "runtime");

describe("optional built-ins", () => {
  it("lists the same components as the runtime", () => {
    const all = readFileSync(join(RUNTIME, "src", "components.c"), "utf8");
    const runtime = [...all.matchAll(/&(js_component_\w+)/g)].map((m) => m[1]);
    expect(COMPONENTS.map((c) => c.symbol)).toEqual(runtime);
  });

  it("reaches a component by identifier, property name or string key, and not otherwise", () => {
    const reach = (src: string) => reachableComponents(programNames(parseModule(src, "m.js"))).map((c) => c.name);
    expect(reach("Math.max(1, 2);")).toEqual(["math"]);
    expect(reach("globalThis.Math;")).toEqual(["math"]);
    expect(reach('globalThis["Math"];')).toEqual(["math"]);
    expect(reach("const { Math: m } = globalThis;")).toEqual(["math"]);
    expect(reach('console.log("hello");')).toEqual([]);
    expect(reach('globalThis["Ma" + "th"];')).toEqual([]);  /* the documented limit */
    expect(reach("Date.now();")).toEqual(["date"]);
    expect(reach("/a+/g.test(s);")).toEqual(["regexp"]);  /* a literal reaches RegExp */
    expect(reach('s.match("-");')).toEqual(["regexp"]);   /* match, matchAll and search create one */
    expect(reach('s.replace("a", "b");')).toEqual([]);
    expect(reach("x * 2n;")).toEqual(["bigint"]);  /* a literal reaches BigInt */
    expect(reach("new WeakMap();")).toEqual(["weak"]);
  });

  it("reaches the language's own components by syntax too", () => {
    const reach = (src: string) => reachableComponents(programNames(parseModule(src, "m.js"))).map((c) => c.name);
    expect(reach("Promise.resolve(1);")).toEqual(["promise"]);
    expect(reach("async function f() {}")).toEqual(["promise"]);
    expect(reach("const f = async () => 1;")).toEqual(["promise"]);
    expect(reach("await 1;")).toEqual(["promise"]);  /* top-level await */
    expect(reach('import("./m.js");')).toEqual(["promise"]);
    expect(reach("Array.fromAsync([]);")).toEqual(["promise"]);
    expect(reach("function* g() {}")).toEqual(["generator"]);
    expect(reach("({ *g() {} });")).toEqual(["generator"]);
    expect(reach("async function* g() {}")).toEqual(["promise", "asynciterator"]);
    expect(reach("for await (const x of xs);")).toEqual(["promise", "asynciterator"]);
    expect(reach("function f() { return 1; }")).toEqual([]);
  });

  it("adds the components a reached one needs, in install order", () => {
    const reach = (src: string) => reachableComponents(programNames(parseModule(src, "m.js"))).map((c) => c.name);
    expect(reach("new Uint8Array(4);")).toEqual(["arraybuffer", "typedarray"]);
    expect(reach("new BigInt64Array(4);")).toEqual(["bigint", "arraybuffer", "typedarray"]);  /* bigint first */
    expect(reach("new DataView(new ArrayBuffer(1));")).toEqual(["arraybuffer"]);
  });
});

describe("core methods", () => {
  const core = (src: string) => namedCore(programNames(parseModule(src, "m.js"))).map((e) => `${e.target}.${e.name ?? "@@"}`);

  it("reads the whole catalog", () => {
    const def = readFileSync(join(RUNTIME, "include", "js_core.def"), "utf8");
    expect(coreCatalog().length).toBe([...def.matchAll(/^JS_CORE_\w+\(/gm)].length);
  });

  it("keeps the methods a program names, the implicit ones and symbol keys, in catalog order", () => {
    expect(core('console.log("hello");')).toEqual([
      "OBJECT_PROTO.toString", "OBJECT_PROTO.valueOf", "ARRAY.@@", "ARRAY_PROTO.join",
      "ARRAY_PROTO.values", "ARRAY_PROTO.toString", "ARRAY_PROTO.@@", "STRING_PROTO.toString", "STRING_PROTO.valueOf",
      "NUMBER_PROTO.toString", "NUMBER_PROTO.valueOf", "CONSOLE.log",
    ]);
    expect(core("console.table(rows);")).toContain("CONSOLE.table");
    expect(core("console.table(rows);")).not.toContain("CONSOLE.log");
    expect(core("[1].push(2);")).toContain("ARRAY_PROTO.push");
    expect(core('o["slice"];')).toContain("STRING_PROTO.slice");
    expect(core("o.trimLeft;")).toEqual(expect.arrayContaining(["STRING_PROTO.trimStart", "STRING_PROTO.trimLeft"]));
    expect(core("o.trimLeft;")).not.toContain("STRING_PROTO.trimEnd");
    expect(core('parseInt("7");')).toEqual(expect.arrayContaining(["NUMBER.parseInt", "GLOBAL.parseInt"]));
    expect(core("Number.EPSILON;")).toContain("NUMBER.EPSILON");
  });
});
