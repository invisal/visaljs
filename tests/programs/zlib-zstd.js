// node:zlib's zstd: compress and decompress, sync, with callbacks and as streams; the compressed
// bytes (zstd 1.5.7, Node's copy) at each level and strategy, with a checksum, a pledged size and a
// dictionary; flushes, params and errors.
import { once } from "node:events";
import zlib from "node:zlib";

const log = (...a) => console.log(...a);
const hex = (b) => Buffer.from(b).toString("hex");
const short = (b) => (b.length > 48 ? hex(b.subarray(0, 24)) + "…" + hex(b.subarray(-24)) + " (" + b.length + ")" : hex(b));
const show = (e) => log("error", e.name, e.code, e.errno, e.message);
const closed = (s) => new Promise((resolve) => s.on("close", resolve));
const { constants } = zlib;

const words = ["{\"id\":", "\"name\":", "\"tags\":[", "]}", "alpha", "beta", "gamma", "delta", "42", "null"];
let text = "";
for (let i = 0; i < 3000; i++) text += words[(i * 7 + (i >> 2)) % words.length] + (i % 11 === 0 ? "\n" : ",");
const input = Buffer.from(text);

log("default", short(zlib.zstdCompressSync(input)), zlib.zstdDecompressSync(zlib.zstdCompressSync(input)).equals(input));
log("small", hex(zlib.zstdCompressSync("hello")), hex(zlib.zstdCompressSync("")), zlib.zstdDecompressSync(zlib.zstdCompressSync("")).length);
for (const level of [-5, 1, 3, 9, 19]) {
  const z = zlib.zstdCompressSync(input, { params: { [constants.ZSTD_c_compressionLevel]: level } });
  log("level", level, short(z), zlib.zstdDecompressSync(z).equals(input));
}
for (const strategy of [constants.ZSTD_fast, constants.ZSTD_lazy2, constants.ZSTD_btultra2]) {
  log("strategy", strategy, short(zlib.zstdCompressSync(input, { params: { [constants.ZSTD_c_strategy]: strategy } })));
}
log("checksum", short(zlib.zstdCompressSync(input, { params: { [constants.ZSTD_c_checksumFlag]: true } })));
log("pledged", short(zlib.zstdCompressSync(input, { pledgedSrcSize: input.length })));
log("window", short(zlib.zstdCompressSync(input, { params: { [constants.ZSTD_c_windowLog]: 10 } })));

/* a dictionary: raw content, both ways */
const dictionary = Buffer.from(words.join(""));
const withDict = zlib.zstdCompressSync(input, { dictionary });
log("dictionary", short(withDict), zlib.zstdDecompressSync(withDict, { dictionary }).equals(input));
try {
  log("without it", zlib.zstdDecompressSync(withDict).equals(input));
} catch (e) {
  show(e);
}

/* errors */
for (const data of [Buffer.from("not zstd at all"), zlib.zstdCompressSync(input).subarray(0, 40), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff])]) {
  try {
    log("decompressed", zlib.zstdDecompressSync(data).length);
  } catch (e) {
    show(e);
  }
}
for (const options of [{ params: { 500: 1 } }, { params: { x: 1 } }, { params: { [constants.ZSTD_c_compressionLevel]: "3" } },
  { params: { [constants.ZSTD_c_windowLog]: 2 } }, { pledgedSrcSize: -1 }, { flush: 3 }]) {
  try {
    zlib.zstdCompressSync("x", options);
  } catch (e) {
    show(e);
  }
}
try {
  zlib.zstdDecompressSync(zlib.zstdCompressSync(input), { params: { [constants.ZSTD_d_windowLogMax]: 5 } });
} catch (e) {
  show(e);
}

/* callbacks */
await new Promise((resolve) =>
  zlib.zstdCompress(input, (err, z) => {
    log("callback", err, short(z));
    zlib.zstdDecompress(z, (err2, back) => {
      log("callback back", err2, back.equals(input));
      resolve();
    });
  }),
);
await new Promise((resolve) =>
  zlib.zstdDecompress(Buffer.from("bad data"), (err) => {
    log("callback error", err.code, err.errno, err.message);
    resolve();
  }),
);

/* streams, and a flush that makes the output so far readable */
{
  const zs = zlib.createZstdCompress();
  const un = zlib.createZstdDecompress();
  zs.pipe(un);
  zs.write("streamed ");
  await new Promise((resolve) => zs.flush(resolve));
  log("flushed", (await once(un, "data"))[0].toString());
  const rest = [];
  un.on("data", (c) => rest.push(c));
  for (let i = 0; i < input.length; i += 4096) zs.write(input.subarray(i, i + 4096));
  zs.end();
  await once(un, "end");
  log("stream", Buffer.concat(rest).equals(input), zs.bytesWritten, un.bytesWritten);
}
{
  const zs = zlib.createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 5 } });
  const chunks = [];
  zs.on("data", (c) => chunks.push(c));
  zs.end(input);
  await once(zs, "end");
  log("stream bytes", short(Buffer.concat(chunks)));

  const un = zlib.createZstdDecompress();
  un.on("error", (e) => log("stream error", e.code, e.errno, e.message));
  un.resume();
  un.end(Buffer.from("garbage!"));
  await closed(un);
}

/* the shape (not reset(): Node v22.22.2 corrupts its heap resetting a zstd stream) */
{
  const zs = zlib.createZstdCompress();
  log("shape", typeof zs.params, zs instanceof zlib.ZstdCompress, new zlib.ZstdDecompress() instanceof zlib.ZstdDecompress);
  try {
    zlib.ZstdCompress();
  } catch (e) {
    log("without new", e.name);
  }
}
