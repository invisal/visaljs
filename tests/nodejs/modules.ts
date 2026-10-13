// Which module a test of Node's tests, by its file name: test-<prefix>-*.js or test-<prefix>.js.
// The longest prefix wins (test-fs-promises- is fs/promises, not fs); a test no prefix names is
// "other".

const PREFIXES: Record<string, string> = {
  "abortcontroller": "events",
  "abortsignal": "events",
  "assert": "assert",
  "async-hooks": "async_hooks",
  "async-local-storage": "async_hooks",
  "blob": "buffer",
  "buffer": "buffer",
  "child-process": "child_process",
  "console": "console",
  "crypto": "crypto",
  "dgram": "dgram",
  "diagnostics-channel": "diagnostics_channel",
  "dns": "dns",
  "event-emitter": "events",
  "event-target": "events",
  "events": "events",
  "eventtarget": "events",
  "file": "buffer",
  "fs": "fs",
  "fs-promises": "fs/promises",
  "http": "http",
  "http2": "http2",
  "https": "https",
  "module": "module",
  "net": "net",
  "os": "os",
  "path": "path",
  "perf-hooks": "perf_hooks",
  "performance": "perf_hooks",
  "process": "process",
  "punycode": "punycode",
  "querystring": "querystring",
  "readline": "readline",
  "stream": "stream",
  "stream2": "stream",
  "stream3": "stream",
  "stream-consumers": "stream/consumers",
  "string-decoder": "string_decoder",
  "timers": "timers",
  "timers-promises": "timers/promises",
  "tls": "tls",
  "tty": "tty",
  "url": "url",
  "util": "util",
  "webcrypto": "crypto",
  "webstreams": "stream/web",
  "whatwg-encoding": "util",
  "whatwg-readablebytestream": "stream/web",
  "whatwg-readablestream": "stream/web",
  "whatwg-transformstream": "stream/web",
  "whatwg-url": "url",
  "whatwg-webstreams": "stream/web",
  "whatwg-writablestream": "stream/web",
  "worker": "worker_threads",
  "zlib": "zlib",
};

/** The module a test file (test-path-join.js) tests. */
export function moduleOf(file: string): string {
  const name = file.replace(/^test-/, "").replace(/\.m?js$/, "");
  let best = "";
  for (const prefix of Object.keys(PREFIXES)) {
    if ((name === prefix || name.startsWith(prefix + "-")) && prefix.length > best.length) best = prefix;
  }
  return best ? PREFIXES[best]! : "other";
}
