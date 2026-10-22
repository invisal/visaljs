// End-to-end tests: each tests/programs/*.js is compiled to a
// native binary with visaljs, run, and its stdout compared with the output
// Node produced (<name>.expected, from gen_expected.mjs).
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "visaljs";
import { findCompiler } from "visaljs/cc";

const DIR = import.meta.dirname;
const OUT = mkdtempSync(join(tmpdir(), "visaljs-e2e-"));

async function build(source: string, name: string, extra: string[] = []): Promise<{ code: number; stderr: string; binary: string }> {
  const binary = join(OUT, name) + (process.platform === "win32" ? ".exe" : "");
  let stderr = "";
  const code = await main(["build", source, "-o", binary, ...extra], { stdout: () => {}, stderr: (t) => (stderr += t) });
  return { code, stderr, binary };
}

/* Programs whose expected output is Linux Node's, and why they don't run on another OS yet. Node
 * there prints other things for some (path.win32, errno numbers, absolute paths in fs errors); some
 * have timer margins a busy CI machine misses; the rest need work here. */
const NOT_ON: Partial<Record<NodeJS.Platform, Record<string, string>>> = {
  darwin: {
    "event-loop.js": "timer margins (a 25 ms interval against 60 and 70 ms sleeps) that GitHub's macOS VMs miss",
    "set-immediate.js": "the 1 ms timer's callback and the 5 ms timer fall due in one pass on a slow macOS VM",
    "net-more.js": "the client's connect is reported before the server's connection (Linux: the other way round)",
    "tls.js": "a reset reaches a read as ECONNRESET, without the end Linux gives first",
  },
  win32: {
    "host-modules.js": "node:path is POSIX-only (Node's is path.win32 there)",
    "process-signals.js": "SIGUSR1 and SIGUSR2: Windows has neither",
    "child-process.js": "it runs sh, cat, tr, sleep and head",
    "worker-threads-constants.js": "Linux's fs.constants",
    "fs-calls.js": "symlinks, POSIX modes and process.getuid",
    "import-meta.js": "the program looks for / in import.meta.dirname",
    "net-more.js": "Unix domain sockets: Windows has named pipes (\\\\.\\pipe\\…)",
    "date.js": "TZ=Europe/Lisbon: the C library on Windows knows no IANA time zones",
    "event-loop.js": "timer margins finer than Windows' 15.6 ms clock tick",
    "set-immediate.js": "1 ms and 5 ms timers fall due in one tick on Windows (Node's output differs too)",
    "tls.js": "a reset reaches a read as ECONNRESET, without the end POSIX gives first",
  },
};
const notHere = NOT_ON[process.platform] ?? {};

/* VISALJS_PROGRAMS_SHARD=i/n (CI's shards): every n-th program from the i-th, and the other
 * tests only in shard 1. */
const [SHARD, SHARDS] = (process.env.VISALJS_PROGRAMS_SHARD ?? "1/1").split("/").map(Number) as [number, number];
const inShard = (_: unknown, k: number) => k % SHARDS === SHARD - 1;
const FIRST = SHARD === 1;

/** Builds tests/programs/<file> as `name`, runs it and compares what it prints with Node's. */
async function check(file: string, name: string) {
  /* a first line `// visaljs-flags: --a --b` passes build flags */
  const flags = /^\/\/ visaljs-flags: (.*)$/m.exec(readFileSync(join(DIR, file), "utf8").split("\n")[0]!)?.[1]!.split(" ") ?? [];
  const { code, stderr, binary } = await build(join(DIR, file), name, flags);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  /* in an empty directory: programs may write files (host-modules.js); in a fixed time zone */
  const run = spawnSync(binary, [], { encoding: "utf8", cwd: mkdtempSync(join(OUT, "cwd-")), env: { ...process.env, TZ: "Europe/Lisbon" } });
  const stderrFile = join(DIR, file.replace(/\.js$/, ".stderr"));  /* console.error output, from Node */
  /* a warning names the process: (node:1234) */
  const pid = (text: string) => text.replace(/^\(node:\d+\)/gm, "(node:PID)");
  expect(pid(run.stderr)).toBe(existsSync(stderrFile) ? pid(readFileSync(stderrFile, "utf8")) : "");
  expect(run.status).toBe(0);
  expect(run.stdout).toBe(readFileSync(join(DIR, file.replace(/\.js$/, ".expected")), "utf8"));
}

describe("programs (compiled vs Node)", () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".js")).filter(inShard)) {
    it.skipIf(file in notHere)(file, () => check(file, file.replace(/\.js$/, "")), 180000);  /* the node:tls and node:crypto programs compile ~77k lines of C: ~50 s on CI's slower runners */
  }
});

/* tests/<platform>/ (process.platform's name): programs only that OS runs, as Windows' paths, and
 * their output Node's there */
const PLATFORM = join(DIR, process.platform);
describe.runIf(FIRST && existsSync(PLATFORM))(`programs on ${process.platform} (compiled vs Node)`, () => {
  for (const file of existsSync(PLATFORM) ? readdirSync(PLATFORM).filter((f) => f.endsWith(".js")) : []) {
    it(file, () => check(join(process.platform, file), `${process.platform}-${file.replace(/\.js$/, "")}`), 180000);
  }
});

/* in C files of about 50 IR instructions, most functions have one of their own, so
 * direct calls, closures, generators, literals and caches cross files */
describe.runIf(FIRST)("programs split into C files", () => {
  async function split<T>(run: () => Promise<T>): Promise<T> {
    process.env.VISALJS_PART_SIZE = "50";
    try {
      return await run();
    } finally {
      delete process.env.VISALJS_PART_SIZE;
    }
  }

  it("emits program.c and the functions' files", async () => {
    const dir = join(OUT, "split-c");
    const code = await split(() => main(["build", join(DIR, "closures.js"), "--emit", "c", "-o", dir], { stdout: () => {}, stderr: () => {} }));
    expect(code).toBe(0);
    const files = readdirSync(dir);
    expect(files).toEqual(expect.arrayContaining(["program.c", "program_1.c", "program_2.c"]));
  }, 60000);

  for (const file of ["classes.js", "closures.js", "generators.js", "async-generators.js", "bigint.js", "regexp.js", "templates.js", "tostring.js"])
    it(file, () => split(() => check(file, `${file.replace(/\.js$/, "")}-split`)), 180000);
});

describe.runIf(FIRST)("uncaught errors", () => {
  it("print the error to stderr and exit with status 1", async () => {
    const src = join(OUT, "uncaught.js");
    writeFileSync(src, 'print("before");\nfunction f() { throw "boom"; }\nf();\nprint("never");\n');
    const { code, binary } = await build(src, "uncaught");
    expect(code).toBe(0);
    const run = spawnSync(binary, [], { encoding: "utf8" });
    expect(run.stdout).toBe("before\n");
    expect(run.stderr).toBe("Uncaught boom\n");
    expect(run.status).toBe(1);
  }, 60000);
});

describe.runIf(FIRST)("unhandled rejections and microtask errors", () => {
  async function run(name: string, source: string) {
    const src = join(OUT, `${name}.js`);
    writeFileSync(src, source);
    const { code, binary } = await build(src, name);
    expect(code).toBe(0);
    return spawnSync(binary, [], { encoding: "utf8" });
  }

  it("a rejection still unhandled after the checkpoint ends the program with status 1", async () => {
    const r = await run("unhandled", 'Promise.reject(new Error("boom"));\n' +
      'var late = Promise.reject(1); Promise.resolve().then(function () { late.catch(function () { print("handled in time"); }); });\n' +
      'Promise.resolve().then(function () { print("microtasks run first"); });\n');
    expect(r.stdout).toBe("microtasks run first\nhandled in time\n");
    expect(r.stderr).toBe("Uncaught (in promise) Error: boom\n");
    expect(r.status).toBe(1);
  }, 60000);

  it("an error thrown by a timer callback is uncaught: later timers never run", async () => {
    const r = await run("timer-throws", 'setTimeout(function () { print("first"); throw new RangeError("late"); }, 1);\n' +
      'setTimeout(function () { print("never"); }, 5);\n');
    expect(r.stdout).toBe("first\n");
    expect(r.stderr).toBe("Uncaught RangeError: late\n");
    expect(r.status).toBe(1);
  }, 60000);

  it("an error thrown by a queueMicrotask callback is uncaught", async () => {
    const r = await run("microtask-throws", 'queueMicrotask(function () { throw new TypeError("bad"); });\n' +
      'queueMicrotask(function () { print("never"); });\nprint("sync");\n');
    expect(r.stdout).toBe("sync\n");
    expect(r.stderr).toBe("Uncaught TypeError: bad\n");
    expect(r.status).toBe(1);
  }, 60000);

  it("an event listener's error doesn't stop the dispatch, and is uncaught after it", async () => {
    const r = await run("listener-throws", 'const t = new EventTarget();\n' +
      't.addEventListener("x", () => { throw new Error("boom"); });\nt.addEventListener("x", () => print("second"));\n' +
      'print(t.dispatchEvent(new Event("x")));\nprint("after");\n');
    expect(r.stdout).toBe("second\ntrue\nafter\n");
    expect(r.stderr).toBe("Uncaught Error: boom\n");
    expect(r.status).toBe(1);
  }, 60000);
});

describe.runIf(FIRST)("process", () => {
  /* stdin: a string piped in, or a file's descriptor */
  async function run(name: string, source: string, args: string[] = [], env: Record<string, string> = {}, stdin?: string | number) {
    const src = join(OUT, `${name}.js`);
    writeFileSync(src, source);
    const { code, stderr, binary } = await build(src, name);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const io = typeof stdin === "number" ? { stdio: [stdin, "pipe", "pipe"] as const } : { input: stdin };
    return spawnSync(binary, args, { encoding: "utf8", env: { ...process.env, ...env }, ...io });
  }

  it("exits with process.exitCode, and process.exit() ends the program at once, output flushed", async () => {
    expect((await run("exitcode", 'process.exitCode = 3;\nconsole.log("done");\n')).status).toBe(3);
    const r = await run("exit", 'console.log("before");\nsetTimeout(() => console.log("never"), 0);\nprocess.exit(5);\nconsole.log("never");\n');
    expect(r.stdout).toBe("before\n");
    expect(r.status).toBe(5);
    expect((await run("exit-default", 'process.exitCode = 4;\nprocess.exit();\n')).status).toBe(4);
  }, 60000);

  it("emits 'exit' however the program ends, with the status it ends with", async () => {
    const onExit = 'process.on("exit", (code) => console.log("exit", code, process.exitCode));\n';
    let r = await run("exit-uncaught", onExit + 'throw new Error("boom");\n');
    expect([r.stdout, r.stderr, r.status]).toEqual(["exit 1 1\n", "Uncaught Error: boom\n", 1]);
    r = await run("exit-rejection", onExit + 'Promise.reject(new Error("no"));\n');
    expect([r.stdout, r.stderr, r.status]).toEqual(["exit 1 1\n", "Uncaught (in promise) Error: no\n", 1]);
    /* process.exit() from a listener ends the program at once, with its status */
    r = await run("exit-in-exit", 'process.on("exit", (c) => { console.log("exit", c); process.exit(6); });\nprocess.on("exit", () => console.log("never"));\nprocess.exitCode = 2;\n');
    expect([r.stdout, r.status]).toEqual(["exit 2\n", 6]);
    /* a listener's error is uncaught: the status is 1, or what process.exit() asked for */
    r = await run("exit-throws", 'process.on("exit", () => { throw new Error("late"); });\nprocess.on("exit", () => console.log("never"));\n');
    expect([r.stdout, r.stderr, r.status]).toEqual(["", "Uncaught Error: late\n", 1]);
    r = await run("exit-throws-code", 'process.on("exit", () => { throw new Error("late"); });\nprocess.exit(4);\n');
    expect([r.stderr, r.status]).toEqual(["Uncaught Error: late\n", 4]);
    /* the listeners set the status */
    r = await run("exit-sets-code", 'process.once("beforeExit", () => { process.exitCode = 3; });\nprocess.on("exit", (c) => { console.log(c); process.exitCode = 9; });\n');
    expect([r.stdout, r.status]).toEqual(["3\n", 9]);
  }, 120000);

  it("ends the program when an 'uncaughtException' or 'unhandledRejection' listener throws", async () => {
    let r = await run("uncaught-throws", 'process.on("uncaughtException", () => { throw new Error("again"); });\nprocess.on("exit", (c) => console.log("exit", c));\nthrow new Error("first");\n');
    expect([r.stdout, r.stderr, r.status]).toEqual(["", "Uncaught Error: again\n", 7]);  /* no 'exit', as in Node */
    /* an 'unhandledRejection' listener's error goes to 'uncaughtException', else ends the program */
    const rejects = 'process.on("unhandledRejection", (reason) => { throw new Error("from " + reason); });\nPromise.reject("rejection");\n';
    r = await run("rejection-throws-caught", rejects + 'process.on("uncaughtException", (e, origin) => console.log(e.message, origin));\n');
    expect([r.stdout, r.stderr, r.status]).toEqual(["from rejection uncaughtException\n", "", 0]);
    r = await run("rejection-throws", rejects);
    expect([r.stderr, r.status]).toEqual(["Uncaught Error: from rejection\n", 1]);
  }, 120000);

  it("sees its command line and environment", async () => {
    const r = await run("argv", 'console.log(process.argv.slice(2), process.env.JSN_TEST, process.argv0.length > 0);\n', ["a", "b c"], { JSN_TEST: "x=y" });
    expect(r.stdout).toBe("[ 'a', 'b c' ] x=y true\n");
  }, 60000);

  it("times with console.time, and warns about unknown labels on stderr", async () => {
    const r = await run("timers", 'console.time();\nconsole.timeLog(undefined, "data");\nconsole.timeEnd();\nconsole.timeEnd("nope");\nconsole.time("t"); console.time("t");\n' +
      'process.emitWarning("careful", { code: "W1", type: "DeprecationWarning" });\n');
    expect(r.stdout).toMatch(/^default: \d+(\.\d+)?ms data\ndefault: \d+(\.\d+)?ms\n$/);
    expect(r.stderr).toMatch(/^\(node:\d+\) Warning: No such label 'nope' for console\.timeEnd\(\)\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n\(node:\d+\) Warning: Label 't' already exists for console\.time\(\)\n\(node:\d+\) \[W1\] DeprecationWarning: careful\n$/);
  }, 60000);

  it("reads process.stdin: piped, from a file, and empty", async () => {
    const source = 'process.stdin.setEncoding("utf8");\nlet text = "";\n' +
      'process.stdin.on("data", (d) => (text += d)).on("end", () => console.log(JSON.stringify(text), process.stdin.fd));\n';
    expect((await run("stdin-pipe", source, [], {}, "one\ntwo\n")).stdout).toBe('"one\\ntwo\\n" 0\n');
    const file = join(OUT, "stdin-input.txt");
    writeFileSync(file, "from a file\n".repeat(10000));
    const fd = openSync(file, "r");
    try {
      const r = await run("stdin-file", source.replace("JSON.stringify(text)", "text.length, text.slice(0, 12)"), [], {}, fd);
      expect(r.stdout).toBe("120000 from a file\n 0\n");
    } finally {
      closeSync(fd);
    }
    expect((await run("stdin-empty", source)).stdout).toBe('"" 0\n');
  }, 360000);  /* three programs with node:stream: ~40 s each on the faster runner, ~100 s on the slower */

  it("reads process.stdin's lines with node:readline, and exits without reading it", async () => {
    const r = await run("stdin-readline", 'import { createInterface } from "node:readline";\n' +
      'const rl = createInterface({ input: process.stdin });\nfor await (const line of rl) console.log("[" + line + "]");\nconsole.log("done");\n',
    [], {}, "a\r\nb\nlast");
    expect(r.stdout).toBe("[a]\n[b]\n[last]\ndone\n");
    /* named, not read: the program ends with its pipe still open */
    const untouched = await run("stdin-unread", 'console.log(typeof process.stdin.on);\n', [], {}, "x\n");
    expect([untouched.stdout, untouched.status]).toEqual(["function\n", 0]);
  }, 300000);  /* two programs with node:stream */

  it("runs process.finalization's callbacks at exit for the objects still alive, with Node's warning", async () => {
    const r = await run("finalization", 'const kept = { name: "kept" };\nlet gone = { name: "gone" };\n' +
      'process.finalization.register(kept, (obj, event) => console.log("finalized", obj.name, event));\n' +
      'process.finalization.registerBeforeExit(kept, (obj, event) => console.log("finalized", obj.name, event));\n' +
      'process.finalization.register(gone, () => console.log("never"));\nprocess.finalization.unregister(gone);\n' +
      'process.on("exit", () => console.log("exiting", kept.name));\n');
    expect(r.stdout).toBe("finalized kept beforeExit\nfinalized kept exit\nexiting kept\n");
    expect(r.stderr).toMatch(/^\(node:\d+\) ExperimentalWarning: process\.finalization\.register is an experimental feature and might change at any time\n/);
    expect(r.status).toBe(0);
  }, 180000);

  it("collects and gives memory back when it has waited a second with nothing to do", async () => {
    const r = await run("idle", 'let last;\nfor (let i = 0; i < 300000; i++) last = { i, s: "item " + i };\n' +
      'setTimeout(() => console.log("done", last.i), 1500);\n', [], { JS_GC_STATS: "1" });
    expect(r.stdout).toBe("done 299999\n");
    expect(r.stderr).toMatch(/"idle_collections":1\b/);
  }, 60000);
});

describe.runIf(FIRST)("optional built-ins", () => {
  /* nm: binutils', not on a Windows machine with Zig or LLVM-MinGW */
  it.skipIf(process.platform === "win32")("are linked only into programs that can reach them", async () => {
    /* the symbol table: --debug, as default builds are stripped (debug info still names what the linker dropped) */
    const symbols = (binary: string) => execFileSync("nm", [binary], { encoding: "utf8" });
    const hello = await build(join(DIR, "hello.js"), "hello-components", ["--debug"]);
    expect(symbols(hello.binary)).not.toMatch(/js_ieee754_sin|js_component_math/);  /* no Math */
    const math = await build(join(DIR, "math.js"), "math-components", ["--debug"]);
    expect(symbols(math.binary)).toMatch(/js_ieee754_sin/);
  }, 300000);  /* --debug: on a fresh machine, the first build compiles the runtime libraries without optimization */
});

describe.runIf(FIRST)("Function.prototype.toString", () => {
  it("prints [native code] for every function without --embed-source", async () => {
    const src = join(OUT, "tostring-default.js");
    writeFileSync(src, "function add(a, b) { return a + b; }\nclass K { m() {} }\n" +
      "print(add.toString());\nprint(K.toString());\nprint(new K().m.toString());\nprint(add.bind(null).toString());\n");
    const { code, binary } = await build(src, "tostring-default");
    expect(code).toBe(0);
    const run = spawnSync(binary, [], { encoding: "utf8" });
    expect(run.stdout).toBe("function add() { [native code] }\nfunction K() { [native code] }\n" +
      "function m() { [native code] }\nfunction () { [native code] }\n");
    expect(readFileSync(binary).includes("return a + b")).toBe(false);  // no source in the binary
  }, 60000);
});

describe.runIf(FIRST)("generated C", () => {
  it("compiles without warnings under -Wall -Wextra -Werror", async () => {
    const golden = join(DIR, "..", "..", "compiler", "test", "golden");
    const [cc, ...prefix] = findCompiler().split(/\s+/) as [string, ...string[]];  /* "zig cc" */
    for (const file of readdirSync(golden).filter((f) => f.endsWith(".js"))) {
      const out = join(OUT, `c-${file}`);
      let stderr = "";
      const code = await main(["build", join(golden, file), "--emit", "c", "-o", out], { stdout: () => {}, stderr: (t) => (stderr += t) });
      expect(stderr, file).toBe("");
      expect(code, file).toBe(0);
      /* to an object, not -fsyntax-only: Zig on Windows fails on that */
      execFileSync(cc, [...prefix, "-std=c11", "-Wall", "-Wextra", "-Wpedantic", "-Werror", "-c", "-o", join(out, "program.o"),
        `-I${join(DIR, "..", "..", "runtime", "include")}`, join(out, "program.c")], { stdio: "pipe" });
    }
  }, 60000);
});
