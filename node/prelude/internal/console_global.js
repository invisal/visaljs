// The global console as Node's (lib/internal/console/global.js): a Console writing to whatever
// process.stdout and process.stderr are when it writes, and its _stdout and _stderr settable. A
// feature module (implicitModules in node/index.ts): linked into a program that replaces a stdio
// stream or its write, which the runtime's console, writing to the fds, wouldn't go through.
import { Console } from "../console.js";

const p = globalThis.process;

/* process[name], looked up at each use, as Node's console binds its streams lazily */
function lazyStream(name) {
  return {
    write: (...args) => p[name].write(...args),
    get isTTY() { return p[name].isTTY; },
    getColorDepth: (...args) => (typeof p[name].getColorDepth === "function" ? p[name].getColorDepth(...args) : 1),
    listenerCount: (event) => (typeof p[name].listenerCount === "function" ? p[name].listenerCount(event) : 0),
    once: (event, listener) => p[name].once?.(event, listener),
  };
}

const global = globalThis.console;
const instance = new Console({ stdout: lazyStream("stdout"), stderr: lazyStream("stderr") });
for (const key of Object.keys(Console.prototype)) {
  Object.defineProperty(global, key, { value: instance[key], writable: true, enumerable: true, configurable: true });
}
for (const name of ["_stdout", "_stderr"]) {
  Object.defineProperty(global, name, {
    get: () => instance[name],
    set: (stream) => { instance[name] = stream; },
    configurable: true,
  });
}
