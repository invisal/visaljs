# Node's own tests

Node's `test/parallel` tests, compiled by visaljs. Each test checks itself with `assert` and
passes when it exits 0, as it does under Node, so it measures behaviour, where
`node/compat.json` only counts export names.

```
tests/nodejs/
  main.ts          the runner
  sync.ts          copies tests from Node's repository
  modules.ts       which module a test is for, by its file name
  node.results     the tests that pass: one that stops passing fails CI
  node.skip        tests that can't run here, with the reason
  NODE_VERSION     the Node the copies are from (node/compat.json's)
  test/
    common/        ours: the helpers Node's tests use (Node's own needs its internals)
    fixtures/      the fixtures the copied tests name, from Node
    parallel/      Node's tests, copied unchanged
```

## Running

```sh
npm run nodejs                              # every copied test
npm run nodejs -- test-path test-events-    # the tests these file names start with
npm run nodejs -- --failures test-util-     # and why each one failed
npm run nodejs -- --update                  # record newly passing tests in node.results
npm run nodejs -- --shard=1/2               # the first of two parts (CI runs one job each)
```

Tests are compiled in batches of 20: a generated entry file, in a temporary directory, requires
the one test `VISALJS_NODEJS_TEST` names, so a batch is one build and each test still runs in its
own process with its own exit status. The tests are Node's, unchanged. A batch that doesn't build
is built again without the test the compiler names. In a batch a test isn't compiled exactly as
alone (the bundle and the preludes it reaches are the batch's), so a result that would change
`node.results`, a regression or a new pass, is confirmed with the test built alone, and the
summary lists any test whose result differs. The whole suite (147 tests) takes about 100 s on 12
cores.

Each test first runs under Node with our `test/common`. A test that fails there needs more of
`test/common` and isn't counted (`shim` in the output). A test that runs under Node and fails
compiled is visaljs's: `fail` (it exits non-zero), `build` (it doesn't compile) or `timeout`.
Tests with `// Flags:` or that load Node's internals are skipped.

## Adding a module's tests

```sh
npm run nodejs:sync -- test-zlib            # copy test/parallel/test-zlib*.js and their fixtures
npm run nodejs -- --failures test-zlib      # see where visaljs differs
```

`sync.ts` clones Node at `node/compat.json`'s version once (only `test/`, into `build/nodejs/`).
The copies are never edited: a test that needs a helper gets it in `test/common`, and one that
can never run here goes in `node.skip`. When the Node version changes, `--refresh` copies every
test again from the new one.
