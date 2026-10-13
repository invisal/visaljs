// node:zlib's Brotli: compress and decompress, sync, with callbacks and as streams; the compressed
// bytes (Brotli 1.1.0, Node's copy) at each quality, window and mode; params, flushes, errors.
import { once } from "node:events";
import zlib from "node:zlib";

const log = (...a) => console.log(...a);
const hex = (b) => Buffer.from(b).toString("hex");
const short = (b) => (b.length > 48 ? hex(b.subarray(0, 24)) + "…" + hex(b.subarray(-24)) + " (" + b.length + ")" : hex(b));
const show = (e) => log("error", e.name, e.code, e.errno, e.message);
const closed = (s) => new Promise((resolve) => s.on("close", resolve));
const { constants } = zlib;

const words = ["<div class=\"item\">", "</div>", "<span>", "</span>", "hello", "world", "the", "quick", "brown", "fox"];
let text = "";
for (let i = 0; i < 3000; i++) text += words[(i * 7 + (i >> 2)) % words.length] + (i % 11 === 0 ? "\n" : " ");
const input = Buffer.from(text);

log("default", short(zlib.brotliCompressSync(input)), zlib.brotliDecompressSync(zlib.brotliCompressSync(input)).equals(input));
log("small", hex(zlib.brotliCompressSync("hello")), hex(zlib.brotliCompressSync("")), zlib.brotliDecompressSync(zlib.brotliCompressSync("")).length);
for (const quality of [0, 1, 4, 5, 9, 11]) {
  const z = zlib.brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } });
  log("quality", quality, short(z), zlib.brotliDecompressSync(z).equals(input));
}
log("window", short(zlib.brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_LGWIN]: 10, [constants.BROTLI_PARAM_QUALITY]: 6 } })));
log("text mode", short(zlib.brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_SIZE_HINT]: input.length } })));
log("boolean param", short(zlib.brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING]: true } })));
log("large window", short(zlib.brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_LARGE_WINDOW]: true, [constants.BROTLI_PARAM_LGWIN]: 25 } })));
log("info", zlib.brotliCompressSync("abc", { info: true }).engine.constructor.name);

/* errors */
for (const data of [Buffer.from("not brotli at all"), zlib.brotliCompressSync(input).subarray(0, 40), Buffer.from([0xff, 0xff, 0xff])]) {
  try {
    log(zlib.brotliDecompressSync(data).length);
  } catch (e) {
    show(e);
  }
}
for (const params of [{ 100: 1 }, { x: 1 }, { [constants.BROTLI_PARAM_QUALITY]: "4" }, { "-1": 1 }]) {
  try {
    zlib.brotliCompressSync("x", { params });
  } catch (e) {
    show(e);
  }
}
try {
  zlib.createBrotliCompress({ flush: 4 });
} catch (e) {
  show(e);
}

/* callbacks */
await new Promise((resolve) =>
  zlib.brotliCompress(input, (err, z) => {
    log("callback", err, short(z));
    zlib.brotliDecompress(z, (err2, back) => {
      log("callback back", err2, back.equals(input));
      resolve();
    });
  }),
);
await new Promise((resolve) =>
  zlib.brotliDecompress(Buffer.from("bad data"), (err) => {
    log("callback error", err.code, err.errno, err.message);
    resolve();
  }),
);

/* streams, and a flush that makes the output so far readable */
{
  const br = zlib.createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  const un = zlib.createBrotliDecompress();
  br.pipe(un);
  br.write("streamed ");
  await new Promise((resolve) => br.flush(resolve));
  log("flushed", (await once(un, "data"))[0].toString());
  const rest = [];
  un.on("data", (c) => rest.push(c));
  for (let i = 0; i < input.length; i += 4096) br.write(input.subarray(i, i + 4096));
  br.end();
  await once(un, "end");
  log("stream", Buffer.concat(rest).equals(input), br.bytesWritten, un.bytesWritten);
}
{
  const br = zlib.createBrotliCompress();
  const chunks = [];
  br.on("data", (c) => chunks.push(c));
  br.end(input);
  await once(br, "end");
  log("stream bytes", Buffer.concat(chunks).equals(zlib.brotliCompressSync(input)));

  const un = zlib.createBrotliDecompress();
  un.on("error", (e) => log("stream error", e.code, e.errno, e.message));
  un.resume();
  un.end(Buffer.from("garbage"));
  await closed(un);

  const truncated = zlib.createBrotliDecompress();
  truncated.on("error", (e) => log("truncated", e.code, e.errno, e.message));
  truncated.resume();
  truncated.end(zlib.brotliCompressSync(input).subarray(0, 30));
  await closed(truncated);
}

/* reset: not while a write is in progress; before one, it starts the stream over. And params (a
   no-op for Brotli). */
{
  const busy = zlib.createBrotliCompress();
  busy.write("dropped");
  try {
    busy.reset();
    log("reset while writing: no error");
  } catch (e) {
    log("reset while writing:", e.message);
  }
  busy.destroy();
  const br = zlib.createBrotliCompress();
  br.reset();
  const chunks = [];
  br.on("data", (c) => chunks.push(c));
  br.end("kept");
  await once(br, "end");
  log("reset", zlib.brotliDecompressSync(Buffer.concat(chunks)).toString());
  log("params", typeof br.params, br instanceof zlib.BrotliCompress, zlib.BrotliDecompress() instanceof zlib.BrotliDecompress);
}
