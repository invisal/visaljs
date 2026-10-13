// node:tty: isatty, and ReadStream: a terminal read as node:net's Socket, which
// process.stdin is when it's a terminal. ReadStream links node:net and libuv: its class is
// internal/tty_read_stream.js, in programs whose code names it (a name only computed at run time
// throws ERR_VISALJS_UNSUPPORTED). WriteStream isn't provided yet: process.stdout and
// process.stderr have isTTY.
import { ttyIsatty } from "visaljs:host";
import { notSupported } from "./internal/errors.js";
import { streams } from "./internal/tty_streams.js";

export function isatty(fd) {
  return Number.isInteger(fd) && fd >= 0 && fd <= 2147483647 && ttyIsatty(fd);
}

/** ReadStream(fd, options): a terminal, read. */
export function ReadStream(fd, options) {
  if (streams.ReadStream === undefined) throw notSupported("tty.ReadStream (named only at run time)");
  return Reflect.construct(streams.ReadStream, [fd, options], new.target ?? ReadStream);
}

export function WriteStream() {
  throw notSupported("tty.WriteStream");
}

export default { isatty, ReadStream, WriteStream };
