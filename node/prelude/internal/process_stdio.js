// process.stdout and process.stderr as Writables, as Node's are (lib/internal/bootstrap/switches/
// is_main_thread.js: a SyncWriteStream for a file, a tty.WriteStream for a terminal, writing at
// once): a program that pipes into them, listens on them or ends them gets this module first
// (implicitModules in node/index.ts). The runtime's own stdout and stderr only write. Like Node's,
// destroying one doesn't close its fd.
import { Writable } from "../stream.js";

const p = globalThis.process;

function stdio(name) {
  const native = p[name];
  const write = native.write;
  const stream = new Writable({
    write(chunk, encoding, cb) {
      try {
        Reflect.apply(write, native, [chunk]);
      } catch (e) {
        cb(e);
        return;
      }
      cb();
    },
  });
  /* the runtime's fd, isTTY and the rest */
  for (const key of Object.keys(native)) if (key !== "write") stream[key] = native[key];
  stream._isStdio = true;
  stream.destroySoon = stream.destroy;
  stream._destroy = (err, cb) => {
    /* Node's dummyDestroy: stdio isn't closed */
    cb(err);
  };
  Object.defineProperty(p, name, { value: stream, writable: true, enumerable: true, configurable: true });
}

stdio("stdout");
stdio("stderr");
