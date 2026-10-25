# Benchmarks

How fast visaljs's binaries run, and how much memory and disk they use, measured against Node and
Bun on the same machine. Every benchmark checks its output against Node's first: a fast wrong
answer fails the run.

| Suite | Measures | Run |
|---|---|---|
| [Servers](#servers) | Real HTTP apps under load: throughput, latency, startup, memory, binary size | `npm run bench:servers` |
| [React SSR](#react-ssr) | `renderToString` of a store page with React | `npm run bench:react-ssr` |
| [Kernels](#kernels) | Small CPU-heavy programs: the speed of the generated code | `npm run bench:kernels` |
| [GC](#gc) | Allocation-heavy programs, pauses as the heap grows, and a server under load: the garbage collector | `npm run bench:gc`, `npm run bench:gc-scaling`, `npm run bench:gc-server` |
| [Size](#size) | Binary size of every app in [`tests/apps`](../tests/apps) | `npm run bench:size` |

The nightly workflow ([`nightly.yml`](../.github/workflows/nightly.yml)) runs the servers, kernels
and GC suites on our own runner (a 4-core Linux VM kept for them, one suite at a time),
and puts their tables in the run's summary. A VM still shares its host: a night's numbers can
move a few percent. Numbers compare programs on one machine; they don't carry across machines.

## Requirements

- Node 22 or later, and the repository installed (`npm install` at the root).
- A C compiler, as for any visaljs build.
- [`wrk`](https://github.com/wg/wrk) for the server benchmarks (`apt install wrk`, `brew install wrk`).
- [Bun](https://bun.sh), optionally: without it, the Bun rows are left out.

## Servers

[`servers.ts`](servers.ts) builds each HTTP app as three standalone binaries: visaljs's, Node's
[single executable application](https://nodejs.org/api/single-executable-applications.html), and
Bun's `bun build --compile`. It then measures them one after another:

- **binary size**;
- **startup**: from spawning the binary to its first HTTP response (the median of 5);
- **memory**: resident memory when idle, and its peak under load;
- **throughput and latency**: requests per second, p50 and p99, under `wrk` on each route, after
  a warmup.

| App | Routes |
|---|---|
| [`http-hello`](../tests/apps/http-hello) | A bare `node:http` server: `/` |
| [`express`](../tests/apps/express) | Express 5: `/`, `/json`, `/users/42?q=x&tag=a&tag=b` |
| [`hono`](../tests/apps/hono) | Hono on `@hono/node-server`: `/`, `/json`, `/users/42?q=x` |

```sh
npm run bench:servers                            # every app
npm run bench:servers -- express --duration=5    # one app, 5 s per route
npm run bench:servers -- hono --only=visaljs,node
npm run bench:servers -- --min-ratio=1           # exit 1 if visaljs is slower than Node on a route
npm run bench:servers -- --json=bench/servers.json  # also write the results as JSON
```

On Linux, the server and `wrk` are pinned to separate halves of the cores (`taskset`), so they
don't compete for the same CPUs. Nightly runs `express` with `--min-ratio=0.8`, so a route on which
visaljs serves under 0.8× Node's requests per second fails the job (it serves about 1.3×; the
margin is the shared runner's noise), and reports `hono` without a gate: it runs at about Node's
speed, where noise alone would fail it.

The website's front page shows [`servers.json`](servers.json): the nightly saves it as the
`servers-json` artifact, and committing that file updates the site.

## React SSR

[`react-ssr.ts`](react-ssr.ts) renders a store page of products with React's `renderToString`
([`tests/apps/react-ssr/render.js`](../tests/apps/react-ssr/render.js)), many times, in
production mode. The time is taken inside the program, so startup isn't counted. Both must
produce the same HTML.

```sh
npm run bench:react-ssr -- --products=200 --renders=200 --runs=3
```

## Kernels

A kernel is a small program that captures the hot core of some computation, such as a numeric
loop, object allocation or string building. It runs for a fraction of a second and does one
thing intensively. Kernels measure the code the compiler and [optimizer](../optimizer) generate,
without a server or a network in the way.

There are four sets. Two of them are established suites, used to compare language
implementations, and are kept unchanged from their sources:

- **[Are We Fast Yet](https://github.com/smarr/are-we-fast-yet)** (Marr, Daloze and Mössenböck,
  DLS 2016): 14 benchmarks designed to compare compilers across languages, written in the subset
  of features that every object-oriented language has: objects, classes, closures, arrays and
  strings. They are [`kernels/awfy/src/`](kernels/awfy/src), from commit `74306fe`, under the
  licences in [`kernels/awfy/LICENSE.md`](kernels/awfy/LICENSE.md). Each runs with the suite's
  own argument (its `rebench.conf`) and checks its own result. Our entry files and
  [`harness.js`](kernels/awfy/harness.js) replace the suite's harness, which prints times.
- **[The Benchmarks Game](https://benchmarksgame-team.pages.debian.net/benchmarksgame/)**: the
  single-threaded Node programs, in [`kernels/benchmarks-game/`](kernels/benchmarks-game), from
  commit `4029666`, under the [revised BSD licence](kernels/benchmarks-game/LICENSE.md). Sizes are
  smaller than the Game's own so that each runs in under a second on Node. k-nucleotide,
  regex-redux and reverse-complement read fasta's output, which the runner makes once with Node
  and gives them as stdin.
- **Ours**, [`kernels/*.js`](kernels): one language feature each.
- **`"use static"` code**, [`kernels/static/`](kernels/static): typed TypeScript kernels (sieve,
  collatz, spectral-norm, fib, an HTTP token check, nbody on classes, a vector class's small methods), each with a C reference of the same
  algorithm. Their table adds two columns: the same files built as plain TypeScript
  (`--no-static`), and the C reference built with `cc -O2`. Every build's output must equal
  Node's, so the kernels stay where C's integers and JavaScript's numbers agree.

| Kernel | Exercises |
|---|---|
| [`fib`](kernels/fib.js) | Recursive calls and number arithmetic |
| [`nbody`](kernels/nbody.js) | Floating-point math on object properties |
| [`objects`](kernels/objects.js) | Allocating small objects, property reads, method calls |
| [`sieve`](kernels/sieve.js) | Array elements indexed by a loop counter |
| [`strings`](kernels/strings.js) | String building and character codes |
| [`sum-loop`](kernels/sum-loop.js) | A numeric loop inside a function |
| [`top-level`](kernels/top-level.js) | A loop at a module's top level, on module bindings |

[`kernels.ts`](kernels.ts) builds each program with visaljs, runs the binary and Node on the
source, checks that their outputs are the same byte for byte, and prints the best wall time of
each over the runs. Wall time includes startup, which is a few milliseconds for visaljs and about
40 ms for Node. Each set gets a table, with the geometric mean of the ratios, so that each kernel
counts the same however long it runs.

A suite's [`kernels.json`](kernels/benchmarks-game/kernels.json) lists its programs, their
arguments and their input. A program that visaljs can't run yet is marked `"unsupported"` with the
reason. The table shows it, it doesn't fail the run, and the run says when it starts working.

```sh
npm run bench:kernels                          # all, best of 3
npm run bench:kernels -- awfy                  # one suite
npm run bench:kernels -- fib awfy/richards --runs=5 --json=kernels.json
```

## GC

[`gc.ts`](gc.ts) runs the allocation-heavy programs in [`gc/`](gc) the same way, and adds what
the collector reports about itself (`JS_GC_STATS=1`, `JS_GC_TRACE=1`): the number of collections,
the total, p99 and longest pause, and the share of the run spent collecting. Node's peak memory
comes from a preload, [`lib/node-rss.cjs`](lib/node-rss.cjs).

The time against Node measures the generated code as much as the collector. To see the
collector's share alone, look at the "Collecting" column, or run a binary with a nursery too large
to fill (`JS_GC_NURSERY_MB=16384`): it then never collects, and the difference is what collecting
costs, less what reusing memory saves.

| Program | Exercises |
|---|---|
| [`binary-trees`](gc/binary-trees.js) | Short-lived trees next to a long-lived one |
| [`buffers`](gc/buffers.js) | Buffers and typed arrays: memory outside the heap's cells |
| [`closures`](gc/closures.js) | Closures and their environments |
| [`maps`](gc/maps.js) | Map, Set and WeakMap churn around a live table |
| [`retained`](gc/retained.js) | A million live objects while short-lived ones come and go |
| [`strings`](gc/strings.js) | Building, joining and splitting strings |

[`gc-server.ts`](gc-server.ts) runs [`gc-server/server.js`](gc-server/server.js), which holds a
cache of 20,000 entries, through three phases: steady load, a spike of large responses, then
idle. It reports latency, peak memory, and whether memory goes back down when the server is idle.

[`gc-scaling.ts`](gc-scaling.ts) runs the programs in [`gc-scaling/`](gc-scaling) at several
sizes (`SIZE` in the environment), to show how pauses grow with what is live. A young
collection's pauses should stay flat as the size grows; a full collection's grow with the live
heap, and incremental marking splits them into slices.

| Program | Sizes | Grows |
|---|---|---|
| [`live-heap`](gc-scaling/live-heap.js) | 10, 100, 500 MB | The live heap, replaced in full while short-lived objects churn |
| [`atoms`](gc-scaling/atoms.js) | 10k, 100k, 1M | Property names: an object used as a string-keyed table |
| [`shapes`](gc-scaling/shapes.js) | 10k, 100k, 1M | Object layouts: shapes and their transitions |
| [`weakmap`](gc-scaling/weakmap.js) | 10k, 100k, 1M | Live WeakMap entries: ephemerons |

`live-heap` also runs with the collector's optional features off (`JS_GC_INCREMENTAL=0`,
`JS_GC_THREADS=0`, and both): the second table says what incremental and parallel marking buy in
pause time and cost in wall time.

```sh
npm run bench:gc -- --runs=3 --json=gc.json
npm run bench:gc-scaling -- atoms --runs=3
npm run bench:gc-server -- --duration=10
```

The nightly keeps all three as the `gc-json` artifact.

## Size

[`size.ts`](size.ts) builds every app in [`tests/apps`](../tests/apps) with visaljs, as a Node
single executable and with Bun, and writes the sizes in bytes to
[`tests/apps/sizes.json`](../tests/apps/sizes.json).

```sh
npm run bench:size                     # every app
npm run bench:size -- hono express     # only these; the other entries stay
```

## Layout

```
bench/
  servers.ts  react-ssr.ts  kernels.ts  gc.ts  gc-scaling.ts  gc-server.ts  size.ts   the suites
  kernels/  gc/  gc-scaling/  gc-server/                                          their programs
  kernels/awfy/  kernels/benchmarks-game/                            the established suites
  lib/standalone.ts     builds a program as visaljs's, Node's and Bun's standalone binary
  lib/node-rss.cjs      reports Node's peak memory at exit
```

The apps themselves live in [`tests/apps`](../tests/apps), where the HTTP differential tests use
them too.

## Adding a benchmark

- **A kernel or GC program**: a `.js` file in `kernels/` or `gc/` that prints its result. A
  comment on its first line says what it exercises. It runs unchanged under Node, which is the
  reference, and should take at least 50 ms there, so that startup doesn't dominate.
- **A program from another suite**: its files unchanged in the suite's folder, with the suite's
  licence, and an entry in its `kernels.json`.
- **A server**: an app in [`tests/apps`](../tests/apps) whose `package.json` `"main"` starts a
  server on `PORT`, and an entry in `SERVERS` in [`servers.ts`](servers.ts) with the routes to load.
