import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  /* bench/kernels/awfy/src/ and bench/kernels/benchmarks-game/: other projects' benchmarks, unchanged; tests/nodejs/test/parallel/, fixtures/ and common/dns.js: Node's tests, unchanged (dns.js names Node's lint rules) */
  { ignores: ["**/dist/", "**/.next/", "**/.astro/", "build/", "tests/test262/", "node_modules/", "compiler/test/golden/", "tests/programs/*.js", "tests/programs/win32/", "tests/programs/bundle/", "tests/differential/*.js", "tests/differential/app/", "tests/apps/typescript/sample/", "bench/kernels/awfy/src/", "bench/kernels/benchmarks-game/", "tests/nodejs/test/parallel/", "tests/nodejs/test/fixtures/", "tests/nodejs/test/common/dns.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    /* the host prelude runs on visaljs's runtime: its globals, and URL checked with typeof */
    files: ["node/prelude/**/*.js"],
    languageOptions: {
      globals: { queueMicrotask: "readonly", URL: "readonly", process: "readonly", Buffer: "readonly", TextDecoder: "readonly", ReadableStream: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setImmediate: "readonly", AbortController: "readonly", SharedArrayBuffer: "readonly", DOMException: "readonly", Headers: "readonly", Request: "readonly", Response: "readonly", WritableStream: "readonly", TransformStream: "readonly", File: "readonly", Blob: "readonly", TextEncoder: "readonly", URLSearchParams: "readonly" },
    },
  },
  {
    /* the apps are Node programs (they run under node too) */
    files: ["tests/apps/**/*.js"],
    languageOptions: { globals: { console: "readonly", process: "readonly", TextEncoder: "readonly", ReadableStream: "readonly", Request: "readonly", Response: "readonly", URL: "readonly" } },
  },
  {
    /* the benchmark kernels and GC benchmarks print their result; buffers.js makes Buffers */
    files: ["bench/kernels/**/*.js", "bench/gc/**/*.js"],
    languageOptions: { globals: { console: "readonly", Buffer: "readonly" } },
  },
  {
    /* the GC server benchmark's server, run by visaljs and Node */
    files: ["bench/gc-server/**/*.js"],
    languageOptions: { globals: { Buffer: "readonly", process: "readonly" } },
  },
  {
    /* the GC scaling benchmarks: their size in process.env.SIZE */
    files: ["bench/gc-scaling/**/*.js"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    /* CommonJS: the Express apps, and the test of require() from CommonJS */
    files: ["tests/apps/express/**/*.js", "tests/apps/express-postgres/**/*.js", "bench/kernels/awfy/*.js", "tests/nodejs/test/common/*.js", "**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly", module: "writable", __dirname: "readonly", Buffer: "readonly", console: "readonly", process: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    /* Node's lib/internal/streams, ported close to its source: Node's own style */
    files: ["node/prelude/internal/streams/**/*.js"],
    languageOptions: { globals: { console: "readonly", AbortSignal: "readonly" } },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_|^unused$" }],
      "no-useless-assignment": "off",
    },
  },
);
