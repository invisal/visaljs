// stream.compose and stream.duplexPair. Linked into programs that name them (internal/features.js).
import { Duplex, pipeline } from "../stream.js";
import { codeError } from "./errors.js";
import { features } from "./features.js";

const isNodeStream = (stream) => !!stream && typeof stream === "object" &&
  (stream._readableState !== undefined || stream._writableState !== undefined || (typeof stream.pipe === "function" && typeof stream.on === "function"));

/* one end of a duplexPair: what it's written comes out of the other end */
class DuplexSide extends Duplex {
  constructor(options) {
    super(options);
    this._otherSide = null;
    this._readCallback = null;
  }
  _read() {
    const callback = this._readCallback;
    if (callback) {
      this._readCallback = null;
      callback();
    }
  }
  _write(chunk, encoding, callback) {
    if (chunk.length === 0) process.nextTick(callback);
    else {
      this._otherSide.push(chunk);
      this._otherSide._readCallback = callback;
    }
  }
  _final(callback) {
    this._otherSide.on("end", callback);
    this._otherSide.push(null);
  }
}

/** Two Duplexes, each one's writes the other's reads: an in-memory socket pair. */
function duplexPair(options) {
  const a = new DuplexSide(options);
  const b = new DuplexSide(options);
  a._otherSide = b;
  b._otherSide = a;
  return [a, b];
}

/** Streams piped one into the next, as one Duplex: writes go to the first, reads come from the
 *  last. (Node's takes functions and async iterables too: not yet.) */
function compose(...streams) {
  if (streams.length === 0) throw codeError(TypeError, "ERR_MISSING_ARGS", 'The "streams" argument must be specified');
  for (const stream of streams) {
    if (!isNodeStream(stream)) {
      const e = new Error("stream.compose of anything but streams is not supported by visaljs yet");
      e.code = "ERR_VISALJS_UNSUPPORTED";
      throw e;
    }
  }
  if (streams.length === 1) return streams[0];
  const head = streams[0];
  const tail = streams[streams.length - 1];
  const writable = !!head._writableState && head.writable !== false;
  const readable = !!tail._readableState && tail.readable !== false;
  let ondrain = null;
  let onfinish = null;
  let onclose = null;
  const d = new Duplex({
    writableObjectMode: !!head.writableObjectMode,
    readableObjectMode: !!tail.readableObjectMode,
    writable,
    readable,
  });
  pipeline(...streams, (err) => {
    const cb = onclose;
    onclose = null;
    if (cb) cb(err);
    else if (err) d.destroy(err);
    else if (!readable && !writable) d.destroy();
  });
  if (writable) {
    d._write = (chunk, encoding, callback) => {
      if (head.write(chunk, encoding)) callback();
      else ondrain = callback;
    };
    d._final = (callback) => {
      head.end();
      onfinish = callback;
    };
    head.on("drain", () => {
      const cb = ondrain;
      ondrain = null;
      if (cb) cb();
    });
    tail.on("finish", () => {
      const cb = onfinish;
      onfinish = null;
      if (cb) cb();
    });
  }
  if (readable) {
    /* the last stream's chunks as it emits them, paused while the Duplex's buffer is full (Node
       24's; 22's read() drained it, joining the chunks) */
    d._read = () => {
      tail.resume();
    };
    tail.on("data", (chunk) => {
      if (!d.push(chunk)) tail.pause();
    });
    tail.on("end", () => d.push(null));
  }
  d._destroy = (err, callback) => {
    ondrain = onfinish = null;
    if (tail.destroyed) callback(err);
    else {
      onclose = callback;
      tail.destroy(err);
    }
  };
  return d;
}

Object.assign(features, { compose, duplexPair });
