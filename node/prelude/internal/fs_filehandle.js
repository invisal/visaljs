// fs/promises' open and FileHandle, as Node's: an fd's calls as promises (read, write, readv,
// writev, readFile, writeFile, appendFile, stat, truncate, sync, datasync, utimes, chmod, chown),
// read streams, write streams and readLines on it, close and Symbol.asyncDispose, and its 'close'
// event. The I/O happens when the method is called, as node:fs/promises' other calls. Linked into
// programs that name them (internal/features.js).
import { EventEmitter } from "../events.js";
import {
  closeSync, createReadStream, createWriteStream, fchmodSync, fchownSync, fdatasyncSync, fstatSync, fsyncSync, ftruncateSync, futimesSync,
  openSync, readSync, readvSync, writeSync, writevSync,
} from "../fs.js";
import { createInterface } from "../readline.js";
import { notSupported } from "./errors.js";
import { features } from "./features.js";
import {
  getOptions, kIoMaxLength, validateBufferArray, validateOffsetLengthRead, validateOffsetLengthWrite, validatePosition,
  validateStringAfterArrayBufferView,
} from "./fs_utils.js";
import "./fs_streams.js";  /* its streams */
import { AbortError, codes } from "./streams/errors.js";
import { kEmptyObject, validateAbortSignal, validateBuffer, validateInteger, validateObject } from "./streams/validators.js";

const { ERR_FS_FILE_TOO_LARGE, ERR_INVALID_ARG_VALUE } = codes;
const kReadChunk = 512 * 1024;
const kWriteFileMaxChunkSize = 512 * 1024;

function checkAborted(signal) {
  if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });
}

/* an iterable, or async iterable, of chunks: not a string or bytes */
const isCustomIterable = (obj) =>
  obj != null && typeof obj !== "string" && !ArrayBuffer.isView(obj) &&
  (typeof obj[Symbol.asyncIterator] === "function" || typeof obj[Symbol.iterator] === "function");

/* Node's validateEncoding: hex takes whole bytes */
function validateEncoding(data, encoding) {
  if (typeof encoding === "string" && encoding.toLowerCase() === "hex" && data.length % 2 !== 0) {
    throw new ERR_INVALID_ARG_VALUE("encoding", encoding, `is invalid for data of length ${data.length}`);
  }
}

/* EBADF for a handle that's closed, as Node's */
function closedError(syscall) {
  const e = new Error("file closed");
  e.errno = -9;
  e.code = "EBADF";
  e.syscall = syscall;
  return e;
}

export class FileHandle extends EventEmitter {
  #fd;
  #closing = null;

  constructor(fd) {
    super();
    this.#fd = fd;
  }

  get fd() {
    return this.#fd;
  }

  /* the call on the fd as a promise; EBADF once the handle is closed */
  /* done at once, settled on a later turn of the loop: Node's run on the thread pool, so what
   * the caller's ticks and promise jobs do (an abort) comes first. An async operation's promise
   * is followed at once (its steps are these calls), so its rejection has a handler. */
  #call(syscall, fn) {
    return new Promise((resolve, reject) => {
      if (this.#fd < 0) return reject(closedError(syscall));
      try {
        const result = fn(this.#fd);
        if (typeof result?.then === "function") resolve(result);
        else setImmediate(resolve, result);
      } catch (e) {
        setImmediate(reject, e);
      }
    });
  }

  /** read(buffer, offset, length, position), read(buffer, options) or read(options): { bytesRead,
   *  buffer }. Node's argument handling (lib/internal/fs/promises.js). */
  read(bufferOrParams, offset, length, position) {
    return this.#call("read", (fd) => {
      let buffer = bufferOrParams;
      if (!ArrayBuffer.isView(buffer)) {
        if (bufferOrParams !== undefined && bufferOrParams !== null) validateObject(bufferOrParams, "options");
        ({ buffer = Buffer.alloc(16384), offset = 0, length = buffer.byteLength - offset, position = null } = bufferOrParams ?? kEmptyObject);
        validateBuffer(buffer);
      }
      if (offset !== null && typeof offset === "object") {
        ({ offset = 0, length = buffer.byteLength - offset, position = null } = offset);
      }
      if (offset == null) offset = 0;
      else validateInteger(offset, "offset", 0);
      length ??= buffer.byteLength - offset;
      if (position == null) position = -1;
      else validatePosition(position, "position", length);
      if (length === 0) return { __proto__: null, bytesRead: length, buffer };
      if (buffer.byteLength === 0) throw new ERR_INVALID_ARG_VALUE("buffer", buffer, "is empty and cannot be written");
      validateOffsetLengthRead(offset, length, buffer.byteLength);
      return { __proto__: null, bytesRead: readSync(fd, buffer, offset, length, position) || 0, buffer };
    });
  }

  /** write(buffer[, offset[, length[, position]]]), write(buffer, options) or write(string[, position[,
   *  encoding]]): { bytesWritten, buffer }. */
  write(buffer, offsetOrOptions, length, position) {
    return this.#call("write", (fd) => {
      if (buffer?.byteLength === 0) return { __proto__: null, bytesWritten: 0, buffer };
      let offset = offsetOrOptions;
      if (ArrayBuffer.isView(buffer)) {
        if (typeof offset === "object") {
          ({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOptions ?? kEmptyObject);
        }
        if (offset == null) offset = 0;
        else validateInteger(offset, "offset", 0);
        if (typeof length !== "number") length = buffer.byteLength - offset;
        if (typeof position !== "number") position = null;
        validateOffsetLengthWrite(offset, length, buffer.byteLength);
        return { __proto__: null, bytesWritten: writeSync(fd, buffer, offset, length, position) || 0, buffer };
      }
      validateStringAfterArrayBufferView(buffer, "buffer");
      validateEncoding(buffer, length);
      return { __proto__: null, bytesWritten: writeSync(fd, buffer, offset, length) || 0, buffer };
    });
  }

  readv(buffers, position) {
    return this.#call("read", (fd) => {
      validateBufferArray(buffers);
      return { __proto__: null, bytesRead: readvSync(fd, buffers, typeof position === "number" ? position : null), buffers };
    });
  }

  writev(buffers, position) {
    return this.#call("write", (fd) => {
      validateBufferArray(buffers);
      if (buffers.length === 0) return { __proto__: null, bytesWritten: 0, buffers };
      return { __proto__: null, bytesWritten: writevSync(fd, buffers, typeof position === "number" ? position : null), buffers };
    });
  }

  /** The rest of the file from its current position: a Buffer, or a string with an encoding. An
   *  abort signal is checked before and between reads, as Node's. */
  readFile(options) {
    return this.#call("read", async (fd) => {
      options = getOptions(options, { flag: "r" });
      const { signal, encoding } = options;
      validateAbortSignal(signal, "options.signal");
      checkAborted(signal);
      const st = fstatSync(fd);
      if (st.isFile() && st.size > kIoMaxLength) throw new ERR_FS_FILE_TOO_LARGE(st.size);
      const chunks = [];
      let total = 0;
      for (;;) {
        await undefined;  /* a turn for an abort, as Node's reads on its thread pool */
        checkAborted(signal);
        const chunk = Buffer.allocUnsafe(kReadChunk);
        const n = readSync(fd, chunk, 0, kReadChunk, null);
        if (n === 0) break;
        chunks.push(n === kReadChunk ? chunk : chunk.subarray(0, n));
        total += n;
      }
      const all = Buffer.concat(chunks, total);
      return encoding && encoding !== "buffer" ? all.toString(encoding) : all;
    });
  }

  /** The data written from the current position: a string, bytes, or an iterable or stream of them,
   *  in chunks, an abort signal checked between them (Node's writeFileHandle). */
  writeFile(data, options) {
    return this.#call("write", async () => {
      options = getOptions(options, { encoding: "utf8", mode: 0o666, flag: "w", flush: false });
      if (!ArrayBuffer.isView(data) && !isCustomIterable(data)) {
        validateStringAfterArrayBufferView(data, "data");
        data = Buffer.from(data, options.encoding || "utf8");
      }
      const { signal, encoding } = options;
      validateAbortSignal(signal, "options.signal");
      checkAborted(signal);
      if (isCustomIterable(data)) {
        for await (const buf of data) {
          checkAborted(signal);
          const toWrite = ArrayBuffer.isView(buf) ? buf : Buffer.from(buf, encoding || "utf8");
          let remaining = toWrite.byteLength;
          while (remaining > 0) {
            const writeSize = Math.min(kWriteFileMaxChunkSize, remaining);
            const { bytesWritten } = await this.write(toWrite, toWrite.byteLength - remaining, writeSize);
            remaining -= bytesWritten;
            checkAborted(signal);
          }
        }
        return;
      }
      data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      let remaining = data.byteLength;
      if (remaining === 0) return;
      do {
        checkAborted(signal);
        const { bytesWritten } = await this.write(data, 0, Math.min(kWriteFileMaxChunkSize, data.byteLength));
        remaining -= bytesWritten;
        data = new Uint8Array(data.buffer, data.byteOffset + bytesWritten, data.byteLength - bytesWritten);
      } while (remaining > 0);
    });
  }

  appendFile(data, options) {
    return this.writeFile(data, options);
  }

  stat(options) {
    return this.#call("fstat", (fd) => fstatSync(fd, options ?? { bigint: false }));
  }

  truncate(len = 0) {
    return this.#call("ftruncate", (fd) => void ftruncateSync(fd, len));
  }

  sync() {
    return this.#call("fsync", (fd) => void fsyncSync(fd));
  }

  datasync() {
    return this.#call("fdatasync", (fd) => void fdatasyncSync(fd));
  }

  utimes(atime, mtime) {
    return this.#call("futime", (fd) => void futimesSync(fd, atime, mtime));
  }

  chmod(mode) {
    return this.#call("fchmod", (fd) => void fchmodSync(fd, mode));
  }

  chown(uid, gid) {
    return this.#call("fchown", (fd) => void fchownSync(fd, uid, gid));
  }

  /* streams on the handle, as Node's: they read and write through it, and close it */
  createReadStream(options = undefined) {
    return createReadStream(undefined, { ...options, fd: this });
  }

  createWriteStream(options = undefined) {
    return createWriteStream(undefined, { ...options, fd: this });
  }

  /** The lines: node:readline's interface on a read stream. */
  readLines(options) {
    return createInterface({ input: this.createReadStream(options), crlfDelay: Infinity });
  }

  readableWebStream() {
    throw notSupported("FileHandle.readableWebStream");
  }

  /** Closes the fd, once: 'close' follows. */
  close() {
    if (this.#closing) return this.#closing;
    if (this.#fd < 0) return Promise.resolve();
    const fd = this.#fd;
    this.#closing = new Promise((resolve, reject) => {
      try {
        closeSync(fd);
        this.#fd = -1;
        this.emit("close");
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    return this.#closing;
  }

  [Symbol.asyncDispose ?? Symbol.for("nodejs.asyncDispose")]() {
    return this.close();
  }
}

/** fs/promises' open(path[, flags[, mode]]): a FileHandle. */
/* settled on a later turn of the loop, as Node's open on its thread pool (FileHandle's #call) */
function promisesOpen(path, flags = "r", mode = 0o666) {
  return new Promise((resolve, reject) => {
    try {
      setImmediate(resolve, new FileHandle(openSync(path, flags, mode)));
    } catch (e) {
      setImmediate(reject, e);
    }
  });
}

Object.assign(features, { promisesOpen, FileHandle });
