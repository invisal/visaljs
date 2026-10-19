import { join } from "node:path";

import { preludeDir } from "@visaljs/node";
import { describe, expect, it } from "vitest";

import { attribute, bundleRegions, bundleSizes, parseLineTable, parseLinkMap, type SizeEntry } from "../src/size.ts";

/* ld64's map and dwarfdump --debug-line's output, cut down to the parts size.ts reads */
const MAP = `# Path: app
# Arch: arm64
# Object files:
[  0] linker synthesized
[  1] /tmp/b/program.o
[  2] /tmp/b/typed.o
[  3] /cache/jsrt-c6515c15546c4a2b/libjsrt.a(1.o)
[  4] /prebuilt/boringssl-0123456789abcdef.a(0.o)
[  5] /sdk/libSystem.tbd
# Sections:
# Address\tSize    \tSegment\tSection
0x100000000\t0x00000200\t__TEXT\t__text
0x100000200\t0x00000040\t__TEXT\t__cstring
0x100001000\t0x00000100\t__DATA\t__bss
# Symbols:
# Address\tSize    \tFile  Name
0x100000000\t0x00000100\t[  1] _js_script
0x100000100\t0x00000020\t[  1] _js_truthy
0x100000120\t0x00000010\t[  2] _vjs_typed_jsf_fib
0x100000130\t0x00000050\t[  3] _js_gc_collect
0x100000180\t0x00000060\t[  4] _SHA256
0x1000001E0\t0x00000010\t[  5] _malloc
0x100000200\t0x00000020\t[  1] literal string: hello
0x100000220\t0x00000010\t[  1] _jss_3
0x100001000\t0x00000100\t[  1] _mod_ics
# Dead Stripped Symbols:
# \tSize    \tFile  Name
<<dead>>\t0x00000010\t[  1] _jsf_unused
`;

const LINES = `debug_line[0x00000000]
include_directories[  0] = "/work/app"
include_directories[  1] = "/repo/runtime/include"
file_names[  0]:
           name: "program.c"
      dir_index: 0
file_names[  1]:
           name: "bundle.js"
      dir_index: 0
file_names[  2]:
           name: "js_value.h"
      dir_index: 1
file_names[  3]:
           name: "${join(preludeDir, "events.js")}"
      dir_index: 0

Address            Line   Column File   ISA Discriminator OpIndex Flags
------------------ ------ ------ ------ --- ------------- ------- -------------
0x0000000100000000      3      0      1   0             0       0  is_stmt
0x0000000100000040      6      0      1   0             0       0  is_stmt
0x0000000100000080      7      0      2   0             0       0  is_stmt
0x00000001000000c0     40      0      3   0             0       0  is_stmt
0x0000000100000100      1      0      2   0             0       0  is_stmt
0x0000000100000120      1      0      2   0             0       0  end_sequence
`;

const BUNDLE = `import x from "y";
//#region src/a.js
const a = 1;
//#endregion
//#region node_modules/pkg/data.json
var data = [1, 2, 3];
//#endregion
//#region \\0rolldown/runtime.js
var __export = () => {};
//#endregion
//#region \\0visaljs-require:${join(preludeDir, "events.js")}
var events = require_events();
//#endregion
`;

const LIBRARIES = [
  { name: "jsrt", sources: ["/repo/runtime/src/value.c", "/repo/runtime/src/gc.c"], headers: [], flags: [] },
  { name: "boringssl", sources: ["/repo/bssl/crypto/sha.cc", "/repo/bssl/crypto/aes.cc"], headers: [], flags: [] },
];

function measure(): Map<string, number> {
  const map = parseLinkMap(MAP);
  const entries = attribute(map, parseLineTable(LINES), LIBRARIES, new Set(["program.o", "typed.o"]), "/work/app", bundleRegions(BUNDLE, "/work/app"));
  return new Map(entries.map((e: SizeEntry) => [`${e.group} / ${e.name}`, Math.round(e.bytes)]));
}

describe("size report", () => {
  it("reads the link map's objects, sections and live symbols", () => {
    const map = parseLinkMap(MAP);
    expect(map.objects[3]).toBe("/cache/jsrt-c6515c15546c4a2b/libjsrt.a(1.o)");
    expect(map.sections.map((s) => s.name)).toEqual(["__TEXT,__text", "__TEXT,__cstring", "__DATA,__bss"]);
    expect(map.symbols.map((s) => s.name)).not.toContain("_jsf_unused");
    expect(map.symbols[0]).toEqual({ address: 0x100000000, size: 0x100, object: 1, name: "_js_script" });
  });

  it("reads the line table's ranges, each until the next row", () => {
    const ranges = parseLineTable(LINES);
    expect(ranges).toHaveLength(5);
    expect(ranges[0]).toEqual({ start: 0x100000000, end: 0x100000040, file: "/work/app/bundle.js", line: 3 });
    expect(ranges[3]!.file).toBe(join(preludeDir, "events.js"));
  });

  it("finds a bundle line's module from its region", () => {
    const regionOf = bundleRegions(BUNDLE, "/work/app");
    expect(regionOf(1)).toBeUndefined();
    expect(regionOf(3)).toBe("/work/app/src/a.js");
    expect(regionOf(6)).toBe("/work/app/node_modules/pkg/data.json");
    expect(regionOf(9)).toBeUndefined();
    expect(regionOf(12)).toBe(join(preludeDir, "events.js"));
  });

  it("measures the bundle by module, and the static files beside it", () => {
    const sizes = new Map(bundleSizes(BUNDLE, "/work/app", [import.meta.filename], "/work/app").map((e) => [`${e.group} / ${e.name}`, e.bytes]));
    expect(sizes.get("Your code / src/a.js")).toBe("const a = 1;\n".length + "//#region src/a.js\n".length);
    expect(sizes.get("npm packages / pkg")).toBe("//#region node_modules/pkg/data.json\nvar data = [1, 2, 3];\n".length);
    expect(sizes.get("Node built-ins / node:events")).toBeGreaterThan(0);
    expect([...sizes.keys()].filter((k) => k.startsWith("\"use static\""))).toHaveLength(1);
  });

  it("splits the program's code among its modules, and inlined runtime code with them", () => {
    const sizes = measure();
    /* js_script: 0x40 bytes each of src/a.js, data.json and node:events, 0x40 of an inline header */
    expect(sizes.get("Your code / src/a.js")).toBe(Math.round(0x100 / 3));
    expect(sizes.get("npm packages / pkg")).toBe(Math.round(0x100 / 3));
    expect(sizes.get("Node built-ins / node:events")).toBe(Math.round(0x100 / 3));
    expect(sizes.get("Runtime helpers (C, compiled with the program) / in the program")).toBe(0x20);
    expect(sizes.get("Runtime helpers (C, compiled with the program) / in the \"use static\" unit")).toBe(0x10);
  });

  it("names a library's member by its source, a program's data by its kind, and leaves out zero fill", () => {
    const sizes = measure();
    expect(sizes.get("libjsrt / gc.c")).toBe(0x50);
    expect(sizes.get("libboringssl / sha.cc")).toBe(0x60);
    expect(sizes.get("Linker / stubs for system libraries")).toBe(0x10);
    expect(sizes.get("Program data / C string literals")).toBe(0x20);
    expect(sizes.get("Program data / string constants")).toBe(0x10);
    expect([...sizes.keys()].some((k) => k.includes("ics"))).toBe(false);
  });
});
