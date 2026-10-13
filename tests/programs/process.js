// process and the rest of console: what's deterministic, compared with Node.
// Timings, PIDs and exit codes are checked in programs.test.ts.
Error.stackTraceLimit = 0;  /* console.trace prints frames in Node; visaljs records none */

console.table([{ a: 1, b: "x" }, { a: 2, c: true }]);
console.table([[1, 2], [3]]);
console.table({ r1: { c: 1, d: [1, 2, 3, 4] }, r2: { c: 2 } }, ["c", "d"]);
console.table([1, "s", { o: { deep: { er: 1 } } }]);
console.table("not tabular");
console.group("in a group");
console.table([{ x: 1 }]);
console.groupEnd();
console.trace("here %d", 1);
console.trace();

console.log(typeof process, global === globalThis, Object.keys(globalThis).indexOf("global") !== -1);
console.log(process.argv.length, typeof process.argv[0], process.argv[0] === process.execPath, typeof process.env.PATH);
console.log(process.platform === "linux" || process.platform === "darwin" || process.platform === "win32", typeof process.pid, typeof process.cwd());
const wrote = process.stdout.write("written without a newline");
process.stdout.write("\n");
console.log(wrote, process.exitCode);
for (const bad of ["x", 1.5, {}]) {
  try { process.exitCode = bad; } catch (e) { console.log(e.name, e.code, e.message); }
}
process.exitCode = "0";
console.log(process.exitCode, typeof process.exitCode);
const t = process.hrtime();
console.log(t.length, typeof t[0], typeof t[1], process.hrtime(t)[0] >= 0);
try { process.nextTick(5); } catch (e) { console.log(e.code, e.message); }
process.nextTick((a, b) => console.log("tick", a, b), 1, 2);
console.log("sync");
