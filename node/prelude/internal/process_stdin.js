// process.stdin: made when first read, as Node's getStdin makes it, by what descriptor 0 is: a
// terminal is tty.ReadStream, a file fs.ReadStream, a pipe or socket a net.Socket, and anything
// else (closed) an empty stream. It starts paused; paused again, it stops reading, so a program
// that doesn't read it all can exit. A program that may use it gets this module first (the
// driver adds it: implicitModules in node/index.ts).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { netGuessHandle, netReadStop } from "visaljs:host";
import { ReadStream as FileReadStream } from "../fs.js";
import { Socket } from "../net.js";
import { Readable } from "../stream.js";
import { ReadStream as TTYReadStream } from "../tty.js";
import "./tty_read_stream.js";

const p = globalThis.process;
let stdin;

function getStdin() {
  const fd = 0;
  switch (netGuessHandle(fd)) {
    case "TTY":
      stdin = new TTYReadStream(fd);
      break;
    case "FILE":
      stdin = new FileReadStream(null, { fd, autoClose: false });
      break;
    case "PIPE":
    case "TCP":
      stdin = new Socket({ fd, readable: true, writable: false, manualStart: true });
      stdin._writableState.ended = true;
      break;
    default:
      stdin = new Readable({ read() {} });
      stdin.push(null);
  }
  stdin.fd = fd;
  /* paused: stop reading a tick later, once the stream has (Node's onpause) */
  stdin.on("pause", () => process.nextTick(onpause));
  return stdin;
}

function onpause() {
  if (typeof stdin._handle !== "number" || !stdin._reading || stdin.readableFlowing) return;
  stdin._readableState.reading = false;
  stdin._reading = false;
  netReadStop(stdin._handle);
}

Object.defineProperty(p, "stdin", {
  configurable: true,
  enumerable: true,
  get: () => stdin ?? getStdin(),
});
