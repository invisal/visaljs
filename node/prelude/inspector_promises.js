// node:inspector/promises: as node:inspector, a compiled program has no V8 inspector: it loads,
// with no debugger attached, and what needs one throws when called.
export * from "./inspector.js";
export { default } from "./inspector.js";
