// The global console as Node's (lib/internal/console/global.js): Console's methods bound to an
// instance writing to process.stdout and process.stderr, looked up when first written to, and
// its _stdout and _stderr settable. A feature module (implicitModules in node/index.ts): linked
// into a program that replaces a stdio stream's write, which the runtime's console, writing to
// the fds, wouldn't go through. The runtime's console object stays the global (code may hold it).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { Console, kBindProperties, kBindStreamsLazy } from "../console.js";

const global = globalThis.console;
const instance = Object.create(Console.prototype);
instance[kBindStreamsLazy](globalThis.process);
instance[kBindProperties](true, "auto");

for (const key of Object.keys(Console.prototype)) {
  const method = Console.prototype[key].bind(instance);
  Object.defineProperty(method, "name", { value: key });
  Object.defineProperty(global, key, { value: method, writable: true, enumerable: true, configurable: true });
}
for (const name of ["_stdout", "_stderr"]) {
  Object.defineProperty(global, name, {
    get: () => instance[name],
    set: (stream) => { instance[name] = stream; },
    configurable: true,
  });
}
