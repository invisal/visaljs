// WritableStream, TransformStream, pipeTo and pipeThrough, as Node has them: sinks, writers,
// backpressure, errors and aborts, transformers, and piping with its options.
const err = async (f) => {
  try {
    await f();
    return "no error";
  } catch (e) {
    return `${e.name}${e.code ? ` [${e.code}]` : ""}: ${e.message}`;
  }
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* a sink, and its writer */
const ws = new WritableStream({
  write(c) {
    console.log("sink", c);
  },
  close() {
    console.log("sink close");
  },
});
console.log(ws, ws.locked);
const w = ws.getWriter();
console.log(w, w.desiredSize);
await w.write("a");
await w.write("b");
await w.close();
console.log(ws, await w.closed, w.desiredSize);
console.log(await err(() => ws.getWriter()), "|", await err(() => w.write("late")));

/* backpressure: a slow sink */
let release;
const slow = new WritableStream({
  write(chunk) {
    console.log("slow write", chunk);
    return new Promise((resolve) => (release = resolve));
  },
}, { highWaterMark: 2 });
const sw = slow.getWriter();
const writes = [sw.write(1), sw.write(2), sw.write(3)];
console.log("desired", sw.desiredSize);
await tick();
release();
await tick();
release();
await tick();
release();
await Promise.all(writes);
console.log("desired after", sw.desiredSize);
sw.releaseLock();
console.log(slow.locked, await err(() => sw.closed));

/* a failing sink, aborting, the controller's error and signal */
const bad = new WritableStream({
  write() {
    throw new Error("w");
  },
});
const bw = bad.getWriter();
console.log(await err(() => bw.write(1)), "|", await err(() => bw.closed), "|", await err(() => bw.ready), bad);
const ab = new WritableStream({
  abort(reason) {
    console.log("abort", reason);
  },
});
console.log(await ab.abort("why"), ab);
const controllers = [];
const s2 = new WritableStream({
  start(c) {
    controllers.push(c);
  },
});
console.log(controllers[0], controllers[0].signal);
controllers[0].error(new TypeError("from the controller"));
console.log(s2, await err(() => s2.getWriter().write(1)));
const signalled = new WritableStream({
  start(c) {
    c.signal.addEventListener("abort", () => console.log("signal aborted:", c.signal.reason));
  },
});
await signalled.abort("stop");

/* TransformStream */
const ts = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(String(chunk).toUpperCase());
  },
  flush(controller) {
    controller.enqueue("!");
  },
});
console.log(ts);
const tw = ts.writable.getWriter();
tw.write("x");
tw.write("y");
tw.close();
for await (const v of ts.readable) console.log("t", v);
const id = new TransformStream();
const ir = id.readable.getReader();
const iw = id.writable.getWriter();
console.log(iw.desiredSize);
iw.write(1);
console.log(iw.desiredSize, await ir.read());
const terminated = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk);
    controller.terminate();
  },
});
const tr = terminated.readable.getReader();
const twr = terminated.writable.getWriter();
twr.write("only").catch(() => {});
console.log(await tr.read(), await tr.read(), await err(() => twr.closed));
const failing = new TransformStream({
  transform() {
    throw new Error("transform failed");
  },
});
const fw = failing.writable.getWriter();
const pendingRead = failing.readable.getReader().read();  /* a transform runs once the readable pulls */
console.log(await err(() => fw.write(1)), "|", await err(() => pendingRead));

/* pipeTo and pipeThrough */
const source = () => new ReadableStream({
  start(c) {
    c.enqueue("p");
    c.enqueue("q");
    c.close();
  },
});
const out = [];
await source().pipeTo(new WritableStream({
  write(c) {
    out.push(c);
  },
  close() {
    out.push("closed");
  },
}));
console.log(out);
const up = source().pipeThrough(new TransformStream({
  transform(c, k) {
    k.enqueue(c + c);
  },
}));
for await (const v of up) console.log("through", v);
console.log(await err(() => new ReadableStream({ start(c) { c.error(new Error("src")); } }).pipeTo(new WritableStream({
  abort(r) {
    console.log("dest aborted:", r.message);
  },
}))));
console.log(await err(() => source().pipeTo(new WritableStream({
  write() {
    throw new Error("dest");
  },
}))));
const kept = new WritableStream({
  close() {
    console.log("never closed");
  },
});
await source().pipeTo(kept, { preventClose: true });
console.log(kept.locked, kept);
const ac = new AbortController();
const endless = new ReadableStream({
  pull(c) {
    c.enqueue("tick");
  },
  cancel(r) {
    console.log("source canceled:", r);
  },
});
const sink = new WritableStream({
  write() {
    ac.abort("enough");
  },
});
console.log(await err(() => endless.pipeTo(sink, { signal: ac.signal })));

/* errors */
console.log(await err(() => new WritableStream(1)), "|", await err(() => new WritableStream({ write: 1 })));
console.log(await err(() => new TransformStream({ transform: 1 })), "|", await err(() => new WritableStreamDefaultController()));
console.log(await err(() => source().pipeTo({})), "|", await err(() => source().pipeThrough({})));
console.log(Object.keys(WritableStream.prototype), Object.keys(WritableStreamDefaultWriter.prototype), Object.keys(TransformStream.prototype));
