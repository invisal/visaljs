// node:stream/consumers: a stream read to its end as text, JSON, bytes or a Blob, as Node's: any
// async iterable of chunks (a Readable, a web ReadableStream, an async generator).

/** The chunks as a Blob. */
export async function blob(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new globalThis.Blob(chunks);
}

export async function arrayBuffer(stream) {
  return (await blob(stream)).arrayBuffer();
}

export async function buffer(stream) {
  return Buffer.from(await arrayBuffer(stream));
}

/** The chunks as UTF-8 text: strings as they are, bytes decoded across chunk boundaries. */
export async function text(stream) {
  const decoder = new TextDecoder();
  let string = "";
  for await (const chunk of stream) {
    if (typeof chunk === "string") string += chunk;
    else string += decoder.decode(chunk, { stream: true });
  }
  return string + decoder.decode(undefined, { stream: false });
}

export async function json(stream) {
  return JSON.parse(await text(stream));
}

export default { arrayBuffer, blob, buffer, json, text };
