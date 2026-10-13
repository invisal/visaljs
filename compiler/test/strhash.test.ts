import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HASH_INIT, jsStringHash } from "../src/emit/strhash.ts";
// @ts-expect-error: plain JS module without types
import { generate } from "../../runtime/tools/gen_atoms.mjs";

describe("jsStringHash", () => {
  it("is FNV-1a over UTF-16 code units", () => {
    expect(jsStringHash("hello")).toBe(0x4f9f2cab);
    expect(jsStringHash("")).toBe(HASH_INIT);
    expect(jsStringHash("a")).toBe(Math.imul(HASH_INIT ^ 0x61, 0x01000193) >>> 0);
  });

  it("hashes code units, not code points or bytes", () => {
    const pair = "😀";  // one emoji, two code units
    expect(jsStringHash(pair)).toBe(
      Math.imul(Math.imul(HASH_INIT ^ 0xd83d, 0x01000193) ^ 0xde00, 0x01000193) >>> 0,
    );
    expect(jsStringHash("é")).not.toBe(jsStringHash("Ã©"));  // not UTF-8 bytes
  });
});

describe("runtime/include/js_atoms.gen.h", () => {
  it("is up to date with gen_atoms.mjs", () => {
    const file = readFileSync(join(import.meta.dirname, "../../runtime/include/js_atoms.gen.h"), "utf8");
    expect(file).toBe(generate());
  });
});
