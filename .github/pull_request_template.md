<!--
A change of a particular kind has its own template, with the sections its reviewers need:

  codegen.md        how JavaScript compiles to C (the compiler, the IR, the emitted C)
  optimization.md   making programs faster (optimizer passes, fast paths)
  runtime.md        built-ins and the C runtime (values, GC, strings, ECMAScript built-ins)
  node-api.md       Node's API (node/: the prelude modules and their host primitives)
  framework.md      a framework's integration (cli/src/integrations)
  bugfix.md         a program that behaves differently from Node

Pick one by adding ?template=<name> to the pull request's URL, or with
`gh pr create --template <name>`. This one is for everything else: tooling, CI, docs, tests.
-->

## Problem

<!-- What is wrong or missing, and who it affects. -->

## Proposal

<!-- What this pull request changes, and why this way. -->

## Changes

<!-- The main changes, a line each. -->

-

## Tests

<!-- How it was checked: which tests, and what they show. -->

## Checklist

- [ ] Tests cover the change, and pass locally
- [ ] `npm run lint` and `npm run typecheck` pass
- [ ] Comments say what the code does and why, without pointing at notes outside the repository
- [ ] Third-party code comes with its license file and a notice (THIRD_PARTY_NOTICES.md)
