// CompressionStream and DecompressionStream, as Node's (lib/internal/webstreams/compression.js):
// a node:zlib stream as a readable and writable pair of web streams. Decompression rejects
// trailing data (rejectGarbageAfterEnd). Linked into programs that name them (implicitModules in
// node/index.ts); they are globals and node:stream/web's.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { CompressionStream as CompressionWrapper, DecompressionStream as DecompressionWrapper } from "../stream_web.js";
import { createBrotliCompress, createBrotliDecompress, createDeflate, createDeflateRaw, createGunzip, createGzip, createInflate,
  createInflateRaw } from "../zlib.js";
import { codeError, invalidArgType } from "./errors.js";
import { provideClass } from "./features.js";

const kInspect = Symbol.for("nodejs.util.inspect.custom");
const FORMATS = new Set(["deflate", "deflate-raw", "gzip", "brotli"]);

/** webidl's CompressionFormat enum */
function format(value, constructor) {
  const s = String(value);
  if (!FORMATS.has(s)) {
    throw codeError(TypeError, "ERR_INVALID_ARG_VALUE",
      `Failed to construct '${constructor}': 1st argument '${s}' is not a valid enum value of type CompressionFormat.`);
  }
  return s;
}

/** newReadableWritablePairFromDuplex: the duplex's output as a ReadableStream, its input as a
 *  WritableStream; an error of either side errors both */
function pairFromDuplex(duplex) {
  let readableController, writableController;
  let closed = false;
  const onError = (error) => {
    if (closed) return;
    closed = true;
    readableController.error(error);
    writableController.error(error);
  };
  duplex.on("error", onError);
  const readable = new ReadableStream({
    start(controller) {
      readableController = controller;
      duplex.on("data", (chunk) => {
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if (controller.desiredSize <= 0) duplex.pause();
      });
      duplex.on("end", () => {
        if (closed) return;
        closed = true;
        controller.close();
      });
    },
    pull() {
      duplex.resume();
    },
    cancel(reason) {
      duplex.destroy(reason);
    },
  });
  const writable = new WritableStream({
    start(controller) {
      writableController = controller;
    },
    write(chunk) {
      /* a BufferSource, not backed by a SharedArrayBuffer */
      if (typeof SharedArrayBuffer === "function" && (ArrayBuffer.isView(chunk) ? chunk.buffer : chunk) instanceof SharedArrayBuffer) {
        throw invalidArgType("chunk", "an instance of ArrayBuffer, Buffer, TypedArray, or DataView", chunk);
      }
      return new Promise((resolve, reject) => {
        try {
          if (duplex.write(chunk)) resolve();
          else duplex.once("drain", resolve);
        } catch (error) {
          duplex.destroy(error);
          reject(error);
        }
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        duplex.once("finish", resolve);
        duplex.once("error", reject);
        duplex.end();
      });
    },
    abort(reason) {
      duplex.destroy(reason);
    },
  });
  return { readable, writable };
}

function inspectAs(name, self, depth, options, inspect) {
  if (depth < 0) return self;
  const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
  return `${name} ${inspect({ readable: self.readable, writable: self.writable }, opts)}`;
}

class CompressionStream {
  #transform;

  constructor(kind) {
    kind = format(kind, "CompressionStream");
    const handle = kind === "deflate" ? createDeflate() : kind === "deflate-raw" ? createDeflateRaw() : kind === "gzip" ? createGzip()
      : createBrotliCompress();
    this.#transform = pairFromDuplex(handle);
  }

  get readable() {
    return this.#transform.readable;
  }

  get writable() {
    return this.#transform.writable;
  }

  [kInspect](depth, options, inspect) {
    return inspectAs("CompressionStream", this, depth, options, inspect);
  }
}

class DecompressionStream {
  #transform;

  constructor(kind) {
    kind = format(kind, "DecompressionStream");
    const options = { rejectGarbageAfterEnd: true };
    const handle = kind === "deflate" ? createInflate(options) : kind === "deflate-raw" ? createInflateRaw(options)
      : kind === "gzip" ? createGunzip(options) : createBrotliDecompress(options);
    this.#transform = pairFromDuplex(handle);
  }

  get readable() {
    return this.#transform.readable;
  }

  get writable() {
    return this.#transform.writable;
  }

  [kInspect](depth, options, inspect) {
    return inspectAs("DecompressionStream", this, depth, options, inspect);
  }
}

for (const [Class, name] of [[CompressionStream, "CompressionStream"], [DecompressionStream, "DecompressionStream"]]) {
  Object.defineProperties(Class.prototype, {
    readable: { enumerable: true },
    writable: { enumerable: true },
    [Symbol.toStringTag]: { configurable: true, value: name },
  });
}
provideClass(CompressionWrapper, CompressionStream);
provideClass(DecompressionWrapper, DecompressionStream);
Object.defineProperty(globalThis, "CompressionStream", { value: CompressionWrapper, writable: true, enumerable: false, configurable: true });
Object.defineProperty(globalThis, "DecompressionStream", { value: DecompressionWrapper, writable: true, enumerable: false, configurable: true });
