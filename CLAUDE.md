# visaljs

An ahead-of-time JavaScript compiler: JavaScript → IR → C → a native binary.

- test262 takes ~25 minutes: run only the directories a change touches
  (`node tests/runner/main.ts --failures built-ins/Array`); CI runs the full suite.
- The heavy suites (the full test262, Node's tests, the programs, cross-platform) run on CI: push
  to a draft pull request and read its checks (`gh pr checks --watch`) instead of running them
  locally. A push cancels the run for the one before, so push a batch of changes, not each one.
- CI commits the test262 snapshot (`tests/test262.results`) to the pull request's branch:
  `git pull` before pushing again. A test that passed by accident and now fails needs
  `--accept-regressions`, run on the full suite.
- Pull requests use the template for their kind of change:
  `gh pr create --template <name>.md` (`.github/PULL_REQUEST_TEMPLATE/`).
- Run `/deslop` when a pull request is final: before `gh pr create` or `gh pr ready`, not on
  drafts.
