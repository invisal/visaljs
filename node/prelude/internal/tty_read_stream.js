// node:tty's ReadStream, for programs whose code names it, or process.stdin (it links node:net and
// libuv, which tty.isatty alone doesn't need): a terminal read as node:net's Socket, on libuv's
// terminal handle (ttyOpen). tty.ReadStream builds this class, and is its prototype's constructor.
import { ttyOpen, ttySetRawMode } from "visaljs:host";
import { errnoException } from "./errors.js";
import { Socket } from "../net.js";
import { ReadStream, isatty } from "../tty.js";
import { streams } from "./tty_streams.js";

/** A terminal, read: Node's, a Socket on its handle that reads once something reads from it. */
class TTYReadStream extends Socket {
  constructor(fd, options) {
    if (!isatty(fd)) throw errnoException(-22, "TTY initialization");  /* EINVAL, as Node's */
    const id = ttyOpen(fd);
    if (id < 0) throw errnoException(id, "TTY initialization");
    super({ readableHighWaterMark: 0, ...options, handle: id, manualStart: true });
    this.fd = fd;
    this.isRaw = false;
    this.isTTY = true;
  }

  /** Keys as they're typed, unechoed (raw), or lines the terminal edits (normal). */
  setRawMode(flag) {
    flag = Boolean(flag);
    const err = this._handle === null ? -9 : ttySetRawMode(this._handle, flag);
    if (err) {
      this.emit("error", errnoException(err, "setRawMode"));
      return this;
    }
    this.isRaw = flag;
    return this;
  }
}

/* instanceof tty.ReadStream holds, and its constructor is tty.ReadStream */
ReadStream.prototype = TTYReadStream.prototype;
Object.defineProperty(TTYReadStream.prototype, "constructor", { value: ReadStream, writable: true, configurable: true });
Object.setPrototypeOf(ReadStream, Socket);
streams.ReadStream = TTYReadStream;
