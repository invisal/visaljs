# visaljs

An ahead-of-time JavaScript compiler: JavaScript → IR → C → a native binary.

- test262 takes ~25 minutes: run only the directories a change touches
  (`node tests/runner/main.ts --failures built-ins/Array`); CI runs the full suite.
- CI commits the test262 snapshot (`tests/test262.results`) to the pull request's branch:
  `git pull` before pushing again. A test that passed by accident and now fails needs
  `--accept-regressions`, run on the full suite.
- Pull requests use the template for their kind of change:
  `gh pr create --template <name>.md` (`.github/PULL_REQUEST_TEMPLATE/`).
