# Third-party notices

visaljs is MIT licensed ([`LICENSE`](LICENSE)). It includes code, and data, from other projects,
each under its own license. Their license files sit with the code; this page lists them.

## In a compiled program

A binary visaljs builds holds its runtime and, of these, the parts the program uses. Their
licenses require their notices to go with copies of the code. If you distribute a binary, ship
the text `visaljs licenses` prints with it, in its documentation or a file beside it:

```sh
visaljs licenses > THIRD_PARTY_LICENSES
```

| Project | What | Version | License | License files |
|---|---|---|---|---|
| [QuickJS](https://github.com/bellard/quickjs) | Regular expressions, Unicode tables, number printing and parsing, BigInt arithmetic (`runtime/src/bigint.c`, ported) | commit `a38171d` | MIT | [`quickjs-regexp`](runtime/third_party/quickjs-regexp/LICENSE), [`quickjs-dtoa`](runtime/third_party/quickjs-dtoa/LICENSE) |
| [Unicode](https://www.unicode.org) | The Unicode Character Database's tables (in QuickJS's), CLDR's time zone names (`runtime/src/tznames.gen.h`) | as in QuickJS and Node v24.21.0 | Unicode-3.0 | [`unicode`](runtime/third_party/unicode/LICENSE) |
| [V8](https://v8.dev) | `Math`'s functions (its fdlibm port) and `Date.parse` (`runtime/src/date.c`, ported) | 12.4 (fdlibm) | BSD-3-Clause, fdlibm's notice | [`v8-ieee754`](runtime/third_party/v8-ieee754/LICENSE), [fdlibm](runtime/third_party/v8-ieee754/LICENSE.fdlibm) |
| [Ada](https://github.com/ada-url/ada) | Domain names in URLs (IDNA) | 4.0.0 | MIT | [`ada-idna`](runtime/third_party/ada-idna/LICENSE-MIT) |
| [Node.js](https://nodejs.org) | The `node:` modules ported from its `lib/` (each says so at its top), `util.inspect`, `console.table`, the zlib binding | v22.22.2 | MIT | [`runtime`](runtime/third_party/nodejs/LICENSE), [`node`](node/third_party/nodejs/LICENSE) |
| [BoringSSL](https://boringssl.googlesource.com/boringssl) | Cryptography and TLS, with fiat-crypto's field arithmetic | commit `304dad3` | Apache-2.0 | [`boringssl`](runtime/third_party/boringssl/LICENSE), [fiat](runtime/third_party/boringssl/third_party/fiat/LICENSE) |
| Mozilla's CA certificates | The root certificates TLS trusts (`runtime/src/tls_roots.gen.h`), as Node v24.21.0 bundles them | Node v24.21.0's | MPL-2.0 | [`mozilla-ca`](runtime/third_party/mozilla-ca) |
| [libuv](https://libuv.org) | The event loop and I/O | 1.51.0 | MIT, ISC, BSD-2-Clause | [`libuv`](node/third_party/libuv/LICENSE), [extra](node/third_party/libuv/LICENSE-extra) |
| [llhttp](https://github.com/nodejs/llhttp) | The HTTP parser | 9.3.0 | MIT | [`llhttp`](node/third_party/llhttp/LICENSE) |
| [zlib](https://zlib.net), Chromium's copy | Deflate and gzip | 1.3.1 | Zlib, BSD-3-Clause (Chromium's parts) | [`zlib`](node/third_party/zlib/LICENSE), [Chromium](node/third_party/zlib/LICENSE.chromium) |
| [Brotli](https://github.com/google/brotli) | Brotli compression | 1.1.0 | MIT | [`brotli`](node/third_party/brotli/LICENSE) |
| [Zstandard](https://facebook.github.io/zstd/) | zstd compression | 1.5.7 | BSD-3-Clause | [`zstd`](node/third_party/zstd/LICENSE) |
| [punycode.js](https://github.com/mathiasbynens/punycode.js) | `node:punycode` (`node/prelude/punycode.js`, ported) | 2.1.0 | MIT | [`punycode`](node/third_party/punycode/LICENSE) |
| [parseargs](https://github.com/pkgjs/parseargs) | `util.parseArgs` (`node/prelude/internal/parse_args.js`, ported) | as in Node v22.22.2 | MIT | [`parseargs`](node/third_party/parseargs/LICENSE) |
| [HdrHistogram_c](https://github.com/HdrHistogram/HdrHistogram_c) | `perf_hooks`' histograms (`node/prelude/internal/perf_histogram.js`, ported) | | CC0-1.0 or BSD-2-Clause | [`hdrhistogram`](node/third_party/hdrhistogram/LICENSE) |

The list is checked: [`cli/test/licenses.test.ts`](cli/test/licenses.test.ts) fails when a
directory of `third_party/` has no notice, or a ported file names a license file that isn't there.
Vendoring new code means adding its license file and its entry (`NOTICES` in
[`runtime/index.ts`](runtime/index.ts), `notices` in [`node/index.ts`](node/index.ts)).

The npm package carries the same text as `THIRD_PARTY_LICENSES`.

## In the repository only

These are tests and benchmarks; none of them is in the npm package or in a compiled program.

| Project | What | License | Where |
|---|---|---|---|
| [Node.js](https://nodejs.org)'s tests | Node's `test/parallel` tests and their fixtures, copied unchanged | MIT | [`tests/nodejs`](tests/nodejs/LICENSE) |
| [test262](https://github.com/tc39/test262) | The ECMAScript conformance suite (a git submodule) | BSD-3-Clause | `tests/test262` |
| [Are We Fast Yet?](https://github.com/smarr/are-we-fast-yet) | Benchmark kernels | Each benchmark's own (its `LICENSE.md` lists them) | [`bench/kernels/awfy`](bench/kernels/awfy/LICENSE.md) |
| [The Benchmarks Game](https://benchmarksgame-team.pages.debian.net/benchmarksgame/) | Benchmark programs | BSD-3-Clause | [`bench/kernels/benchmarks-game`](bench/kernels/benchmarks-game/LICENSE.md) |
