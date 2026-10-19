// tests/static/errors/*.ts: "use static" files that must not compile, each with the message it
// fails with on its first line (`// error: <message>`, a part of the message).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_HOSTS, hostPrimitives } from "../src/hosts.ts";
import { buildTypedUnit } from "../src/static/unit.ts";

const DIR = join(import.meta.dirname, "..", "..", "tests", "static", "errors");

describe("static code that doesn't compile", () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort()) {
    it(file, () => {
      const expected = /^\/\/ error: (.*)$/m.exec(readFileSync(join(DIR, file), "utf8").split("\n")[0]!)?.[1];
      expect(expected, "the first line names the error").toBeDefined();
      expect(() => buildTypedUnit([join(DIR, file)], hostPrimitives(DEFAULT_HOSTS))).toThrow(expected!);
    }, 30000);  /* a full tsc check each: 2.5–6.5 s on a busy CI runner */
  }
});
