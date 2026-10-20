// @visaljs/node: the Node platform as a host package. It provides `node:*` modules
// (prelude JS in prelude/, bundled only when imported), the host primitives they import from
// "visaljs:host" (C in src/), and the C libraries those need (libuv, llhttp). The driver
// composes host packages with the compiler and the runtime; another package can replace a
// module by providing it.
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dirname;
const UV = join(DIR, "third_party", "libuv");
const LLHTTP = join(DIR, "third_party", "llhttp");
const ZLIB = join(DIR, "third_party", "zlib");
const BROTLI = join(DIR, "third_party", "brotli");
const ZSTD = join(DIR, "third_party", "zstd");
const CARES = join(DIR, "third_party", "c-ares");
const INCLUDE = join(DIR, "include");

const files = (dir: string, ext: string) => readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => join(dir, f));

/** Prelude modules may import "visaljs:host". */
export const preludeDir = join(DIR, "prelude");

/** The Node built-in modules provided: `node:<name>` (or `<name>`) → its prelude file. */
export const modules: Readonly<Record<string, string>> = {
  assert: join(preludeDir, "assert.js"),
  "assert/strict": join(preludeDir, "assert_strict.js"),
  async_hooks: join(preludeDir, "async_hooks.js"),
  buffer: join(preludeDir, "buffer.js"),
  child_process: join(preludeDir, "child_process.js"),
  cluster: join(preludeDir, "cluster.js"),
  console: join(preludeDir, "console.js"),
  constants: join(preludeDir, "constants.js"),
  crypto: join(preludeDir, "crypto.js"),
  diagnostics_channel: join(preludeDir, "diagnostics_channel.js"),
  dns: join(preludeDir, "dns.js"),
  "dns/promises": join(preludeDir, "dns_promises.js"),
  domain: join(preludeDir, "domain.js"),
  events: join(preludeDir, "events.js"),
  fs: join(preludeDir, "fs.js"),
  "fs/promises": join(preludeDir, "fs_promises.js"),
  http: join(preludeDir, "http.js"),
  http2: join(preludeDir, "http2.js"),
  https: join(preludeDir, "https.js"),
  inspector: join(preludeDir, "inspector.js"),
  "inspector/promises": join(preludeDir, "inspector_promises.js"),
  module: join(preludeDir, "module.js"),
  dgram: join(preludeDir, "dgram.js"),
  net: join(preludeDir, "net.js"),
  os: join(preludeDir, "os.js"),
  path: join(preludeDir, "path.js"),
  "path/posix": join(preludeDir, "path_posix.js"),
  "path/win32": join(preludeDir, "path_win32.js"),
  perf_hooks: join(preludeDir, "perf_hooks.js"),
  process: join(preludeDir, "process.js"),
  punycode: join(preludeDir, "punycode.js"),
  querystring: join(preludeDir, "querystring.js"),
  readline: join(preludeDir, "readline.js"),
  "readline/promises": join(preludeDir, "readline_promises.js"),
  repl: join(preludeDir, "repl.js"),
  sea: join(preludeDir, "sea.js"),
  stream: join(preludeDir, "stream.js"),
  _http_agent: join(preludeDir, "_http_agent.js"),
  _http_common: join(preludeDir, "_http_common.js"),
  _http_server: join(preludeDir, "_http_server.js"),
  _stream_duplex: join(preludeDir, "_stream_duplex.js"),
  _stream_passthrough: join(preludeDir, "_stream_passthrough.js"),
  _stream_readable: join(preludeDir, "_stream_readable.js"),
  _stream_transform: join(preludeDir, "_stream_transform.js"),
  _stream_writable: join(preludeDir, "_stream_writable.js"),
  "stream/consumers": join(preludeDir, "stream_consumers.js"),
  "stream/promises": join(preludeDir, "stream_promises.js"),
  "stream/web": join(preludeDir, "stream_web.js"),
  string_decoder: join(preludeDir, "string_decoder.js"),
  sys: join(preludeDir, "sys.js"),
  test: join(preludeDir, "test.js"),
  "test/reporters": join(preludeDir, "test_reporters.js"),
  timers: join(preludeDir, "timers.js"),
  "timers/promises": join(preludeDir, "timers_promises.js"),
  tls: join(preludeDir, "tls.js"),
  trace_events: join(preludeDir, "trace_events.js"),
  tty: join(preludeDir, "tty.js"),
  url: join(preludeDir, "url.js"),
  util: join(preludeDir, "util.js"),
  "util/types": join(preludeDir, "util_types.js"),
  v8: join(preludeDir, "v8.js"),
  vm: join(preludeDir, "vm.js"),
  wasi: join(preludeDir, "wasi.js"),
  worker_threads: join(preludeDir, "worker_threads.js"),
  zlib: join(preludeDir, "zlib.js"),
};

/** Prelude modules a program gets without importing them, run before its own code, when its
 *  bundled code may use what they add (`reached` tests the code's text, conservatively). */
export const implicitModules: readonly { file: string; reached: (code: string, program: string) => boolean }[] = [
  /* process's EventEmitter methods: the runtime's process, in every binary, has none */
  { file: join(preludeDir, "internal", "process_events.js"), reached: (code) => /\bprocess\b/.test(code) && EMITTER_METHOD.test(code) },
  /* its signal events and kill(), apart: they link libuv */
  { file: join(preludeDir, "internal", "process_signals.js"), reached: (code) => /\bprocess\b/.test(code) && /["'`]SIG[A-Z0-9]+["'`]|\.kill\b/.test(code) },
  /* process.stdout and stderr as Writables: when the program's own code, or a package's, names
   * them and uses streams (pipes into them, listens on them, ends them) */
  { file: join(preludeDir, "internal", "process_stdio.js"), reached: (_code, program) => /\b(?:stdout|stderr)\b/.test(program) && STDIO_STREAM_USE.test(program) },
  /* the global console as Node's, through process.stdout and stderr: when a program replaces one's write (or the console's streams) */
  { file: join(preludeDir, "internal", "console_global.js"), reached: (_code, program) => /\b(?:stdout|stderr)\b/.test(program) && STDIO_WRITE_REPLACED.test(program) },
  /* console.Console, for a program that names it */
  { file: join(preludeDir, "internal", "console_class.js"), reached: (_code, program) => /\bConsole\b/.test(program) },
  /* process.stdin, made when first read: when the program's own code, or a package's, names it */
  { file: join(preludeDir, "internal", "process_stdin.js"), reached: (_code, program) => /\bstdin\b/.test(program) },
  /* node:tty's ReadStream: it links node:net and libuv */
  { file: join(preludeDir, "internal", "tty_read_stream.js"), reached: (_code, program) => /\bReadStream\b/.test(program) },
  /* features of node:util and node:events in modules of their own (internal/features.js): each when
   * the program's own code, or a package's, names it */
  { file: join(preludeDir, "internal", "parse_args.js"), reached: (_code, program) => /\bparseArgs\b/.test(program) },
  { file: join(preludeDir, "internal", "mime.js"), reached: (_code, program) => /\bMIME(?:Type|Params)\b/.test(program) },
  { file: join(preludeDir, "internal", "dotenv.js"), reached: (_code, program) => /\bparseEnv\b/.test(program) },
  { file: join(preludeDir, "internal", "system_errors.js"), reached: (_code, program) => /\bgetSystemError(?:Name|Message|Map)\b/.test(program) },
  /* inspect's colors and styles as `inspect.colors`: `colors` alone is in most loggers (debug) */
  { file: join(preludeDir, "internal", "util_styles.js"), reached: (_code, program) => /\bstyleText\b|\binspect\s*\.\s*(?:colors|styles)\b/.test(program) },
  /* util.diff: `diff` alone is a common name */
  { file: join(preludeDir, "internal", "util_diff.js"), reached: (_code, program) => UTIL_DIFF.test(program) },
  /* debuglog, or util.debug */
  { file: join(preludeDir, "internal", "util_debuglog.js"), reached: (_code, program) => /\bdebuglog\b/.test(program) || UTIL_DEBUG.test(program) },
  /* the rarely used ones: by a distinctive name, or a common one named as node:util's */
  { file: join(preludeDir, "internal", "util_more.js"), reached: (_code, program) => UTIL_MORE.test(program) || UTIL_MORE_MEMBERS.test(program) },
  { file: join(preludeDir, "internal", "buffer_transcode.js"), reached: (_code, program) => /\btranscode\b/.test(program) },
  /* events.on as a call (bare, or of events or EventEmitter): `.on(` is an emitter's method */
  { file: join(preludeDir, "internal", "events_on.js"), reached: (_code, program) =>
      EVENTS_ON.test(program) || (/readline|readLines|createInterface/i.test(program) && /\bfor\s+await\b|\basyncIterator\b/.test(program)) },
  /* node:stream's rarer parts: compose, Duplex.from and duplexPair; the operators (map, filter, …
   * on a Readable: drop, take, flatMap and toArray by name, the others named with streams); the
   * conversions to and from web streams */
  { file: join(preludeDir, "internal", "stream_compose.js"),
    reached: (_code, program) => /\bduplexPair\b|(?<![.\w$])compose\s*\(|\.\s*compose\b|\bDuplex[\w$]*\s*\.\s*from\b/.test(program) },
  { file: join(preludeDir, "internal", "stream_operators.js"), reached: (_code, program) => STREAM_OPERATORS.test(program) },
  { file: join(preludeDir, "internal", "stream_from.js"), reached: (_code, program) => /\bReadable[\w$]*\s*\.\s*from\b/.test(program) },
  { file: join(preludeDir, "internal", "stream_pipeline.js"), reached: (_code, program) => /\bpipeline\b/.test(program) },
  { file: join(preludeDir, "internal", "stream_transform.js"), reached: (_code, program) => /\b(?:Transform|PassThrough)\b/.test(program) },
  { file: join(preludeDir, "internal", "stream_web_adapters.js"), reached: (_code, program) => /\b(?:toWeb|fromWeb)\b/.test(program) },
  { file: join(preludeDir, "internal", "events_extras.js"),
    reached: (_code, program) => /\b(?:getEventListeners|[gs]etMaxListeners|addAbortListener|EventEmitterAsyncResource)\b/.test(program) },
  /* module.SourceMap */
  { file: join(preludeDir, "internal", "source_map.js"), reached: (_code, program) => /\bSourceMap\b/.test(program) },
  /* net.Socket's onread option */
  { file: join(preludeDir, "internal", "net_onread.js"), reached: (_code, program) => /\bonread\b/.test(program) },
  /* net.Socket's type of service */
  { file: join(preludeDir, "internal", "net_tos.js"), reached: (_code, program) => /TypeOfService|typeOfService/.test(program) },
  /* net.BoundSocket */
  { file: join(preludeDir, "internal", "net_bound.js"), reached: (_code, program) => /\bBoundSocket\b/.test(program) },
  /* perf_hooks' observers and histograms */
  { file: join(preludeDir, "internal", "perf_observe.js"), reached: (_code, program) => /\bPerformance(?:Observer|ObserverEntryList|ResourceTiming)\b/.test(program) },
  { file: join(preludeDir, "internal", "perf_histogram.js"), reached: (_code, program) => /\b(?:createHistogram|monitorEventLoopDelay)\b/.test(program) },
  /* node:fs's and node:fs/promises' larger or rarer functions: named bare, or as fs's or promises' */
  /* fs's streams (Node's, over node:stream) */
  { file: join(preludeDir, "internal", "fs_streams.js"), reached: (_code, program) => FS_STREAMS.test(program) },
  /* stat's `bigint: true` option (the bundle keeps an option's name) */
  { file: join(preludeDir, "internal", "fs_bigint_stats.js"), reached: (_code, program) => /\bbigint\s*:/.test(program) },
  { file: join(preludeDir, "internal", "fs_statfs.js"), reached: (_code, program) => /\b(?:statfs|statfsSync|StatFs)\b/.test(program) },
  { file: join(preludeDir, "internal", "fs_dir.js"), reached: (_code, program) => FS_DIR.test(program) },
  { file: join(preludeDir, "internal", "fs_cp.js"), reached: (_code, program) => FS_CP.test(program) },
  { file: join(preludeDir, "internal", "fs_glob.js"), reached: (_code, program) =>
      FS_GLOB.test(program) || /\bmatchesGlob\b/.test(program) || (FS_WATCH.test(program) && /\bignore\b/.test(program)) },
  { file: join(preludeDir, "internal", "fs_watch.js"), reached: (_code, program) => FS_WATCH.test(program) },
  { file: join(preludeDir, "internal", "fs_blob.js"), reached: (_code, program) => /\bopenAsBlob\b/.test(program) },
  /* fs/promises' open and FileHandle: as promises', or a bare open(…) call (imported); or a program
   * that names node:fs's promises and calls some open() (`const fs = require("fs").promises;
   * fs.open(…)`: the bundle renames fs) */
  { file: join(preludeDir, "internal", "fs_filehandle.js"), reached: (_code, program) =>
      FS_OPEN.test(program) || /\bFileHandle\b/.test(program) || (/\bpromises\b/.test(program) && /\.\s*open\s*\(/.test(program)) },
  /* readline's terminal line editor: a readline program that reads stdin or names a terminal's parts */
  { file: join(preludeDir, "internal", "readline_editor.js"), reached: (_code, program) =>
      READLINE_EDITOR.test(program) || (/readline|createInterface/i.test(program) && /\b(?:stdin|terminal)\b/.test(program)) },
  /* dns.Resolver and the resolve* functions (c-ares): named, or node:dns's resolve(…) or reverse(…) */
  { file: join(preludeDir, "internal", "dns_resolver.js"), reached: (_code, program) =>
      DNS_RESOLVER.test(program) || DNS_RESOLVE_RRTYPE.test(program) || DNS_MODULE_RESOLVE.test(program) },
  /* crypto.X509Certificate, and the TLS sockets' getters that give one */
  { file: join(preludeDir, "internal", "crypto_x509.js"), reached: (_code, program) => /\b(?:X509Certificate|get(?:Peer)?X509Certificate)\b/.test(program) },
  /* process's other members (some link libuv): named as process's, or by a distinctive name */
  { file: join(preludeDir, "internal", "process_more.js"), reached: (_code, program) => PROCESS_MORE.test(program) },
  /* process.memoryUsage(): it links libuv */
  { file: join(preludeDir, "internal", "process_memory.js"), reached: (code) => /\bprocess\b/.test(code) && /\bmemoryUsage\b/.test(code) },
  /* Node's timer globals, returning Timeouts: when the code may use one (TIMER_USE), or node:timers */
  { file: join(preludeDir, "internal", "timers_global.js"), reached: (code, program) => TIMER_USE.test(code) || TIMER_DISPOSE.test(program) },
  /* the performance globals (node:perf_hooks'): when the program's own code, or a package's, names one */
  { file: join(preludeDir, "internal", "performance_global.js"), reached: (_code, program) => /\b[Pp]erformance(?:Entry|Mark|Measure)?\b/.test(program) },
  /* the FormData global, and Request's and Response's formData() */
  { file: join(preludeDir, "internal", "form_data.js"), reached: (_code, program) => /\b(?:FormData|formData)\b/.test(program) },
  /* the structuredClone global */
  { file: join(preludeDir, "internal", "structured_clone.js"), reached: (_code, program) => /\bstructuredClone\b/.test(program) },
  /* the compression streams (globals and node:stream/web's): they link node:zlib */
  { file: join(preludeDir, "internal", "compression_streams.js"), reached: (_code, program) => /\b(?:Compression|Decompression)Stream\b/.test(program) },
  /* the fetch global: it links node:http, node:https and node:zlib */
  { file: join(preludeDir, "internal", "fetch.js"), reached: (_code, program) => FETCH.test(program) },
  /* node:zlib's Brotli and zstd (their libraries are large): when the program's own code, or a
   * package's, names them */
  { file: join(preludeDir, "internal", "zlib_brotli.js"), reached: (_code, program) => /brotli/i.test(program) },
  { file: join(preludeDir, "internal", "zlib_zstd.js"), reached: (_code, program) => /zstd/i.test(program) },
];
/* the fetch global: called bare (not as another object's method, `.fetch(`), passed or assigned
 * (`= fetch;`, `f(fetch)`), tested with typeof, or as the global object's; not a key or a field
 * named fetch (Hono's app.fetch) */
const FETCH = /(?<![.\w$#])fetch\s*\(|[=(,]\s*fetch\s*[;,)\n]|\btypeof\s+fetch\b|\b(?:globalThis|global|self)\s*(?:\.\s*fetch\b|\[\s*["'`]fetch["'`])/;
/* a Readable's operators: the distinctive ones by name, the others with node:stream named */
const STREAM_OPERATORS = /\.\s*(?:flatMap|toArray|drop|take|asIndexedPairs)\s*\(|\bReadable\b[\s\S]*\.\s*(?:map|filter|forEach|reduce|some|every|find)\s*\(/;
const DNS_RESOLVER = /\b(?:Resolver|resolve(?:4|6|Any|Caa|Cname|Mx|Naptr|Ns|Ptr|Soa|Srv|Tlsa|Txt)|getServers|setServers|setLocalAddress)\b/;
const READLINE_EDITOR = /\b(?:emitKeypressEvents|setRawMode|keypress|completer)\b/;
/* dns.resolve(…), dns.promises.reverse(…), as the bundle names node:dns */
const DNS_MODULE_RESOLVE = /\b(?:dns|dns_default|require_dns\(\))\s*\.\s*(?:promises\s*\.\s*)?(?:resolve|reverse)\b/;
/* resolve(name, "MX"): a record type names it, whatever the module's binding is called */
const DNS_RESOLVE_RRTYPE = /\.\s*resolve\s*\([^,()]+,\s*["'`](?:A|AAAA|ANY|CAA|CNAME|MX|NAPTR|NS|PTR|SOA|SRV|TLSA|TXT)["'`]/;
const STDIO_WRITE_REPLACED = /\b(?:stdout|stderr|stream)\s*\.\s*write\s*=(?![=>])|\b_std(?:out|err)\s*=(?!=)/;
const STDIO_STREAM_USE = /\.\s*(?:pipe|on|once|end|cork|uncork|destroy|removeListener|addListener|prependListener)\s*\(|\b(?:pipeline|finished)\b|\bwritable(?:Length|HighWaterMark|NeedDrain|Ended|Finished)\b/;
const PROCESS_DISTINCT = "chdir|umask|uptime|cpuUsage|threadCpuUsage|resourceUsage|availableMemory|constrainedMemory|setuid|setgid|seteuid|setegid|getgroups|setgroups|initgroups|reallyExit|execve|getBuiltinModule|loadEnvFile|hasUncaughtExceptionCaptureCallback|setUncaughtExceptionCaptureCallback|allowedNodeEnvironmentFlags|setSourceMapsEnabled|sourceMapsEnabled|getActiveResourcesInfo|moduleLoadList|openStdin|debugPort|dlopen";
const PROCESS_COMMON = "title|ppid|release|config|ref|unref|abort|report|domain|assert|binding|finalization";

/** node:util's functions with common names, as the bundle names them: bare (imported by name, or
 *  destructured), never as another object's property (Array.isArray, console.log), or as a
 *  property of node:util (util.x, util_default.x, require_util().x). */
const utilNamed = (names: string) =>
  new RegExp(`(?<![.\\w$])(?:${names})\\b|\\butil[\\w$]*\\s*\\.\\s*(?:${names})\\b|\\brequire_util\\(\\)\\s*\\.\\s*(?:${names})\\b`);
const UTIL_DIFF = utilNamed("diff");
/** node:fs's and node:fs/promises' functions, as the bundle names them: bare, or as a property of
 *  fs or promises (fs.x, fs_default.x, promises.x, fsPromises.x, require_fs().x). */
const fsNamed = (names: string) =>
  new RegExp(`(?<![.\\w$])(?:${names})\\b|\\b(?:fs|promises|fsPromises)[\\w$]*\\s*\\.\\s*(?:${names})\\b|\\brequire_(?:fs|promises)\\(\\)\\s*\\.\\s*(?:${names})\\b`);
const FS_STREAMS = /\b(?:createReadStream|createWriteStream|ReadStream|WriteStream|FileReadStream|FileWriteStream)\b/;
const FS_DIR = fsNamed("opendir|opendirSync|Dir");
const FS_CP = fsNamed("cp|cpSync");
const FS_GLOB = fsNamed("glob|globSync");
const FS_WATCH = fsNamed("watch|watchFile|unwatchFile");
const FS_OPEN = /\b[\w$]*[pP]romises[\w$]*\s*\.\s*open\b|\brequire_promises\(\)\s*\.\s*open\b|(?<![.\w$])open(?:\$\d+)?\s*\(/;
/* process's members in internal/process_more.js: as process's (process.x, process_default.x), or bare
 * when distinctive (imported from node:process) */
const PROCESS_MORE = new RegExp(`\\bprocess[\\w$]*\\s*\\.\\s*(?:${PROCESS_DISTINCT}|${PROCESS_COMMON})\\b|(?<![.\\w$])(?:${PROCESS_DISTINCT})\\b`);
const EVENTS_ON = /(?<![.\w$])on\s*\(|\b(?:events|EventEmitter)[\w$]*\s*\.\s*on\b|\brequire_events\(\)\s*\.\s*on\b/;
const UTIL_DEBUG = utilNamed("debug");
const UTIL_MORE = /\b(?:callbackify|transferableAbort(?:Controller|Signal)|toUSVString|getCallSites|setTraceSigInt|convertProcessSignalToExitCode|_extend)\b/;
const UTIL_MORE_MEMBERS = utilNamed("aborted|isArray");
/* a Timeout's methods, node:timers, or a callback that clears its own timer: `this` is the Timeout */
/* a Timeout disposed of: timer[Symbol.dispose](), or a `using` declaration (the program's own code,
 * or a package's: the prelude's streams name Symbol.dispose too) */
const TIMER_DISPOSE = /\bSymbol\s*\.\s*(?:asyncD|d)ispose\b|\b(?:await\s+)?using\s+[\w$]+\s*=/;
const TIMER_USE = /\.(?:unref|hasRef|refresh)\s*\(|\bclass Timeout\b|\bclear(?:Interval|Timeout)\s*\(\s*this\s*\)/;
const EMITTER_METHOD = /(?:\.|\[\s*["'`])\s*(?:on|once|off|emit|addListener|prependListener|prependOnceListener|removeListener|removeAllListeners|listeners|rawListeners|listenerCount|eventNames|setMaxListeners|getMaxListeners)\b/;

/** The table createRequire's require() looks packages up in (node:module): the Symbol.for key
 *  on globalThis of a Map, name → a function giving the module's exports, which the bundler
 *  sets with the packages it finds a program may require() at run time. */
export const requireTable = "visaljs.requireTable";

/** The host primitives: the name prelude code imports → its C function (JSNativeFn) and length.
 *  Failures return -errno (a number), which the prelude turns into Node's error. */
export const primitives: Readonly<Record<string, { c: string; length: number }>> = {
  fsReadFile: { c: "js_host_fs_read_file", length: 1 },       // (path) → string (UTF-8)
  fsWriteFile: { c: "js_host_fs_write_file", length: 3 },     // (path, string, append) → undefined
  fsExists: { c: "js_host_fs_exists", length: 1 },            // (path) → boolean
  fsUnlink: { c: "js_host_fs_unlink", length: 1 },            // (path) → undefined
  fsStat: { c: "js_host_fs_stat", length: 2 },                // (path, follow) → [mode, size, mtimeMs, atimeMs, ctimeMs, birthtimeMs, ino, dev, nlink, uid, gid, rdev, blksize, blocks]
  fsReaddir: { c: "js_host_fs_readdir", length: 1 },          // (path) → [name, type (uv_dirent_type_t), …]
  fsReadAt: { c: "js_host_fs_read_at", length: 3 },           // (path, position, length) → Buffer
  fsRealpath: { c: "js_host_fs_realpath", length: 1 },        // (path) → the canonical path
  fsMkdir: { c: "js_host_fs_mkdir", length: 2 },              // (path, mode) → undefined
  fsUtimes: { c: "js_host_fs_utimes", length: 3 },            // (path, atime, mtime: seconds) → undefined
  fsConstants: { c: "js_host_fs_constants", length: 0 },      // () → fs.constants as [name, number, …]
  fsCall: { c: "js_host_fs_call", length: 2 },                // (op, …) → the rest of the fs calls (FS_OPS in prelude/fs.js): undefined, a result, or -errno
  /* fs.watch and fs.watchFile: libuv's file system event handles and stat pollers (src/host_fswatch.c) */
  fsWatchStart: { c: "js_host_fs_watch_start", length: 3 },   // (path, recursive, cb) → id | -errno; cb(events | -errno, filename)
  fsPollStart: { c: "js_host_fs_poll_start", length: 3 },     // (path, interval, cb) → id | -errno; cb(status, current, previous)
  fsWatchClose: { c: "js_host_fs_watch_close", length: 1 },
  fsWatchRef: { c: "js_host_fs_watch_ref", length: 2 },       // (id, ref)
  fsOpen: { c: "js_host_fs_open", length: 3 },                // (path, flags: "w+" | O_* number, mode) → fd
  fsClose: { c: "js_host_fs_close", length: 1 },              // (fd) → undefined
  fsWrite: { c: "js_host_fs_write", length: 5 },              // (fd, bytes, offset, length, position (-1: current)) → bytes written
  fsRead: { c: "js_host_fs_read", length: 5 },                // (fd, bytes, offset, length, position (-1: current)) → bytes read
  errnoName: { c: "js_host_errno_name", length: 1 },          // (-errno) → "ENOENT"
  errnoMessage: { c: "js_host_errno_message", length: 1 },    // (-errno) → "no such file or directory"
  errnoMap: { c: "js_host_errno_map", length: 0 },            // () → [[uv code, name, message], …], libuv's order
  cwd: { c: "js_host_cwd", length: 0 },                       // () → the working directory (the runtime's)
  bufferInspectMaxBytes: { c: "js_host_buffer_inspect_max_bytes", length: 1 }, // (n) → undefined: node:buffer's INSPECT_MAX_BYTES, which Buffer's inspect shows
  cloneClass: { c: "js_host_clone_class", length: 1 },        // (value) → its internal class's name, for structuredClone; undefined for a primitive
  /* fetch() (prelude/internal/fetch.js), over the fetch component's Request and Response (runtime/src/fetch.c) */
  fetchHeaderList: { c: "js_host_fetch_header_list", length: 1 },   // (headers) → [name, value, …] as added
  fetchRequestBody: { c: "js_host_fetch_request_body", length: 1 }, // (request) → Uint8Array | ReadableStream | null; the body is then used
  fetchResponse: { c: "js_host_fetch_response", length: 6 },        // (status, statusText, headers, body, url, redirected) → Response
  fetchFormDataHooks: { c: "js_host_fetch_form_data_hooks", length: 2 }, // (serialize, parse): FormData's (prelude/internal/form_data.js)
  ttyIsatty: { c: "js_host_tty_isatty", length: 1 },          // (fd) → boolean
  timerUnref: { c: "js_host_timer_unref", length: 2 },        // (fn, ms) → id: a timer that doesn't keep the program alive
  loopNow: { c: "js_host_loop_now", length: 0 },             // () → libuv's time in ms as of the last poll (Node's getLibuvNow)
  /* node:timers' Timeouts and Immediates (the runtime's timers, runtime/src/jobs.c) */
  timerStart: { c: "js_host_timer_start", length: 4 },        // (fn, ms (< 0: an immediate), ref, id (0: new; else restart it)) → id
  timerRef: { c: "js_host_timer_ref", length: 2 },            // (id, ref)
  timerClear: { c: "js_host_timer_clear", length: 1 },        // (id)
  /* the async context the runtime carries through jobs, timers and promise reactions */
  asyncContextGet: { c: "js_host_async_context_get", length: 0 },  // () → the current one (undefined: none)
  asyncContextSet: { c: "js_host_async_context_set", length: 1 },  // (context)
  /* the program's own process, beyond the runtime's process object (src/host_proc.c) */
  procChdir: { c: "js_host_proc_chdir", length: 1 },              // (path) → 0 | -errno
  procUmask: { c: "js_host_proc_umask", length: 1 },              // (mask | -1) → the old mask
  procUptime: { c: "js_host_proc_uptime", length: 0 },            // () → seconds since the program started
  procCpuUsage: { c: "js_host_proc_cpu_usage", length: 1 },       // (thread) → [user µs, system µs] | -errno
  procResourceUsage: { c: "js_host_proc_resource_usage", length: 0 },// () → [16 numbers, Node's order] | -errno
  procPpid: { c: "js_host_proc_ppid", length: 0 },                // () → the parent's pid
  procMemory: { c: "js_host_proc_memory", length: 0 },            // () → [available, constrained] bytes
  procSetId: { c: "js_host_proc_set_id", length: 2 },             // (0 setuid | 1 setgid | 2 seteuid | 3 setegid, id) → 0 | -errno
  procUserId: { c: "js_host_proc_user_id", length: 1 },           // (name) → uid | -1
  procGroupId: { c: "js_host_proc_group_id", length: 1 },         // (name) → gid | -1
  procUserName: { c: "js_host_proc_user_name", length: 1 },       // (uid) → name | null
  procGetGroups: { c: "js_host_proc_get_groups", length: 0 },     // () → [gid, …] | -errno
  procSetGroups: { c: "js_host_proc_set_groups", length: 1 },     // ([gid, …]) → 0 | -errno
  procInitGroups: { c: "js_host_proc_init_groups", length: 2 },   // (user, gid) → 0 | -errno
  procAbort: { c: "js_host_proc_abort", length: 0 },              // ()
  procReallyExit: { c: "js_host_proc_really_exit", length: 1 },   // (code): output flushed, no 'exit'
  procExecve: { c: "js_host_proc_execve", length: 3 },            // (file, [arg, …], [key=value, …]) → -errno
  /* node:os, through libuv (src/host_os.c): strings and numbers, or -errno */
  osInterfaces: { c: "js_host_os_interfaces", length: 0 },    // () → [name, address, netmask, family, mac, internal, scopeid, …] | -errno
  osGetPriority: { c: "js_host_os_get_priority", length: 1 },  // (pid) → priority | -errno
  osSetPriority: { c: "js_host_os_set_priority", length: 2 },  // (pid, priority) → 0 | -errno
  osUname: { c: "js_host_os_uname", length: 0 },              // () → [sysname, release, version, machine]
  osHostname: { c: "js_host_os_hostname", length: 0 },
  osHomedir: { c: "js_host_os_homedir", length: 0 },
  osMemory: { c: "js_host_os_memory", length: 0 },            // () → [total, free]
  osUptime: { c: "js_host_os_uptime", length: 0 },
  osLoadavg: { c: "js_host_os_loadavg", length: 0 },
  osParallelism: { c: "js_host_os_parallelism", length: 0 },
  osCpus: { c: "js_host_os_cpus", length: 0 },                // () → [[model, speed, user, nice, sys, idle, irq], …]
  osUserInfo: { c: "js_host_os_user_info", length: 0 },       // () → [uid, gid, username, homedir, shell]
  osConstants: { c: "js_host_os_constants", length: 0 },      // () → [signals, errno] as [name, number, …]
  /* process's signal events and process.kill (src/host_signal.c) */
  signalStart: { c: "js_host_signal_start", length: 2 },      // (signum, cb) → 0 | -errno: cb(signum) on each arrival
  signalStop: { c: "js_host_signal_stop", length: 1 },
  processKill: { c: "js_host_process_kill", length: 2 },      // (pid, signum) → 0 | -errno
  processMemory: { c: "js_host_process_memory", length: 0 },  // () → [rss, heapTotal, heapUsed]
  /* node:child_process: child processes on libuv (src/host_process.c); their pipes are node:net's */
  processSpawn: { c: "js_host_process_spawn", length: 9 },   // (file, args, envPairs, cwd, stdio [[kind, value], …], flags, uid, gid, cb) → [0, id, pid] | [-errno]; cb(exitStatus, termSignal)
  processKillChild: { c: "js_host_process_kill_child", length: 2 },  // (id, signum) → 0 | -errno
  processRef: { c: "js_host_process_ref", length: 2 },       // (id, ref)
  processClose: { c: "js_host_process_close", length: 1 },   // (id): after its exit
  processSpawnSync: { c: "js_host_process_spawn_sync", length: 11 },  // (file, args, envPairs, cwd, stdio, flags, uid, gid, timeout, maxBuffer, killSignal) → [error, pid, exitStatus, termSignal, output]
  /* node:util: the runtime's own (console uses them too) */
  utilInspect: { c: "js_util_inspect", length: 2 },
  utilFormat: { c: "js_util_format", length: 0 },
  utilFormatWithOptions: { c: "js_util_format_with_options", length: 1 },
  utilTypeTag: { c: "js_util_type_tag", length: 1 },          // (value) → its internal kind: "Date", "Proxy", "Uint8Array", … | ""
  eventTargetListeners: { c: "js_event_target_listeners", length: 2 },  // (target, type) → its listeners, in order | undefined
  /* node:crypto: the runtime's own (Web Crypto runs on the same C; runtime/src/crypto_host.c) */
  cryptoHashNew: { c: "js_crypto_hash_new", length: 2 },      // (algorithm, outputLength) → hash | null
  cryptoHashInfo: { c: "js_crypto_hash_info", length: 1 },    // (algorithm) → digest length | -1 unknown | -(len + 1) XOF
  cryptoHashCopy: { c: "js_crypto_hash_copy", length: 2 },    // (hash, outputLength) → hash
  cryptoHmacNew: { c: "js_crypto_hmac_new", length: 2 },      // (algorithm, key bytes | string) → hmac | null
  cryptoDigestUpdate: { c: "js_crypto_digest_update", length: 2 },  // (hash | hmac, string (UTF-8) | bytes)
  cryptoDigestFinal: { c: "js_crypto_digest_final", length: 1 },    // (hash | hmac) → Buffer
  cryptoRandomFill: { c: "js_crypto_random_fill", length: 3 },      // (bytes, offset, size)
  cryptoHostRandomUUID: { c: "js_crypto_host_random_uuid", length: 0 },
  cryptoTimingSafeEqual: { c: "js_crypto_timing_safe_equal", length: 2 },
  cryptoHashes: { c: "js_crypto_hashes", length: 0 },         // () → crypto.getHashes()
  cryptoPbkdf2: { c: "js_crypto_pbkdf2", length: 5 },         // (digest, password, salt, iterations, keylen) → Buffer | null | false
  cryptoHkdf: { c: "js_crypto_hkdf", length: 5 },             // (digest, ikm, salt, info, keylen) → ArrayBuffer | null | false
  cryptoScryptCheck: { c: "js_crypto_scrypt_check", length: 4 },  // (N, r, p, maxmem) → 0 | 1 invalid | 2 memory
  cryptoScrypt: { c: "js_crypto_scrypt", length: 6 },         // (password, salt, N, r, p, keylen) → Buffer | false
  /* ciphers: results are Buffers, or the C error codes (JS_CIPHER_ERR_*) the prelude turns into Node's errors */
  cryptoCipherNew: { c: "js_crypto_cipher_new", length: 5 },  // (name, encrypt, key, iv | null, authTagLength | -1) → handle | code
  cryptoCipherUpdate: { c: "js_crypto_cipher_update", length: 2 },
  cryptoCipherFinal: { c: "js_crypto_cipher_final", length: 1 },
  cryptoCipherSetAAD: { c: "js_crypto_cipher_set_aad", length: 3 },  // (handle, aad, plaintextLength | -1) → 0 | code
  cryptoCipherSetAuthTag: { c: "js_crypto_cipher_set_auth_tag", length: 2 },
  cryptoCipherGetAuthTag: { c: "js_crypto_cipher_get_auth_tag", length: 1 },  // → Buffer | undefined
  cryptoCipherSetPadding: { c: "js_crypto_cipher_set_padding", length: 2 },   // → boolean
  cryptoCipherInfo: { c: "js_crypto_cipher_info", length: 1 },  // (name | nid) → [name, nid, mode, blockSize, ivLength, keyLength] | null
  cryptoCiphers: { c: "js_crypto_ciphers", length: 0 },
  /* keys: handles to the runtime's key record, which CryptoKey shares (runtime/src/crypto_pkey.c) */
  cryptoKeyParse: { c: "js_crypto_key_parse", length: 3 },    // (der, encoding 0 spki 1 pkcs1 2 pkcs8 3 sec1 4 cert, private) → handle | error code
  cryptoKeyExport: { c: "js_crypto_key_export", length: 2 },  // (handle, encoding) → DER Buffer | error code
  cryptoKeyInfo: { c: "js_crypto_key_info", length: 1 },      // (handle) → [type, asymmetricKeyType, namedCurve, pss [hash, mgf1, salt] | null]
  cryptoKeyParts: { c: "js_crypto_key_parts", length: 1 },    // (handle) → RSA's n, e, d, p, q, dp, dq, qi | EC's point, scalar (Buffers)
  cryptoKeyFromParts: { c: "js_crypto_key_from_parts", length: 4 },  // (kind, private, crv, parts) → handle | error code
  cryptoKeyPublic: { c: "js_crypto_key_public", length: 1 },  // (private handle) → its public handle
  cryptoKeyEquals: { c: "js_crypto_key_equals", length: 2 },
  cryptoKeySecret: { c: "js_crypto_key_secret", length: 1 },  // (bytes) → handle
  cryptoKeySecretBytes: { c: "js_crypto_key_secret_bytes", length: 1 },
  cryptoKeyGenerate: { c: "js_crypto_key_generate", length: 4 },  // (kind, bits | curve, publicExponent, pss) → handle | error code
  cryptoKeyHandleOf: { c: "js_crypto_key_handle_of", length: 1 },  // (CryptoKey) → its handle | undefined
  cryptoToCryptoKey: { c: "js_crypto_to_crypto_key", length: 5 },  // importKey's steps, synchronously
  /* asymmetric operations (runtime/src/crypto_asym.c): results, or error codes (JS_ASYM_ERR_*) */
  cryptoSign: { c: "js_crypto_sign", length: 6 },             // (key, hash, digest, padding, saltLength, p1363) → Buffer | code
  cryptoVerify: { c: "js_crypto_verify", length: 7 },         // (key, hash, digest, signature, padding, saltLength, p1363) → boolean | code
  cryptoSignMessage: { c: "js_crypto_sign_message", length: 2 },      // (key, data) → Buffer | code: Ed25519
  cryptoVerifyMessage: { c: "js_crypto_verify_message", length: 3 },  // (key, data, signature) → boolean | code
  /* big integers (runtime/src/crypto_bn.c): Diffie-Hellman, generatePrime, checkPrime */
  cryptoModExp: { c: "js_crypto_mod_exp", length: 4 },        // (base, exponent, modulus, pad) → Buffer | null
  cryptoGeneratePrime: { c: "js_crypto_generate_prime", length: 4 },  // (bits, safe, add, rem) → Buffer | null
  cryptoCheckPrime: { c: "js_crypto_check_prime", length: 2 },  // (candidate, checks) → boolean
  cryptoRsaCrypt: { c: "js_crypto_rsa_crypt", length: 6 },    // (key, op, data, padding, oaepHash, oaepLabel) → Buffer | code
  cryptoEcdh: { c: "js_crypto_ecdh", length: 2 },             // (private key, peer point | key) → secret | code
  cryptoEcPoint: { c: "js_crypto_ec_point", length: 3 },      // (curve, point, format 4 | 2 | 6) → Buffer | code
  cryptoEcPrivate: { c: "js_crypto_ec_private", length: 2 },  // (curve, scalar) → handle | code
  /* node:tls: BoringSSL (runtime/src/crypto_tls.c); contexts (SSL_CTX) and connections (SSL) are handles */
  tlsContextNew: { c: "js_tls_context_new", length: 6 },      // (min, max, ciphers, serverPreference, groups, sigalgs) → context | error
  tlsContextAddRoots: { c: "js_tls_context_add_roots", length: 1 },
  tlsContextAddCA: { c: "js_tls_context_add_ca", length: 2 },  // (context, der) → 0 | error
  tlsContextSetCert: { c: "js_tls_context_set_cert", length: 2 },  // (context, [der, …]) → 0 | error
  tlsContextSetKey: { c: "js_tls_context_set_key", length: 2 },    // (context, key handle) → 0 | 1 unusable | 2 not the cert's
  tlsContextAddCredential: { c: "js_tls_context_add_credential", length: 3 },  // (context, [der, …], key handle) → 0 | 1 unusable | 2 not the cert's
  tlsContextAllowPartialChain: { c: "js_tls_context_allow_partial_chain", length: 1 },
  tlsContextTicketKeys: { c: "js_tls_context_ticket_keys", length: 2 },  // (context, keys | null) → Buffer: its 48 bytes
  tlsContextSetSessions: { c: "js_tls_context_set_sessions", length: 3 },  // (context, timeout | null, sessionIdContext | null)
  tlsPkcs12: { c: "js_tls_pkcs12", length: 2 },               // (der, password | null) → [pkcs8 | null, cert | null, [der, …]] | reason
  tlsRootCertificates: { c: "js_tls_root_certificates", length: 0 },  // () → [pem, …]
  tlsCiphers: { c: "js_tls_ciphers", length: 0 },             // () → [OpenSSL name, …]
  /* crypto.X509Certificate's checks (runtime/src/crypto_tls.c) */
  x509Check: { c: "js_x509_check", length: 4 },               // (der, 0 host | 1 email | 2 ip, value, flags) → the name matched | undefined
  x509CheckIssued: { c: "js_x509_check_issued", length: 2 },  // (der, issuer der) → boolean
  x509CheckKey: { c: "js_x509_check_key", length: 2 },        // (der, key handle) → public: signed it; private: its key
  tlsNew: { c: "js_tls_new", length: 7 },                     // (context, server, servername, alpn, session, requestCert, alpnStrict) → connection | error
  tlsRun: { c: "js_tls_run", length: 3 },                     // (connection, records | null, data | null) → [records, data, taken, state, error, handshakes, keylog]
  tlsShutdown: { c: "js_tls_shutdown", length: 1 },           // (connection) → records: our close_notify
  tlsInfo: { c: "js_tls_info", length: 1 },                   // → [version, cipher, alpn | false, servername | null, resumed, group]
  tlsPeerCerts: { c: "js_tls_peer_certs", length: 1 },        // → [der, …]
  tlsVerifyError: { c: "js_tls_verify_error", length: 1 },    // → 0 | X509_V_ERR_* | -1 none received
  tlsSession: { c: "js_tls_session", length: 1 },             // → Buffer | undefined
  tlsTicket: { c: "js_tls_ticket", length: 1 },               // → Buffer | undefined: a client's session ticket
  tlsExportKeyingMaterial: { c: "js_tls_export_keying_material", length: 4 },
  tlsSetNoRenegotiation: { c: "js_tls_set_no_renegotiation", length: 1 },
  tlsEnableKeylog: { c: "js_tls_enable_keylog", length: 1 },
  tlsSetMaxSendFragment: { c: "js_tls_set_max_send_fragment", length: 2 },  // (connection, size 512–16384)
  tlsFinished: { c: "js_tls_finished", length: 2 },           // (connection, peer) → Buffer | undefined
  /* node:http: llhttp on node:net's sockets (src/host_http.c); a connection is its socket's handle id */
  httpParsers: { c: "js_host_http_parsers", length: 6 },      // (onHead, onBody, onComplete, onUpgrade, onError, onDrain) → parsers
  httpAttach: { c: "js_host_http_attach", length: 4 },        // (conn, parsers, response, maxHeaderSize) → 0 | -errno: bytes go to llhttp
  httpDetach: { c: "js_host_http_detach", length: 2 },        // (conn, afterRead): bytes go to JS again (afterRead: once the read is parsed)
  httpBusy: { c: "js_host_http_busy", length: 1 },
  httpGuard: { c: "js_host_http_guard", length: 2 },          // (conn, onData) → an idle client socket's reads call onData(conn)
  httpPending: { c: "js_host_http_pending", length: 1 },      // (conn) → bytes written, not yet sent
  httpWritten: { c: "js_host_http_written", length: 1 },      // (conn) → bytes written, sent or not
  httpWatchDrain: { c: "js_host_http_watch_drain", length: 1 },  // (conn) → drained already | onDrain later            // (conn) → a message under way on it
  httpExpired: { c: "js_host_http_expired", length: 3 },      // (parsers, headersTimeout, requestTimeout) → [conn, …] over time
  httpWrite: { c: "js_host_http_write", length: 3 },          // (conn, string | Uint8Array, latin1) → written (corked)
  httpFlush: { c: "js_host_http_flush", length: 1 },          // (conn): the corked output, now
  httpFedOpen: { c: "js_host_http_fed_open", length: 1 },     // (writer) → conn: a socket whose bytes JS feeds (TLS, a Duplex)
  httpFeed: { c: "js_host_http_feed", length: 2 },            // (conn, bytes | null) → taken by the parser
  httpFedClose: { c: "js_host_http_fed_close", length: 1 },   // (conn)
  httpDate: { c: "js_host_http_date", length: 0 },            // () → "Sun, 04 Oct 2026 20:51:49 GMT" (cached per second)
  /* node:dgram: UDP handles on libuv (src/host_udp.c); each calls back cb(event, …) */
  udpOpen: { c: "js_host_udp_open", length: 1 },              // (cb) → id
  udpOpenFd: { c: "js_host_udp_open_fd", length: 2 },         // (id, fd) → 0 | -errno
  udpFd: { c: "js_host_udp_fd", length: 1 },                  // (id) → fd | -errno
  udpBind: { c: "js_host_udp_bind", length: 4 },              // (id, ip, port, flags) → 0 | -errno
  udpConnect: { c: "js_host_udp_connect", length: 3 },        // (id, ip, port) → 0 | -errno
  udpDisconnect: { c: "js_host_udp_disconnect", length: 1 },
  udpSend: { c: "js_host_udp_send", length: 4 },              // (id, [bytes…], ip | null, port) → length + 1 | 0 queued | -errno
  udpSendQueue: { c: "js_host_udp_send_queue", length: 2 },   // (id, count) → bytes | requests waiting
  udpRecvStart: { c: "js_host_udp_recv_start", length: 1 },
  udpRecvStop: { c: "js_host_udp_recv_stop", length: 1 },
  udpAddress: { c: "js_host_udp_address", length: 2 },        // (id, peer) → [address, family, port] | -errno
  udpSetBroadcast: { c: "js_host_udp_set_broadcast", length: 2 },
  udpSetTTL: { c: "js_host_udp_set_ttl", length: 2 },
  udpSetMulticastTTL: { c: "js_host_udp_set_multicast_ttl", length: 2 },
  udpSetMulticastLoopback: { c: "js_host_udp_set_multicast_loopback", length: 2 },
  udpSetMulticastInterface: { c: "js_host_udp_set_multicast_interface", length: 2 },
  udpMembership: { c: "js_host_udp_membership", length: 4 },  // (id, group, iface | null, join) → 0 | -errno
  udpSourceMembership: { c: "js_host_udp_source_membership", length: 5 },  // (id, source, group, iface | null, join)
  udpBufferSize: { c: "js_host_udp_buffer_size", length: 3 }, // (id, size, recv) → size | -errno
  udpClose: { c: "js_host_udp_close", length: 1 },
  udpRef: { c: "js_host_udp_ref", length: 2 },
  udpHasRef: { c: "js_host_udp_has_ref", length: 1 },
  /* node:net and dns.lookup: TCP and pipe handles on libuv (src/host_net.c); each calls back cb(event, value) */
  netOpen: { c: "js_host_net_open", length: 2 },              // (pipe, cb) → id
  netGuessHandle: { c: "js_host_net_guess_handle", length: 1 },  // (fd) → "TCP" | "PIPE" | "TTY" | "UDP" | "FILE" | "UNKNOWN"
  netOpenFd: { c: "js_host_net_open_fd", length: 2 },         // (id, fd) → 0 | -errno
  netBind: { c: "js_host_net_bind", length: 4 },              // (id, ip | path, port, flags 1 ipv6Only | 2 reusePort) → 0 | -errno
  netChmod: { c: "js_host_net_chmod", length: 2 },            // (id, mode 1 readable | 2 writable) → 0 | -errno: a pipe server's
  netListen: { c: "js_host_net_listen", length: 2 },          // (id, backlog) → 0 | -errno
  netConnect: { c: "js_host_net_connect", length: 3 },        // (id, ip | path, port) → 0 | -errno
  netCallback: { c: "js_host_net_callback", length: 2 },      // (id, cb): an accepted connection's
  netReadStart: { c: "js_host_net_read_start", length: 1 },
  netReadStop: { c: "js_host_net_read_stop", length: 1 },
  netWrite: { c: "js_host_net_write", length: 2 },            // (id, bytes) → 0 done | 1 pending | -errno
  netShutdown: { c: "js_host_net_shutdown", length: 1 },
  netClose: { c: "js_host_net_close", length: 1 },
  netReset: { c: "js_host_net_reset", length: 1 },            // close with an RST → 0 | -errno
  netRef: { c: "js_host_net_ref", length: 2 },                // (id, ref)
  netAddress: { c: "js_host_net_address", length: 2 },        // (id, peer) → [address, family, port] | path | -errno
  netFd: { c: "js_host_net_fd", length: 1 },                  // (id) → its descriptor | -errno (-1 on Windows)
  netNoDelay: { c: "js_host_net_no_delay", length: 2 },
  netKeepAlive: { c: "js_host_net_keep_alive", length: 3 },   // (id, on, seconds)
  netTypeOfService: { c: "js_host_net_type_of_service", length: 2 }, // (id, tos | -1) → 0 | the socket's tos | -errno
  ttyOpen: { c: "js_host_tty_open", length: 2 },              // (fd, cb) → id | -errno: a terminal's, read as a net handle
  ttySetRawMode: { c: "js_host_tty_set_raw_mode", length: 2 }, // (id, raw) → 0 | -errno
  dnsLookup: { c: "js_host_dns_lookup", length: 3 },          // (host, family, cb) → 0 | -errno; cb(errno, code, [[address, family], …])
  dnsLookupService: { c: "js_host_dns_lookup_service", length: 3 },  // (ip, port, cb) → 0 | -errno; cb(errno, hostname, service)
  /* dns.Resolver: c-ares channels on libuv (src/host_dns.c) */
  dnsChannel: { c: "js_host_dns_channel", length: 3 },        // (timeoutMs, tries, maxTimeoutMs) → channel
  dnsQuery: { c: "js_host_dns_query", length: 4 },            // (channel, name, type, cb) → 0; cb(status, answer | null)
  dnsReverse: { c: "js_host_dns_reverse", length: 3 },        // (channel, ip, cb) → 0 | -EINVAL; cb(status, [name, …] | null)
  dnsParse: { c: "js_host_dns_parse", length: 2 },            // (answer, kind) → [status, records, ttls, cname]
  dnsGetServers: { c: "js_host_dns_get_servers", length: 1 }, // (channel) → [[ip, port], …]
  dnsSetServers: { c: "js_host_dns_set_servers", length: 2 }, // (channel, [[family, ip, port], …]) → 0 | status
  dnsSetLocalAddress: { c: "js_host_dns_set_local_address", length: 3 },  // (channel, ip4 | null, ip6 | null)
  dnsCancel: { c: "js_host_dns_cancel", length: 1 },
  dnsStrerror: { c: "js_host_dns_strerror", length: 1 },      // (status) → message
  /* node:zlib: Chromium's zlib, as Node has it (src/host_zlib.c); a stream is a handle. Failures are
   * [message, errno, code], as Node's binding passes them to its onerror */
  zlibNew: { c: "js_host_zlib_new", length: 1 },              // (mode) → handle
  zlibInit: { c: "js_host_zlib_init", length: 7 },            // (handle, windowBits, level, memLevel, strategy, dictionary | undefined, rejectGarbageAfterEnd)
  zlibWrite: { c: "js_host_zlib_write", length: 9 },          // (handle, flush, in | null, inOff, inLen, out, outOff, outLen, state) → 0 | failure; state: [availOut, availIn]
  zlibParams: { c: "js_host_zlib_params", length: 3 },        // (handle, level, strategy) → 0 | failure
  zlibReset: { c: "js_host_zlib_reset", length: 1 },          // (handle) → 0 | failure
  zlibClose: { c: "js_host_zlib_close", length: 1 },
  zlibCrc32: { c: "js_host_zlib_crc32", length: 2 },          // (string | bytes, value) → CRC-32
  /* its Brotli streams (src/host_brotli.c), the same way */
  brotliNew: { c: "js_host_brotli_new", length: 1 },          // (mode) → handle
  brotliInit: { c: "js_host_brotli_init", length: 3 },        // (handle, params: Uint32Array, 0xffffffff unset, dictionary | undefined) → 0 | failure
  brotliWrite: { c: "js_host_brotli_write", length: 9 },      // as zlibWrite
  brotliReset: { c: "js_host_brotli_reset", length: 1 },      // (handle) → 0 | failure
  brotliClose: { c: "js_host_brotli_close", length: 1 },
  /* and its zstd streams (src/host_zstd.c) */
  zstdNew: { c: "js_host_zstd_new", length: 1 },              // (compress) → handle
  zstdInit: { c: "js_host_zstd_init", length: 4 },            // (handle, params: Uint32Array, pledgedSrcSize | undefined, dictionary | undefined) → 0 | failure
  zstdWrite: { c: "js_host_zstd_write", length: 9 },          // as zlibWrite
  zstdReset: { c: "js_host_zstd_reset", length: 1 },          // (handle) → 0 | failure
  zstdClose: { c: "js_host_zstd_close", length: 1 },
};

/* libuv's sources for this platform, as its CMakeLists.txt lists them, its flags, and the
 * system libraries it links */
const UV_COMMON = ["fs-poll", "idna", "inet", "random", "strscpy", "strtok", "thread-common", "threadpool", "timer", "uv-common", "uv-data-getter-setters", "version"];
const UV_UNIX = ["async", "core", "dl", "fs", "getaddrinfo", "getnameinfo", "loop-watcher", "loop", "pipe", "poll", "process", "random-devurandom", "signal", "stream", "tcp", "thread", "tty", "udp", "proctitle"].map((f) => `unix/${f}`);
const UV_PLATFORM: Record<string, { sources: string[]; defines: string[]; link?: string[] }> = {
  linux: { sources: [...UV_UNIX, ...["linux", "procfs-exepath", "random-getrandom", "random-sysctl-linux"].map((f) => `unix/${f}`)], defines: ["_GNU_SOURCE", "_POSIX_C_SOURCE=200112"] },
  darwin: { sources: [...UV_UNIX, ...["random-getentropy", "darwin-proctitle", "darwin", "fsevents", "bsd-ifaddrs", "kqueue"].map((f) => `unix/${f}`)], defines: ["_DARWIN_UNLIMITED_SELECT=1", "_DARWIN_USE_64_BIT_INODE=1"] },
  win32: {
    sources: ["async", "core", "detect-wakeup", "dl", "error", "fs", "fs-event", "getaddrinfo", "getnameinfo", "handle", "loop-watcher", "pipe", "thread", "poll", "process", "process-stdio", "signal", "snprintf", "stream", "tcp", "tty", "udp", "util", "winapi", "winsock"].map((f) => `win/${f}`),
    defines: ["WIN32_LEAN_AND_MEAN", "_WIN32_WINNT=0x0A00", "_CRT_DECLARE_NONSTDC_NAMES=0"],
    link: ["psapi", "user32", "advapi32", "iphlpapi", "userenv", "ws2_32", "dbghelp", "ole32", "shell32"],
  },
};

/* c-ares's source directories, and its configured headers by platform (Node's cares.gyp; Windows needs none) */
const CARES_DIRS = ["", "dsa", "event", "legacy", "record", "str", "util"].map((d) => join(CARES, "src", "lib", d));
const CARES_CONFIG: Record<string, string> = { linux: "linux", darwin: "darwin", freebsd: "freebsd", openbsd: "openbsd" };

/* Brotli's platform macro, as Node's brotli.gyp defines it */
const BROTLI_OS: Record<string, string> = { linux: "OS_LINUX", darwin: "OS_MACOSX", freebsd: "OS_FREEBSD" };

/** The C libraries to build and link (before libjsrt, which they use), for `platform` (a
 *  prebuilt package's is another's: cli/prebuilt). */
export function libraries(runtimeInclude: string, platform: NodeJS.Platform = process.platform) {
  const uv = UV_PLATFORM[platform];
  const uvSources = uv ? [...UV_COMMON, ...uv.sources].map((f) => join(UV, "src", `${f}.c`)) : [];
  const zlibHeaders = [...files(ZLIB, ".h"), ...files(join(ZLIB, "contrib", "optimizations"), ".h")];
  const brotliHeaders = ["common", "dec", "enc", join("include", "brotli")].flatMap((d) => files(join(BROTLI, d), ".h"));
  const zstdHeaders = ["", "common", "compress", "decompress"].flatMap((d) => files(join(ZSTD, d), ".h"));
  const caresHeaders = [...files(join(CARES, "include"), ".h"), ...CARES_DIRS.flatMap((d) => files(d, ".h")), ...files(join(CARES, "src", "lib", "include"), ".h"),
    ...files(join(CARES, "src", "lib", "thirdparty", "apple"), ".h"), ...(CARES_CONFIG[platform] ? files(join(CARES, "config", CARES_CONFIG[platform]), ".h") : [])];
  const uvHeaders = [join(UV, "include"), join(UV, "include", "uv"), join(UV, "src"), join(UV, "src", "unix"), join(UV, "src", "win")].flatMap((d) => files(d, ".h"));
  return [
    {
      name: "jsnode",
      sources: [...files(join(DIR, "src"), ".c"), ...files(LLHTTP, ".c")],
      /* the runtime's headers too: the host code is compiled against its structs (JSRuntime, …) */
      headers: [...files(INCLUDE, ".h"), ...files(runtimeInclude, ".h"), ...files(LLHTTP, ".h"), ...uvHeaders, ...zlibHeaders, ...brotliHeaders, ...zstdHeaders,
        ...caresHeaders],
      flags: [`-I${INCLUDE}`, `-I${runtimeInclude}`, `-I${LLHTTP}`, `-I${join(UV, "include")}`, `-I${ZLIB}`, `-I${join(BROTLI, "include")}`, `-I${ZSTD}`,
        `-I${join(CARES, "include")}`, "-DCARES_STATICLIB", "-DCARES_NO_DEPRECATED"],
    },
    {
      /* Chromium's zlib, as Node vendors it (deps/zlib): its portable C, whose output is the same
       * bytes as Node's on every CPU (the SIMD paths only make checksums and copies faster) */
      name: "zlib",
      sources: files(ZLIB, ".c"),
      headers: zlibHeaders,
      flags: ["-w", "-DCPU_NO_SIMD", "-DHAVE_HIDDEN", `-I${ZLIB}`],
    },
    {
      /* Brotli 1.1.0, as Node vendors it (deps/brotli) */
      name: "brotli",
      sources: ["common", "dec", "enc"].flatMap((d) => files(join(BROTLI, d), ".c")),
      headers: brotliHeaders,
      flags: ["-w", ...(BROTLI_OS[platform] ? [`-D${BROTLI_OS[platform]}`] : []), `-I${join(BROTLI, "include")}`],
    },
    {
      /* zstd 1.5.7, as Node vendors it (deps/zstd), with its defines: multithreaded (nbWorkers), C only */
      name: "zstd",
      sources: ["common", "compress", "decompress"].flatMap((d) => files(join(ZSTD, d), ".c")),
      headers: zstdHeaders,
      flags: ["-w", "-DXXH_NAMESPACE=ZSTD_", "-DZSTD_MULTITHREAD", "-DZSTD_DISABLE_ASM", `-I${ZSTD}`],
    },
    {
      /* c-ares 1.34.8, as Node vendors it (deps/cares): dns.Resolver's queries, on libuv's loop (src/host_dns.c) */
      name: "cares",
      sources: CARES_DIRS.flatMap((d) => files(d, ".c")),
      headers: caresHeaders,
      flags: ["-std=gnu11", "-w", "-DCARES_STATICLIB", "-D_LARGEFILE_SOURCE", "-D_FILE_OFFSET_BITS=64",
        ...(platform === "win32" ? ["-DCARES_PULL_WS2TCPIP_H=1", "-D_WINSOCK_DEPRECATED_NO_WARNINGS"] : ["-DHAVE_CONFIG_H", "-D_GNU_SOURCE", "-D_DARWIN_USE_64_BIT_INODE=1"]),
        ...(CARES_CONFIG[platform] ? [`-I${join(CARES, "config", CARES_CONFIG[platform])}`] : []),
        `-I${join(CARES, "include")}`, `-I${join(CARES, "src", "lib")}`, `-I${join(CARES, "src", "lib", "include")}`],
      link: platform === "win32" ? ["ws2_32", "iphlpapi", "advapi32"] : [],
    },
    {
      name: "uv",
      sources: uvSources,
      headers: uvHeaders,
      flags: ["-std=gnu11", "-w", "-fno-strict-aliasing", "-D_FILE_OFFSET_BITS=64", "-D_LARGEFILE_SOURCE", ...(uv?.defines ?? []).map((d) => `-D${d}`),
        `-I${join(UV, "include")}`, `-I${join(UV, "src")}`],
      link: uv?.link ?? [],
    },
  ];
}

/** Third-party code in a program's binary, with the license files that go with it (the
 *  runtime's Notice). Each directory of third_party/ is in one of these. */
export const notices = [
  { name: "Node.js", what: "node: modules ported from Node.js", license: "MIT", files: [join(DIR, "third_party", "nodejs", "LICENSE")] },
  { name: "libuv", what: "the event loop and I/O", license: "MIT AND ISC AND BSD-2-Clause", files: [join(UV, "LICENSE"), join(UV, "LICENSE-extra")] },
  { name: "llhttp", what: "the HTTP parser", license: "MIT", files: [join(LLHTTP, "LICENSE")] },
  { name: "zlib", what: "deflate and gzip (Chromium's copy)", license: "Zlib AND BSD-3-Clause",
    files: [join(ZLIB, "LICENSE"), join(ZLIB, "LICENSE.chromium")] },
  { name: "Brotli", what: "Brotli compression", license: "MIT", files: [join(BROTLI, "LICENSE")] },
  { name: "Zstandard", what: "zstd compression", license: "BSD-3-Clause", files: [join(ZSTD, "LICENSE")] },
  { name: "c-ares", what: "dns.Resolver's DNS queries", license: "MIT", files: [join(CARES, "LICENSE.md")] },
  { name: "punycode.js", what: "node:punycode", license: "MIT", files: [join(DIR, "third_party", "punycode", "LICENSE")] },
  { name: "parseargs", what: "util.parseArgs", license: "MIT", files: [join(DIR, "third_party", "parseargs", "LICENSE")] },
  { name: "HdrHistogram", what: "perf_hooks' histograms", license: "CC0-1.0 OR BSD-2-Clause", files: [join(DIR, "third_party", "hdrhistogram", "LICENSE")] },
];
