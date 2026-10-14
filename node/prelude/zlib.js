// node:zlib: Node's lib/zlib.js (v24) on Node's binding, which is C here
// (node/src/host_zlib.c over Chromium's zlib, the copy Node vendors): the same streams, the same
// convenience functions, and the same compressed bytes, Brotli's and zstd's too (node/src/host_brotli.c
// and host_zstd.c, linked into programs that name them: internal/zlib_engines.js). A write's
// callback runs a turn later, where Node's thread pool would call it back.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { timerStart, zlibClose, zlibCrc32, zlibInit, zlibNew, zlibParams, zlibReset, zlibWrite } from "visaljs:host";
import { Buffer, kMaxLength } from "./buffer.js";
import { codeError, invalidArgType, outOfRange } from "./internal/errors.js";
import { finished } from "./stream.js";
import Transform from "./internal/streams/transform.js";
import { deprecate } from "./util.js";
import { engines } from "./internal/zlib_engines.js";

/* Node's zlib.constants: a null-prototype object, not frozen */
export const constants = {
  __proto__: null,
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_OK: 0,
  Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1, Z_FILTERED: 1, Z_HUFFMAN_ONLY: 2, Z_RLE: 3, Z_FIXED: 4, Z_DEFAULT_STRATEGY: 0,
  ZLIB_VERNUM: 4880, DEFLATE: 1, INFLATE: 2, GZIP: 3, GUNZIP: 4, DEFLATERAW: 5, INFLATERAW: 6, UNZIP: 7,
  BROTLI_DECODE: 8, BROTLI_ENCODE: 9, ZSTD_DECOMPRESS: 11, ZSTD_COMPRESS: 10, Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15, Z_DEFAULT_WINDOWBITS: 15, Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: 16384, Z_MIN_MEMLEVEL: 1, Z_MAX_MEMLEVEL: 9, Z_DEFAULT_MEMLEVEL: 8, Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9, Z_DEFAULT_LEVEL: -1, BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_FINISH: 2, BROTLI_OPERATION_EMIT_METADATA: 3, BROTLI_PARAM_MODE: 0, BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT: 1, BROTLI_MODE_FONT: 2, BROTLI_DEFAULT_MODE: 0, BROTLI_PARAM_QUALITY: 1,
  BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11, BROTLI_PARAM_LGWIN: 2,
  BROTLI_MIN_WINDOW_BITS: 10, BROTLI_MAX_WINDOW_BITS: 24, BROTLI_LARGE_MAX_WINDOW_BITS: 30,
  BROTLI_DEFAULT_WINDOW: 22, BROTLI_PARAM_LGBLOCK: 3, BROTLI_MIN_INPUT_BLOCK_BITS: 16,
  BROTLI_MAX_INPUT_BLOCK_BITS: 24, BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4, BROTLI_PARAM_SIZE_HINT: 5,
  BROTLI_PARAM_LARGE_WINDOW: 6, BROTLI_PARAM_NPOSTFIX: 7, BROTLI_PARAM_NDIRECT: 8,
  BROTLI_DECODER_RESULT_ERROR: 0, BROTLI_DECODER_RESULT_SUCCESS: 1, BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3, BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
  BROTLI_DECODER_PARAM_LARGE_WINDOW: 1, BROTLI_DECODER_NO_ERROR: 0, BROTLI_DECODER_SUCCESS: 1,
  BROTLI_DECODER_NEEDS_MORE_INPUT: 2, BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1, BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4, BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
  BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6, BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
  BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8, BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10, BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
  BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12, BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14, BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
  BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16, BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
  BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20, BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
  BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22, BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26, BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
  BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30, BROTLI_DECODER_ERROR_UNREACHABLE: -31, ZSTD_e_continue: 0,
  ZSTD_e_flush: 1, ZSTD_e_end: 2, ZSTD_fast: 1, ZSTD_dfast: 2, ZSTD_greedy: 3, ZSTD_lazy: 4, ZSTD_lazy2: 5,
  ZSTD_btlazy2: 6, ZSTD_btopt: 7, ZSTD_btultra: 8, ZSTD_btultra2: 9, ZSTD_c_compressionLevel: 100,
  ZSTD_c_windowLog: 101, ZSTD_c_hashLog: 102, ZSTD_c_chainLog: 103, ZSTD_c_searchLog: 104,
  ZSTD_c_minMatch: 105, ZSTD_c_targetLength: 106, ZSTD_c_strategy: 107, ZSTD_c_enableLongDistanceMatching: 160,
  ZSTD_c_ldmHashLog: 161, ZSTD_c_ldmMinMatch: 162, ZSTD_c_ldmBucketSizeLog: 163, ZSTD_c_ldmHashRateLog: 164,
  ZSTD_c_contentSizeFlag: 200, ZSTD_c_checksumFlag: 201, ZSTD_c_dictIDFlag: 202, ZSTD_c_nbWorkers: 400,
  ZSTD_c_jobSize: 401, ZSTD_c_overlapLog: 402, ZSTD_d_windowLogMax: 100, ZSTD_CLEVEL_DEFAULT: 3,
  ZSTD_error_no_error: 0, ZSTD_error_GENERIC: 1, ZSTD_error_prefix_unknown: 10,
  ZSTD_error_version_unsupported: 12, ZSTD_error_frameParameter_unsupported: 14,
  ZSTD_error_frameParameter_windowTooLarge: 16, ZSTD_error_corruption_detected: 20,
  ZSTD_error_checksum_wrong: 22, ZSTD_error_literals_headerWrong: 24, ZSTD_error_dictionary_corrupted: 30,
  ZSTD_error_dictionary_wrong: 32, ZSTD_error_dictionaryCreation_failed: 34,
  ZSTD_error_parameter_unsupported: 40, ZSTD_error_parameter_combination_unsupported: 41,
  ZSTD_error_parameter_outOfBound: 42, ZSTD_error_tableLog_tooLarge: 44,
  ZSTD_error_maxSymbolValue_tooLarge: 46, ZSTD_error_maxSymbolValue_tooSmall: 48,
  ZSTD_error_stabilityCondition_notRespected: 50, ZSTD_error_stage_wrong: 60, ZSTD_error_init_missing: 62,
  ZSTD_error_memory_allocation: 64, ZSTD_error_workSpace_tooSmall: 66, ZSTD_error_dstSize_tooSmall: 70,
  ZSTD_error_srcSize_wrong: 72, ZSTD_error_dstBuffer_null: 74, ZSTD_error_noForwardProgress_destFull: 80,
  ZSTD_error_noForwardProgress_inputEmpty: 82
};
const {
  Z_NO_FLUSH, Z_BLOCK, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH,
  Z_MIN_CHUNK, Z_MIN_WINDOWBITS, Z_MAX_WINDOWBITS, Z_MIN_LEVEL, Z_MAX_LEVEL,
  Z_MIN_MEMLEVEL, Z_MAX_MEMLEVEL, Z_DEFAULT_CHUNK, Z_DEFAULT_COMPRESSION,
  Z_DEFAULT_STRATEGY, Z_DEFAULT_WINDOWBITS, Z_DEFAULT_MEMLEVEL, Z_FIXED,
  DEFLATE, DEFLATERAW, INFLATE, INFLATERAW, GZIP, GUNZIP, UNZIP, BROTLI_DECODE, BROTLI_ENCODE, ZSTD_DECOMPRESS,
  BROTLI_OPERATION_PROCESS, BROTLI_OPERATION_FLUSH, BROTLI_OPERATION_FINISH, BROTLI_OPERATION_EMIT_METADATA,
  ZSTD_COMPRESS, ZSTD_e_continue, ZSTD_e_flush, ZSTD_e_end,
} = constants;

/* the result codes' names, both ways */
export const codes = {
  Z_OK: constants.Z_OK, Z_STREAM_END: constants.Z_STREAM_END, Z_NEED_DICT: constants.Z_NEED_DICT, Z_ERRNO: constants.Z_ERRNO,
  Z_STREAM_ERROR: constants.Z_STREAM_ERROR, Z_DATA_ERROR: constants.Z_DATA_ERROR, Z_MEM_ERROR: constants.Z_MEM_ERROR,
  Z_BUF_ERROR: constants.Z_BUF_ERROR, Z_VERSION_ERROR: constants.Z_VERSION_ERROR,
};
for (const ckey of Object.keys(codes)) codes[codes[ckey]] = ckey;
Object.freeze(codes);
/* each constant read-only and permanent, as NODE_DEFINE_CONSTANT makes them */
for (const key of Object.keys(constants)) Object.defineProperty(constants, key, { writable: false, configurable: false });

const kFlushFlag = Symbol("kFlushFlag");
const kError = Symbol("kError");
const ownerSymbol = Symbol("owner_symbol");

const isArrayBufferView = (v) => ArrayBuffer.isView(v);
const isAnyArrayBuffer = (v) => v instanceof ArrayBuffer;
const emptyBuffer = () => Buffer.alloc(0);

function assert(value, message) {
  if (!value) throw codeError(Error, "ERR_INTERNAL_ASSERTION", message ?? "Assertion failed");
}

const bufferTooLarge = (max) => codeError(RangeError, "ERR_BUFFER_TOO_LARGE", "Cannot create a Buffer larger than " + max + " bytes");

/* internal/validators' */
function validateFiniteNumber(number, name) {
  if (number === undefined) return false;
  if (Number.isFinite(number)) return true;
  if (Number.isNaN(number)) return false;
  if (typeof number !== "number") throw invalidArgType(name, "of type number", number);
  throw outOfRange(name, "a finite number", number);
}

function checkRangesOrGetDefault(number, name, lower, upper, def) {
  if (!validateFiniteNumber(number, name)) return def;
  if (number < lower || number > upper) throw outOfRange(name, ">= " + lower + " and <= " + upper, number);
  return number;
}

function validateFunction(value, name) {
  if (typeof value !== "function") throw invalidArgType(name, "of type function", value);
}

/* Node's binding object for a stream (its CompressionStream), on the host's handle: write() runs
 * the library now and calls back a turn later; a close while a write is pending waits for it, as
 * there. `ops` are the host's primitives for the library. */
class CompressionHandle {
  constructor(ops, native) {
    this._ops = ops;
    this._native = native;
    this._writeResult = null;
    this._writeCallback = null;
    this._writing = false;
    this._pendingClose = false;
    this.onerror = null;
  }

  writeSync(flush, input, inOff, inLen, out, outOff, outLen) {
    const failure = this._ops.write(this._native, flush, input, inOff, inLen, out, outOff, outLen, this._writeResult);
    if (failure !== 0) this._emitError(failure);
  }

  write(flush, input, inOff, inLen, out, outOff, outLen) {
    this._writing = true;
    const failure = this._ops.write(this._native, flush, input, inOff, inLen, out, outOff, outLen, this._writeResult);
    timerStart(() => {
      this._writing = false;
      if (failure !== 0) {
        this._emitError(failure);
        return;
      }
      this._writeCallback.call(this);
      if (this._pendingClose) this.close();
    }, -1, true, 0);
  }

  _emitError(failure) {
    this.onerror?.call(this, failure[0], failure[1], failure[2]);
    this._writing = false;
    if (this._pendingClose) this.close();
  }

  reset() {
    if (this._writing) throw new Error("Cannot reset zlib stream while a write is in progress");
    const failure = this._ops.reset(this._native);
    if (failure !== 0) this._emitError(failure);
  }

  close() {
    if (this._writing) {
      this._pendingClose = true;
      return;
    }
    this._pendingClose = false;
    this._ops.close(this._native);
  }
}

const zlibOps = { write: zlibWrite, reset: zlibReset, close: zlibClose };

class ZlibHandle extends CompressionHandle {
  constructor(mode) {
    super(zlibOps, zlibNew(mode));
  }

  init(windowBits, level, memLevel, strategy, writeResult, writeCallback, dictionary, rejectGarbageAfterEnd) {
    this._writeResult = writeResult;
    this._writeCallback = writeCallback;
    zlibInit(this._native, windowBits, level, memLevel, strategy, isArrayBufferView(dictionary) ? dictionary : undefined, rejectGarbageAfterEnd);
  }

  params(level, strategy) {
    const failure = zlibParams(this._native, level, strategy);
    if (failure !== 0) this._emitError(failure);
  }
}

/* an optional library's handle (internal/zlib_engines.js); not linked: Node's API is there, but
 * creating a stream throws */
function engine(name, what) {
  const ops = engines[name];
  if (!ops) {
    throw codeError(Error, "ERR_VISALJS_UNSUPPORTED",
      what + " isn't linked into this program: visaljs links it when the program's code names it (" + what + "Compress, …)");
  }
  return ops;
}

class BrotliHandle extends CompressionHandle {
  constructor(mode) {
    const ops = engine("brotli", "Brotli");
    super(ops, ops.new(mode));
  }

  init(params, writeResult, writeCallback, dictionary) {
    this._writeResult = writeResult;
    this._writeCallback = writeCallback;
    const failure = this._ops.init(this._native, params, dictionary);
    if (failure !== 0) {
      this._emitError(failure);
      throw codeError(Error, "ERR_ZLIB_INITIALIZATION_FAILED", "Initialization failed");
    }
  }

  /* Brotli can't change its parameters mid-stream: Node's is a no-op too */
  params() {}
}

class ZstdHandle extends CompressionHandle {
  constructor(compress) {
    const ops = engine("zstd", "Zstd");
    super(ops, ops.new(compress));
  }

  init(params, pledgedSrcSize, writeResult, writeCallback, dictionary) {
    this._writeResult = writeResult;
    this._writeCallback = writeCallback;
    /* Node 24's binding checks it: a number, a safe integer, not negative */
    if (pledgedSrcSize !== undefined) {
      if (typeof pledgedSrcSize !== "number") throw codeError(TypeError, "ERR_INVALID_ARG_TYPE", "pledgedSrcSize must be a number");
      if (!Number.isSafeInteger(pledgedSrcSize)) throw codeError(RangeError, "ERR_OUT_OF_RANGE", "pledgedSrcSize must be a safe integer");
      if (pledgedSrcSize < 0) throw codeError(RangeError, "ERR_OUT_OF_RANGE", "pledgedSrcSize must be non-negative");
    }
    const failure = this._ops.init(this._native, params, pledgedSrcSize, dictionary);
    if (failure !== 0) {
      this._emitError(failure);
      throw codeError(Error, "ERR_ZLIB_INITIALIZATION_FAILED", failure[0]);
    }
  }

  params() {}
}

/* a legacy alias of the stream on its binding object */
Object.defineProperty(CompressionHandle.prototype, "jsref", {
  __proto__: null,
  get() {
    return this[ownerSymbol];
  },
  set(v) {
    this[ownerSymbol] = v;
  },
});

function zlibBuffer(engine, buffer, callback) {
  validateFunction(callback, "callback");
  /* streams take Uint8Arrays: another view becomes a Buffer over the same memory */
  if (isArrayBufferView(buffer) && !(buffer instanceof Uint8Array)) {
    buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } else if (isAnyArrayBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }
  engine.buffers = null;
  engine.nread = 0;
  engine.cb = callback;
  engine.on("data", zlibBufferOnData);
  engine.on("error", zlibBufferOnError);
  engine.on("end", zlibBufferOnEnd);
  engine.end(buffer);
}

function zlibBufferOnData(chunk) {
  if (!this.buffers) this.buffers = [chunk];
  else this.buffers.push(chunk);
  this.nread += chunk.length;
  if (this.nread > this._maxOutputLength) {
    this.close();
    this.removeAllListeners("end");
    this.cb(bufferTooLarge(this._maxOutputLength));
  }
}

function zlibBufferOnError(err) {
  this.removeAllListeners("end");
  this.cb(err);
}

function zlibBufferOnEnd() {
  let buf;
  if (this.nread === 0) {
    buf = emptyBuffer();
  } else {
    const bufs = this.buffers;
    buf = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs, this.nread);
  }
  this.close();
  if (this._info) this.cb(null, { buffer: buf, engine: this });
  else this.cb(null, buf);
}

function zlibBufferSync(engine, buffer) {
  if (typeof buffer === "string") {
    buffer = Buffer.from(buffer);
  } else if (!isArrayBufferView(buffer)) {
    if (isAnyArrayBuffer(buffer)) buffer = Buffer.from(buffer);
    else throw invalidArgType("buffer", "of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer", buffer);
  }
  buffer = processChunkSync(engine, buffer, engine._finishFlushFlag);
  if (engine._info) return { buffer, engine };
  return buffer;
}

function zlibOnError(message, errno, code) {
  const self = this[ownerSymbol];
  /* there's no way to recover cleanly */
  const error = new Error(message);
  error.errno = errno;
  error.code = code;
  self.destroy(error);
  self[kError] = error;
}

/* the base of all the streams */
function ZlibBase(opts, mode, handle, { flush, finishFlush, fullFlush }) {
  let chunkSize = Z_DEFAULT_CHUNK;
  let maxOutputLength = kMaxLength;
  assert(typeof mode === "number");
  assert(mode >= DEFLATE && mode <= ZSTD_DECOMPRESS);
  const brotli = mode === BROTLI_ENCODE || mode === BROTLI_DECODE;
  const zstd = mode === ZSTD_COMPRESS || mode === ZSTD_DECOMPRESS;
  /* FLUSH_BOUND: the flush kinds each engine takes */
  const minFlush = brotli ? BROTLI_OPERATION_PROCESS : zstd ? ZSTD_e_continue : Z_NO_FLUSH;
  const maxFlushFlag = brotli ? BROTLI_OPERATION_EMIT_METADATA : zstd ? ZSTD_e_end : Z_BLOCK;

  if (opts) {
    chunkSize = opts.chunkSize;
    if (!validateFiniteNumber(chunkSize, "options.chunkSize")) {
      chunkSize = Z_DEFAULT_CHUNK;
    } else if (chunkSize < Z_MIN_CHUNK) {
      throw outOfRange("options.chunkSize", ">= " + Z_MIN_CHUNK, chunkSize);
    }
    flush = checkRangesOrGetDefault(opts.flush, "options.flush", minFlush, maxFlushFlag, flush);
    finishFlush = checkRangesOrGetDefault(opts.finishFlush, "options.finishFlush", minFlush, maxFlushFlag, finishFlush);
    maxOutputLength = checkRangesOrGetDefault(opts.maxOutputLength, "options.maxOutputLength", 1, kMaxLength, kMaxLength);
    if (opts.rejectGarbageAfterEnd !== undefined && typeof opts.rejectGarbageAfterEnd !== "boolean") {
      throw invalidArgType("options.rejectGarbageAfterEnd", "of type boolean", opts.rejectGarbageAfterEnd);
    }
    if (opts.encoding || opts.objectMode || opts.writableObjectMode) {
      opts = { ...opts };
      opts.encoding = null;
      opts.objectMode = false;
      opts.writableObjectMode = false;
    }
  }

  Reflect.apply(Transform, this, [{ autoDestroy: true, ...opts }]);
  this[kError] = null;
  this.bytesWritten = 0;
  this._handle = handle;
  handle[ownerSymbol] = this;
  handle.onerror = zlibOnError;
  this._outBuffer = Buffer.allocUnsafe(chunkSize);
  this._outOffset = 0;
  this._chunkSize = chunkSize;
  this._defaultFlushFlag = flush;
  this._finishFlushFlag = finishFlush;
  this._defaultFullFlushFlag = fullFlush;
  this._flushBound = [minFlush, maxFlushFlag];
  this._info = opts?.info;
  this._maxOutputLength = maxOutputLength;
  this._rejectGarbageAfterEnd = opts?.rejectGarbageAfterEnd === true;
}
Object.setPrototypeOf(ZlibBase.prototype, Transform.prototype);
Object.setPrototypeOf(ZlibBase, Transform);

Object.defineProperty(ZlibBase.prototype, "_closed", {
  __proto__: null,
  configurable: true,
  enumerable: true,
  get() {
    return !this._handle;
  },
});

Object.defineProperty(ZlibBase.prototype, "bytesRead", {
  __proto__: null,
  configurable: true,
  enumerable: true,
  get: deprecate(function () {
    return this.bytesWritten;
  }, "zlib.bytesRead is deprecated and will change its meaning in the future. Use zlib.bytesWritten instead.", "DEP0108"),
  set: deprecate(function (value) {
    this.bytesWritten = value;
  }, "Setting zlib.bytesRead is deprecated. This feature will be removed in the future.", "DEP0108"),
});

ZlibBase.prototype.reset = function () {
  assert(this._handle, "zlib binding closed");
  return this._handle.reset();
};

/* Transform calls it when the last chunk has been written */
ZlibBase.prototype._flush = function (callback) {
  this._transform(emptyBuffer(), "", callback);
};

/* Transform's behavior, forced */
ZlibBase.prototype._final = function (callback) {
  callback();
};

/* which of two pending flushes is the stronger: Z_NO_FLUSH < Z_BLOCK < Z_PARTIAL_FLUSH <
 * Z_SYNC_FLUSH < Z_FULL_FLUSH < Z_FINISH */
const flushiness = [];
const kFlushFlagList = [Z_NO_FLUSH, Z_BLOCK, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH];
for (let i = 0; i < kFlushFlagList.length; i++) flushiness[kFlushFlagList[i]] = i;

function maxFlush(a, b) {
  return flushiness[a] > flushiness[b] ? a : b;
}

/* empty buffers .flush() writes, to put a flush into the sequence of writes */
const kFlushBuffers = [];
{
  const dummyArrayBuffer = new ArrayBuffer();
  for (const flushFlag of kFlushFlagList) {
    kFlushBuffers[flushFlag] = Buffer.from(dummyArrayBuffer);
    kFlushBuffers[flushFlag][kFlushFlag] = flushFlag;
  }
}

ZlibBase.prototype.flush = function (kind, callback) {
  if (typeof kind === "function" || (kind === undefined && !callback)) {
    callback = kind;
    kind = this._defaultFullFlushFlag;
  }
  kind = checkRangesOrGetDefault(kind, "kind", this._flushBound[0], this._flushBound[1], this._defaultFullFlushFlag);
  if (this.writableFinished) {
    if (callback) process.nextTick(callback);
  } else if (this.writableEnded) {
    if (callback) this.once("end", callback);
  } else {
    this.write(kFlushBuffers[kind], "", callback);
  }
};

ZlibBase.prototype.close = function (callback) {
  if (callback) finished(this, callback);
  this.destroy();
};

ZlibBase.prototype._destroy = function (err, callback) {
  _close(this);
  callback(err);
};

ZlibBase.prototype._transform = function (chunk, encoding, cb) {
  let flushFlag = this._defaultFlushFlag;
  /* a zero-length chunk carries a flush from the public API */
  if (typeof chunk[kFlushFlag] === "number") flushFlag = chunk[kFlushFlag];
  /* the last chunk gets _finishFlushFlag too */
  if (this.writableEnded && this.writableLength === chunk.byteLength) flushFlag = maxFlush(flushFlag, this._finishFlushFlag);
  processChunk(this, chunk, flushFlag, cb);
};

/* kept for compatibility */
ZlibBase.prototype._processChunk = function (chunk, flushFlag, cb) {
  if (typeof cb === "function") processChunk(this, chunk, flushFlag, cb);
  else return processChunkSync(this, chunk, flushFlag);
};

function processChunkSync(self, chunk, flushFlag) {
  let availInBefore = chunk.byteLength;
  let availOutBefore = self._chunkSize - self._outOffset;
  let inOff = 0;
  let availOutAfter;
  let availInAfter;

  const buffers = [];
  let nread = 0;
  let inputRead = 0;
  const state = self._writeState;
  const handle = self._handle;
  let buffer = self._outBuffer;
  let offset = self._outOffset;
  const chunkSize = self._chunkSize;

  let error;
  self.on("error", function onError(er) {
    error = er;
  });

  while (true) {
    handle.writeSync(flushFlag, chunk, inOff, availInBefore, buffer, offset, availOutBefore);
    if (error) throw error;
    else if (self[kError]) throw self[kError];

    availOutAfter = state[0];
    availInAfter = state[1];

    const inDelta = availInBefore - availInAfter;
    inputRead += inDelta;

    const have = availOutBefore - availOutAfter;
    if (have > 0) {
      const out = buffer.slice(offset, offset + have);
      offset += have;
      buffers.push(out);
      nread += out.byteLength;
      if (nread > self._maxOutputLength) {
        _close(self);
        throw bufferTooLarge(self._maxOutputLength);
      }
    } else {
      assert(have === 0, "have should not go down");
    }

    /* the output buffer is full, or all the input was used: a new one */
    if (availOutAfter === 0 || offset >= chunkSize) {
      availOutBefore = chunkSize;
      offset = 0;
      buffer = Buffer.allocUnsafe(chunkSize);
    }

    if (availOutAfter === 0) {
      /* not done: again, from where the input stopped */
      inOff += inDelta;
      availInBefore = availInAfter;
    } else {
      break;
    }
  }

  if (availInAfter > 0 && self._rejectGarbageAfterEnd) {
    _close(self);
    throw codeError(TypeError, "ERR_TRAILING_JUNK_AFTER_STREAM_END", "Trailing junk found after the end of the compressed stream");
  }

  self.bytesWritten = inputRead;
  _close(self);

  if (nread === 0) return emptyBuffer();
  return buffers.length === 1 ? buffers[0] : Buffer.concat(buffers, nread);
}

function processChunk(self, chunk, flushFlag, cb) {
  const handle = self._handle;
  if (!handle) return process.nextTick(cb);

  handle.buffer = chunk;
  handle.cb = cb;
  handle.availOutBefore = self._chunkSize - self._outOffset;
  handle.availInBefore = chunk.byteLength;
  handle.inOff = 0;
  handle.flushFlag = flushFlag;

  handle.write(flushFlag, chunk, 0, handle.availInBefore, self._outBuffer, self._outOffset, handle.availOutBefore);
}

/* `this` is the handle: its values are nulled once they aren't needed, as it can outlive them */
function processCallback() {
  const self = this[ownerSymbol];
  const state = self._writeState;

  if (self.destroyed) {
    this.buffer = null;
    this.cb();
    return;
  }

  const availOutAfter = state[0];
  const availInAfter = state[1];

  const inDelta = this.availInBefore - availInAfter;
  self.bytesWritten += inDelta;

  const have = this.availOutBefore - availOutAfter;
  let streamBufferIsFull = false;
  if (have > 0) {
    const out = self._outBuffer.slice(self._outOffset, self._outOffset + have);
    self._outOffset += have;
    streamBufferIsFull = !self.push(out);
  } else {
    assert(have === 0, "have should not go down");
  }

  if (self.destroyed) {
    this.cb();
    return;
  }

  /* the output buffer is full, or all the input was used: a new one */
  if (availOutAfter === 0 || self._outOffset >= self._chunkSize) {
    this.availOutBefore = self._chunkSize;
    self._outOffset = 0;
    self._outBuffer = Buffer.allocUnsafe(self._chunkSize);
  }

  if (availOutAfter === 0) {
    /* not done: again, from where the input stopped */
    this.inOff += inDelta;
    this.availInBefore = availInAfter;
    if (!streamBufferIsFull) {
      this.write(this.flushFlag, this.buffer, this.inOff, this.availInBefore, self._outBuffer, self._outOffset, self._chunkSize);
    } else {
      const oldRead = self._read;
      self._read = (n) => {
        self._read = oldRead;
        this.write(this.flushFlag, this.buffer, this.inOff, this.availInBefore, self._outBuffer, self._outOffset, self._chunkSize);
        self._read(n);
      };
    }
    return;
  }

  if (availInAfter > 0) {
    /* input left with room for output: the compressed stream ended early (everything but Gunzip
     * and Unzip stops at its end) */
    if (self._rejectGarbageAfterEnd) {
      const err = codeError(TypeError, "ERR_TRAILING_JUNK_AFTER_STREAM_END", "Trailing junk found after the end of the compressed stream");
      self.destroy(err);
      this.cb(err);
      return;
    }
    self.push(null);
  }

  /* done with the chunk */
  this.buffer = null;
  this.cb();
}

function _close(engine) {
  /* close() may come after an error, which nulls _handle */
  engine._handle?.close();
  engine._handle = null;
}

const zlibDefaultOpts = { flush: Z_NO_FLUSH, finishFlush: Z_FINISH, fullFlush: Z_FULL_FLUSH };

/* the base of the streams zlib itself runs, with its parameters */
function Zlib(opts, mode) {
  let windowBits = Z_DEFAULT_WINDOWBITS;
  let level = Z_DEFAULT_COMPRESSION;
  let memLevel = Z_DEFAULT_MEMLEVEL;
  let strategy = Z_DEFAULT_STRATEGY;
  let dictionary;

  if (opts) {
    /* windowBits 0 is invalid to compress; to decompress, it's the window size in the stream's header */
    if ((opts.windowBits == null || opts.windowBits === 0) && (mode === INFLATE || mode === GUNZIP || mode === UNZIP)) {
      windowBits = 0;
    } else {
      /* { windowBits: 8 } is valid for deflate, not gzip */
      const min = Z_MIN_WINDOWBITS + (mode === GZIP ? 1 : 0);
      windowBits = checkRangesOrGetDefault(opts.windowBits, "options.windowBits", min, Z_MAX_WINDOWBITS, Z_DEFAULT_WINDOWBITS);
    }
    level = checkRangesOrGetDefault(opts.level, "options.level", Z_MIN_LEVEL, Z_MAX_LEVEL, Z_DEFAULT_COMPRESSION);
    memLevel = checkRangesOrGetDefault(opts.memLevel, "options.memLevel", Z_MIN_MEMLEVEL, Z_MAX_MEMLEVEL, Z_DEFAULT_MEMLEVEL);
    strategy = checkRangesOrGetDefault(opts.strategy, "options.strategy", Z_DEFAULT_STRATEGY, Z_FIXED, Z_DEFAULT_STRATEGY);
    dictionary = opts.dictionary;
    if (dictionary !== undefined && !isArrayBufferView(dictionary)) {
      if (isAnyArrayBuffer(dictionary)) dictionary = Buffer.from(dictionary);
      else throw invalidArgType("options.dictionary", "an instance of Buffer, TypedArray, DataView, or ArrayBuffer", dictionary);
    }
  }

  const handle = new ZlibHandle(mode);
  this._writeState = new Uint32Array(2);
  handle.init(windowBits, level, memLevel, strategy, this._writeState, processCallback, dictionary, opts?.rejectGarbageAfterEnd === true);

  Reflect.apply(ZlibBase, this, [opts, mode, handle, zlibDefaultOpts]);

  this._level = level;
  this._strategy = strategy;
  this._mode = mode;
}
Object.setPrototypeOf(Zlib.prototype, ZlibBase.prototype);
Object.setPrototypeOf(Zlib, ZlibBase);

/* params() changes them after a full flush, not while a write is in progress */
function paramsAfterFlushCallback(level, strategy, callback) {
  assert(this._handle, "zlib binding closed");
  this._handle.params(level, strategy);
  if (!this.destroyed) {
    this._level = level;
    this._strategy = strategy;
    if (callback) callback();
  }
}

Zlib.prototype.params = function params(level, strategy, callback) {
  checkRangesOrGetDefault(level, "level", Z_MIN_LEVEL, Z_MAX_LEVEL);
  checkRangesOrGetDefault(strategy, "strategy", Z_DEFAULT_STRATEGY, Z_FIXED);
  if (this._level !== level || this._strategy !== strategy) {
    this.flush(Z_SYNC_FLUSH, paramsAfterFlushCallback.bind(this, level, strategy, callback));
  } else {
    process.nextTick(callback);
  }
};

/* a constructor called without new: Node 24 deprecates it (DEP0184), warning once */
let warnedInstantiation = false;
function deprecateInstantiation(target, opts) {
  if (!warnedInstantiation) {
    warnedInstantiation = true;
    process.emitWarning(`Instantiating ${target.name} without the 'new' keyword has been deprecated.`, "DeprecationWarning", "DEP0184");
  }
  return new target(opts);
}

export function Deflate(opts) {
  if (!(this instanceof Deflate)) return deprecateInstantiation(Deflate, opts);
  Reflect.apply(Zlib, this, [opts, DEFLATE]);
}
Object.setPrototypeOf(Deflate.prototype, Zlib.prototype);
Object.setPrototypeOf(Deflate, Zlib);

export function Inflate(opts) {
  if (!(this instanceof Inflate)) return deprecateInstantiation(Inflate, opts);
  Reflect.apply(Zlib, this, [opts, INFLATE]);
}
Object.setPrototypeOf(Inflate.prototype, Zlib.prototype);
Object.setPrototypeOf(Inflate, Zlib);

export function Gzip(opts) {
  if (!(this instanceof Gzip)) return deprecateInstantiation(Gzip, opts);
  Reflect.apply(Zlib, this, [opts, GZIP]);
}
Object.setPrototypeOf(Gzip.prototype, Zlib.prototype);
Object.setPrototypeOf(Gzip, Zlib);

export function Gunzip(opts) {
  if (!(this instanceof Gunzip)) return deprecateInstantiation(Gunzip, opts);
  Reflect.apply(Zlib, this, [opts, GUNZIP]);
}
Object.setPrototypeOf(Gunzip.prototype, Zlib.prototype);
Object.setPrototypeOf(Gunzip, Zlib);

export function DeflateRaw(opts) {
  if (opts && opts.windowBits === 8) opts.windowBits = 9;
  if (!(this instanceof DeflateRaw)) return deprecateInstantiation(DeflateRaw, opts);
  Reflect.apply(Zlib, this, [opts, DEFLATERAW]);
}
Object.setPrototypeOf(DeflateRaw.prototype, Zlib.prototype);
Object.setPrototypeOf(DeflateRaw, Zlib);

export function InflateRaw(opts) {
  if (!(this instanceof InflateRaw)) return deprecateInstantiation(InflateRaw, opts);
  Reflect.apply(Zlib, this, [opts, INFLATERAW]);
}
Object.setPrototypeOf(InflateRaw.prototype, Zlib.prototype);
Object.setPrototypeOf(InflateRaw, Zlib);

export function Unzip(opts) {
  if (!(this instanceof Unzip)) return deprecateInstantiation(Unzip, opts);
  Reflect.apply(Zlib, this, [opts, UNZIP]);
}
Object.setPrototypeOf(Unzip.prototype, Zlib.prototype);
Object.setPrototypeOf(Unzip, Zlib);

function createConvenienceMethod(ctor, sync) {
  if (sync) {
    return function syncBufferWrapper(buffer, opts) {
      return zlibBufferSync(new ctor(opts), buffer);
    };
  }
  return function asyncBufferWrapper(buffer, opts, callback) {
    if (typeof opts === "function") {
      callback = opts;
      opts = {};
    }
    return zlibBuffer(new ctor(opts), buffer, callback);
  };
}

const kMaxBrotliParam = Math.max(...Object.keys(constants).map((key) => (key.startsWith("BROTLI_PARAM_") ? constants[key] : 0)));
const brotliInitParamsArray = new Uint32Array(kMaxBrotliParam + 1);

const brotliDefaultOpts = { flush: BROTLI_OPERATION_PROCESS, finishFlush: BROTLI_OPERATION_FINISH, fullFlush: BROTLI_OPERATION_FLUSH };

function Brotli(opts, mode) {
  assert(mode === BROTLI_DECODE || mode === BROTLI_ENCODE);
  brotliInitParamsArray.fill(-1);
  if (opts?.params) {
    Object.keys(opts.params).forEach((origKey) => {
      const key = +origKey;
      if (Number.isNaN(key) || key < 0 || key > kMaxBrotliParam || (brotliInitParamsArray[key] | 0) !== -1) {
        throw codeError(RangeError, "ERR_BROTLI_INVALID_PARAM", origKey + " is not a valid Brotli parameter");
      }
      const value = opts.params[origKey];
      if (typeof value !== "number" && typeof value !== "boolean") {
        throw invalidArgType("options.params[key]", "of type number", opts.params[origKey]);
      }
      brotliInitParamsArray[key] = value;
    });
  }

  let dictionary = opts?.dictionary;
  if (dictionary !== undefined && !isArrayBufferView(dictionary)) {
    if (isAnyArrayBuffer(dictionary)) dictionary = Buffer.from(dictionary);
    else throw invalidArgType("options.dictionary", "an instance of Buffer, TypedArray, DataView, or ArrayBuffer", dictionary);
  }

  const handle = new BrotliHandle(mode);
  this._writeState = new Uint32Array(2);
  handle.init(brotliInitParamsArray, this._writeState, processCallback, dictionary);

  Reflect.apply(ZlibBase, this, [opts, mode, handle, brotliDefaultOpts]);
}
Object.setPrototypeOf(Brotli.prototype, Zlib.prototype);
Object.setPrototypeOf(Brotli, Zlib);

export function BrotliCompress(opts) {
  if (!(this instanceof BrotliCompress)) return deprecateInstantiation(BrotliCompress, opts);
  Reflect.apply(Brotli, this, [opts, BROTLI_ENCODE]);
}
Object.setPrototypeOf(BrotliCompress.prototype, Brotli.prototype);
Object.setPrototypeOf(BrotliCompress, Brotli);

export function BrotliDecompress(opts) {
  if (!(this instanceof BrotliDecompress)) return deprecateInstantiation(BrotliDecompress, opts);
  Reflect.apply(Brotli, this, [opts, BROTLI_DECODE]);
}
Object.setPrototypeOf(BrotliDecompress.prototype, Brotli.prototype);
Object.setPrototypeOf(BrotliDecompress, Brotli);

const zstdDefaultOpts = { flush: ZSTD_e_continue, finishFlush: ZSTD_e_end, fullFlush: ZSTD_e_flush };

class Zstd extends ZlibBase {
  constructor(opts, mode, initParamsArray, maxParam) {
    assert(mode === ZSTD_COMPRESS || mode === ZSTD_DECOMPRESS);
    initParamsArray.fill(-1);
    if (opts?.params) {
      Object.keys(opts.params).forEach((origKey) => {
        const key = +origKey;
        if (Number.isNaN(key) || key < 0 || key > maxParam || (initParamsArray[key] | 0) !== -1) {
          throw codeError(RangeError, "ERR_ZSTD_INVALID_PARAM", origKey + " is not a valid zstd parameter");
        }
        const value = opts.params[origKey];
        if (typeof value !== "number" && typeof value !== "boolean") {
          throw invalidArgType("options.params[key]", "of type number", opts.params[origKey]);
        }
        initParamsArray[key] = value;
      });
    }

    let dictionary = opts?.dictionary;
    if (dictionary !== undefined && !isArrayBufferView(dictionary)) dictionary = isAnyArrayBuffer(dictionary) ? new Uint8Array(dictionary) : undefined;
    const handle = new ZstdHandle(mode === ZSTD_COMPRESS);
    const pledgedSrcSize = opts?.pledgedSrcSize;
    const writeState = new Uint32Array(2);
    handle.init(initParamsArray, pledgedSrcSize, writeState, processCallback, dictionary);

    super(opts, mode, handle, zstdDefaultOpts);
    this._writeState = writeState;
  }
}

const kMaxZstdCParam = Math.max(...Object.keys(constants).map((key) => (key.startsWith("ZSTD_c_") ? constants[key] : 0)));
const zstdInitCParamsArray = new Uint32Array(kMaxZstdCParam + 1);

export class ZstdCompress extends Zstd {
  constructor(opts) {
    super(opts, ZSTD_COMPRESS, zstdInitCParamsArray, kMaxZstdCParam);
  }
}

const kMaxZstdDParam = Math.max(...Object.keys(constants).map((key) => (key.startsWith("ZSTD_d_") ? constants[key] : 0)));
const zstdInitDParamsArray = new Uint32Array(kMaxZstdDParam + 1);

export class ZstdDecompress extends Zstd {
  constructor(opts) {
    super(opts, ZSTD_DECOMPRESS, zstdInitDParamsArray, kMaxZstdDParam);
  }
}

/** zlib.crc32(data, value = 0): CRC-32 (IEEE), as zlib computes it. */
export function crc32(data, value = 0) {
  if (typeof data !== "string" && !isArrayBufferView(data)) {
    throw invalidArgType("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
  }
  if (typeof value !== "number") throw invalidArgType("value", "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange("value", "an integer", value);
  if (value < 0 || value > 4294967295) throw outOfRange("value", ">= 0 && <= 4294967295", value);
  return zlibCrc32(data, value);
}

export const deflate = createConvenienceMethod(Deflate, false);
export const deflateSync = createConvenienceMethod(Deflate, true);
export const gzip = createConvenienceMethod(Gzip, false);
export const gzipSync = createConvenienceMethod(Gzip, true);
export const deflateRaw = createConvenienceMethod(DeflateRaw, false);
export const deflateRawSync = createConvenienceMethod(DeflateRaw, true);
export const unzip = createConvenienceMethod(Unzip, false);
export const unzipSync = createConvenienceMethod(Unzip, true);
export const inflate = createConvenienceMethod(Inflate, false);
export const inflateSync = createConvenienceMethod(Inflate, true);
export const gunzip = createConvenienceMethod(Gunzip, false);
export const gunzipSync = createConvenienceMethod(Gunzip, true);
export const inflateRaw = createConvenienceMethod(InflateRaw, false);
export const inflateRawSync = createConvenienceMethod(InflateRaw, true);
export const brotliCompress = createConvenienceMethod(BrotliCompress, false);
export const brotliCompressSync = createConvenienceMethod(BrotliCompress, true);
export const brotliDecompress = createConvenienceMethod(BrotliDecompress, false);
export const brotliDecompressSync = createConvenienceMethod(BrotliDecompress, true);
export const zstdCompress = createConvenienceMethod(ZstdCompress, false);
export const zstdCompressSync = createConvenienceMethod(ZstdCompress, true);
export const zstdDecompress = createConvenienceMethod(ZstdDecompress, false);
export const zstdDecompressSync = createConvenienceMethod(ZstdDecompress, true);

export const createDeflate = (options) => new Deflate(options);
export const createInflate = (options) => new Inflate(options);
export const createDeflateRaw = (options) => new DeflateRaw(options);
export const createInflateRaw = (options) => new InflateRaw(options);
export const createGzip = (options) => new Gzip(options);
export const createGunzip = (options) => new Gunzip(options);
export const createUnzip = (options) => new Unzip(options);
export const createBrotliCompress = (options) => new BrotliCompress(options);
export const createBrotliDecompress = (options) => new BrotliDecompress(options);
export const createZstdCompress = (options) => new ZstdCompress(options);
export const createZstdDecompress = (options) => new ZstdDecompress(options);

/* module.exports as Node builds it: constants and codes read-only, and the zlib constants again,
 * deprecated, as hidden properties */
const zlib = {
  crc32, Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw, Unzip, BrotliCompress, BrotliDecompress, ZstdCompress,
  ZstdDecompress, deflate, deflateSync, gzip, gzipSync, deflateRaw, deflateRawSync, unzip, unzipSync, inflate, inflateSync,
  gunzip, gunzipSync, inflateRaw, inflateRawSync, brotliCompress, brotliCompressSync, brotliDecompress, brotliDecompressSync,
  zstdCompress, zstdCompressSync, zstdDecompress, zstdDecompressSync, createDeflate, createInflate, createDeflateRaw,
  createInflateRaw, createGzip, createGunzip, createUnzip, createBrotliCompress, createBrotliDecompress, createZstdCompress,
  createZstdDecompress,
};
Object.defineProperties(zlib, {
  constants: { __proto__: null, configurable: false, enumerable: true, value: constants },
  codes: { __proto__: null, enumerable: true, writable: false, value: codes },
});
for (const key of Object.keys(constants)) {
  if (key.startsWith("BROTLI")) continue;
  Object.defineProperty(zlib, key, { __proto__: null, enumerable: false, value: constants[key], writable: false });
}

export default zlib;
