<!--
For making programs faster: an optimizer pass, a fast path in the emitted C, or a runtime
shortcut. An optimization has to stay correct for every program, not only the benchmark, and
has to be measured.
-->

## Problem

<!-- What is slow, measured: the program or benchmark, its time, and where the time goes
     (a profile: `visaljs build --symbols`, then perf). -->

## Proposal

<!-- The transformation: when it applies, what it proves first, and what it does when the proof
     fails (the guard and the generic path). -->

## Example

```js

```

**C before:**

```c

```

**C after:**

```c

```

<!-- The IR before and after too, for an optimizer pass (`--emit ir`, `--no-optimize`). -->

## Correctness

<!-- Why the fast path gives the same result as the generic one, including the cases that make it
     bail out: other types, getters, proxies, prototype changes, overflow, -0 and NaN. -->

## Results

<!-- Before and after, on the same machine, best of several runs: `npm run bench:kernels`, and
     `npm run bench:servers` when it can change a server. Binary sizes too: an optimization that
     inlines grows code. -->

| Benchmark | main | this branch | change |
|---|---|---|---|
| | | | |

## Checklist

- [ ] Tests for the fast path and for each way out of it
- [ ] The pass reports what it did (`visaljs build` prints the counts)
- [ ] Benchmarks measured before and after, with the numbers above
- [ ] test262 run locally on the directories it touches
- [ ] `npm run lint` and `npm run typecheck` pass
