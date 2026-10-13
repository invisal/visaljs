// node:stream's functions: compose, duplexPair, destroy, isDestroyed, isWritable, the default
// highWaterMarks; and node:stream/consumers.
import stream, {
  PassThrough, Readable, Transform, Writable, compose, destroy, duplexPair, getDefaultHighWaterMark, isDestroyed, isWritable,
  setDefaultHighWaterMark,
} from "node:stream";
import { arrayBuffer, blob, buffer, json, text } from "node:stream/consumers";

/* compose: writes into the first, reads from the last */
{
  const upper = new Transform({ transform: (chunk, enc, cb) => cb(null, String(chunk).toUpperCase()) });
  const exclaim = new Transform({ transform: (chunk, enc, cb) => cb(null, chunk + "!") });
  const both = compose(upper, exclaim);
  const out = [];
  both.on("data", (chunk) => out.push(String(chunk)));
  both.on("end", () => print("compose: " + out.join(" ")));
  both.write("a");
  both.write("b");
  both.end();
  await new Promise((resolve) => both.on("close", resolve));
}

/* duplexPair: each side's writes are the other's reads */
{
  const [a, b] = duplexPair();
  b.on("data", (chunk) => print("b read: " + chunk));
  a.on("data", (chunk) => print("a read: " + chunk));
  a.write("from a");
  b.write("from b");
  a.end();
  await new Promise((resolve) => b.on("end", resolve));
  print("b ended");
}

/* destroy, isDestroyed, isWritable */
{
  const w = new Writable({ write: (chunk, enc, cb) => cb() });
  print("isWritable: " + isWritable(w) + " isDestroyed: " + isDestroyed(w));
  w.end();
  print("after end: " + isWritable(w));
  const p = new PassThrough();
  p.on("error", (err) => print("destroy error: " + err.message));
  destroy(p, new Error("gone"));
  print("destroyed: " + isDestroyed(p) + " " + isWritable(p));
  print("not streams: " + isDestroyed({}) + " " + isWritable({}));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/* the default highWaterMarks */
{
  print("defaults: " + getDefaultHighWaterMark(false) + " " + getDefaultHighWaterMark(true));
  setDefaultHighWaterMark(false, 1024);
  print("new streams: " + new Readable({ read() {} }).readableHighWaterMark + " " + new PassThrough({ objectMode: true }).readableHighWaterMark);
  setDefaultHighWaterMark(false, 65536);
  try {
    setDefaultHighWaterMark(false, -1);
  } catch (err) {
    print("negative: " + err.code);
  }
  print("statics: " + [stream.compose, stream.duplexPair, stream.isDestroyed].every((f) => typeof f === "function"));
}

/* stream/consumers: any async iterable of chunks */
{
  print("text: " + (await text(Readable.from(["héllo ", Buffer.from([0xc3]), Buffer.from([0xa9, 0x21])]))));
  print("json: " + JSON.stringify(await json(Readable.from(['{"a":', "[1,2]}"]))));
  print("buffer: " + (await buffer(Readable.from([Buffer.from("ab"), Buffer.from("c")]))).toString("hex"));
  print("arrayBuffer: " + (await arrayBuffer(Readable.from([new Uint8Array([1, 2, 3])]))).byteLength);
  const b = await blob(Readable.from([Buffer.from("blob")]));
  print("blob: " + b.size + " " + (await b.text()));
  const web = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("web "));
      controller.enqueue(new TextEncoder().encode("stream"));
      controller.close();
    },
  });
  print("web: " + (await text(web)));
  async function* chunks() {
    yield "gen";
    yield "erator";
  }
  print("generator: " + (await text(chunks())));
}
