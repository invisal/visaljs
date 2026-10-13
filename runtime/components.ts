// The runtime's optional components, for the compiler: each one's C symbol
// (runtime/src/*.c, `js_component_<name>`) and the names that reach it. A test checks this list
// against runtime/src/components.c. Pure data: the web playground's compiler imports it too.
export interface Component {
  name: string;
  /** The runtime's JSComponent. */
  symbol: string;
  /** Names that reach it: as an identifier, a property name or a string key. */
  names: string[];
  /** Components it needs, installed before it (typed arrays need ArrayBuffer). */
  needs?: string[];
}

export const COMPONENTS: readonly Component[] = [
  /* the language's own: syntax reaches them too, as the names programNames gives it (an async
   * function or await counts as Promise, a generator as "function*", an async generator or for
   * await as "async function*"); Array.fromAsync returns a promise */
  { name: "promise", symbol: "js_component_promise", names: ["Promise", "fromAsync"] },
  { name: "generator", symbol: "js_component_generator", names: ["function*"] },
  { name: "asynciterator", symbol: "js_component_asynciterator", names: ["async function*", "asyncIterator"], needs: ["promise"] },
  { name: "weak", symbol: "js_component_weak", names: ["WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry"] },
  { name: "math", symbol: "js_component_math", names: ["Math"] },
  { name: "json", symbol: "js_component_json", names: ["JSON"] },
  { name: "collections", symbol: "js_component_collections", names: ["Map", "Set"] },
  { name: "reflect", symbol: "js_component_reflect", names: ["Reflect"] },
  { name: "proxy", symbol: "js_component_proxy", names: ["Proxy"] },
  /* a BigInt literal counts as the name BigInt (programNames); a BigInt value can only come from
   * a literal, BigInt(), or the BigInt typed arrays and DataView methods, which exist only
   * when it is installed: so it comes before arraybuffer and typedarray */
  {
    name: "bigint",
    symbol: "js_component_bigint",
    names: ["BigInt", "BigInt64Array", "BigUint64Array", "getBigInt64", "getBigUint64", "setBigInt64", "setBigUint64",
      /* Buffer's 64-bit reads and writes make BigInts too */
      "readBigInt64LE", "readBigInt64BE", "readBigUInt64LE", "readBigUInt64BE", "readBigUint64LE", "readBigUint64BE",
      "writeBigInt64LE", "writeBigInt64BE", "writeBigUInt64LE", "writeBigUInt64BE", "writeBigUint64LE", "writeBigUint64BE"],
  },
  { name: "arraybuffer", symbol: "js_component_arraybuffer", names: ["ArrayBuffer", "DataView"] },
  {
    name: "typedarray",
    symbol: "js_component_typedarray",
    names: ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
      "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"],
    needs: ["arraybuffer"],
  },
  { name: "date", symbol: "js_component_date", names: ["Date"] },
  /* a regex literal counts as the name RegExp (programNames); match, matchAll and search create
   * a RegExp from a string argument */
  { name: "regexp", symbol: "js_component_regexp", names: ["RegExp", "match", "matchAll", "search"] },
  /* the web-standard host layer */
  { name: "domexception", symbol: "js_component_domexception", names: ["DOMException"] },
  { name: "encoding", symbol: "js_component_encoding", names: ["TextEncoder", "TextDecoder"], needs: ["typedarray"] },
  { name: "base64", symbol: "js_component_base64", names: ["atob", "btoa"], needs: ["domexception"] },
  { name: "url", symbol: "js_component_url", names: ["URL", "URLSearchParams"] },
  { name: "events", symbol: "js_component_events", names: ["Event", "EventTarget", "AbortController", "AbortSignal"], needs: ["domexception"] },
  /* Node's Buffer, a global in C like the web-standard ones */
  { name: "buffer", symbol: "js_component_buffer", names: ["Buffer"], needs: ["typedarray"] },
  /* Web Crypto */
  { name: "crypto", symbol: "js_component_crypto", names: ["crypto", "Crypto", "SubtleCrypto", "CryptoKey"], needs: ["promise", "json", "typedarray", "domexception"] },
  /* fetch's classes: Request and Response need the rest */
  { name: "headers", symbol: "js_component_headers", names: ["Headers"] },
  {
    name: "streams",
    symbol: "js_component_streams",
    names: ["ReadableStream", "ReadableStreamDefaultReader", "ReadableStreamDefaultController", "WritableStream",
      "WritableStreamDefaultWriter", "WritableStreamDefaultController", "TransformStream", "TransformStreamDefaultController"],
    needs: ["promise", "asynciterator", "typedarray", "domexception", "events"],
  },
  { name: "blob", symbol: "js_component_blob", names: ["Blob", "File"], needs: ["promise", "typedarray", "streams"] },
  {
    name: "fetch",
    symbol: "js_component_fetch",
    names: ["Request", "Response"],
    needs: ["promise", "json", "domexception", "url", "events", "typedarray", "headers", "streams", "blob"],
  },
];
