<!--
For a program that behaves differently compiled than under Node: wrong output, a crash, a hang,
or a build that fails.
-->

## Bug

<!-- What goes wrong, in a sentence. Link the issue, if there is one. -->

## Reproduction

```js

```

**Node:**

```

```

**visaljs (before this fix):**

```

```

## Cause

<!-- Why it happened: the code at fault and what it got wrong. -->

## Fix

<!-- What changed, and why the fix is in that place. Other code with the same mistake, and
     whether it was fixed too. -->

## Tests

<!-- The test that failed before and passes now. Programs that compare output with Node go in
     tests/programs. -->

## Checklist

- [ ] A regression test that fails without the fix
- [ ] test262 run locally on the directories it touches, when the runtime or compiler changed
- [ ] `npm run lint` and `npm run typecheck` pass
