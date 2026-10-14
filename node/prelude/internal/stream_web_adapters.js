// Readable.toWeb and fromWeb, Writable.toWeb and fromWeb, Duplex.toWeb and fromWeb: a node:stream
// as a web stream and back, linked into programs that name them (internal/features.js). Node's
// are lib/internal/webstreams/adapters.js; these give the same streams for the common cases.
import { Duplex, finished, Readable, Writable } from "../stream.js";
import { features } from "./features.js";

/* Readable.toWeb(readable): a ReadableStream of its chunks (Uint8Arrays, unless in object mode) */
function newReadableStreamFromStreamReadable(streamReadable) {
  const objectMode = streamReadable.readableObjectMode;
  let controller;
  let closed = false;
  const onData = (chunk) => {
    if (closed) return;
    if (Buffer.isBuffer(chunk) && !objectMode) chunk = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    controller.enqueue(chunk);
    if (controller.desiredSize <= 0) streamReadable.pause();
  };
  return new ReadableStream({
    start(c) {
      controller = c;
      streamReadable.on("data", onData);
      finished(streamReadable, (error) => {
        if (closed) return;
        closed = true;
        if (error) controller.error(error);
        else controller.close();
      });
      if (streamReadable.readableEnded) {
        closed = true;
        controller.close();
      }
    },
    pull() {
      streamReadable.resume();
    },
    cancel(reason) {
      closed = true;
      streamReadable.destroy(reason);
    },
  }, { highWaterMark: objectMode ? 16 : 65536, size: objectMode ? undefined : (chunk) => chunk.byteLength });
}

/* Readable.fromWeb(readableStream): a Readable of its chunks */
function newStreamReadableFromReadableStream(readableStream, options) {
  const reader = readableStream.getReader();
  let closed = false;
  const readable = new Readable({
    objectMode: !!(options && options.objectMode),
    highWaterMark: options?.highWaterMark,
    encoding: options?.encoding,
    signal: options?.signal,
    read() {
      reader.read().then(({ value, done }) => {
        if (done) this.push(null);
        else this.push(value);
      }, (error) => this.destroy(error));
    },
    destroy(error, callback) {
      if (!closed) reader.cancel(error).then(() => callback(error), (e) => callback(e));
      else callback(error);
    },
  });
  reader.closed.then(() => (closed = true), () => (closed = true));
  return readable;
}

/* Writable.toWeb(writable): a WritableStream writing to it */
function newWritableStreamFromStreamWritable(streamWritable) {
  return new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        if (streamWritable.write(chunk, (error) => error && reject(error))) resolve();
        else streamWritable.once("drain", resolve);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        finished(streamWritable, { readable: false }, (error) => (error ? reject(error) : resolve()));
        streamWritable.end();
      });
    },
    abort(reason) {
      streamWritable.destroy(reason);
    },
  });
}

/* Writable.fromWeb(writableStream): a Writable writing to it */
function newStreamWritableFromWritableStream(writableStream, options) {
  const writer = writableStream.getWriter();
  return new Writable({
    objectMode: !!(options && options.objectMode),
    decodeStrings: options?.decodeStrings,
    highWaterMark: options?.highWaterMark,
    signal: options?.signal,
    write(chunk, encoding, cb) {
      writer.write(chunk).then(() => cb(), cb);
    },
    final(cb) {
      writer.close().then(() => cb(), cb);
    },
    destroy(error, cb) {
      writer.abort(error).then(() => cb(error), () => cb(error));
    },
  });
}

/* Duplex.toWeb(duplex): its readable and writable sides as web streams */
function newReadableWritablePairFromDuplex(duplex) {
  return { readable: newReadableStreamFromStreamReadable(duplex), writable: newWritableStreamFromStreamWritable(duplex) };
}

/* Duplex.fromWeb({ readable, writable }): a Duplex reading one and writing the other */
function newStreamDuplexFromReadableWritablePair(pair, options) {
  const reader = pair.readable.getReader();
  const writer = pair.writable.getWriter();
  return new Duplex({
    objectMode: !!(options && options.objectMode),
    encoding: options?.encoding,
    decodeStrings: options?.decodeStrings,
    signal: options?.signal,
    read() {
      reader.read().then(({ value, done }) => {
        if (done) this.push(null);
        else this.push(value);
      }, (error) => this.destroy(error));
    },
    write(chunk, encoding, cb) {
      writer.write(chunk).then(() => cb(), cb);
    },
    final(cb) {
      writer.close().then(() => cb(), cb);
    },
    destroy(error, cb) {
      Promise.allSettled([reader.cancel(error), writer.abort(error)]).then(() => cb(error));
    },
  });
}

features.webStreamsAdapters = {
  newReadableStreamFromStreamReadable, newStreamReadableFromReadableStream, newWritableStreamFromStreamWritable,
  newStreamWritableFromWritableStream, newReadableWritablePairFromDuplex, newStreamDuplexFromReadableWritablePair,
};
