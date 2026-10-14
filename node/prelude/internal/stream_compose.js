// stream.compose, Duplex.from, readable.compose and stream.duplexPair: Node's
// internal/streams/compose.js, duplexify.js and duplexpair.js, linked into programs that name
// them (implicitModules in node/index.ts, internal/features.js).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { Duplex } from "../stream.js";
import { features } from "./features.js";
import compose from "./streams/compose.js";
import duplexify from "./streams/duplexify.js";
/* Duplex.from of web streams converts them */
import "./stream_web_adapters.js";

const kCallback = Symbol("Callback");
const kInitOtherSide = Symbol("InitOtherSide");

/* one end of a duplexPair: what's written to it comes out of the other end */
class DuplexSide extends Duplex {
  #otherSide = null;

  constructor(options) {
    super(options);
    this[kCallback] = null;
    this.#otherSide = null;
  }

  [kInitOtherSide](otherSide) {
    if (this.#otherSide === null) this.#otherSide = otherSide;
  }

  _read() {
    const callback = this[kCallback];
    if (callback) {
      this[kCallback] = null;
      callback();
    }
  }

  _write(chunk, encoding, callback) {
    if (chunk.length === 0) {
      process.nextTick(callback);
    } else {
      this.#otherSide.push(chunk);
      this.#otherSide[kCallback] = callback;
    }
  }

  _final(callback) {
    this.#otherSide.on("end", callback);
    this.#otherSide.push(null);
  }

  _destroy(err, callback) {
    const otherSide = this.#otherSide;
    if (otherSide !== null && !otherSide.destroyed) {
      process.nextTick(() => {
        if (otherSide.destroyed) return;
        if (err) otherSide.destroy();
        else otherSide.push(null);
      });
    }
    callback(err);
  }
}

function duplexPair(options) {
  const side0 = new DuplexSide(options);
  const side1 = new DuplexSide(options);
  side0[kInitOtherSide](side1);
  side1[kInitOtherSide](side0);
  return [side0, side1];
}

features.compose = compose;
features.duplexify = duplexify;
features.duplexPair = duplexPair;
