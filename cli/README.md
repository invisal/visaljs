# visaljs

An ahead-of-time JavaScript to C compiler: `visaljs build` turns a JavaScript or TypeScript program
(ES modules, CommonJS, `node_modules`) into a native binary.

```sh
npm install -g visaljs
visaljs build app.js -o app
./app
```

In a project, `visaljs build` with no file finds the entry in `package.json`, and names the binary
after the project:

```sh
cd my-api                # package.json: "name": "my-api", "scripts": { "start": "node server.js" }
visaljs build            # 📄 Entry: server.js (package.json "scripts.start") → ./my-api
```

It takes, in order, the first of these whose file exists: the one command in `"bin"` (with several,
it asks which), the file `"scripts.start"` runs with `node`, `"main"`, and `index.js`. Arguments in
the start script aren't built into the binary: give them when you run it.

A [Next.js](https://nextjs.org) app is detected instead (`next` in its dependencies). `visaljs build`
runs `next build` (as a standalone build: `next.config` stays as it is), then compiles Next's own
production server, the one `next start` runs, with the app's routes built in. The binary serves
`.next/` and `public/` from the working directory, as `next start` does:

```sh
cd my-next-app
visaljs build            # next build, then the server → ./my-next-app
PORT=3000 ./my-next-app  # to deploy: copy my-next-app, .next/ (without .next/cache) and public/
```

It compiles Turbopack builds (`next build`'s default): tested with the App Router's static and
dynamic pages, client components and route handlers ([`tests/apps/nextjs`](../tests/apps/nextjs)).
Not tested yet: the Pages Router, middleware and `next/image`. Not supported: a webpack build
(`next build --webpack`); a static export (`output: "export"`) has no server to compile. A
[vinext](https://github.com/cloudflare/vinext) app (Next.js on Vite) is built with its own
`vite build` first.

Needs Node 22 or later and a C compiler (`cc`, `gcc` or `clang`). Linux and macOS; on Windows,
a clang-family compiler: [Zig](https://ziglang.org/) (`winget install zig.zig`) or LLVM-MinGW
(MSVC isn't supported yet).
The C runtime is built on first use and cached in `~/.cache/visaljs`. The third-party C libraries
(BoringSSL, libuv, zlib, Brotli, zstd) come prebuilt in the package for Linux (x64, arm64; glibc
and musl), macOS and Windows x64; on another platform, the first build compiles them too, which
takes a minute. `VISALJS_PREBUILT=0` builds them anyway.

`visaljs build` reports each step as it goes:

```
 ✓ 🔍 Detected GCC 13.3.0  10ms
 ✓ 📦 Rolled 6 modules into a single file (63.7 kB)  37ms
 ✓ 🌳 Parsed 1,988 lines of JavaScript  60ms
 ✓ 🧩 Compiled 1 regular expression  6ms
 ✓ 🔧 Converted 272 functions to IR and optimized them  46ms
 ✓ 📝 Emitted 21,951 lines of C code (1.2 MB)  39ms
 ✓ 📚 Runtime libraries ready (cached ⚡)  39ms
 ✓ 🔨 Compiled the binary (-O2, stripped)  6.57s

 🎉 Built srv in 6.85s: 1.2 MB, fits on a floppy disk 💾
```

```
usage: visaljs build [entry.js | entry.ts | project directory] [options]
       visaljs licenses   print the licenses to ship with a binary you distribute

A project (the current directory when none is given) builds its framework's production server: a
vinext app is built with its own `vite build` first, then its server is compiled. Any other
project builds the file its package.json starts: its one "bin" command, the file "scripts.start"
runs with node, or "main"; else index.js. The binary is named after the command or the project.

TypeScript (.ts, .mts, .cts, .tsx) is compiled too: its types are stripped, not checked (run tsc
for that), with the nearest tsconfig.json's settings (paths, decorators).

options:
  -o <file>          output binary (with --emit: what to write)
  --debug            build without optimization (-O0), keeping symbols and debug info
  --symbols          keep symbols and debug info in the optimized build (for profilers such as perf)
  --no-optimize      skip the IR optimizer (to compare, or to rule it out)
  -j, --jobs <n>     compile at most n C files at once (default: one per processor, memory permitting)
  --embed-source     embed the source text: Function.prototype.toString returns it
  --all-builtins     install every built-in, not only those the program names
  --all-features     link every optional part of the Node modules (node:stream's pipeline,
                     FormData, Brotli…), not only those the program's code names
  --node-env <name>  the value of process.env.NODE_ENV, fixed at build time (default: production);
                     empty: read from the environment at run time
  --no-bundle        skip the bundler: the input is one ES module (a bundle)
  --no-framework-build  a project: compile its existing build output, without building it first
  --script           compile as a classic script (sloppy mode, no bundler)
  -q, --quiet        don't report each step of the build
  --verbose          list each place a warning is about
  --version          print the version
  --help             print this help

inspecting the build:
  --emit <stage>     stop after a stage and write what it made:
                       bundle  the bundle (tree-shaken) and the "use static" files to the directory
                               -o names, and how much of the bundle each module and package is
                       ast     the syntax tree, to stdout or the file -o names
                       ir      the optimized IR, to stdout or the file -o names
                       c       the C files, to the directory -o names
  --report <kind>    build the binary, then report on it (repeatable):
                       size    where its bytes come from: each module, package, Node built-in and
                               runtime library (macOS for now; --verbose lists every file)
```

## Licenses

visaljs is MIT licensed. A binary it builds contains its runtime and third-party code (BoringSSL,
libuv, zlib, code ported from Node.js and others), each under its own license, and those
licenses require their notices to go with copies of the code. If you distribute a binary, ship
what `visaljs licenses` prints with it, in its documentation or a file beside it:

```sh
visaljs licenses > THIRD_PARTY_LICENSES
```

The package carries the same text as `THIRD_PARTY_LICENSES`.
