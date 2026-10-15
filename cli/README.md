# visaljs

An ahead-of-time JavaScript to C compiler: `visaljs build` turns a JavaScript program (ES modules,
CommonJS, `node_modules`) into a native binary.

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
the start script aren't built into the binary: give them when you run it. A
[vinext](https://github.com/cloudflare/vinext) app is detected instead, and built with its own
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
usage: visaljs build [entry.js | project directory] [options]
       visaljs licenses   print the licenses to ship with a binary you distribute

A project (the current directory when none is given) builds its framework's production server: a
vinext app is built with its own `vite build` first, then its server is compiled. Any other
project builds the file its package.json starts: its one "bin" command, the file "scripts.start"
runs with node, or "main"; else index.js. The binary is named after the command or the project.

options:
  -o <file>          output binary
  --emit-c <dir>     stop after C emission
  --dump-ast         print the syntax tree and stop
  --dump-ir          print the IR and stop
  --debug            build without optimization (-O0), keeping symbols and debug info
  --symbols          keep symbols and debug info in the optimized build (for profilers such as perf)
  --no-optimize      skip the IR optimizer (to compare, or to rule it out)
  -j, --jobs <n>     compile at most n C files at once (default: one per processor, memory permitting)
  --embed-source     embed the source text: Function.prototype.toString returns it
  --all-builtins     install every built-in, not only those the program names
  --node-env <name>  the value of process.env.NODE_ENV, fixed at build time (default: production);
                     empty: read from the environment at run time
  --no-bundle        skip the bundler: the input is one ES module (a bundle)
  --no-framework-build  a project: compile its existing build output, without building it first
  --script           compile as a classic script (sloppy mode, no bundler)
  -q, --quiet        don't report each step of the build
  --verbose          list each place a warning is about
  --version          print the version
  --help             print this help
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
