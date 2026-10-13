// node:stream/web: the web streams the runtime provides as globals.
export const ReadableStream = globalThis.ReadableStream;
export const ReadableStreamDefaultReader = globalThis.ReadableStreamDefaultReader;
export const ReadableStreamDefaultController = globalThis.ReadableStreamDefaultController;

export default { ReadableStream, ReadableStreamDefaultReader, ReadableStreamDefaultController };
