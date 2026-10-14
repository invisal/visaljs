# visaljs

An ahead-of-time JavaScript to C compiler: `visaljs build` turns a JavaScript program (ES modules,
CommonJS, `node_modules`) into a native binary.

```sh
npm install -g visaljs
visaljs build app.js -o app
./app
```

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
usage: visaljs build <entry.js> [options]

options:
  -o <file>          output binary
  --emit-c <dir>     stop after C emission
  --dump-ast         print the syntax tree and stop
  --dump-ir          print the IR and stop
  --debug            build without optimization (-O0), keeping symbols and debug info
  -j, --jobs <n>     compile at most n C files at once (default: one per processor, memory permitting)
  --embed-source     embed the source text: Function.prototype.toString returns it
  --all-builtins     install every built-in, not only those the program names
  --all-features     link every optional part of the Node modules (node:stream's pipeline,
                     FormData, Brotli…), not only those the program's code names
  --node-env <name>  the value of process.env.NODE_ENV, fixed at build time (default: production);
                     empty: read from the environment at run time
  --no-bundle        skip the bundler: the input is one ES module (a bundle)
  --script           compile as a classic script (sloppy mode, no bundler)
  -q, --quiet        don't report each step of the build
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
