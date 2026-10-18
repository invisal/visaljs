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

## Comments

Comment only what the code can't say, in a line or two:

- why it's done this way, when the obvious way is wrong;
- a constraint from outside the code: Node's or a package's behavior, a platform quirk, a
  measured cost;
- an invariant a change could break;
- the contract of a public export (a file a `package.json` `exports` names) or of an interface
  other modules implement (the hooks in `cli/src/pipeline/types.ts`).

No comments that label or narrate the lines below them, repeat a function's name and types, or
tell history ("used to…", "now…"). When code needs a comment to be followed, change the code
instead: a better name, a named constant, a smaller function. Keep license and attribution
headers and directives (`eslint-disable`, `@ts-expect-error`, `/* fallthrough */`).
