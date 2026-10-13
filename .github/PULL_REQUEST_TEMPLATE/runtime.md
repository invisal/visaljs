<!--
For the C runtime: values, objects, strings, the garbage collector, and the ECMAScript built-ins.
-->

## Problem

<!-- Which behaviour is wrong or missing, and which programs it affects. -->

## Proposal

<!-- What changes in the runtime, and why this way: its data layout, its cost in time and memory,
     and what it does at the edges. -->

## Example

```js

```

<!-- Its output under Node and under visaljs, before and after, when they differ. -->

## Spec

<!-- The ECMAScript sections it implements (§…), and where it follows V8's or Node's choices
     instead (message texts, property order, limits). -->

## Memory

<!-- New cells, roots or fields that hold values: how the collector sees them (trace functions,
     write barriers), and what it costs. Write "None" when nothing changed. -->

## Tests

<!-- Runtime unit tests (runtime/tests), programs (tests/programs), the test262 directories that
     cover it, and what newly passes. -->

## Size

<!-- Hello world's and an app's binary sizes, main vs this branch (stripped), when code that every
     program links changed. -->

## Checklist

- [ ] The example's output matches Node's
- [ ] Runtime tests pass under the sanitizers (`cmake -DJSRT_SANITIZE=ON`) and GC stress
- [ ] Every store of a value into a cell goes through the write barrier (`npm run lint` checks it)
- [ ] test262 run locally on the directories it touches
- [ ] `npm run lint` and `npm run typecheck` pass
