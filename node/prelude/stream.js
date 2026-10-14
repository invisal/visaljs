// node:stream, as Node's lib/stream.js: the legacy Stream with Readable, Writable, Duplex,
// Transform, PassThrough, pipeline, finished and the rest on it, from the port of Node's
// lib/internal/streams in internal/streams/. The operators (map, filter, …), compose,
// Duplex.from, duplexPair and the conversions to and from web streams are modules of their own,
// linked into programs that name them (internal/features.js, implicitModules in node/index.ts).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { Buffer } from "./buffer.js";
import { feature, lazyConstructor, lazyFunction } from "./internal/features.js";
import { addAbortSignal } from "./internal/streams/add_abort_signal.js";
import { destroyer } from "./internal/streams/destroy.js";
import Duplex from "./internal/streams/duplex.js";
import { eos, finished as eosFinished } from "./internal/streams/end_of_stream.js";
import { Stream } from "./internal/streams/legacy.js";
import Readable from "./internal/streams/readable.js";
import { getDefaultHighWaterMark, setDefaultHighWaterMark } from "./internal/streams/state.js";
import { isDestroyed, isDisturbed, isErrored, isIterable, isNodeStream, isReadable, isWebStream, isWritable } from "./internal/streams/utils.js";
import Writable from "./internal/streams/writable.js";

const customPromisify = Symbol.for("nodejs.util.promisify.custom");

/* stream/promises (lib/stream/promises.js) */
function promisesPipeline(...streams) {
  return new Promise((resolve, reject) => {
    let signal;
    let end;
    const lastArg = streams[streams.length - 1];
    if (lastArg && typeof lastArg === "object" && !isNodeStream(lastArg) && !isIterable(lastArg) && !isWebStream(lastArg)) {
      const options = streams.pop();
      signal = options.signal;
      end = options.end;
    }
    feature("pipelineImpl")(streams, (err, value) => {
      if (err) reject(err);
      else resolve(value);
    }, { signal, end });
  });
}
export const promises = { finished: eosFinished, pipeline: promisesPipeline };

/* the rarer parts, modules of their own linked into programs that name them: pipeline
 * (internal/stream_pipeline.js), Transform and PassThrough (internal/stream_transform.js),
 * compose and duplexPair (internal/stream_compose.js) */
export const pipeline = lazyFunction("pipeline");
export const Transform = lazyConstructor("Transform");
export const PassThrough = lazyConstructor("PassThrough");
export const compose = lazyFunction("compose");
export const duplexPair = lazyFunction("duplexPair");

Stream.isDestroyed = isDestroyed;
Stream.isDisturbed = isDisturbed;
Stream.isErrored = isErrored;
Stream.isReadable = isReadable;
Stream.isWritable = isWritable;
Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Duplex = Duplex;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;
Stream.duplexPair = duplexPair;
Stream.pipeline = pipeline;
Stream.addAbortSignal = addAbortSignal;
Stream.finished = eos;
Stream.destroy = destroyer;
Stream.compose = compose;
Stream.setDefaultHighWaterMark = setDefaultHighWaterMark;
Stream.getDefaultHighWaterMark = getDefaultHighWaterMark;
Object.defineProperty(Stream, "promises", { __proto__: null, configurable: true, enumerable: true, get: () => promises });
Object.defineProperty(pipeline, customPromisify, { __proto__: null, enumerable: true, get: () => promises.pipeline });
Object.defineProperty(eos, customPromisify, { __proto__: null, enumerable: true, get: () => promises.finished });

/* backwards compatibility with node 0.4.x */
Stream.Stream = Stream;
Stream._isArrayBufferView = ArrayBuffer.isView;
Stream._isUint8Array = (value) => value instanceof Uint8Array;
Stream._uint8ArrayToBuffer = function _uint8ArrayToBuffer(chunk) {
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
};

export {
  addAbortSignal, destroyer as destroy, Duplex, eos as finished, getDefaultHighWaterMark, isDestroyed, isDisturbed, isErrored, isReadable,
  isWritable, Readable, setDefaultHighWaterMark, Stream, Writable,
};
export default Stream;
