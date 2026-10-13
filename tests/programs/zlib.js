// node:zlib: deflate, gzip and raw deflate with their inverses and unzip, sync, with callbacks and
// as streams; the compressed bytes themselves (Node's zlib is Chromium's: the same bytes here);
// options, dictionaries, flushes, params, multi-member gzip, errors and limits; crc32.
import { once } from "node:events";
import { pipeline, Readable, Writable } from "node:stream";
import zlib from "node:zlib";

const log = (...a) => console.log(...a);
const hex = (b) => Buffer.from(b).toString("hex");
const short = (b) => (b.length > 48 ? hex(b.subarray(0, 24)) + "…" + hex(b.subarray(-24)) + " (" + b.length + ")" : hex(b));
const closed = (s) => new Promise((resolve) => s.on("close", resolve));
const show = (e) => log("error", e.name, e.code, e.errno, e.message);

/* text with repeats, and bytes without */
const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
let text = "";
for (let i = 0; i < 4000; i++) text += words[(i * 7 + (i >> 3)) % words.length] + (i % 13 === 0 ? "\n" : " ");
const input = Buffer.from(text);
const noise = Buffer.alloc(70000);
let seed = 12345;
for (let i = 0; i < noise.length; i++) {
  seed = (seed * 1103515245 + 12345) >>> 0;
  noise[i] = seed >>> 24;
}

/* the bytes of each format, and back */
for (const [c, d] of [["deflateSync", "inflateSync"], ["gzipSync", "gunzipSync"], ["deflateRawSync", "inflateRawSync"]]) {
  const z = zlib[c](input);
  log(c, short(z), zlib[d](z).equals(input), zlib.unzipSync(c === "deflateRawSync" ? zlib.deflateSync(input) : z).length);
}
log("noise", short(zlib.gzipSync(noise)), zlib.gunzipSync(zlib.gzipSync(noise)).equals(noise));
log("strings", hex(zlib.deflateSync("hello hello hello hello")), zlib.inflateSync(zlib.deflateSync("héllo")).toString());
log("empty", hex(zlib.gzipSync("")), zlib.gunzipSync(zlib.gzipSync("")).length);
log("views", zlib.inflateSync(zlib.deflateSync(new Uint16Array([1, 2, 3]))).length, zlib.deflateSync(new ArrayBuffer(4)).length);

/* options: each changes the bytes as it does in Node */
for (const level of [0, 1, 6, 9]) log("level", level, short(zlib.deflateSync(input, { level })));
for (const strategy of [1, 2, 3, 4]) log("strategy", strategy, short(zlib.deflateSync(input, { strategy })));
log("windowBits", short(zlib.deflateSync(input, { windowBits: 9 })), short(zlib.deflateRawSync(input, { windowBits: 8 })));
log("memLevel", short(zlib.gzipSync(input, { memLevel: 1 })), short(zlib.gzipSync(input, { memLevel: 9 })));
log("chunkSize", zlib.gunzipSync(zlib.gzipSync(input), { chunkSize: 64 }).equals(input));
const info = zlib.deflateSync("abc", { info: true });
log("info", hex(info.buffer), info.engine.constructor.name, info.engine.bytesWritten);

/* a dictionary */
const dictionary = Buffer.from("alpha beta gamma delta epsilon");
const withDict = zlib.deflateSync(input, { dictionary });
log("dictionary", short(withDict), zlib.inflateSync(withDict, { dictionary }).equals(input));
try {
  zlib.inflateSync(withDict);
} catch (e) {
  show(e);
}
try {
  zlib.inflateSync(withDict, { dictionary: Buffer.from("other") });
} catch (e) {
  show(e);
}
const rawDict = zlib.deflateRawSync("alpha beta alpha", { dictionary });
log("raw dictionary", hex(rawDict), zlib.inflateRawSync(rawDict, { dictionary }).toString());

/* gzip members, padding and garbage */
const two = Buffer.concat([zlib.gzipSync("one "), zlib.gzipSync("two")]);
log("members", zlib.gunzipSync(two).toString(), zlib.unzipSync(two).toString());
log("padding", zlib.gunzipSync(Buffer.concat([zlib.gzipSync("pad"), Buffer.alloc(5)])).toString());
try {
  zlib.gunzipSync(Buffer.concat([zlib.gzipSync("x"), Buffer.from("garbage")]));
} catch (e) {
  show(e);
}
log("inflate stops at the end", zlib.inflateSync(Buffer.concat([zlib.deflateSync("end"), Buffer.from("junk")])).toString());

/* errors */
for (const [name, data] of [["inflateSync", Buffer.from("not zlib data")], ["gunzipSync", Buffer.from([0x1f, 0x8b, 8, 0, 0])],
  ["inflateSync", zlib.deflateSync(input).subarray(0, 100)], ["inflateRawSync", Buffer.from([0xff, 0xff])], ["unzipSync", Buffer.alloc(0)]]) {
  try {
    log(name, zlib[name](data).length);
  } catch (e) {
    show(e);
  }
}
for (const bad of [() => zlib.deflateSync(123), () => zlib.deflateSync("x", { level: 10 }), () => zlib.deflateSync("x", { chunkSize: 10 }),
  () => zlib.gzipSync("x", { windowBits: 8 }), () => zlib.deflateSync("x", { strategy: "fast" }), () => zlib.deflateSync("x", { dictionary: "d" }),
  () => zlib.deflate("x"), () => zlib.crc32(1), () => zlib.crc32("x", -1)]) {
  try {
    bad();
  } catch (e) {
    show(e);
  }
}
try {
  zlib.gunzipSync(zlib.gzipSync(input), { maxOutputLength: 1000 });
} catch (e) {
  show(e);
}

/* crc32 */
log("crc32", zlib.crc32("hello"), zlib.crc32(Buffer.from("hello")), zlib.crc32("world", zlib.crc32("hello ")), zlib.crc32("héllo"), zlib.crc32(input));

/* callbacks */
await new Promise((resolve) =>
  zlib.gzip(input, (err, z) => {
    log("gzip callback", err, short(z));
    zlib.gunzip(z, (err2, back) => {
      log("gunzip callback", err2, back.equals(input));
      resolve();
    });
  }),
);
await new Promise((resolve) =>
  zlib.inflate(Buffer.from("bad"), (err, out) => {
    log("inflate callback", err.code, err.message, out);
    resolve();
  }),
);
await new Promise((resolve) =>
  zlib.gunzip(zlib.gzipSync(input), { maxOutputLength: 5000 }, (err) => {
    log("maxOutputLength callback", err.code, err.message);
    resolve();
  }),
);
const promised = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, out) => (err ? reject(err) : resolve(out))));
log("promised", (await promised(zlib.deflateRaw, "promised")).length, (await promised(zlib.unzip, zlib.deflateSync("p"), {})).toString());

/* streams: the order of events, and many small writes */
{
  const gz = zlib.createGzip();
  const chunks = [];
  const events = [];
  gz.on("data", (c) => chunks.push(c));
  gz.on("end", () => events.push("end"));
  gz.on("finish", () => events.push("finish"));
  gz.on("close", () => events.push("close"));
  for (let i = 0; i < input.length; i += 1000) gz.write(input.subarray(i, i + 1000));
  gz.end();
  await once(gz, "close");
  const out = Buffer.concat(chunks);
  log("stream", events.join(" "), chunks.length, short(out), out.equals(zlib.gzipSync(input)), gz.bytesWritten, gz._closed);
}

/* pipeline: compress and decompress as streams, with backpressure from a slow writer */
await new Promise((resolve) => {
  const received = [];
  pipeline(
    Readable.from([input, noise, input]),
    zlib.createDeflate({ level: 3 }),
    zlib.createInflate(),
    new Writable({
      highWaterMark: 1024,
      write(chunk, _, cb) {
        received.push(chunk);
        setImmediate(cb);
      },
    }),
    (err) => {
      log("pipeline", err, Buffer.concat(received).equals(Buffer.concat([input, noise, input])));
      resolve();
    },
  );
});

/* flush(): the output so far is complete for a reader */
{
  const deflate = zlib.createDeflate();
  const inflate = zlib.createInflate();
  deflate.pipe(inflate);
  deflate.write("first part ");
  await new Promise((resolve) => deflate.flush(resolve));
  const [part] = await once(inflate, "data");
  log("flush", part.toString());
  deflate.write("second part");
  deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => log("flushed sync"));
  log("flush data", (await once(inflate, "data"))[0].toString());
  deflate.end();
  await once(inflate, "end");
  log("flush end");
}

/* params(): the level changes between parts of one stream */
{
  const deflate = zlib.createDeflate({ level: 0 });
  const chunks = [];
  deflate.on("data", (c) => chunks.push(c));
  deflate.write(input.subarray(0, 5000));
  await new Promise((resolve) => deflate.params(9, zlib.constants.Z_DEFAULT_STRATEGY, resolve));
  deflate.end(input.subarray(5000));
  await once(deflate, "end");
  const out = Buffer.concat(chunks);
  log("params", short(out), zlib.inflateSync(out).equals(input));
}

/* reset(), and errors on a stream */
{
  const deflate = zlib.createDeflateRaw();
  deflate.write("discarded");
  deflate.reset();
  const out = [];
  deflate.on("data", (c) => out.push(c));
  deflate.end("kept");
  await once(deflate, "end");
  log("reset", zlib.inflateRawSync(Buffer.concat(out)).toString());

  const gunzip = zlib.createGunzip();
  gunzip.on("error", (e) => log("stream error", e.code, e.errno, e.message, gunzip.destroyed));
  gunzip.on("close", () => log("stream close"));
  gunzip.end(Buffer.from("definitely not gzip"));
  await closed(gunzip);

  const truncated = zlib.createInflate();
  truncated.on("error", (e) => log("truncated", e.code, e.message));
  truncated.resume();
  truncated.end(zlib.deflateSync(input).subarray(0, 50));
  await closed(truncated);
}

/* rejectGarbageAfterEnd, finishFlush, and an Unzip stream fed a byte at a time */
{
  const inflate = zlib.createInflate({ rejectGarbageAfterEnd: true });
  inflate.on("error", (e) => log("garbage", e.name, e.code, e.message));
  inflate.resume();
  inflate.end(Buffer.concat([zlib.deflateSync("x"), Buffer.from("junk")]));
  await closed(inflate);

  const partial = zlib.inflateSync(zlib.deflateSync(input).subarray(0, 200), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  log("finishFlush", partial.length > 0, input.subarray(0, partial.length).equals(partial));

  const unzip = zlib.createUnzip();
  const out = [];
  unzip.on("data", (c) => out.push(c));
  for (const byte of zlib.gzipSync("byte by byte")) unzip.write(Buffer.from([byte]));
  unzip.end();
  await once(unzip, "end");
  log("unzip bytes", Buffer.concat(out).toString());
}

/* close() with a callback, and writes after close */
{
  const gz = zlib.createGzip();
  gz.close(() => log("closed", gz._closed, gz.destroyed));
  await once(gz, "close");
}

/* the module's shape */
log("constants", Object.getPrototypeOf(zlib.constants), Object.isFrozen(zlib.constants), zlib.constants.Z_MAX_CHUNK, Object.keys(zlib.constants).length);
log("codes", zlib.codes.Z_DATA_ERROR, zlib.codes["-3"], Object.isFrozen(zlib.codes));
log("deprecated constants", zlib.Z_BEST_COMPRESSION, Object.keys(zlib).includes("Z_BEST_COMPRESSION"), zlib.BROTLI_MODE_TEXT);
log("instances", zlib.createGzip() instanceof zlib.Gzip, zlib.Gzip() instanceof zlib.Gzip, typeof zlib.createGunzip().params);
