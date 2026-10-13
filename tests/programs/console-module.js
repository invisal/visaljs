// node:console: Console on streams of its own (groups, counts, timers, table, assert, dir), its
// bound methods, and the module's global console.
import consoleModule, { Console, log as moduleLog } from "node:console";
import { Writable } from "node:stream";

function capture() {
  let text = "";
  const stream = new Writable({
    write(chunk, encoding, cb) {
      text += chunk;
      cb();
    },
  });
  stream.text = () => text;
  return stream;
}

const out = capture();
const err = capture();
const c = new Console({ stdout: out, stderr: err });
c.log("hello %s, %d", "world", 42, { a: [1, 2] });
c.info("info");
c.debug("debug");
c.warn("warn");
c.error(new Error("boom").message);
c.group("group A");
c.log("inside\nwith two lines");
c.groupCollapsed();
c.log("deeper");
c.groupEnd();
c.groupEnd();
c.log("outside");
c.count();
c.count("x");
c.count();
c.countReset("x");
c.count("x");
c.assert(true, "never");
c.assert(false, "failed %s", "here");
c.assert(false, { not: "a string" });
c.dir({ deep: { deeper: { deepest: { gone: 1 } } } }, { depth: 0 });
c.trace("tracing");
c.table([{ a: 1, b: "x" }, { a: 2, c: true }]);
c.table([[1, 2], [3, 4]]);
c.table({ r1: { v: 1 }, r2: 2 }, ["v"]);
c.table(new Map([["k", 1], ["日本", { o: 1 }]]));
c.table(new Set(["s"]));
c.table("not tabular");
c.time("t");
c.timeLog("t", "extra");
c.timeEnd("t");
const { log } = c;
log("bound log");
print("stdout:\n" + out.text().replace(/\d+(\.\d+)?ms/g, "Nms"));
/* Node's trace adds the stack's frames: a compiled program has none */
print("stderr:\n" + err.text().split("\n").filter((line) => !line.startsWith("    at ")).join("\n"));

const two = Console(out);  /* callable without new; stderr is stdout */
two.error("to stdout");
print("one stream: " + JSON.stringify(out.text().split("\n").at(-2)));
const indented = new Console({ stdout: out, groupIndentation: 4 });
indented.group();
indented.log("four");
print("indentation: " + JSON.stringify(out.text().split("\n").at(-2)));

print("instanceof: " + (c instanceof Console) + " " + (consoleModule instanceof Console) + " " + (consoleModule === globalThis.console));
print("module log: " + (moduleLog === console.log) + " " + typeof consoleModule.Console + " " + typeof consoleModule.createTask + " " + consoleModule.createTask("t").run(() => "ran"));
for (const bad of [{}, { stdout: {} }, { stdout: out, groupIndentation: -1 }, { stdout: out, colorMode: "maybe" }]) {
  try {
    new Console(bad);
  } catch (e) {
    print("bad options: " + e.code);
  }
}
