// net.Socket's onread option, as Node's: the bytes read go into the user's buffer, a buffer's worth
// at a time, and to its callback instead of 'data'. The callback returning false, or pausing,
// stops reading, as a read into that buffer would: the bytes not yet given wait for resume().
// Linked into programs that name onread (internal/features.js).
import { netReadStart, netReadStop } from "visaljs:host";
import { features } from "./features.js";

function deliver(socket, bytes) {
  for (let at = 0; at < bytes.length;) {
    const { buffer, callback } = socket._onread;
    const buf = typeof buffer === "function" ? buffer() : buffer;
    const n = Math.min(buf.length, bytes.length - at);
    buf.set(bytes.subarray(at, at + n));
    at += n;
    const more = callback.call(socket, n, buf) !== false && socket._reading;
    if (!more) {
      if (at < bytes.length) socket._onreadRest = bytes.subarray(at);
      return false;
    }
  }
  return true;
}

features.onread = {
  /* bytes read: false stops reading */
  deliver,

  /* a TLS socket's decrypted bytes: all of them, false when a callback asks to stop (its reads
   * resume through its own stream, not the bytes kept here) */
  deliverAll(socket, bytes) {
    let more = true;
    for (let at = 0; at < bytes.length;) {
      const { buffer, callback } = socket._onread;
      const buf = typeof buffer === "function" ? buffer() : buffer;
      const n = Math.min(buf.length, bytes.length - at);
      buf.set(bytes.subarray(at, at + n));
      at += n;
      if (callback.call(socket, n, buf) === false) more = false;
    }
    return more;
  },

  /* libuv takes a buffer for the read that finds EOF too: a buffer function is asked for one */
  eof(socket) {
    if (typeof socket._onread.buffer === "function") socket._onread.buffer();
  },

  /* Node's: pausing stops reading from the handle, resuming starts it (a TLS socket reads through
   * its own stream) */
  pause(socket) {
    if (socket.encrypted || socket.connecting || socket._handle === null || !socket._reading) return;
    socket._reading = false;
    if (!socket.destroyed) {
      const err = netReadStop(socket._handle);
      if (err) socket.destroy(features.net.errnoException(err, "read"));
    }
  },

  resume(socket) {
    if (!socket.encrypted && !socket.connecting && socket._handle !== null && !socket._reading) socket._startReading();
  },

  /* reading again: the bytes left from the last read first, as the next read */
  rest(socket) {
    const rest = socket._onreadRest;
    socket._onreadRest = null;
    process.nextTick(() => {
      if (socket.destroyed || socket._handle === null) return;
      if (deliver(socket, rest)) netReadStart(socket._handle);
      else socket._reading = false;
    });
  },
};
