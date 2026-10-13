// node:stream: Readable (flowing, paused, read()), Writable (backpressure, finish), Transform,
// PassThrough, pipe, pipeline, finished, Readable.from, async iteration, and the web conversions.
import { Duplex, finished, PassThrough, pipeline, Readable, Stream, Transform, Writable } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";

const log = (...a) => console.log(...a);

/* a Readable in flowing mode, and its events in order */
await new Promise((resolve) => {
  const chunks = ["a", "b", "c"];
  const r = new Readable({
    read() {
      this.push(chunks.length ? chunks.shift() : null);
    },
  });
  r.on("data", (d) => log("data", d, Buffer.isBuffer(d)));
  r.on("end", () => log("end", r.readableEnded));
  r.on("close", () => {
    log("close", r.destroyed);
    resolve();
  });
});

/* setEncoding, paused mode with 'readable' and read() */
await new Promise((resolve) => {
  const r = new Readable({ read() {} });
  r.setEncoding("utf8");
  r.push("hé");
  r.push("llo");
  r.push(null);
  r.on("readable", () => {
    let chunk;
    while ((chunk = r.read()) !== null) log("read", JSON.stringify(chunk), r.readableEncoding);
  });
  r.on("end", resolve);
});

/* object mode, Readable.from, async iteration */
const items = [];
for await (const item of Readable.from([1, { two: 2 }, "three"])) items.push(item);
log(items);
const bufs = [];
for await (const b of Readable.from(["x", "y"], { objectMode: false })) bufs.push(b.toString());
log(bufs);

/* a Writable with backpressure: write's result, 'drain', 'finish', end's callback */
await new Promise((resolve) => {
  const seen = [];
  const w = new Writable({
    highWaterMark: 4,
    write(chunk, encoding, cb) {
      seen.push(chunk.toString());
      setTimeout(cb, 1);
    },
  });
  log("write 1", w.write("ab"), "write 2", w.write("cdef"), w.writableLength, w.writableNeedDrain);
  w.once("drain", () => {
    log("drain", seen);
    w.end("!", () => log("end callback", seen, w.writableFinished));
  });
  w.on("finish", () => log("finish"));
  w.on("close", resolve);
});

/* write after end */
await new Promise((resolve) => {
  const w = new Writable({ write(c, e, cb) { cb(); } });
  w.on("error", (e) => {
    log("error", e.code, e.message);
    resolve();
  });
  w.end();
  w.write("late");
});

/* Transform and PassThrough through pipe */
await new Promise((resolve) => {
  const upper = new Transform({
    transform(chunk, enc, cb) {
      cb(null, chunk.toString().toUpperCase());
    },
    flush(cb) {
      this.push("[flushed]");
      cb();
    },
  });
  let out = "";
  const sink = new Writable({
    write(chunk, enc, cb) {
      out += chunk;
      cb();
    },
  });
  sink.on("finish", () => {
    log("piped", out);
    resolve();
  });
  Readable.from(["one ", "two"]).pipe(upper).pipe(new PassThrough()).pipe(sink);
});

/* pipeline (callback and promise), finished, errors */
await new Promise((resolve) => {
  let out = "";
  pipeline(
    Readable.from(["p", "i", "p", "e"]),
    new Transform({ transform: (c, e, cb) => cb(null, c + "-") }),
    new Writable({ write: (c, e, cb) => { out += c; cb(); } }),
    (err) => {
      log("pipeline done", err, out);
      resolve();
    },
  );
});
await new Promise((resolve) => {
  pipeline(
    new Readable({ read() { this.destroy(new Error("source failed")); } }),
    new PassThrough(),
    (err) => {
      log("pipeline error", err.message);
      resolve();
    },
  );
});
let promised = "";
await pipelinePromise(Readable.from(["a", "b"]), new Writable({ write: (c, e, cb) => { promised += c; cb(); } }));
log("pipeline promise", promised);
await new Promise((resolve) => {
  const r = Readable.from(["f"]);
  finished(r, (err) => {
    log("finished", err);
    resolve();
  });
  r.resume();
});
await new Promise((resolve) => {
  const r = new Readable({ read() {} });
  finished(r, (err) => {
    log("finished early", err.code);
    resolve();
  });
  r.destroy();
});

/* destroy with an error */
await new Promise((resolve) => {
  const r = new Readable({ read() {} });
  r.on("error", (e) => log("destroyed with", e.message, r.destroyed, r.errored === e));
  r.on("close", resolve);
  r.destroy(new Error("bye"));
});

/* Duplex */
await new Promise((resolve) => {
  const d = new Duplex({
    read() {
      this.push("from duplex");
      this.push(null);
    },
    write(chunk, enc, cb) {
      log("duplex got", chunk.toString());
      cb();
    },
  });
  d.on("data", (c) => log("duplex data", c.toString()));
  d.on("finish", () => log("duplex finish"));
  d.on("end", () => log("duplex end"));
  d.on("close", resolve);
  d.end("to duplex");
});

/* web streams */
const web = Readable.toWeb(Readable.from([Buffer.from("w1"), Buffer.from("w2")], { objectMode: false }));
const parts = [];
for await (const chunk of web) parts.push(Buffer.from(chunk).toString());
log("toWeb", parts);
const fromWeb = Readable.fromWeb(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("fw")); c.close(); } }));
const got = [];
for await (const chunk of fromWeb) got.push(Buffer.from(chunk).toString());
log("fromWeb", got);

log(new Readable() instanceof Stream, new Writable() instanceof Stream, new Duplex() instanceof Writable, typeof Stream.promises.pipeline);
