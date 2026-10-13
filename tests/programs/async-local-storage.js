// node:async_hooks' AsyncLocalStorage: a store follows its chain of async work
// through await, then(), queueMicrotask, nextTick, timers, immediates, thenables, AsyncResource,
// and node:http's and node:dns's callbacks; two chains interleaved each keep their own. Each
// chain logs to its own list, printed in order at the end, so the output doesn't hang on timing.
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { lookup } from "node:dns";
import { Agent, createServer, request } from "node:http";

const als = new AsyncLocalStorage();
const other = new AsyncLocalStorage();
const log = (...args) => console.log(...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

log("outside:", als.getStore(), other.getStore());

/* two chains at once */
const lines = { a: [], b: [] };
async function chain(tag) {
  const note = (what) => lines[tag].push(`${what}: ${als.getStore()} ${other.getStore()}`);
  note("start");
  await null;
  note("after await");
  await sleep(tag === "a" ? 6 : 1);
  note("after a timer");
  await new Promise((resolve) => {
    queueMicrotask(() => note("queueMicrotask"));
    process.nextTick(() => note("nextTick"));
    setImmediate(() => {
      note("setImmediate");
      resolve();
    });
  });
  const settled = new Promise((resolve) => setTimeout(() => resolve(als.getStore()), 2));
  await als.run(`inner-${tag}`, () => settled.then((v) => note(`then() in a nested run, resolved with ${v}`)));
  note("after the nested run");
  const interval = await new Promise((resolve) => {
    let n = 0;
    const id = setInterval(() => {
      if (++n === 2) {
        clearInterval(id);
        resolve(als.getStore());
      }
    }, 1);
  });
  note(`setInterval's second tick saw ${interval}`);
  return als.getStore();
}
const results = await Promise.all([als.run("A", () => chain("a")), als.run("B", () => other.run("O", () => chain("b")))]);
log("results:", results, "then:", als.getStore());
for (const [tag, list] of Object.entries(lines)) for (const line of list) log(`  ${tag}: ${line}`);

/* run, exit, bind, snapshot, AsyncResource, disable */
log("run returns:", als.run("R", (x, y) => `${als.getStore()} ${x} ${y}`, 1, 2));
log("exit:", als.run("X", () => als.exit(() => als.getStore())), "nested runs:", als.run("1", () => als.run("2", () => als.getStore())));
const bound = als.run("bound", () => AsyncLocalStorage.bind(() => als.getStore()));
log("bind:", bound(), als.run("elsewhere", () => bound()));
const snapshot = als.run("snapshot", () => AsyncLocalStorage.snapshot());
log("snapshot:", snapshot((x) => `${als.getStore()} ${x}`, "arg"));
const resource = als.run("resource", () => new AsyncResource("TEST"));
log("AsyncResource:", resource.runInAsyncScope(() => als.getStore()), AsyncResource.bind(() => als.getStore())());
const boundByResource = als.run("resource.bind", () => resource.bind(() => als.getStore()));
log("its bind():", boundByResource());
als.run("disabled", () => {
  als.disable();
  log("disable:", als.getStore(), "run again:", als.run("again", () => als.getStore()));
});
try {
  als.run("throws", () => {
    throw new Error("boom");
  });
} catch (e) {
  log("after a throw:", als.getStore(), e.message);
}
log("thenable:", await als.run("T", () => Promise.resolve({ then: (resolve) => resolve(als.getStore()) })));
log("async function:", await als.run("F", async () => {
  await sleep(1);
  return als.getStore();
}));

/* enterWith: for the rest of this chain, and what it queues */
await new Promise((resolve) => {
  setTimeout(() => {
    als.enterWith("entered");
    log("enterWith:", als.getStore());
    setTimeout(() => {
      log("a timer set after enterWith:", als.getStore());
      resolve();
    }, 1);
  }, 1);
});
log("back in the main chain:", als.getStore());

/* node:http: a request's handler and its response in their own contexts; two requests on one
 * kept-alive socket */
let requests = 0;
const server = als.run("server", () =>
  createServer((req, res) => {
    const seen = als.getStore();
    als.run(`handler${++requests}`, async () => {
      await sleep(2);
      req.resume();
      req.on("end", () => res.end(`${seen} ${als.getStore()}`));
    });
  }));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
const post = (tag) =>
  als.run(tag, () =>
    new Promise((resolve) => {
      request({ host: "127.0.0.1", port: server.address().port, agent, method: "POST" }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(`${tag}: handler saw ${body}; the response ${als.getStore()}`));
      }).end("x");
    }));
for (const line of await Promise.all([post("client1"), post("client2")])) log(line);
agent.destroy();
await new Promise((resolve) => server.close(resolve));

/* node:dns */
log("dns.lookup:", await als.run("dns", () => new Promise((resolve) => lookup("localhost", () => resolve(als.getStore())))));
log("end:", als.getStore());
