<!--
For a change to how JavaScript compiles to C: the frontend, lowering to IR, the IR itself, or
C emission. Reviewers judge it by the C it produces, so show that C.
-->

## Problem

<!-- Which JavaScript compiles wrong, slowly, or not at all, and what goes wrong. -->

## Proposal

<!-- How it compiles now, and why this way: what it costs (code size, speed, complexity) and what
     it buys. -->

## Example

<!-- A small program that shows the change. -->

```js

```

**Emitted C before:**

```c

```

**Emitted C after:**

```c

```

<!-- The IR too, when it changed (`visaljs build --dump-ir`). The C comes from
     `visaljs build --emit-c <dir>`; trim it to the lines that matter. -->

## Semantics

<!-- The spec sections it follows (§…), and the cases at the edges: exceptions, getters and
     setters, proxies, sloppy mode, generators and async functions. What still differs from the
     spec or from Node, and why. -->

## Tests

<!-- Programs in tests/programs, golden files in compiler/test/golden, the test262 directories
     that cover it, and what newly passes. -->

## Size and speed

<!-- Hello world's and an app's binary sizes, main vs this branch (stripped). Benchmarks, when
     speed is the point. -->

## Checklist

- [ ] The example's output matches Node's
- [ ] Golden files updated (`UPDATE_GOLDEN=1`), and their diff reviewed
- [ ] test262 run locally on the directories it touches (`node tests/runner/main.ts --failures <dirs>`)
- [ ] `npm run lint` and `npm run typecheck` pass
