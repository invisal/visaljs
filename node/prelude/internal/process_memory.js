// process.memoryUsage(): added to the runtime's process when the program may call it
// (implicitModules in node/index.ts), since it links libuv. heapTotal and heapUsed are the GC
// heap's; a compiled program has no separate external or ArrayBuffer accounting (0).
import { processMemory } from "visaljs:host";

function memoryUsage() {
  const [rss, heapTotal, heapUsed] = processMemory();
  return { rss, heapTotal, heapUsed, external: 0, arrayBuffers: 0 };
}
memoryUsage.rss = function rss() {
  return processMemory()[0];
};

Object.defineProperty(globalThis.process, "memoryUsage", { value: memoryUsage, writable: true, enumerable: true, configurable: true });
