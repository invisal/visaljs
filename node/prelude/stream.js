// node:stream: Readable, Writable, Duplex, Transform, PassThrough,
// pipeline and finished, with Node's semantics for the common API: buffering to a
// highWaterMark, flowing and paused modes ('data', 'readable', read()), backpressure ('drain'),
// end/finish/close ordering, destroy(err), pipe, async iteration, Readable.from, and the
// conversions to and from web streams (Readable.toWeb, Readable.fromWeb). Strings written or
// pushed become Buffers unless the stream is in object mode or has an encoding.
// Not yet: writev batching, the legacy `readable.wrap`, compose and the operators (map, filter, …).
import { EventEmitter } from "./events.js";
import { lazyFunction } from "./internal/features.js";

function codeError(Ctor, message, code) {
  const e = new Ctor(message);
  Object.defineProperty(e, "code", { value: code, writable: true, enumerable: true, configurable: true });
  return e;
}
const prematureClose = () => codeError(Error, "Premature close", "ERR_STREAM_PREMATURE_CLOSE");

const nextTick = (fn, ...args) => process.nextTick(fn, ...args);

const isUint8 = (v) => v instanceof Uint8Array;
const chunkSize = (chunk, objectMode) => (objectMode ? 1 : chunk.length);

/* ---- Stream (the legacy base) ---------------------------------------------------------------- */

export function Stream(opts) {
  EventEmitter.call(this, opts);
}
Object.setPrototypeOf(Stream.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Stream, EventEmitter);

/* The legacy pipe (Node's lib/internal/streams/legacy.js): 'data' to write(), pausing on a
 * full destination until 'drain'; the destination ends with the source unless { end: false }. */
Stream.prototype.pipe = function (dest, options) {
  return legacyPipe(this, dest, options);
};

function legacyPipe(source, dest, options) {
  function ondata(chunk) {
    if (dest.writable && dest.write(chunk) === false && source.pause) source.pause();
  }
  source.on("data", ondata);
  function ondrain() {
    if (source.readable && source.resume) source.resume();
  }
  dest.on("drain", ondrain);

  let didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;
    dest.end();
  }
  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;
    if (typeof dest.destroy === "function") dest.destroy();
  }
  if (!dest._isStdio && (!options || options.end !== false)) {
    source.on("end", onend);
    source.on("close", onclose);
  }

  function onerror(er) {
    cleanup();
    if (this.listenerCount("error") === 0) this.emit("error", er);
  }
  source.prependListener("error", onerror);
  dest.prependListener("error", onerror);

  function cleanup() {
    source.removeListener("data", ondata);
    dest.removeListener("drain", ondrain);
    source.removeListener("end", onend);
    source.removeListener("close", onclose);
    source.removeListener("error", onerror);
    dest.removeListener("error", onerror);
    source.removeListener("end", cleanup);
    source.removeListener("close", cleanup);
    dest.removeListener("close", cleanup);
  }
  source.on("end", cleanup);
  source.on("close", cleanup);
  dest.on("close", cleanup);
  dest.emit("pipe", source);
  return dest;
}

/* ---- Readable -------------------------------------------------------------------------------- */

class ReadableState {
  constructor(options, stream) {
    this.objectMode = !!(options && (options.objectMode || options.readableObjectMode));
    const hwm = options && (options.readableHighWaterMark ?? options.highWaterMark);
    this.highWaterMark = hwm !== undefined ? hwm : getDefaultHighWaterMark(this.objectMode);
    this.buffer = [];
    this.length = 0;
    this.pipes = [];
    this.flowing = null;
    this.ended = false;
    this.endEmitted = false;
    this.reading = false;
    this.sync = true;
    this.needReadable = false;
    this.emittedReadable = false;
    this.readableListening = false;
    this.resumeScheduled = false;
    this.destroyed = false;
    this.closed = false;
    this.closeEmitted = false;
    this.errored = null;
    this.errorEmitted = false;
    this.emitClose = !options || options.emitClose !== false;
    this.autoDestroy = !options || options.autoDestroy !== false;
    this.dataEmitted = false;
    this.encoding = null;
    this.decoder = null;
    this.stream = stream;
    if (options && options.encoding) this.setEncoding(options.encoding);
  }

  setEncoding(enc) {
    this.encoding = Buffer.isEncoding(enc) ? String(enc).toLowerCase().replace("-", "") : "utf8";
    if (this.encoding === "utf-8") this.encoding = "utf8";
    this.decoder = this.encoding === "utf8" ? new TextDecoder() : null;
  }

  decode(buf, flush) {
    if (this.decoder) return this.decoder.decode(buf, { stream: !flush });
    return buf.toString(this.encoding);
  }
}

export function Readable(options) {
  if (!(this instanceof Readable)) return new Readable(options);
  Stream.call(this, options);
  this._readableState = new ReadableState(options, this);
  if (options) {
    if (typeof options.read === "function") this._read = options.read;
    if (typeof options.destroy === "function") this._destroy = options.destroy;
    if (typeof options.construct === "function") this._construct = options.construct;
    if (options.signal) addAbortSignal(options.signal, this);
  }
}
Object.setPrototypeOf(Readable.prototype, Stream.prototype);
Object.setPrototypeOf(Readable, Stream);

Readable.prototype._read = function () {
  throw codeError(Error, "The _read() method is not implemented", "ERR_METHOD_NOT_IMPLEMENTED");
};

function readableAddChunk(stream, chunk, encoding, prepend) {
  const state = stream._readableState;
  if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
    return false;
  }
  if (!state.objectMode) {
    if (typeof chunk === "string") {
      encoding = encoding || "utf8";
      if (state.encoding !== encoding) chunk = Buffer.from(chunk, encoding);
      else if (state.encoding) {
        return addChunk(stream, state, chunk, prepend);
      }
    } else if (isUint8(chunk) && !Buffer.isBuffer(chunk)) {
      chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else if (!isUint8(chunk)) {
      const e = codeError(TypeError, 'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array.', "ERR_INVALID_ARG_TYPE");
      errorOrDestroy(stream, e);
      return false;
    }
    if (state.decoder || (state.encoding && state.encoding !== "buffer")) chunk = state.decode(chunk, false);
  }
  if (state.ended && !prepend) {
    errorOrDestroy(stream, codeError(Error, "stream.push() after EOF", "ERR_STREAM_PUSH_AFTER_EOF"));
    return false;
  }
  if (state.destroyed || state.errored) return false;
  state.reading = false;
  if (!state.objectMode && chunk.length === 0) {
    maybeReadMore(stream, state);
    return state.length < state.highWaterMark;
  }
  addChunk(stream, state, chunk, prepend);
  return !state.ended && (state.length < state.highWaterMark || state.length === 0);
}

function addChunk(stream, state, chunk, prepend) {
  if (state.flowing && state.length === 0 && !state.sync && stream.listenerCount("data") > 0) {
    state.dataEmitted = true;
    stream.emit("data", chunk);
  } else {
    state.length += chunkSize(chunk, state.objectMode);
    if (prepend) state.buffer.unshift(chunk);
    else state.buffer.push(chunk);
    if (state.needReadable) emitReadable(stream);
  }
  maybeReadMore(stream, state);
}

Readable.prototype.push = function (chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, false);
};

Readable.prototype.unshift = function (chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, true);
};

Readable.prototype.isPaused = function () {
  return this._readableState.flowing === false;
};

Readable.prototype.setEncoding = function (enc) {
  const state = this._readableState;
  state.setEncoding(enc);
  state.buffer = state.buffer.map((c) => (typeof c === "string" ? c : state.decode(c, false)));
  return this;
};

/* the chunks for read(n): n bytes (or characters), or everything */
function fromList(n, state) {
  if (state.length === 0) return null;
  let ret;
  if (state.objectMode) ret = state.buffer.shift();
  else if (!n || n >= state.length) {
    ret = state.decoder || state.encoding ? state.buffer.join("") : state.buffer.length === 1 ? state.buffer[0] : Buffer.concat(state.buffer);
    state.buffer = [];
  } else {
    const parts = [];
    let need = n;
    while (need > 0) {
      const head = state.buffer[0];
      if (head.length <= need) {
        parts.push(head);
        state.buffer.shift();
        need -= head.length;
      } else {
        parts.push(head.slice(0, need));
        state.buffer[0] = head.slice(need);
        need = 0;
      }
    }
    ret = typeof parts[0] === "string" ? parts.join("") : Buffer.concat(parts);
  }
  state.length -= chunkSize(ret, state.objectMode);
  return ret;
}

/* how much read(n) returns: one object, the first chunk when flowing, everything when n is
 * NaN, n when buffered, else nothing until more arrives (or it ends) */
function howMuchToRead(n, state) {
  if (n <= 0 || (state.length === 0 && state.ended)) return 0;
  if (state.objectMode) return 1;
  if (Number.isNaN(n)) return state.flowing && state.length ? state.buffer[0].length : state.length;
  if (n <= state.length) return n;
  return state.ended ? state.length : 0;
}

Readable.prototype.read = function (n) {
  const state = this._readableState;
  n = n === undefined ? NaN : Number(n);
  const nOrig = n;
  if (n !== 0) state.emittedReadable = false;
  if (n === 0 && state.needReadable && (state.length >= state.highWaterMark || state.ended)) {
    if (state.length === 0 && state.ended) endReadable(this);
    else emitReadable(this);
    return null;
  }
  n = howMuchToRead(n, state);
  if (n === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  }
  let doRead = state.needReadable || state.length === 0 || state.length - n < state.highWaterMark;
  if (state.ended || state.reading || state.destroyed || state.errored) doRead = false;
  if (doRead) {
    state.reading = true;
    state.sync = true;
    if (state.length === 0) state.needReadable = true;
    try {
      this._read(state.highWaterMark);
    } catch (e) {
      errorOrDestroy(this, e);
    }
    state.sync = false;
    if (!state.reading) n = howMuchToRead(nOrig, state);
  }
  const ret = n > 0 ? fromList(n, state) : null;
  if (ret === null) {
    state.needReadable = state.length <= state.highWaterMark;
    n = 0;
  } else {
    state.readableDidRead = true;
  }
  if (state.length === 0) {
    if (!state.ended) state.needReadable = true;
    if (nOrig !== n && state.ended) endReadable(this);
  }
  if (ret !== null && !state.errorEmitted && !state.closeEmitted) {
    state.dataEmitted = true;
    this.emit("data", ret);
  }
  return ret;
};

function onEofChunk(stream, state) {
  if (state.ended) return;
  if (state.decoder) {
    const rest = state.decoder.decode();
    if (rest.length) {
      state.buffer.push(rest);
      state.length += state.objectMode ? 1 : rest.length;
    }
  }
  state.ended = true;
  if (state.sync) emitReadable(stream);
  else {
    state.needReadable = false;
    state.emittedReadable = true;
    emitReadable_(stream);
  }
}

function emitReadable(stream) {
  const state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    state.emittedReadable = true;
    nextTick(emitReadable_, stream);
  }
}

function emitReadable_(stream) {
  const state = stream._readableState;
  if (!state.destroyed && !state.errored && (state.length || state.ended)) {
    stream.emit("readable");
    state.emittedReadable = false;
  }
  state.needReadable = !state.flowing && !state.ended && state.length <= state.highWaterMark;
  flow(stream);
}

function maybeReadMore(stream, state) {
  if (!state.readingMore && !state.ended) {
    state.readingMore = true;
    nextTick(() => {
      while (!state.reading && !state.ended && (state.length < state.highWaterMark || (state.flowing && state.length === 0))) {
        const len = state.length;
        stream.read(0);
        if (len === state.length) break;
      }
      state.readingMore = false;
    });
  }
}

Readable.prototype.on = function (ev, fn) {
  const res = Stream.prototype.on.call(this, ev, fn);
  const state = this._readableState;
  if (ev === "data") {
    state.readableListening = this.listenerCount("readable") > 0;
    if (state.flowing !== false) this.resume();
  } else if (ev === "readable") {
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = state.needReadable = true;
      state.flowing = false;
      state.emittedReadable = false;
      if (state.length) emitReadable(this);
      else if (!state.reading) nextTick(() => this.read(0));
    }
  }
  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

Readable.prototype.removeListener = function (ev, fn) {
  const res = Stream.prototype.removeListener.call(this, ev, fn);
  if (ev === "readable") nextTick(updateReadableListening, this);
  return res;
};
Readable.prototype.off = Readable.prototype.removeListener;

function updateReadableListening(self) {
  const state = self._readableState;
  state.readableListening = self.listenerCount("readable") > 0;
  if (state.resumeScheduled && state.paused === false) state.flowing = true;
  else if (self.listenerCount("data") > 0) self.resume();
  else if (!state.readableListening) state.flowing = null;
}

Readable.prototype.resume = function () {
  const state = this._readableState;
  if (!state.flowing) {
    state.flowing = !state.readableListening;
    if (!state.resumeScheduled) {
      state.resumeScheduled = true;
      nextTick(() => {
        if (!state.reading) this.read(0);
        state.resumeScheduled = false;
        this.emit("resume");
        flow(this);
        if (state.flowing && !state.reading) this.read(0);
      });
    }
  }
  state.paused = false;
  return this;
};

Readable.prototype.pause = function () {
  const state = this._readableState;
  if (state.flowing !== false) {
    state.flowing = false;
    this.emit("pause");
  }
  state.paused = true;
  return this;
};

function flow(stream) {
  const state = stream._readableState;
  while (state.flowing && stream.read() !== null);
}

function endReadable(stream) {
  const state = stream._readableState;
  if (!state.endEmitted) {
    state.ended = true;
    nextTick(() => {
      if (!state.errored && !state.closeEmitted && !state.endEmitted && state.length === 0) {
        state.endEmitted = true;
        stream.emit("end");
        const ws = stream._writableState;
        if (stream.writable && stream.allowHalfOpen === false) {  /* a Duplex that isn't half-open ends its writable side too */
          nextTick(() => {
            if (stream.writable && !stream.writableEnded && !stream.destroyed) stream.end();
          });
          return;
        }
        const autoDestroy = !ws || (ws.autoDestroy && (ws.finished || ws.writable === false));
        if (state.autoDestroy && autoDestroy) stream.destroy();
      }
    });
  }
}

Readable.prototype.pipe = function (dest, pipeOpts) {
  const state = this._readableState;
  state.pipes.push(dest);
  const doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;
  const onend = () => dest.end();
  if (doEnd) this.once("end", onend);
  let ondrain;
  const ondata = (chunk) => {
    const ret = dest.write(chunk);
    if (ret === false) {
      this.pause();
      if (!ondrain) {
        ondrain = () => {
          ondrain = null;
          this.resume();
        };
        dest.once("drain", ondrain);
      }
    }
  };
  this.on("data", ondata);
  const cleanup = () => {
    this.removeListener("data", ondata);
    this.removeListener("end", onend);
    dest.removeListener("close", onclose);
    dest.removeListener("finish", onfinish);
    dest.removeListener("error", onerror);
  };
  const onerror = (er) => {
    this.unpipe(dest);
    dest.removeListener("error", onerror);
    if (dest.listenerCount("error") === 0) {
      const s = dest._writableState || dest._readableState;
      if (s && !s.errorEmitted) errorOrDestroy(dest, er);
      else dest.emit("error", er);
    }
  };
  dest.prependListener("error", onerror);
  const onclose = () => {
    dest.removeListener("finish", onfinish);
    this.unpipe(dest);
  };
  const onfinish = () => {
    dest.removeListener("close", onclose);
    this.unpipe(dest);
  };
  dest.once("close", onclose);
  dest.once("finish", onfinish);
  dest._pipeCleanup = cleanup;
  dest.emit("pipe", this);
  if (dest.writableNeedDrain === true) this.pause();
  else if (!state.flowing) this.resume();
  return dest;
};

Readable.prototype.unpipe = function (dest) {
  const state = this._readableState;
  const dests = dest ? [dest] : state.pipes.slice();
  for (const d of dests) {
    const i = state.pipes.indexOf(d);
    if (i < 0) continue;
    state.pipes.splice(i, 1);
    if (d._pipeCleanup) d._pipeCleanup();
    d.emit("unpipe", this);
  }
  if (state.pipes.length === 0) this.pause();
  return this;
};

Readable.prototype[Symbol.asyncIterator] = function () {
  return createAsyncIterator(this);
};

Readable.prototype.iterator = function (options) {
  return createAsyncIterator(this, options);
};

async function* createAsyncIterator(stream, options) {
  let wake = () => {};
  const next = () => wake();
  stream.on("readable", next);
  let error;
  let done = false;
  finished(stream, { writable: false }, (err) => {
    error = err ? aggregateTwoErrors(error, err) : null;
    done = true;
    wake();
  });
  try {
    for (;;) {
      const chunk = stream.destroyed ? null : stream.read();
      if (chunk !== null) yield chunk;
      else if (error) throw error;
      else if (error === null || done) return;
      else await new Promise((resolve) => (wake = resolve));
    }
  } catch (err) {
    error = aggregateTwoErrors(error, err);
    throw error;
  } finally {
    if ((error || options?.destroyOnReturn !== false) && (error === undefined || stream._readableState.autoDestroy)) destroyImpl(stream, null);
    else stream.off?.("readable", next);
  }
}

function aggregateTwoErrors(inner, outer) {
  return inner || outer;
}

const readableGetters = {
  readable: (s, st) => !!(st.readable !== false && !st.destroyed && !st.errorEmitted && !st.endEmitted),
  readableDidRead: (s, st) => !!st.readableDidRead,
  readableAborted: (s, st) => !!(st.readable !== false && (st.destroyed || st.errored) && !st.endEmitted),
  readableHighWaterMark: (s, st) => st.highWaterMark,
  readableBuffer: (s, st) => st.buffer,
  readableFlowing: (s, st) => st.flowing,
  readableLength: (s, st) => st.length,
  readableObjectMode: (s, st) => st.objectMode,
  readableEncoding: (s, st) => st.encoding,
  readableEnded: (s, st) => st.endEmitted,
  errored: (s, st) => st.errored,
  closed: (s, st) => st.closed,
  destroyed: (s, st) => st.destroyed,
};
for (const name of Object.keys(readableGetters)) {
  const get = readableGetters[name];
  Object.defineProperty(Readable.prototype, name, {
    get() {
      const st = this._readableState;
      return st ? get(this, st) : undefined;
    },
    set(v) {
      if (name === "readable" && this._readableState) this._readableState.readable = v;
      else if (name === "destroyed" && this._readableState) this._readableState.destroyed = v;
      else if (name === "readableFlowing" && this._readableState) this._readableState.flowing = v;
    },
    enumerable: false,
    configurable: true,
  });
}

Readable.from = function (iterable, opts) {
  if (typeof iterable === "string" || isUint8(iterable)) {
    return new Readable({
      objectMode: true,
      ...opts,
      read() {
        this.push(iterable);
        this.push(null);
      },
    });
  }
  const iterator = iterable[Symbol.asyncIterator] ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
  let reading = false;
  const readable = new Readable({
    objectMode: true,
    highWaterMark: 1,
    ...opts,
    async read() {
      if (reading) return;
      reading = true;
      try {
        for (;;) {
          const { value, done } = await iterator.next();
          if (done) {
            this.push(null);
            break;
          }
          const chunk = value && typeof value.then === "function" ? await value : value;
          if (chunk === null) throw codeError(TypeError, "May not write null values to stream", "ERR_STREAM_NULL_VALUES");
          if (!this.push(chunk)) break;
        }
      } catch (err) {
        this.destroy(err);
      }
      reading = false;
    },
    destroy(error, cb) {
      Promise.resolve(typeof iterator.return === "function" ? iterator.return() : undefined).then(() => cb(error), (e) => cb(e || error));
    },
  });
  return readable;
};

/* Readable.toWeb(readable): a ReadableStream of its chunks (as Uint8Arrays) */
Readable.toWeb = function (streamReadable) {
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
        if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE") controller.error(error);
        else if (error) controller.error(error);
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
      destroyImpl(streamReadable, reason);
    },
  }, { highWaterMark: objectMode ? 16 : 65536, size: objectMode ? undefined : (chunk) => chunk.byteLength });
};

/* Readable.fromWeb(readableStream): a Readable of its chunks */
Readable.fromWeb = function (readableStream, options) {
  const reader = readableStream.getReader();
  let closed = false;
  const readable = new Readable({
    objectMode: !!(options && options.objectMode),
    highWaterMark: options?.highWaterMark,
    encoding: options?.encoding,
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
};

/* ---- Writable -------------------------------------------------------------------------------- */

class WritableState {
  constructor(options, stream) {
    this.objectMode = !!(options && (options.objectMode || options.writableObjectMode));
    const hwm = options && (options.writableHighWaterMark ?? options.highWaterMark);
    this.highWaterMark = hwm !== undefined ? hwm : getDefaultHighWaterMark(this.objectMode);
    this.decodeStrings = !options || options.decodeStrings !== false;
    this.defaultEncoding = (options && options.defaultEncoding) || "utf8";
    this.length = 0;
    this.writing = false;
    this.corked = 0;
    this.buffered = [];
    this.needDrain = false;
    this.ending = false;
    this.ended = false;
    this.finished = false;
    this.finalCalled = false;
    this.prefinished = false;
    this.destroyed = false;
    this.closed = false;
    this.closeEmitted = false;
    this.errored = null;
    this.errorEmitted = false;
    this.emitClose = !options || options.emitClose !== false;
    this.autoDestroy = !options || options.autoDestroy !== false;
    this.pendingcb = 0;
    this.stream = stream;
  }
}

export function Writable(options) {
  /* as Node checks: Duplex first, and without Writable's Symbol.hasInstance (which reads
   * _writableState: a lazy stream, crypto's Hash, would make it while it is being made) */
  if (!(this instanceof Duplex) && !Function.prototype[Symbol.hasInstance].call(Writable, this)) return new Writable(options);
  Stream.call(this, options);
  this._writableState = new WritableState(options, this);
  if (options) {
    if (typeof options.write === "function") this._write = options.write;
    if (typeof options.writev === "function") this._writev = options.writev;
    if (typeof options.destroy === "function") this._destroy = options.destroy;
    if (typeof options.final === "function") this._final = options.final;
    if (options.signal) addAbortSignal(options.signal, this);
  }
}
Object.setPrototypeOf(Writable.prototype, Stream.prototype);
Object.setPrototypeOf(Writable, Stream);

Object.defineProperty(Writable, Symbol.hasInstance, {
  value(object) {
    if (Function.prototype[Symbol.hasInstance].call(this, object)) return true;
    if (this !== Writable) return false;
    return !!(object && object._writableState);
  },
  configurable: true,
});

Writable.prototype._write = function (chunk, encoding, cb) {
  if (this._writev) this._writev([{ chunk, encoding }], cb);
  else throw codeError(Error, "The _write() method is not implemented", "ERR_METHOD_NOT_IMPLEMENTED");
};

Writable.prototype.write = function (chunk, encoding, cb) {
  const state = this._writableState;
  if (typeof encoding === "function") {
    cb = encoding;
    encoding = null;
  }
  if (!encoding) encoding = state.defaultEncoding;
  if (typeof cb !== "function") cb = () => {};
  if (chunk === null) throw codeError(TypeError, "May not write null values to stream", "ERR_STREAM_NULL_VALUES");
  if (!state.objectMode) {
    if (typeof chunk === "string") {
      if (state.decodeStrings !== false) {
        chunk = Buffer.from(chunk, encoding);
        encoding = "buffer";
      }
    } else if (isUint8(chunk)) {
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      encoding = "buffer";
    } else {
      throw codeError(TypeError, 'The "chunk" argument must be of type string or an instance of Buffer or Uint8Array.', "ERR_INVALID_ARG_TYPE");
    }
  }
  let err;
  if (state.ending) err = codeError(Error, "write after end", "ERR_STREAM_WRITE_AFTER_END");
  else if (state.destroyed) err = codeError(Error, "Cannot call write after a stream was destroyed", "ERR_STREAM_DESTROYED");
  if (err) {
    nextTick(cb, err);
    errorOrDestroy(this, err, true);
    return err;
  }
  state.pendingcb++;
  const len = state.objectMode ? 1 : chunk.length;
  state.length += len;
  const ret = state.length < state.highWaterMark;
  if (!ret) state.needDrain = true;
  if (state.writing || state.corked || state.errored) state.buffered.push({ chunk, encoding, callback: cb });
  else doWrite(this, state, len, chunk, encoding, cb);
  return ret && !state.errored && !state.destroyed;
};

function doWrite(stream, state, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (state.destroyed) onwrite(stream, codeError(Error, "Cannot call write after a stream was destroyed", "ERR_STREAM_DESTROYED"));
  else stream._write(chunk, encoding, (er) => onwrite(stream, er));
  state.sync = false;
}

function onwrite(stream, er) {
  const state = stream._writableState;
  const cb = state.writecb;
  if (typeof cb !== "function") {
    errorOrDestroy(stream, codeError(Error, "Callback called multiple times", "ERR_MULTIPLE_CALLBACK"));
    return;
  }
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
  if (er) {
    if (!state.errored) state.errored = er;
    if (state.sync) nextTick(onwriteError, stream, state, er, cb);
    else onwriteError(stream, state, er, cb);
    return;
  }
  if (state.buffered.length > 0) clearBuffer(stream, state);
  if (state.sync) nextTick(afterWrite, stream, state, cb);
  else afterWrite(stream, state, cb);
}

function onwriteError(stream, state, er, cb) {
  --state.pendingcb;
  cb(er);
  errorBuffer(state);
  errorOrDestroy(stream, er);
}

function afterWrite(stream, state, cb) {
  const needDrain = !state.ending && !stream.destroyed && state.length === 0 && state.needDrain;
  if (needDrain) {
    state.needDrain = false;
    stream.emit("drain");
  }
  state.pendingcb--;
  cb(null);
  if (state.destroyed) errorBuffer(state);
  finishMaybe(stream, state);
}

function errorBuffer(state) {
  if (state.writing) return;
  for (const { chunk, callback } of state.buffered) {
    state.length -= state.objectMode ? 1 : chunk.length;
    state.pendingcb--;
    callback(state.errored ?? codeError(Error, "Cannot call write after a stream was destroyed", "ERR_STREAM_DESTROYED"));
  }
  state.buffered = [];
}

function clearBuffer(stream, state) {
  if (state.corked || state.destroyed || state.writing || state.buffered.length === 0) return;
  const { chunk, encoding, callback } = state.buffered.shift();
  doWrite(stream, state, state.objectMode ? 1 : chunk.length, chunk, encoding, callback);
}

Writable.prototype.cork = function () {
  this._writableState.corked++;
};

Writable.prototype.uncork = function () {
  const state = this._writableState;
  if (state.corked) {
    state.corked--;
    if (!state.writing) clearBuffer(this, state);
  }
};

Writable.prototype.setDefaultEncoding = function (encoding) {
  this._writableState.defaultEncoding = encoding;
  return this;
};

Writable.prototype.end = function (chunk, encoding, cb) {
  const state = this._writableState;
  if (typeof chunk === "function") {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === "function") {
    cb = encoding;
    encoding = null;
  }
  let err;
  if (chunk !== null && chunk !== undefined) {
    const ret = this.write(chunk, encoding);
    if (ret instanceof Error) err = ret;
  }
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }
  if (err) {
    /* already reported */
  } else if (!state.errored && !state.ending) {
    state.ending = true;
    finishMaybe(this, state, true);
    state.ended = true;
  } else if (state.finished) {
    err = codeError(Error, "Cannot call end after a stream was finished", "ERR_STREAM_ALREADY_FINISHED");
  } else if (state.destroyed) {
    err = codeError(Error, "Cannot call end after a stream was destroyed", "ERR_STREAM_DESTROYED");
  }
  if (typeof cb === "function") {
    if (err || state.finished) nextTick(cb, err);
    else (state.finishCallbacks ||= []).push(cb);
  }
  return this;
};

function needFinish(state) {
  return state.ending && !state.destroyed && state.length === 0 && !state.errored && state.buffered.length === 0 &&
    !state.finished && !state.writing && !state.errorEmitted && !state.closeEmitted;
}

function prefinish(stream, state) {
  if (!state.prefinished && !state.finalCalled) {
    if (typeof stream._final === "function" && !state.destroyed) {
      state.finalCalled = true;
      state.sync = true;
      state.pendingcb++;
      let called = false;
      const onFinal = (err) => {
        if (called) return;
        called = true;
        state.pendingcb--;
        if (err) {
          for (const cb of state.finishCallbacks || []) cb(err);
          state.finishCallbacks = [];
          errorOrDestroy(stream, err, state.sync);
        } else if (needFinish(state)) {
          state.prefinished = true;
          stream.emit("prefinish");
          state.pendingcb++;
          nextTick(finish, stream, state);
        }
      };
      try {
        stream._final(onFinal);
      } catch (err) {
        onFinal(err);
      }
      state.sync = false;
    } else {
      state.prefinished = true;
      stream.emit("prefinish");
    }
  }
}

function finishMaybe(stream, state, sync) {
  if (needFinish(state)) {
    prefinish(stream, state);
    if (state.pendingcb === 0) {
      if (sync) {
        state.pendingcb++;
        nextTick(() => {
          if (needFinish(state)) finish(stream, state);
          else state.pendingcb--;
        });
      } else if (needFinish(state)) {
        state.pendingcb++;
        finish(stream, state);
      }
    }
  }
}

function finish(stream, state) {
  state.pendingcb--;
  state.finished = true;
  for (const cb of state.finishCallbacks || []) cb(null);
  state.finishCallbacks = [];
  stream.emit("finish");
  if (state.autoDestroy) {
    const rState = stream._readableState;
    const autoDestroy = !rState || (rState.autoDestroy && (rState.endEmitted || rState.readable === false));
    if (autoDestroy) stream.destroy();
  }
}

const writableGetters = {
  writable: (s, st) => !!(st.writable !== false && !st.destroyed && !st.errored && !st.ending && !st.ended),
  writableFinished: (s, st) => st.finished,
  writableObjectMode: (s, st) => st.objectMode,
  writableBuffer: (s, st) => st.buffered.map((b) => b.chunk),
  writableEnded: (s, st) => st.ending,
  writableNeedDrain: (s, st) => !st.destroyed && !st.ending && st.needDrain,
  writableHighWaterMark: (s, st) => st.highWaterMark,
  writableCorked: (s, st) => st.corked,
  writableLength: (s, st) => st.length,
  writableAborted: (s, st) => !!(st.writable !== false && (st.destroyed || st.errored) && !st.finished),
};
for (const name of Object.keys(writableGetters)) {
  const get = writableGetters[name];
  Object.defineProperty(Writable.prototype, name, {
    get() {
      const st = this._writableState;
      return st ? get(this, st) : undefined;
    },
    set(v) {
      if (name === "writable" && this._writableState) this._writableState.writable = v;
    },
    enumerable: false,
    configurable: true,
  });
}
for (const name of ["destroyed", "errored", "closed"]) {
  Object.defineProperty(Writable.prototype, name, {
    get() {
      const st = this._writableState;
      return st ? (name === "destroyed" ? st.destroyed : name === "errored" ? st.errored : st.closed) : undefined;
    },
    set(v) {
      if (name === "destroyed" && this._writableState) this._writableState.destroyed = v;
    },
    enumerable: false,
    configurable: true,
  });
}

Writable.fromWeb = function (writableStream) {
  const writer = writableStream.getWriter();
  return new Writable({
    write(chunk, encoding, cb) {
      writer.write(chunk).then(() => cb(), cb);
    },
    final(cb) {
      writer.close().then(() => cb(), cb);
    },
  });
};

/* ---- destroy --------------------------------------------------------------------------------- */

function destroyImpl(stream, err, cb) {
  const r = stream._readableState;
  const w = stream._writableState;
  const s = w || r;
  if ((w && w.destroyed) || (r && r.destroyed)) {
    if (typeof cb === "function") cb();
    return stream;
  }
  if (err) {
    if (w && !w.errored) w.errored = err;
    if (r && !r.errored) r.errored = err;
  }
  if (w) w.destroyed = true;
  if (r) r.destroyed = true;
  const onDestroy = (er) => {
    if (er) {
      if (w && !w.errored) w.errored = er;
      if (r && !r.errored) r.errored = er;
    }
    if (w) w.closed = true;
    if (r) r.closed = true;
    if (typeof cb === "function") cb(er);
    nextTick(() => {
      if (er) emitErrorNT(stream, er);
      if ((w && w.emitClose === false) || (r && r.emitClose === false)) return;
      if (w) w.closeEmitted = true;
      if (r) r.closeEmitted = true;
      stream.emit("close");
    });
  };
  try {
    stream._destroy(err || null, onDestroy);
  } catch (e) {
    onDestroy(e);
  }
  void s;
  return stream;
}

function emitErrorNT(stream, err) {
  const r = stream._readableState;
  const w = stream._writableState;
  if ((w && w.errorEmitted) || (r && r.errorEmitted)) return;
  if (w) w.errorEmitted = true;
  if (r) r.errorEmitted = true;
  stream.emit("error", err);
}

function errorOrDestroy(stream, err, sync) {
  const r = stream._readableState;
  const w = stream._writableState;
  if ((w && w.destroyed) || (r && r.destroyed)) return;
  if ((r && r.autoDestroy) || (w && w.autoDestroy)) stream.destroy(err);
  else if (err) {
    if (w && !w.errored) w.errored = err;
    if (r && !r.errored) r.errored = err;
    if (sync) nextTick(emitErrorNT, stream, err);
    else emitErrorNT(stream, err);
  }
}

Readable.prototype.destroy = function (err, cb) {
  return destroyImpl(this, err, cb);
};
Readable.prototype._destroy = function (err, cb) {
  cb(err);
};
Writable.prototype.destroy = Readable.prototype.destroy;
Writable.prototype._destroy = Readable.prototype._destroy;

/* ---- Duplex, Transform, PassThrough ---------------------------------------------------------- */

export function Duplex(options) {
  if (!(this instanceof Duplex)) return new Duplex(options);
  Readable.call(this, options);
  Writable.call(this, options);
  if (options) {
    this.allowHalfOpen = options.allowHalfOpen !== false;
    if (options.readable === false) {
      this._readableState.readable = false;
      this._readableState.ended = this._readableState.endEmitted = true;
    }
    if (options.writable === false) {
      this._writableState.writable = false;
      this._writableState.ending = this._writableState.ended = this._writableState.finished = true;
    }
  } else {
    this.allowHalfOpen = true;
  }
}
Object.setPrototypeOf(Duplex.prototype, Readable.prototype);
Object.setPrototypeOf(Duplex, Readable);
for (const key of Object.getOwnPropertyNames(Writable.prototype)) {
  if (key === "constructor" || key === "destroy" || key === "_destroy" || Object.prototype.hasOwnProperty.call(Duplex.prototype, key)) continue;
  if (key === "destroyed" || key === "errored" || key === "closed") continue;
  Object.defineProperty(Duplex.prototype, key, Object.getOwnPropertyDescriptor(Writable.prototype, key));
}

export function Transform(options) {
  if (!(this instanceof Transform)) return new Transform(options);
  Duplex.call(this, options);
  this._readableState.sync = false;
  this._transformCallback = null;
  if (options) {
    if (typeof options.transform === "function") this._transform = options.transform;
    if (typeof options.flush === "function") this._flush = options.flush;
  }
  this.on("prefinish", transformPrefinish);
}
Object.setPrototypeOf(Transform.prototype, Duplex.prototype);
Object.setPrototypeOf(Transform, Duplex);

/* _flush, then the end of the readable side; cb is absent when it runs on 'prefinish' because a
 * subclass replaced _final (zlib's streams do) */
function transformFinal(cb) {
  if (typeof this._flush === "function" && !this.destroyed) {
    this._flush((er, data) => {
      if (er) {
        if (cb) cb(er);
        else this.destroy(er);
        return;
      }
      if (data !== null && data !== undefined) this.push(data);
      this.push(null);
      if (cb) cb();
    });
  } else {
    this.push(null);
    if (cb) cb();
  }
}

function transformPrefinish() {
  if (this._final !== transformFinal) transformFinal.call(this);
}

Transform.prototype._final = transformFinal;

Transform.prototype._transform = function () {
  throw codeError(Error, "The _transform() method is not implemented", "ERR_METHOD_NOT_IMPLEMENTED");
};

Transform.prototype._write = function (chunk, encoding, callback) {
  const rState = this._readableState;
  const wState = this._writableState;
  const length = rState.length;
  this._transform(chunk, encoding, (err, val) => {
    if (err) {
      callback(err);
      return;
    }
    if (val !== null && val !== undefined) this.push(val);
    if (rState.ended) nextTick(callback);
    else if (wState.ended || length === rState.length || rState.length < rState.highWaterMark) callback();
    else this._transformCallback = callback;
  });
};

Transform.prototype._read = function () {
  if (this._transformCallback) {
    const callback = this._transformCallback;
    this._transformCallback = null;
    callback();
  }
};

export function PassThrough(options) {
  if (!(this instanceof PassThrough)) return new PassThrough(options);
  Transform.call(this, options);
}
Object.setPrototypeOf(PassThrough.prototype, Transform.prototype);
Object.setPrototypeOf(PassThrough, Transform);
PassThrough.prototype._transform = function (chunk, encoding, cb) {
  cb(null, chunk);
};

/* ---- finished, pipeline, addAbortSignal ------------------------------------------------------ */

export function finished(stream, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};
  let called = false;
  const done = (err) => {
    if (called) return;
    called = true;
    cleanup();
    callback.call(stream, err);
  };
  const r = stream._readableState;
  const w = stream._writableState;
  const readable = options.readable ?? (r !== undefined && r.readable !== false);
  const writable = options.writable ?? (w !== undefined && w.writable !== false);
  let readableFinished = !r || r.endEmitted;
  let writableFinished = !w || w.finished;
  const onfinish = () => {
    writableFinished = true;
    if (!readable || readableFinished) done();
  };
  const onend = () => {
    readableFinished = true;
    if (!writable || writableFinished) done();
  };
  const onerror = (err) => done(err);
  const onclose = () => {
    if (readable && !readableFinished && !(r && r.endEmitted)) return done(prematureClose());
    if (writable && !writableFinished && !(w && w.finished)) return done(prematureClose());
    done();
  };
  const onrequest = () => stream.req && stream.req.on("finish", onfinish);
  stream.on("end", onend);
  stream.on("finish", onfinish);
  stream.on("error", onerror);
  stream.on("close", onclose);
  if (stream.req) onrequest();
  function cleanup() {
    stream.removeListener("end", onend);
    stream.removeListener("finish", onfinish);
    stream.removeListener("error", onerror);
    stream.removeListener("close", onclose);
  }
  const errored = (w && w.errored) || (r && r.errored);
  if (errored) nextTick(done, errored);
  else if ((w && w.closeEmitted) || (r && r.closeEmitted)) nextTick(onclose);
  else if ((!readable || readableFinished) && (!writable || writableFinished) && (r || w)) nextTick(done);
  return cleanup;
}

export function pipeline(...streams) {
  const callback = typeof streams[streams.length - 1] === "function" ? streams.pop() : null;
  if (Array.isArray(streams[0]) && streams.length === 1) streams = streams[0];
  if (streams.length < 2) throw codeError(TypeError, 'The "streams" argument must be specified', "ERR_MISSING_ARGS");
  streams = streams.map((s, i) => {
    if (typeof s === "function") s = s(i === 0 ? undefined : streams[i - 1]);
    if (s && typeof s.getReader === "function") return Readable.fromWeb(s);
    if (s && !s._readableState && !s._writableState && (s[Symbol.asyncIterator] || s[Symbol.iterator])) return Readable.from(s);
    return s;
  });
  let error;
  let remaining = streams.length;
  const destroys = [];
  const finish = (err) => {
    if (err && !error) {
      error = err;
      for (const d of destroys) d(err);
    }
    if (--remaining === 0 && callback) callback(error);
  };
  for (let i = 0; i < streams.length; i++) {
    const s = streams[i];
    const reading = i < streams.length - 1;
    const writing = i > 0;
    finished(s, { readable: reading, writable: writing }, (err) => finish(err));
    destroys.push((err) => {
      if (!s.destroyed) s.destroy(err);
    });
    if (reading) s.pipe(streams[i + 1]);
  }
  return streams[streams.length - 1];
}

export function addAbortSignal(signal, stream) {
  const onAbort = () => stream.destroy(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal.reason }));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return stream;
}

export const promises = {
  pipeline(...streams) {
    return new Promise((resolve, reject) => {
      const last = streams[streams.length - 1];
      if (last && typeof last === "object" && !last._readableState && !last._writableState && !last.pipe && !last.getReader) streams.pop();
      pipeline(...streams, (err) => (err ? reject(err) : resolve()));
    });
  },
  finished(stream, opts) {
    return new Promise((resolve, reject) => finished(stream, opts || {}, (err) => (err ? reject(err) : resolve())));
  },
};

export function isReadable(stream) {
  return !!(stream && stream._readableState && stream.readable);
}
export function isErrored(stream) {
  return !!(stream && ((stream._readableState && stream._readableState.errored) || (stream._writableState && stream._writableState.errored)));
}
export function isDisturbed(stream) {
  return !!(stream && stream._readableState && (stream._readableState.dataEmitted || stream._readableState.endEmitted || stream.readableDidRead));
}

/* ---- the other functions ------------------------------------------------------------------ */

let defaultHighWaterMark = 65536;
let defaultObjectHighWaterMark = 16;

/** The highWaterMark a stream gets without one: bytes, or objects in object mode. */
export function getDefaultHighWaterMark(objectMode) {
  return objectMode ? defaultObjectHighWaterMark : defaultHighWaterMark;
}

export function setDefaultHighWaterMark(objectMode, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw codeError(RangeError, 'The value of "value" is out of range. It must be >= 0 && <= 9007199254740991. Received ' + value, "ERR_OUT_OF_RANGE");
  }
  if (objectMode) defaultObjectHighWaterMark = value;
  else defaultHighWaterMark = value;
}

const isNodeStream = (stream) => !!stream && typeof stream === "object" &&
  (stream._readableState !== undefined || stream._writableState !== undefined || (typeof stream.pipe === "function" && typeof stream.on === "function"));

/** Destroys a stream (a request is aborted), with the error if given. */
export function destroy(stream, err) {
  if (!stream || typeof stream !== "object") return;
  if (typeof stream.setHeader === "function" && typeof stream.abort === "function") stream.abort();
  else if (typeof stream.destroy === "function") stream.destroy(err);
  else if (typeof stream.close === "function") stream.close();
}

/** Whether a Node stream is destroyed; null for anything else. */
export function isDestroyed(stream) {
  if (!isNodeStream(stream)) return null;
  const state = stream._writableState || stream._readableState;
  return !!(stream.destroyed || state?.destroyed);
}

/** Whether a stream can still be written to; null for one that isn't writable at all. */
export function isWritable(stream) {
  if (typeof stream?.writable !== "boolean") return null;
  if (isDestroyed(stream)) return false;
  const w = stream._writableState;
  return !!w && stream.writable && !(w.ended || stream.writableEnded);
}

/* compose and duplexPair: internal/stream_compose.js, linked when the program names them */
export const duplexPair = lazyFunction("duplexPair");
export const compose = lazyFunction("compose");

Stream.Stream = Stream;
Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Duplex = Duplex;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;
Stream.pipeline = pipeline;
Stream.finished = finished;
Stream.addAbortSignal = addAbortSignal;
Stream.promises = promises;
Stream.isReadable = isReadable;
Stream.isErrored = isErrored;
Stream.isDisturbed = isDisturbed;
Object.assign(Stream, { compose, destroy, duplexPair, getDefaultHighWaterMark, isDestroyed, isWritable, setDefaultHighWaterMark });

export default Stream;
