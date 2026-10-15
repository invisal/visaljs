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
import { invalidArgType, notSupported } from "./errors.js";
import { features } from "./features.js";
import "./fs_streams.js";  /* its streams */

const kReadChunk = 512 * 1024;

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
  #call(syscall, fn) {
    return new Promise((resolve, reject) => {
      if (this.#fd < 0) return reject(closedError(syscall));
      try {
        resolve(fn(this.#fd));
      } catch (e) {
        reject(e);
      }
    });
  }

  /** read(buffer, offset, length, position) or read({ buffer, offset, length, position }):
   *  { bytesRead, buffer }. */
  read(buffer, offset, length, position) {
    if (buffer === undefined || (buffer !== null && typeof buffer === "object" && !ArrayBuffer.isView(buffer))) {
      ({ buffer = Buffer.alloc(16384), offset = 0, length, position = null } = buffer ?? {});
    } else if (offset !== null && typeof offset === "object") {
      ({ offset = 0, length, position = null } = offset);
    }
    offset ??= 0;
    length ??= buffer.byteLength - offset;
    return this.#call("read", (fd) => ({ bytesRead: readSync(fd, buffer, offset, length, position ?? null), buffer }));
  }

  /** write(buffer[, offset[, length[, position]]]) or write(string[, position[, encoding]]):
   *  { bytesWritten, buffer }. */
  write(data, offsetOrOptions, length, position) {
    return this.#call("write", (fd) => {
      if (typeof data === "string") return { bytesWritten: writeSync(fd, data, offsetOrOptions, length), buffer: data };
      let offset = offsetOrOptions;
      if (offset !== null && typeof offset === "object") ({ offset = 0, length, position = null } = offset);
      return { bytesWritten: writeSync(fd, data, offset ?? 0, length ?? data.byteLength - (offset ?? 0), position), buffer: data };
    });
  }

  readv(buffers, position) {
    return this.#call("read", (fd) => ({ bytesRead: readvSync(fd, buffers, position), buffers }));
  }

  writev(buffers, position) {
    return this.#call("write", (fd) => ({ bytesWritten: writevSync(fd, buffers, position), buffers }));
  }

  /** The rest of the file from its current position: a Buffer, or a string with an encoding. */
  readFile(options) {
    const encoding = typeof options === "string" ? options : options?.encoding;
    return this.#call("read", (fd) => {
      const chunks = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(kReadChunk);
        const n = readSync(fd, chunk, 0, kReadChunk, null);
        if (n === 0) break;
        chunks.push(n === kReadChunk ? chunk : chunk.subarray(0, n));
        total += n;
      }
      const all = Buffer.concat(chunks, total);
      return encoding ? all.toString(encoding) : all;
    });
  }

  /** The data written from the current position (a string, bytes, or an iterable of them). */
  writeFile(data, options) {
    const encoding = typeof options === "string" ? options : options?.encoding ?? "utf8";
    return this.#call("write", async (fd) => {
      if (typeof data === "string" || ArrayBuffer.isView(data)) {
        const bytes = typeof data === "string" ? Buffer.from(data, encoding) : data;
        let off = 0;
        while (off < bytes.byteLength) off += writeSync(fd, bytes, off, bytes.byteLength - off, null);
        return;
      }
      if (data === null || typeof data !== "object") {
        throw invalidArgType("data", "of type string or an instance of Buffer, TypedArray, DataView, AsyncIterable, Iterable, or Stream", data);
      }
      for await (const chunk of data) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;
        let off = 0;
        while (off < bytes.byteLength) off += writeSync(fd, bytes, off, bytes.byteLength - off, null);
      }
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

  /* streams on the handle's fd, which they leave open: the handle closes it */
  createReadStream(options) {
    return createReadStream(null, { ...options, fd: this.#fd, autoClose: false });
  }

  createWriteStream(options) {
    return createWriteStream(null, { ...options, fd: this.#fd, autoClose: false });
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
function promisesOpen(path, flags = "r", mode = 0o666) {
  return new Promise((resolve, reject) => {
    try {
      resolve(new FileHandle(openSync(path, flags, mode)));
    } catch (e) {
      reject(e);
    }
  });
}

Object.assign(features, { promisesOpen, FileHandle });
