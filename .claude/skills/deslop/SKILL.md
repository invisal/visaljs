---
name: deslop
description: Remove slop from what a pull request touches — every comment but public-API JSDoc in the files it changes, and needless defensive code and one-use abstractions in the lines it adds. Never third-party code or tests. Use when a PR is final, before it is opened or marked ready for review (not on drafts), or when asked to deslop a branch or PR.
---

# Deslop

Clean the code this branch adds, so the PR reads as if a careful maintainer wrote it.

## Scope

The files the branch touches, against main (uncommitted changes included):

```sh
base=$(git merge-base origin/main HEAD)
git diff "$base" --name-only -- . ':!**/third_party/**' ':!**/*.gen.*' \
  ':!tests/test262/**' ':!tests/nodejs/test/parallel/**' ':!tests/nodejs/test/fixtures/**' \
  ':!tests/nodejs/test/common/dns.js' ':!bench/kernels/awfy/**' ':!bench/kernels/benchmarks-game/**'
```

- **Comments**: the whole of each touched file, existing comments included.
- **Code**: only the lines the branch adds or changes (`git diff "$base" --unified=0`).

Never edit third-party code or tests, the paths excluded above: vendored code
(`**/third_party/**`), generated `*.gen.*` files, test262, Node's copied tests and fixtures, and
other projects' benchmarks. A file ported from another project (`THIRD_PARTY_NOTICES.md` lists
them; each says so at its top) keeps its attribution header and license text.

## Comments

Remove every comment in a touched file, except:

- **JSDoc on the public API**: what a package's `exports` entry exports (`package.json`
  `exports`: `cli/src/main.ts`, `cli/src/cc.ts`, `cli/src/regexp.ts`, `compiler/src/index.ts`,
  `compiler/src/frontend/ast.ts`, `ir/src/index.ts`, `optimizer/src/index.ts`,
  `runtime/index.ts`, `runtime/components.ts`, `node/index.ts`). Keep it, and add it when a new
  public export has none. Keep it short: what it is and its parameters' meaning, no restating
  the types.
- **Directives**: `eslint-disable…`, `@ts-expect-error`, `@ts-ignore`, `/// <reference …>`,
  `#pragma`, `/* fallthrough */`.
- **License and attribution headers.**

A comment the code needs to be understood means the code should change: a better name, a named
constant, a smaller function. Make that change instead of keeping the comment.

## Code

Remove or rewrite, in the added lines:

- **Defensive code for what can't happen**: null checks on values the types or the IR already
  guarantee, `try`/`catch` around code that can't throw, fallbacks that hide a compiler bug
  instead of failing (`?? 0`, `default: return undefined`). An impossible state fails loudly.
- **One-use abstractions**: a helper, type, interface or option called from one place — inline
  it. A parameter every caller passes the same value for.
- **Noise**: unused variables, imports and parameters; `console.log`/`printf` debugging; dead
  branches; `else` after `return`; an explicit type the compiler infers; `async` with no `await`.
- **Names**: `data`, `result`, `temp`, `helper`, `handleX`, `processX`, `Manager`, `Util` —
  name what the thing is.

Match the code around the change: its naming, idiom and structure. Don't change behavior: if a
cleanup would, leave it and say so.

## Verify

```sh
npm run lint && npm run typecheck
```

When code (not only comments) changed, also run the tests for what it touches: `npm run
test:compiler`, `npm run test:runtime`, and test262 only on the affected directories
(`node tests/runner/main.ts --failures built-ins/<Dir>`).

## Report

List what changed, grouped by file, one line each, and anything left alone because changing it
would change behavior. Don't commit: the author reviews the diff first.
