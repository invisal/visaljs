import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "ir/test/**/*.test.ts", "compiler/test/**/*.test.ts", "optimizer/test/**/*.test.ts", "cli/test/**/*.test.ts",
      "tests/runner/**/*.test.ts", "tests/programs/**/*.test.ts", "tests/differential/**/*.test.ts", "tests/compat/**/*.test.ts",
    ],
  },
});
