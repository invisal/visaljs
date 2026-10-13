// node:inspector: a compiled program has no V8 inspector to connect to. It
// behaves as Node built without one (--without-inspector): loading the module throws
// ERR_INSPECTOR_NOT_AVAILABLE. Code that only loads it to profile or debug, on request, runs
// until asked (TypeScript's --generateCpuProfile).
import { codeError } from "./internal/errors.js";

export function open() {}
export function close() {}
export function url() {}
export function waitForDebugger() {}
export const console = globalThis.console;
export class Session {}
export const Network = {};
export const NetworkResources = {};

export default { open, close, url, waitForDebugger, console, Session, Network, NetworkResources };

throw codeError(Error, "ERR_INSPECTOR_NOT_AVAILABLE", "Inspector is not available");
