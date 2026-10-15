// node:inspector: a compiled program has no V8 inspector to connect to. It loads as in a Node
// process no debugger is attached to: url() is undefined, close() does nothing, console is the
// global console. What needs the inspector throws when called: open, waitForDebugger and a Session.
// Code that loads it only to ask whether a debugger is attached (Next.js's server) runs; code that
// profiles or debugs on request fails when asked (TypeScript's --generateCpuProfile).
import { notSupported } from "./internal/errors.js";

export function open() {
  throw notSupported("inspector.open() (a compiled program has no V8 inspector)");
}
export function close() {}
export function url() {
  return undefined;
}
export function waitForDebugger() {
  throw notSupported("inspector.waitForDebugger() (a compiled program has no V8 inspector)");
}
export const console = globalThis.console;
export class Session {
  constructor() {
    throw notSupported("inspector.Session (a compiled program has no V8 inspector)");
  }
}
export const Network = {};
export const NetworkResources = {};

export default { open, close, url, waitForDebugger, console, Session, Network, NetworkResources };
