# visaljs

An ahead-of-time JavaScript compiler. visaljs compiles a JavaScript program and its npm
dependencies to C, then to one native executable. It has no interpreter and no JIT: the binary
holds the compiled program and a small runtime written in C.

```sh
npm install -g visaljs
visaljs build app.js -o app
./app
```

A bare `node:http` server compiles to a 1.9 MB binary, and an Express 5 app to 6.6 MB. As a
Node single executable application, each is about 125 MB.

> **Status:** early and under active development (0.0.x). Real programs on Express, Hono, React,
> Zod and the TypeScript compiler build and run, but expect gaps. Please report what breaks.

## How it works

visaljs turns your JavaScript into C, then compiles it into a native binary. A function like this:

```js
function add(a, b) {
  return a + b;
}
```

becomes this C:

```c
JSValue add(JSContext *ctx, JSValue a, JSValue b) {
    JS_CHECK_STACK(ctx);
    JSValue r = js_add(ctx, a, b);
    if (js_is_exception(r)) return JS_EXCEPTION;
    return r;
}
```

## What it supports

- **The language.** visaljs follows ECMAScript and is measured against
  [test262](https://github.com/tc39/test262) on every change. Every language feature is in scope,
  except the ones listed below.
- **Node's APIs.** visaljs implements the `node:` modules (`fs`, `http`, `net`, `crypto`, `zlib`,
  `stream`, `child_process` and the others) and checks them with Node's own tests.
  [`node/compat.json`](node/compat.json) lists, per module, what is implemented.
- **npm packages.** Programs bundle their `node_modules` as Node would resolve them.
  [`tests/apps`](tests/apps) has real apps that compile unchanged.

Not supported:

| Feature | Why |
|---|---|
| Runtime `eval` and `new Function` | There's no compiler inside the binary. |
| Proper tail calls | Deep tail recursion throws `RangeError`, as in V8. |
| Stack frames in `error.stack` | It holds only the `Name: message` line. |

## Requirements

- Node 22 or later, to run the compiler.
- A C compiler: `cc`, `gcc` or `clang`. Linux and macOS are supported. On Windows, use a
  clang-family compiler: [Zig](https://ziglang.org/) or LLVM-MinGW (MSVC isn't supported yet).

See [`cli/README.md`](cli/README.md) for the command's options.

## Repository layout

| Path | What |
|---|---|
| [`cli/`](cli) | The `visaljs` command: bundling, compiling, invoking the C compiler |
| [`compiler/`](compiler) | JavaScript to IR, and IR to C |
| [`ir/`](ir) | The intermediate representation |
| [`optimizer/`](optimizer) | Passes over the IR |
| [`runtime/`](runtime) | The C runtime: values, GC, built-ins |
| [`node/`](node) | Node's APIs: the `node:` modules and the event loop |
| [`tests/`](tests) | Program tests, test262 and Node's test runners, apps |
| [`bench/`](bench) | Benchmarks against Node and Bun |
| [`web/`](web) | The website and guide |

## Development

```sh
git clone --recurse-submodules https://github.com/invisal/visaljs.git
cd visaljs
npm install
npm test               # the compiler's tests, then the runtime's (needs CMake)
npm run lint
npm run typecheck
```

To run part of test262, select tests by path prefix:

```sh
node tests/runner/main.ts --failures built-ins/Array language/statements/class
```

The full suite takes about 25 minutes. CI runs it on every pull request.

[`bench/README.md`](bench/README.md) explains how to run the benchmarks.

## Contributing

visaljs doesn't accept pull requests yet; bug reports are welcome:
[`CONTRIBUTING.md`](CONTRIBUTING.md). Report security vulnerabilities privately:
[`SECURITY.md`](SECURITY.md).

## License

visaljs is licensed under the [MIT License](LICENSE).

It includes third-party code under its own licenses: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
lists each project and where its license file is. A program visaljs builds contains some of that
code. If you distribute one, ship the notices `visaljs licenses` prints with it.
