// Promises, async functions, timers and async iteration: the order things happen in.
const log = (...args) => console.log(...args);

const sleep = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

async function* ticker(n) {
  for (let i = 0; i < n; i++) {
    await sleep(1);
    yield i;
  }
}

async function main() {
  log("start");
  setTimeout(() => log("timeout 0"), 0);
  queueMicrotask(() => log("microtask"));
  Promise.resolve().then(() => log("then"));
  await null;
  log("after first await");

  const [a, b] = await Promise.all([sleep(5, "a"), sleep(1, "b")]);
  log("all:", a, b);
  log("race:", await Promise.race([sleep(5, "slow"), sleep(1, "fast")]));
  const settled = await Promise.allSettled([sleep(1, 1), Promise.reject(new TypeError("no"))]);
  log(settled.map((s) => s.status));

  const seen = [];
  for await (const t of ticker(3)) seen.push(t);
  log("ticks", seen);

  const p = sleep(1, "done");
  log(p);
  log(await p, p);
  try {
    await Promise.reject(new RangeError("bad"));
  } catch (e) {
    log("caught", e.name, e.message);
  }
  return "finished";
}

main().then((r) => log(r));
log("main returned a promise");
