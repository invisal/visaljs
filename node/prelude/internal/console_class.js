// console.Console on the global console, as node:console puts it there: a feature module, linked
// into programs that name Console without importing node:console.
import { Console } from "../console.js";

if (globalThis.console.Console === undefined) {
  Object.defineProperty(globalThis.console, "Console", { value: Console, writable: true, configurable: true });
}
