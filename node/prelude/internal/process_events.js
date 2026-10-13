// process as an EventEmitter: the runtime's process, in every binary, is a plain
// object. A program that may call its emitter methods gets this module first (the driver adds it:
// implicitModules in node/index.ts), and the runtime emits process's events through its emit.
import { EventEmitter } from "../events.js";

const p = globalThis.process;

/* its prototype is process.constructor.prototype, an EventEmitter's, as in Node */
function process() {}
process.prototype = Object.create(EventEmitter.prototype, {
  constructor: { value: process, writable: true, configurable: true },
});
Object.setPrototypeOf(p, process.prototype);
EventEmitter.init.call(p);
