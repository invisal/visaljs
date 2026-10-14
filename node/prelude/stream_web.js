// node:stream/web: the web streams the runtime provides as globals, and the compression streams
// (internal/compression_streams.js, linked into programs that name them).
import { lazyClass } from "./internal/features.js";

export const ReadableStream = globalThis.ReadableStream;
export const ReadableStreamDefaultReader = globalThis.ReadableStreamDefaultReader;
export const ReadableStreamDefaultController = globalThis.ReadableStreamDefaultController;
export const WritableStream = globalThis.WritableStream;
export const WritableStreamDefaultWriter = globalThis.WritableStreamDefaultWriter;
export const WritableStreamDefaultController = globalThis.WritableStreamDefaultController;
export const TransformStream = globalThis.TransformStream;
export const TransformStreamDefaultController = globalThis.TransformStreamDefaultController;
export const CompressionStream = lazyClass("CompressionStream");
export const DecompressionStream = lazyClass("DecompressionStream");

export default {
  ReadableStream, ReadableStreamDefaultReader, ReadableStreamDefaultController, WritableStream, WritableStreamDefaultWriter,
  WritableStreamDefaultController, TransformStream, TransformStreamDefaultController, CompressionStream, DecompressionStream,
};
