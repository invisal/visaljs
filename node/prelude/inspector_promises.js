// node:inspector/promises: as node:inspector, a compiled program has no V8 inspector: loading it
// throws ERR_INSPECTOR_NOT_AVAILABLE, as Node built without one.
export * from "./inspector.js";
export { default } from "./inspector.js";
