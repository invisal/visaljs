// node:http, the server side: createServer, Server, IncomingMessage and
// ServerResponse. As in Node, a Server is a net.Server and a request's socket a net.Socket, whose
// bytes llhttp parses in C (node/src/host_http.c) before JS would see them. Responses are
// written as Node writes them: the status line, the headers in the order set, then Date,
// Connection, Keep-Alive and Content-Length or chunked encoding, corked into one write.
// A request is a Readable of the body's Buffers; a response writes strings and bytes. An
// upgrade (or CONNECT) hands the socket over with 'upgrade' ('connect'). Idle keep-alive
// connections close after keepAliveTimeout; server.timeout and setTimeout are the sockets'.
// Not yet: the client, headersTimeout and requestTimeout, trailers.
import {
  httpAttach, httpDate, httpDetach, httpExpired, httpFedClose, httpFedOpen, httpFeed, httpFlush, httpParsers, httpWrite, timerUnref,
} from "visaljs:host";
import { bindContext, currentContext, runInContext } from "./internal/async_context.js";
import { codeError, invalidArgType, outOfRange, validateInteger, validateString } from "./internal/errors.js";
import { Agent, globalAgent, setGlobalAgent } from "./internal/http_agent.js";
import { kConnectionsCheckingInterval } from "./internal/http_symbols.js";
import { createConnection, Server as NetServer } from "./net.js";
import { addAbortSignal, Readable, Stream } from "./stream.js";
import { callableClass } from "./internal/features.js";

export const METHODS = ["ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK", "M-SEARCH", "MERGE",
  "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY",
  "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE"];

export const STATUS_CODES = {
  100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints",
  200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content", 205: "Reset Content",
  206: "Partial Content", 207: "Multi-Status", 208: "Already Reported", 226: "IM Used",
  300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 305: "Use Proxy",
  307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 407: "Proxy Authentication Required", 408: "Request Timeout", 409: "Conflict", 410: "Gone",
  411: "Length Required", 412: "Precondition Failed", 413: "Payload Too Large", 414: "URI Too Long", 415: "Unsupported Media Type",
  416: "Range Not Satisfiable", 417: "Expectation Failed", 418: "I'm a Teapot", 421: "Misdirected Request",
  422: "Unprocessable Entity", 423: "Locked", 424: "Failed Dependency", 425: "Too Early", 426: "Upgrade Required",
  428: "Precondition Required", 429: "Too Many Requests", 431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
  505: "HTTP Version Not Supported", 506: "Variant Also Negotiates", 507: "Insufficient Storage", 508: "Loop Detected",
  509: "Bandwidth Limit Exceeded", 510: "Not Extended", 511: "Network Authentication Required",
};

/* the UTF-8 length of a string: Content-Length counts bytes */
function byteLength(s) {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x80) {
      if (c < 0x800) n += 1;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
        n += 2;
        i++;
      } else n += 2;
    }
  }
  return n;
}

function chunkLength(chunk) {
  return typeof chunk === "string" ? byteLength(chunk) : chunk.byteLength;
}

/* ---- IncomingMessage ------------------------------------------------------------------------ */

/* A request: a Readable of the body's Buffers, pushed as llhttp parses them. */
export class IncomingMessage extends Readable {
  constructor(socket) {
    super();
    this.socket = socket;
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.httpVersion = "1.1";
    this.complete = false;
    this.rawHeaders = [];
    this.headers = {};
    this.rawTrailers = [];
    this.trailers = {};
    this.method = null;
    this.url = "";
    this.aborted = false;
    this.statusCode = null;
    this.statusMessage = null;
    /* Node's: read yet, and dumped (stream utils' isServerRequest tells a request by them) */
    this._consuming = false;
    this._dumped = false;
  }

  get connection() {
    return this.socket;
  }

  _read() {
    this._consuming = true;
  }

  /* a response nobody reads: its body is discarded, so the socket isn't held up */
  _dump() {
    if (!this._dumped) {
      this._dumped = true;
      this.removeAllListeners("data");
      this.resume();
    }
  }

  _push(chunk) {
    this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }

  _finish() {
    this.complete = true;
    if (!this._readableState.ended) this.push(null);
  }

  /* Node's: a request without a body (the server's optimizeEmptyRequests) ended and closed at once,
   * without its 'data', 'end' and 'close' */
  _dumpAndCloseReadable() {
    this._dumped = true;
    const state = this._readableState;
    state.ended = true;
    state.endEmitted = true;
    state.destroyed = true;
    state.closed = true;
    state.closeEmitted = true;
  }

  /* the connection closed before the response was finished (Node's abortIncoming): destroyed, and
   * 'aborted' if its body wasn't all read (_destroy) */
  _abort() {
    if (this.destroyed) return;
    const e = new Error("aborted");
    e.code = "ECONNRESET";
    this.destroy(e);
  }

  /* Node's: 'aborted' when the body wasn't all read; 'error' only for those listening for it */
  _destroy(err, cb) {
    if (!this.readableEnded || !this.complete) {
      this.aborted = true;
      this.emit("aborted");
    }
    if (this.socket && !this.socket.destroyed && this.aborted) this.socket.destroy(err);
    process.nextTick(() => cb(this.listenerCount("error") === 0 ? undefined : err));
  }

  setTimeout(msecs, callback) {
    if (typeof callback === "function") this.on("timeout", callback);
    this.socket.setTimeout(msecs);
    return this;
  }
}

/* Node's req.headers: lowercase names; repeats joined with ", " ("; " for cookie), kept as an
 * array for set-cookie, and the first one kept for the headers that can't repeat (unless
 * joinDuplicateHeaders) */
const SINGLE = new Set(["age", "authorization", "content-length", "content-type", "etag", "expires", "from", "host",
  "if-modified-since", "if-unmodified-since", "last-modified", "location", "max-forwards", "proxy-authorization", "referer",
  "retry-after", "server", "user-agent"]);

function addHeader(headers, name, value, join) {
  const key = name.toLowerCase();
  const existing = headers[key];
  if (key === "set-cookie") {
    if (existing !== undefined) existing.push(value);
    else headers[key] = [value];
  } else if (SINGLE.has(key) && !join) {
    if (existing === undefined) headers[key] = value;  /* duplicates dropped */
  } else if (typeof existing === "string") {  /* as Node's: not a value inherited from Object.prototype */
    headers[key] = existing + (key === "cookie" ? "; " : ", ") + value;
  } else {
    headers[key] = value;
  }
}

/* ---- OutgoingMessage: a response's (and a request's) headers ------------------------------------ */

/* Node's checks: a header name is an HTTP token; a value has no control characters */
const tokenRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const headerCharRegex = /[^\t\x20-\x7e\x80-\xff]/;

export function validateHeaderName(name, label = "Header name") {
  if (typeof name !== "string" || !name || !tokenRegExp.test(name)) {
    throw codeError(TypeError, "ERR_INVALID_HTTP_TOKEN", label + " must be a valid HTTP token [\"" + name + "\"]");
  }
}

export function validateHeaderValue(name, value) {
  if (value === undefined) throw codeError(TypeError, "ERR_HTTP_INVALID_HEADER_VALUE", "Invalid value \"" + value + "\" for header \"" + name + "\"");
  if (headerCharRegex.test(value)) throw codeError(TypeError, "ERR_INVALID_CHAR", "Invalid character in header content [\"" + name + "\"]");
}

const headersSent = (what) => codeError(Error, "ERR_HTTP_HEADERS_SENT", "Cannot " + what + " headers after they are sent to the client");

/* llhttp's error, as Node's: its code and reason, how far it parsed the read, and the read */
function parseError(code, reason, bytesParsed, rawPacket) {
  const e = new Error("Parse Error: " + reason);
  e.code = code;
  e.reason = reason;
  e.bytesParsed = bytesParsed;
  if (rawPacket !== undefined) {
    e.rawPacket = Buffer.isBuffer(rawPacket) ? rawPacket : Buffer.from(rawPacket.buffer, rawPacket.byteOffset, rawPacket.byteLength);
  }
  return e;
}

export class OutgoingMessage extends Stream {
  constructor() {
    super();
    this.writable = true;
    this.destroyed = false;
    this.writableCorked = 0;
    this.writableNeedDrain = false;
    this.writableHighWaterMark = 16384;
    this.headersSent = false;
    this.finished = false;
    this.writableEnded = false;
    this.writableFinished = false;
    this.sendDate = false;
    this.chunkedEncoding = false;
    this.useChunkedEncodingByDefault = true;
    this._hasBody = true;
    this._contentLength = null;
    this._removedContLen = false;
    this._trailer = "";
    this._headers = new Map();  /* lowercase name → [name as set, value] */
    this.socket = null;
  }

  setHeader(name, value) {
    if (this.headersSent) throw headersSent("set");
    validateHeaderName(name);
    validateHeaderValue(name, value);
    this._headers.set(String(name).toLowerCase(), [String(name), value]);
    return this;
  }

  appendHeader(name, value) {
    if (this.headersSent) throw headersSent("append");
    validateHeaderName(name);
    validateHeaderValue(name, value);
    const key = String(name).toLowerCase();
    const existing = this._headers.get(key);
    if (existing === undefined) return this.setHeader(name, value);
    existing[1] = [].concat(existing[1], value);
    return this;
  }

  get connection() {
    return this.socket;
  }

  get writableLength() {
    return 0;
  }

  cork() {
    this.writableCorked++;
  }

  uncork() {
    if (this.writableCorked) this.writableCorked--;
  }

  getHeader(name) {
    validateString(name, "name");
    const h = this._headers.get(String(name).toLowerCase());
    return h === undefined ? undefined : h[1];
  }

  hasHeader(name) {
    return this._headers.has(String(name).toLowerCase());
  }

  removeHeader(name) {
    validateString(name, "name");
    if (this.headersSent) throw headersSent("remove");
    if (name.toLowerCase() === "content-length") this._removedContLen = true;
    this._headers.delete(String(name).toLowerCase());
  }

  getHeaderNames() {
    return [...this._headers.keys()];
  }

  getHeaders() {
    const out = Object.create(null);
    for (const [key, [, value]] of this._headers) out[key] = value;
    return out;
  }

  getRawHeaderNames() {
    return [...this._headers.values()].map(([name]) => name);
  }

  /* trailers, sent after a chunked body: { name: value } or [[name, value], …] */
  addTrailers(headers) {
    this._trailer = "";
    const entries = Array.isArray(headers) ? headers : Object.keys(headers).map((key) => [key, headers[key]]);
    for (const [field, value] of entries) {
      validateHeaderName(field, "Trailer name");
      const values = Array.isArray(value) && value.length > 1 ? value : [Array.isArray(value) ? value.join("; ") : value];
      for (const v of values) {
        if (headerCharRegex.test(v)) throw codeError(TypeError, "ERR_INVALID_CHAR", "Invalid character in trailer content [\"" + field + "\"]");
        this._trailer += field + ": " + v + "\r\n";
      }
    }
  }
}

/* ---- ServerResponse ------------------------------------------------------------------------- */

export class ServerResponse extends OutgoingMessage {
  constructor(req, conn, keepAlive, server) {
    super();
    /* Node's OutgoingMessage internals, which frameworks set (@hono/node-server sets
     * _contentLength to have the length sent after the other headers, as Node sends it) */
    this._hasBody = req.method !== "HEAD";
    this.req = req;
    this.socket = req.socket;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.sendDate = true;
    this._conn = conn;
    /* one made by hand (new ServerResponse(req)) is kept alive, without a Keep-Alive timeout, as Node's */
    this._keepAlive = keepAlive ?? true;
    this._keepAliveTimeout = server ? server.keepAliveTimeout : 0;
    this._head = req.method === "HEAD";
  }

  /* the response's bytes: to the connection's parser, which corks them; or, for a response made by
   * hand (new ServerResponse(req), Node's assignSocket), to its socket, kept until it has one */
  _send(data, latin1 = false) {
    if (this._conn !== undefined) httpWrite(this._conn, data, latin1);
    else if (this.socket) this.socket.write(data, latin1 ? "latin1" : undefined);
    else (this._unsent ??= []).push([data, latin1]);
  }

  /** A socket for a response made by hand, as Node's: its writes go there. */
  assignSocket(socket) {
    if (socket._httpMessage) throw codeError(Error, "ERR_HTTP_SOCKET_ASSIGNED", "Socket already assigned");
    socket._httpMessage = this;
    this.socket = socket;
    this.emit("socket", socket);
    const unsent = this._unsent;
    this._unsent = undefined;
    if (unsent) for (const [data, latin1] of unsent) socket.write(data, latin1 ? "latin1" : undefined);
  }

  detachSocket(socket) {
    socket._httpMessage = null;
    this.socket = null;
  }

  setTimeout(msecs, callback) {
    if (typeof callback === "function") this.on("timeout", callback);
    if (this.socket) this.socket.setTimeout(msecs);
    return this;
  }

  /* the head a write sends without writeHead, through writeHead as Node's: a wrapper of it runs
   * (on-headers: compression sets Vary and Content-Encoding there). Middleware calls it too, before
   * writing (compression). `length`: the whole body's, when end() knows it */
  _implicitHeader(length) {
    this._implicitLength = length;
    try {
      this.writeHead(this.statusCode);
    } finally {
      this._implicitLength = undefined;
    }
  }

  /* sends the head now: the body that follows is chunked */
  flushHeaders() {
    if (!this.headersSent && Object.hasOwn(this, "writeHead")) this._implicitHeader(undefined);  /* a wrapper sees it */
    const head = this._takeHead(undefined);
    if (head) this._send(head, true);
  }

  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    this._closeEmitted = true;
    if (this.socket) this.socket.destroy();
    queueMicrotask(() => {
      if (error) this.emit("error", error);
      this.emit("close");
    });
    return this;
  }

  /* the connection closed: 'close', without 'finish' when the response wasn't ended */
  _connectionClosed() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.destroyed = true;
    this.writable = false;
    queueMicrotask(() => this.emit("close"));
  }

  writeHead(statusCode, statusMessage, headers) {
    if (typeof statusMessage !== "string") {
      headers = statusMessage;
      statusMessage = undefined;
    }
    this.statusCode = statusCode;
    if (statusMessage !== undefined) this.statusMessage = statusMessage;
    if (Array.isArray(headers)) {
      for (let i = 0; i < headers.length; i += 2) this.appendHeader(headers[i], headers[i + 1]);
    } else if (headers) {
      for (const name of Object.keys(headers)) this.setHeader(name, headers[name]);
    }
    /* Node renders the head now (sent with the first write): without a known length, the body
     * is chunked even when end() brings all of it */
    if (!this.headersSent) this._pendingHead = this._renderHead(this._implicitLength);
    return this;
  }

  /* what goes out before a body chunk: the head, if it hasn't gone yet */
  _takeHead(length) {
    if (!this.headersSent) return this._renderHead(length);
    const head = this._pendingHead;
    this._pendingHead = null;
    return head ?? "";
  }

  /* the status line and headers; `length` is the whole body's when end() knows it */
  _renderHead(length) {
    const status = this.statusCode;
    const noBody = status === 204 || status === 304 || (status >= 100 && status < 200);
    /* an empty statusMessage gets the standard one, as in Node (Next.js's route handlers set "") */
    let head = "HTTP/1.1 " + status + " " + (this.statusMessage || STATUS_CODES[status] || "unknown") + "\r\n";
    for (const [, [name, value]] of this._headers) {
      if (Array.isArray(value)) for (const v of value) head += name + ": " + v + "\r\n";
      else head += name + ": " + value + "\r\n";
    }
    if (this.sendDate && !this._headers.has("date")) head += "Date: " + httpDate() + "\r\n";
    const connection = this._headers.get("connection");
    if (connection !== undefined && String(connection[1]).toLowerCase().includes("close")) this._keepAlive = false;
    if (connection === undefined) {
      if (!this._keepAlive) head += "Connection: close\r\n";
      else {
        head += "Connection: keep-alive\r\n";
        if (this._keepAliveTimeout) head += "Keep-Alive: timeout=" + Math.floor(this._keepAliveTimeout / 1000) + "\r\n";
      }
    }
    /* Node: no length for HEAD; an HTTP/1.0 client gets a body that ends with the connection */
    const http10 = this.req.httpVersionMajor < 1 || this.req.httpVersionMinor < 1;
    /* a Transfer-Encoding: chunked the program set: the body is chunk-encoded, as Node does */
    const te = this._headers.get("transfer-encoding");
    if (te !== undefined && /\bchunked\b/i.test(String(te[1])) && !noBody) this.chunkedEncoding = true;
    if (!noBody && !this._head && !http10 && !this._headers.has("content-length") && te === undefined) {
      if (this._contentLength !== null && this._contentLength !== undefined) length = this._contentLength;
      if (length !== undefined) {
        head += "Content-Length: " + length + "\r\n";
      } else {
        head += "Transfer-Encoding: chunked\r\n";
        this.chunkedEncoding = true;
      }
    }
    /* as Node's _storeHeader: only a chunked body can have trailers (the head isn't sent) */
    if (this.chunkedEncoding !== true && this._headers.has("trailer")) {
      throw codeError(Error, "ERR_HTTP_TRAILER_INVALID", "Trailers are invalid with this transfer encoding");
    }
    this.headersSent = true;
    return head + "\r\n";
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === "function") callback = encoding;
    if (this.writableEnded || this.destroyed) {
      /* Node's write_: after end before destroyed; the callback, then 'error' (Node's emitErrorNt),
       * none on a destroyed response (it closed, or its client went away) */
      const ended = this.writableEnded;
      const e = new Error(ended ? "write after end" : "Cannot call write after a stream was destroyed");
      e.code = ended ? "ERR_STREAM_WRITE_AFTER_END" : "ERR_STREAM_DESTROYED";
      if (!this.destroyed) {
        process.nextTick(() => {
          if (typeof callback === "function") callback(e);
          if (!this.destroyed) this.emit("error", e);
        });
      } else if (typeof callback === "function") {
        process.nextTick(callback, e);
      }
      return false;
    }
    if (typeof chunk === "string" && typeof encoding === "string" && encoding !== "utf8" && encoding !== "utf-8") chunk = Buffer.from(chunk, encoding);
    /* a writeHead of the response's own (a wrapper) sees the implicit head, as in Node */
    if (!this.headersSent && Object.hasOwn(this, "writeHead")) this._implicitHeader(undefined);
    const head = this._takeHead(undefined);
    if (head) this._send(head, true);
    if (chunk !== undefined && chunk !== null && chunkLength(chunk) > 0 && !this._head) {
      if (this.chunkedEncoding) {
        this._send(chunkLength(chunk).toString(16) + "\r\n");
        this._send(chunk);
        this._send("\r\n");
      } else {
        this._send(chunk);
      }
    }
    if (typeof callback === "function") queueMicrotask(callback);
    return true;
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
    }
    if (this.writableEnded) return this;
    if (typeof chunk === "string" && typeof encoding === "string" && encoding !== "utf8" && encoding !== "utf-8") chunk = Buffer.from(chunk, encoding);
    if (!this.headersSent && Object.hasOwn(this, "writeHead")) this._implicitHeader(chunk !== undefined && chunk !== null ? chunkLength(chunk) : 0);
    if (!this.headersSent) {
      const hasChunk = chunk !== undefined && chunk !== null;
      const length = hasChunk ? chunkLength(chunk) : 0;
      if (hasChunk && typeof chunk === "string" && !this._head) {
        /* the head's bytes are latin1, the body's UTF-8: corked into one write by the parser's
         * connection; a response made by hand writes them as one string, as Node's _send */
        if (this._conn === undefined) {
          this._send(this._renderHead(length) + chunk);
        } else {
          this._send(this._renderHead(length), true);
          this._send(chunk);
        }
      } else {
        this._send(this._renderHead(length), true);
        if (hasChunk && length && !this._head) this._send(chunk);
      }
    } else {
      if (chunk !== undefined && chunk !== null) this.write(chunk);
      const head = this._takeHead(undefined);
      if (head) this._send(head, true);
      if (this.chunkedEncoding && !this._head) this._send("0\r\n" + this._trailer + "\r\n", true);
    }
    this.writableEnded = this.finished = true;
    this.writable = false;
    if (!this._keepAlive && this.socket) {  /* the response goes out, then the socket ends */
      httpFlush(this._conn);
      if (typeof this.socket.destroySoon === "function") this.socket.destroySoon();  /* as Node's resOnFinish */
      else this.socket.end();
    }
    queueMicrotask(() => {
      this.writableFinished = true;
      this.emit("finish");
      if (!this._closeEmitted) {
        this._closeEmitted = true;
        this.destroyed = true;  /* as Node's emitCloseNT */
        this.emit("close");
      }
      if (typeof callback === "function") callback();
    });
    return this;
  }
}

/* ---- Server --------------------------------------------------------------------------------- */

const badRequestResponse = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
const headersTooLargeResponse = "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n";
const requestTimeoutResponse = "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n";

function noop() {}

/** (options, requestListener) or (requestListener): the options an object. */
function serverArguments(options, requestListener) {
  if (typeof options === "function") return [{}, options];
  if (options === undefined || options === null) return [{}, requestListener];
  if (typeof options !== "object" || Array.isArray(options)) throw invalidArgType("options", "of type object", options);  /* validateObject */
  return [options, requestListener];
}

class ServerClass extends NetServer {
  constructor(options, requestListener) {
    [options, requestListener] = serverArguments(options, requestListener);
    super({ allowHalfOpen: true, noDelay: options.noDelay ?? true, keepAlive: options.keepAlive, keepAliveInitialDelay: options.keepAliveInitialDelay });
    this._initHttp(options, requestListener, "connection");
  }

  /* Node's storeHTTPOptions and the server's timeouts, and its sockets' requests: those of each
   * 'connection' (https.Server's: of each 'secureConnection') */
  _initHttp(options, requestListener, connectionEvent) {
    if (typeof requestListener === "function") this.on("request", requestListener);
    this.httpAllowHalfOpen = false;
    this.timeout = 0;
    this.maxHeadersCount = null;
    this.maxRequestsPerSocket = 0;
    const integer = (name, fallback) => {
      const value = options[name];
      if (value === undefined) return fallback;
      validateInteger(value, name);
      if (value < 0) throw outOfRange(name, ">= 0 && <= 9007199254740991", value);
      return value;
    };
    const boolean = (name, fallback) => {
      const value = options[name];
      if (value === undefined) return fallback;
      if (typeof value !== "boolean") throw invalidArgType("options." + name, "of type boolean", value);
      return value;
    };
    this.maxHeaderSize = integer("maxHeaderSize", undefined);
    this.insecureHTTPParser = boolean("insecureHTTPParser", undefined);
    this.requireHostHeader = boolean("requireHostHeader", true);
    this.joinDuplicateHeaders = boolean("joinDuplicateHeaders", undefined);
    /* the classes requests and responses are made of (subclasses of node:http's), as Node's */
    this._IncomingMessage = options.IncomingMessage || IncomingMessage;
    this._ServerResponse = options.ServerResponse || ServerResponse;
    this._optimizeEmptyRequests = boolean("optimizeEmptyRequests", false);
    this.requestTimeout = integer("requestTimeout", 300_000);
    this.headersTimeout = integer("headersTimeout", Math.min(60_000, this.requestTimeout));
    if (this.requestTimeout > 0 && this.headersTimeout > 0 && this.headersTimeout > this.requestTimeout) {
      throw outOfRange("headersTimeout", "<= requestTimeout", this.headersTimeout);
    }
    this.keepAliveTimeout = integer("keepAliveTimeout", 5000);
    this.connectionsCheckingInterval = integer("connectionsCheckingInterval", 30_000);
    this._parsers = -1;
    this._states = new Map();  /* connection → { socket, req, res, keepAliveTimeoutSet } */
    this.on(connectionEvent, (socket) => this._onSocket(socket));
    this.on("listening", () => this._startConnectionsChecking());
  }

  /* captureRejections: a 'request' listener's rejection answers 500, its headers dropped (or the
   * response destroyed, once sent), as Node's; another event's goes to net.Server's */
  [Symbol.for("nodejs.rejection")](err, event, ...args) {
    if (event === "request") {
      const res = args[1];
      if (!res.headersSent && !res.writableEnded) {
        for (const name of res.getHeaderNames()) res.removeHeader(name);
        res.statusCode = 500;
        res.end(STATUS_CODES[500]);
      } else {
        res.destroy();
      }
      return;
    }
    const base = NetServer.prototype[Symbol.for("nodejs.rejection")];
    if (typeof base === "function") base.call(this, err, event, ...args);
    else this.emit("error", err);
  }

  /* Node's setupConnectionsTracking: the connections checked every connectionsCheckingInterval ms
   * (unref'd), a new timer for each 'listening'. server[kConnectionsCheckingInterval] stands for
   * Node's interval: its _destroyed says whether it was stopped. */
  _startConnectionsChecking() {
    this._stopConnectionsChecking();
    const interval = { _destroyed: false, _timer: null };
    this[kConnectionsCheckingInterval] = interval;
    const tick = () => {
      if (interval._destroyed) return;
      this._checkConnections();
      interval._timer = timerUnref(tick, this.connectionsCheckingInterval);
    };
    if (this.connectionsCheckingInterval > 0) interval._timer = timerUnref(tick, this.connectionsCheckingInterval);
  }

  _stopConnectionsChecking() {
    const interval = this[kConnectionsCheckingInterval];
    if (!interval || interval._destroyed) return;
    interval._destroyed = true;
    if (interval._timer !== null) clearTimeout(interval._timer);
    interval._timer = null;
  }

  /* Node's checkConnections: a request (or its head) over requestTimeout (headersTimeout) gets a 408 */
  _checkConnections() {
    if (this._handle === null) return;
    if (this._parsers !== -1 && (this.headersTimeout > 0 || this.requestTimeout > 0)) {
      for (const conn of httpExpired(this._parsers, this.headersTimeout, this.requestTimeout)) {
        const state = this._states.get(conn);
        if (state) socketOnError.call(state.socket, codeError(Error, "ERR_HTTP_REQUEST_TIMEOUT", "Request timeout"));
      }
    }
  }

  setTimeout(msecs, callback) {
    this.timeout = msecs;
    if (typeof callback === "function") this.on("timeout", callback);
    return this;
  }

  /* the sockets go before the server stops listening: idle ones on close(), all on request */
  closeAllConnections() {
    for (const { socket } of [...this._states.values()]) socket.destroy();
  }

  closeIdleConnections() {
    for (const state of [...this._states.values()]) if (!state.req && !state.res) state.socket.destroy();
  }

  close(callback) {
    this.closeIdleConnections();
    this._stopConnectionsChecking();
    return super.close(callback);
  }

  /* a connection: its bytes go to llhttp; its end, timeout, errors and close are the requests' */
  _onSocket(socket) {
    if (this._parsers === -1) {
      /* in the async context of the connection's, as the server's sockets' callbacks */
      this._parsers = httpParsers(...[
        (conn, method, url, raw, major, minor, keepAlive, upgrade) => this._onRequest(conn, method, url, raw, major, minor, keepAlive, upgrade),
        (conn, chunk) => {
          /* the bytes llhttp reads in C are the socket's activity, as Node's onParserExecute counts them */
          const state = this._states.get(conn);
          state?.socket._unrefTimer?.();
          state?.req?._push(chunk);
        },
        (conn, trailers) => {
          const state = this._states.get(conn);
          const req = state?.req;
          if (req) {
            if (state.res === null || state.res.writableEnded) state.req = null;
            if (trailers) {
              req.rawTrailers = trailers;
              for (let i = 0; i < trailers.length; i += 2) addHeader(req.trailers, trailers[i], trailers[i + 1]);
            }
            req._finish();
          }
        },
        (conn, head) => this._onUpgrade(conn, head),
        (conn, code, reason, bytesParsed, rawPacket) => {
          const state = this._states.get(conn);
          if (!state) return;
          const e = parseError(code, reason, bytesParsed, rawPacket);
          socketOnError.call(state.socket, e);
        },
      ].map(bindContext));
    }
    const conn = connOf(socket);
    if (conn === null) return;
    const state = { socket, conn, req: null, res: null, keepAliveTimeoutSet: false, listeners: null };
    this._states.set(conn, state);
    if (this.timeout && typeof socket.setTimeout === "function") socket.setTimeout(this.timeout);
    const onTimeout = () => this._onTimeout(state);
    const onEnd = () => {
      this._abortIncoming(state);
      if (socket.writable) socket.end();
    };
    const onClose = () => {
      this._states.delete(conn);
      this._abortIncoming(state);
      const res = state.res;
      state.res = null;
      if (res) res._connectionClosed();
    };
    state.listeners = { timeout: onTimeout, end: onEnd, close: onClose, error: socketOnError };
    for (const [event, fn] of Object.entries(state.listeners)) socket.on(event, fn);
    httpAttach(conn, this._parsers, false, this.maxHeaderSize ?? maxHeaderSize);
  }

  _abortIncoming(state) {
    const req = state.req;
    state.req = null;
    if (req) req._abort();
  }

  /* Node's socketOnTimeout: the request's, the response's or the server's 'timeout', or the end */
  _onTimeout(state) {
    const req = state.req;
    const reqTimeout = req && !req.complete && req.emit("timeout", state.socket);
    const res = state.res;
    const resTimeout = res && res.emit("timeout", state.socket);
    const serverTimeout = this.emit("timeout", state.socket);
    if (!reqTimeout && !resTimeout && !serverTimeout) state.socket.destroy();
  }

  _onRequest(conn, method, url, raw, major, minor, keepAlive, upgrade) {
    const state = this._states.get(conn);
    if (!state) return 0;
    const socket = state.socket;
    socket._unrefTimer?.();  /* the head's bytes are the socket's activity */
    if (state.keepAliveTimeoutSet) {
      socket.setTimeout(0);
      state.keepAliveTimeoutSet = false;
    }
    const req = new this._IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.httpVersionMajor = major;
    req.httpVersionMinor = minor;
    req.httpVersion = major + "." + minor;
    req.rawHeaders = raw;
    for (let i = 0; i < raw.length; i += 2) addHeader(req.headers, raw[i], raw[i + 1], this.joinDuplicateHeaders);
    req.upgrade = upgrade && (method === "CONNECT" || this.listenerCount("upgrade") > 0);
    if (req.upgrade) {
      state.upgradeReq = req;
      return 2;
    }
    state.req = req;
    if (this._optimizeEmptyRequests && !("content-length" in req.headers) && !("transfer-encoding" in req.headers)) req._dumpAndCloseReadable();
    const res = new this._ServerResponse(req, conn, keepAlive, this);
    state.res = res;
    if (this.requireHostHeader && major === 1 && minor === 1 && !req.headers.host) {  /* Node: a 400, and the connection ends */
      res.writeHead(400, ["Connection", "close"]);
      res.end();
      return 0;
    }
    res.once("finish", () => {
      if (state.res === res) state.res = null;
      if (state.req === req && req.complete) state.req = null;
      if (res._keepAlive && !state.res && this.keepAliveTimeout && socket.writable) {
        socket.setTimeout(this.keepAliveTimeout);
        state.keepAliveTimeoutSet = true;
      }
    });
    this.emit("request", req, res);
    return 0;
  }

  /* the parser let go of the socket after an upgrade's head: it's the 'upgrade' listener's */
  _onUpgrade(conn, head) {
    const state = this._states.get(conn);
    if (!state) return;
    const { socket, upgradeReq: req } = state;
    this._states.delete(conn);
    for (const [event, fn] of Object.entries(state.listeners)) socket.removeListener(event, fn);
    if (socket.listenerCount("error") === 0) socket.on("error", noop);
    unfeed(socket);
    /* what the socket reads next goes to its stream, buffered until someone reads it */
    socket._readableState.flowing = null;
    const bodyHead = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
    const eventName = req.method === "CONNECT" ? "connect" : "upgrade";
    if (eventName === "upgrade" || this.listenerCount(eventName) > 0) this.emit(eventName, req, socket, bodyHead);
    else socket.destroy();
  }
}
export const Server = callableClass(ServerClass, "Server");  /* Server(…) without new, as Node's */

/* ---- Connections: llhttp on a socket's handle, or fed --------------------------------------- */

/* A socket whose bytes aren't its handle's: a TLSSocket's handle carries ciphertext, a Duplex
 * has none. llhttp parses what it reads ('data') and writes through it (write()). */
const isFed = (socket) => socket.encrypted === true || socket._handle === undefined;
const kFed = Symbol("kFed");

/** The socket's connection for llhttp: its net handle's id (the parser reads the handle in C), or a
 *  fed connection, made the first time; null for a net socket without a handle yet. */
function connOf(socket) {
  if (!isFed(socket)) return socket._handle;
  const fed = socket[kFed];
  if (fed) return fed.conn;
  const conn = httpFedOpen((bytes) => {
    if (!socket.destroyed) socket.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
  const onData = (chunk) => httpFeed(conn, typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const onEnd = () => httpFeed(conn, null);
  const onClose = () => unfeed(socket);
  socket[kFed] = { conn, onData, onEnd, onClose };
  socket.on("data", onData);
  socket.on("end", onEnd);
  socket.on("close", onClose);
  return conn;
}

/** A socket's connection if it has one: its handle's id, or its fed connection's. */
const connKey = (socket) => (isFed(socket) ? socket[kFed]?.conn : socket._handle);

/* the socket's bytes stop going to llhttp: it upgraded, or closed */
function unfeed(socket) {
  const fed = socket[kFed];
  if (!fed) return;
  socket[kFed] = undefined;
  socket.removeListener("data", fed.onData);
  socket.removeListener("end", fed.onEnd);
  socket.removeListener("close", fed.onClose);
  httpFedClose(fed.conn);
}

/* Node's socketOnError: 'clientError', or a 400 (when nothing was written yet) and the end */
function socketOnError(e) {
  this.removeListener("error", socketOnError);
  if (this.listenerCount("error") === 0) this.on("error", noop);
  const server = this.server;
  if (!server.emit("clientError", e, this)) {
    const state = server._states.get(connKey(this));
    const res = state?.res;
    if (this.writable && (!res || !res.headersSent)) {
      if (state) httpFlush(state.conn);
      this.write(e.code === "HPE_HEADER_OVERFLOW" ? headersTooLargeResponse : e.code === "ERR_HTTP_REQUEST_TIMEOUT" ? requestTimeoutResponse : badRequestResponse);
    }
    this.destroy(e);
  }
}

export function createServer(options, requestListener) {
  return new Server(options, requestListener);
}

/* ---- The client: ClientRequest, request, get ------------------------------------------------- */

const connReset = (message) => codeError(Error, "ECONNRESET", message);

function urlToHttpOptions(url) {
  const { hostname, pathname, port, username, password, search } = url;
  const options = {
    __proto__: null, ...url, protocol: url.protocol, hostname: hostname && hostname[0] === "[" ? hostname.slice(1, -1) : hostname,
    hash: url.hash, search, pathname, path: (pathname || "") + (search || ""), href: url.href,
  };
  if (port !== "") options.port = Number(port);
  if (username || password) options.auth = decodeURIComponent(username) + ":" + decodeURIComponent(password);
  return options;
}

/* the sockets whose responses llhttp parses: connection → socket */
const clientSockets = new Map();
let clientParsers = -1;

/* the async context a request was made in: its response's callbacks run in it, as in
 * Node, whichever request's the socket was */
const kAsyncContext = Symbol("kAsyncContext");
const inRequestContext = (fn) => (conn, ...args) =>
  runInContext(clientSockets.get(conn)?._httpMessage?.[kAsyncContext], fn, undefined, [conn, ...args]);

function clientParsersId() {
  if (clientParsers !== -1) return clientParsers;
  const reqOf = (conn) => clientSockets.get(conn)?._httpMessage;
  clientParsers = httpParsers(...[
    (conn, statusCode, statusMessage, raw, major, minor, keepAlive, upgrade) => {
      const socket = clientSockets.get(conn);
      const req = socket?._httpMessage;
      if (!req) return 0;
      const res = new IncomingMessage(socket);
      res.statusCode = statusCode;
      res.statusMessage = statusMessage;
      res.httpVersionMajor = major;
      res.httpVersionMinor = minor;
      res.httpVersion = major + "." + minor;
      res.rawHeaders = raw;
      for (let i = 0; i < raw.length; i += 2) addHeader(res.headers, raw[i], raw[i + 1], req.joinDuplicateHeaders);
      res.upgrade = upgrade;
      return parserOnIncomingClient(req, socket, res, keepAlive);
    },
    (conn, chunk) => {
      clientSockets.get(conn)?._unrefTimer?.();  /* the socket's activity, as Node's onParserExecute */
      reqOf(conn)?.res?._push(chunk);
    },
    (conn, trailers) => {
      const socket = clientSockets.get(conn);
      const req = socket?._httpMessage;
      const res = req?.res;
      if (!res) return;
      if (res.upgrade) {  /* llhttp completes an upgrade's head before it pauses: the upgrade frees the parser */
        res.complete = true;
        return;
      }
      if (trailers) {
        res.rawTrailers = trailers;
        for (let i = 0; i < trailers.length; i += 2) addHeader(res.trailers, trailers[i], trailers[i + 1]);
      }
      if (!statusIsInformational(res.statusCode)) freeParserAfterRead(socket);
      res._finish();
    },
    (conn, head) => {
      const socket = clientSockets.get(conn);
      if (socket?._httpMessage) clientUpgrade(socket._httpMessage, socket, head);
    },
    (conn, code, reason, bytesParsed, rawPacket) => {
      const socket = clientSockets.get(conn);
      const req = socket?._httpMessage;
      const e = parseError(code, reason, bytesParsed, rawPacket);
      if (socket) {
        freeParser(socket);
        socket.removeListener("end", socketOnEnd);  /* as Node's socketOnData */
        socket.destroy();
      }
      if (req) {
        socket._hadError = true;
        req.emit("error", e);
      }
    },
  ].map(inRequestContext));
  return clientParsers;
}

const statusIsInformational = (status) => status < 200 && status >= 100 && status !== 101;

/* the socket's bytes go to a response parser: now, or once it has connected */
function attachParser(socket, req) {
  const attach = () => {
    if (socket._httpMessage !== req) return;
    const conn = connOf(socket);
    if (conn === null) return;
    clientSockets.set(conn, socket);
    socket._clientConn = conn;
    httpAttach(conn, clientParsersId(), true, req.maxHeaderSize ?? maxHeaderSize);
  };
  /* a net socket's handle is its once connected; a fed socket's bytes come as they come */
  if (!isFed(socket) && (socket.connecting || socket._handle === null)) socket.once("connect", attach);
  else attach();
}

function freeParser(socket) {
  const conn = socket._clientConn;
  if (conn === undefined) return;
  socket._clientConn = undefined;
  clientSockets.delete(conn);
  httpDetach(conn);
}

/* a complete response's parser, let go of once the read is parsed, as Node's socketOnData frees it:
 * what follows the response in the read is still parsed, and an error there is the request's (the
 * socket's entry stays until then) */
function freeParserAfterRead(socket) {
  const conn = socket._clientConn;
  if (conn === undefined) return;
  socket._clientConn = undefined;
  httpDetach(conn, true);
  queueMicrotask(() => {
    if (clientSockets.get(conn) === socket && socket._clientConn !== conn) clientSockets.delete(conn);
  });
}

/* Node's parserOnIncomingClient: 0, or 1 for no body, or 2 to take the socket */
function parserOnIncomingClient(req, socket, res, shouldKeepAlive) {
  if (req.res) {  /* a second response to one request */
    socket.destroy();
    return 0;
  }
  req.res = res;
  if (res.upgrade) return 2;
  if (req.method === "CONNECT") {
    res.upgrade = true;
    return 2;
  }
  if (statusIsInformational(res.statusCode)) {  /* 1xx: the final response follows */
    req.res = null;
    if (res.statusCode === 100) req.emit("continue");
    req.emit("information", {
      statusCode: res.statusCode, statusMessage: res.statusMessage, httpVersion: res.httpVersion, httpVersionMajor: res.httpVersionMajor,
      httpVersionMinor: res.httpVersionMinor, headers: res.headers, rawHeaders: res.rawHeaders,
    });
    return 1;
  }
  if (req.shouldKeepAlive && !shouldKeepAlive && !req.upgradeOrConnect) req.shouldKeepAlive = false;
  res.req = req;
  res.on("end", responseOnEnd);
  req.on("finish", requestOnFinish);
  socket.on("timeout", responseOnTimeout);
  if (req.aborted || !req.emit("response", res)) res._dump();
  if (req.method === "HEAD") return 1;
  if (res.statusCode === 304) {
    res.complete = true;
    return 1;
  }
  return 0;
}

function clientUpgrade(req, socket, head) {
  socket.removeListener("end", socketOnEnd);
  if (req.timeoutCb) socket.removeListener("timeout", req.timeoutCb);
  socket.removeListener("timeout", responseOnTimeout);
  freeParser(socket);
  unfeed(socket);
  const bodyHead = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  const eventName = req.method === "CONNECT" ? "connect" : "upgrade";
  if (req.listenerCount(eventName) > 0) {
    req.upgradeOrConnect = true;
    socket.emit("agentRemove");
    socket.removeListener("close", socketCloseListener);
    socket.removeListener("error", socketErrorListener);
    socket._httpMessage = null;
    socket._readableState.flowing = null;
    req.emit(eventName, req.res, socket, bodyHead);
    req.destroyed = true;
    req._closed = true;
    req.emit("close");
  } else {
    socket.destroy();
  }
}

function responseOnEnd() {
  const req = this.req;
  const socket = req.socket;
  if (socket) {
    if (req.timeoutCb) socket.removeListener("timeout", emitRequestTimeout);
    socket.removeListener("timeout", responseOnTimeout);
  }
  req._ended = true;
  if (!req.shouldKeepAlive) {
    if (socket.writable) socket.destroySoon();
  } else if (req.writableFinished && !this.aborted) {
    responseKeepAlive(req);
  }
}

function requestOnFinish() {
  if (this.shouldKeepAlive && this._ended) responseKeepAlive(this);
}

/* the response is read and the request sent: the socket goes back to the agent */
function responseKeepAlive(req) {
  const socket = req.socket;
  if (req.timeoutCb) {
    socket.setTimeout(0, req.timeoutCb);
    req.timeoutCb = null;
  }
  socket.removeListener("close", socketCloseListener);
  socket.removeListener("error", socketErrorListener);
  socket.removeListener("end", socketOnEnd);
  process.nextTick(() => {
    req._closed = true;
    req.emit("close");
    if (req.socket) req.socket.emit("free");
  });
  req.destroyed = true;
  if (req.res) req.res.socket = null;
}

function responseOnTimeout() {
  const req = this._httpMessage;
  if (req?.res) req.res.emit("timeout");
}

function emitRequestTimeout() {
  const req = this._httpMessage;
  if (req) req.emit("timeout");
}

function listenSocketTimeout(req) {
  if (req.timeoutCb) return;
  req.timeoutCb = emitRequestTimeout;
  if (req.socket) req.socket.once("timeout", emitRequestTimeout);
  else req.on("socket", (socket) => socket.once("timeout", emitRequestTimeout));
}

function socketCloseListener() {
  const req = this._httpMessage;
  const res = req.res;
  req.destroyed = true;
  if (res) {
    if (!res.complete) res.destroy(connReset("aborted"));
    req._closed = true;
    req.emit("close");
    if (!res.aborted && res.readable) res.push(null);
  } else {
    if (!this._hadError) {  /* closed before a response: the request's error */
      this._hadError = true;
      req.emit("error", connReset("socket hang up"));
    }
    req._closed = true;
    req.emit("close");
  }
  req.outputData.length = 0;
  freeParser(this);
}

function socketErrorListener(err) {
  const req = this._httpMessage;
  if (req) {
    this._hadError = true;
    req.emit("error", err);
  }
  freeParser(this);
  this.removeListener("end", socketOnEnd);
  this.destroy();
}

function socketOnEnd() {
  const req = this._httpMessage;
  if (!req.res && !this._hadError) {
    this._hadError = true;
    req.emit("error", connReset("socket hang up"));
  }
  freeParser(this);
  this.destroy();
}

const INVALID_PATH_REGEX = /[^!-ÿ]/;
const kPath = Symbol("kPath");

export class ClientRequest extends OutgoingMessage {
  constructor(input, options, cb) {
    super();
    this[kAsyncContext] = currentContext();
    if (typeof input === "string") input = urlToHttpOptions(new URL(input));
    else if (input instanceof URL) input = urlToHttpOptions(input);
    else {
      cb = options;
      options = input;
      input = null;
    }
    if (typeof options === "function") {
      cb = options;
      options = input || {};
    } else {
      options = Object.assign({ __proto__: null }, input, options);  /* as Node's: no prototype's options */
    }
    let agent = options.agent;
    const defaultAgent = options._defaultAgent || globalAgent;
    if (agent === false) agent = new defaultAgent.constructor();
    else if (agent === null || agent === undefined) {
      if (typeof options.createConnection !== "function") agent = defaultAgent;
      options._defaultAgent = defaultAgent;
    } else if (typeof agent.addRequest !== "function") {
      throw invalidArgType("options.agent", "one of Agent-like Object, undefined, or false", agent);
    }
    this.agent = agent;
    const protocol = options.protocol || defaultAgent.protocol;
    const expectedProtocol = this.agent?.protocol || defaultAgent.protocol;
    if (options.path && INVALID_PATH_REGEX.test(String(options.path))) {
      throw codeError(TypeError, "ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters");
    }
    if (protocol !== expectedProtocol) {
      throw codeError(TypeError, "ERR_INVALID_PROTOCOL", "Protocol \"" + protocol + "\" not supported. Expected \"" + expectedProtocol + "\"");
    }
    const defaultPort = options.defaultPort || this.agent?.defaultPort;
    const optsWithoutSignal = { __proto__: null, ...options };
    const port = optsWithoutSignal.port = options.port || defaultPort || 80;
    const validHost = (host, name) => {
      if (host !== null && host !== undefined && typeof host !== "string") throw invalidArgType("options." + name, "of type string or one of undefined or null", host);
      return host;
    };
    const host = optsWithoutSignal.host = validHost(options.hostname, "hostname") || validHost(options.host, "host") || "localhost";
    const setHost = options.setHost !== undefined ? Boolean(options.setHost) : options.setDefaultHeaders !== false;
    this.socketPath = options.socketPath;
    if (options.timeout !== undefined) {
      if (typeof options.timeout !== "number") throw invalidArgType("timeout", "of type number", options.timeout);
      this.timeout = options.timeout;
    }
    const signal = options.signal;
    if (signal) {
      addAbortSignal(signal, this);  /* as Node's: destroyed with an AbortError, now if already aborted */
      delete optsWithoutSignal.signal;
    }
    let method = options.method;
    if (method !== null && method !== undefined && typeof method !== "string") throw invalidArgType("options.method", "of type string", method);
    if (method) {
      if (!tokenRegExp.test(method)) throw codeError(TypeError, "ERR_INVALID_HTTP_TOKEN", "Method must be a valid HTTP token [\"" + method + "\"]");
      method = this.method = method.toUpperCase();
    } else {
      method = this.method = "GET";
    }
    if (options.maxHeaderSize !== undefined) validateInteger(options.maxHeaderSize, "maxHeaderSize");
    this.maxHeaderSize = options.maxHeaderSize;
    const insecureHTTPParser = options.insecureHTTPParser;
    if (insecureHTTPParser !== undefined && typeof insecureHTTPParser !== "boolean") {
      throw invalidArgType("options.insecureHTTPParser", "of type boolean", insecureHTTPParser);
    }
    this.insecureHTTPParser = insecureHTTPParser;
    const httpValidation = options.httpValidation;
    if (httpValidation !== undefined) {
      if (httpValidation !== "strict" && httpValidation !== "relaxed" && httpValidation !== "insecure") {
        throw codeError(TypeError, "ERR_INVALID_ARG_VALUE",
          `The property 'options.httpValidation' must be one of: 'strict', 'relaxed', 'insecure'. Received ${JSON.stringify(httpValidation)}`);
      }
      if (insecureHTTPParser !== undefined) {
        throw codeError(TypeError, "ERR_INVALID_ARG_VALUE",
          `The property 'options.httpValidation' cannot be used together with options.insecureHTTPParser. Received ${JSON.stringify(httpValidation)}`);
      }
    }
    this.httpValidation = httpValidation;
    if (options.joinDuplicateHeaders !== undefined && typeof options.joinDuplicateHeaders !== "boolean") {
      throw invalidArgType("options.joinDuplicateHeaders", "of type boolean", options.joinDuplicateHeaders);
    }
    this.joinDuplicateHeaders = options.joinDuplicateHeaders;
    this[kPath] = options.path || "/";
    if (cb) this.once("response", cb);
    this.useChunkedEncodingByDefault = !(method === "GET" || method === "HEAD" || method === "DELETE" || method === "OPTIONS" ||
      method === "TRACE" || method === "CONNECT");
    this._ended = false;
    this.res = null;
    this.aborted = false;
    this.timeoutCb = null;
    this.upgradeOrConnect = false;
    this.maxHeadersCount = null;
    this.reusedSocket = false;
    this.host = host;
    this.protocol = protocol;
    this.outputData = [];
    this.outputSize = 0;
    this._header = null;
    this._headerSent = false;
    this._closed = false;
    this.shouldKeepAlive = false;
    this._last = true;
    if (this.agent) {
      if (!this.agent.keepAlive && !Number.isFinite(this.agent.maxSockets)) {
        this._last = true;
        this.shouldKeepAlive = false;
      } else {
        this._last = false;
        this.shouldKeepAlive = true;
      }
    }
    if (!Array.isArray(options.headers)) {
      if (options.headers) for (const key of Object.keys(options.headers)) this.setHeader(key, options.headers[key]);
      if (host && !this.getHeader("host") && setHost) {
        let hostHeader = host;
        const colon = hostHeader.indexOf(":");
        if (colon !== -1 && hostHeader.includes(":", colon + 1) && hostHeader.charCodeAt(0) !== 91) hostHeader = "[" + hostHeader + "]";
        if (port && +port !== defaultPort) hostHeader += ":" + port;
        this.setHeader("Host", hostHeader);
      }
      if (options.auth && !this.getHeader("Authorization")) this.setHeader("Authorization", "Basic " + Buffer.from(options.auth).toString("base64"));
      if (this.getHeader("expect")) this._storeHeader(this.method + " " + this.path + " HTTP/1.1\r\n", null);
    } else {
      this._storeHeader(this.method + " " + this.path + " HTTP/1.1\r\n", options.headers);
    }
    if (this.agent) {
      this.agent.addRequest(this, optsWithoutSignal);
    } else {
      this._last = true;
      this.shouldKeepAlive = false;
      let opts = optsWithoutSignal;
      if (opts.path || opts.socketPath) {
        opts = { ...optsWithoutSignal };
        if (opts.socketPath) opts.path = opts.socketPath;
        else if (opts.path) opts.path = undefined;
      }
      if (typeof opts.createConnection === "function") {
        let done = false;
        const oncreate = (err, socket) => {
          if (done) return;
          done = true;
          if (err) process.nextTick(() => this.emit("error", err));
          else this.onSocket(socket);
        };
        try {
          const newSocket = opts.createConnection(opts, oncreate);
          if (newSocket) oncreate(null, newSocket);
        } catch (err) {
          oncreate(err);
        }
      } else {
        this.onSocket(createConnection(opts));
      }
    }
  }

  /* Node's _storeHeader: the request line, the headers as set (or as given in an array), then
   * Connection and the body's framing */
  _storeHeader(firstLine, headersArray) {
    let head = firstLine;
    let hasConnection = false, hasLength = false, hasTE = false, hasTrailer = false;
    const add = (name, value) => {
      const key = String(name).toLowerCase();
      if (key === "connection") {
        hasConnection = true;
        if (/close/i.test(String(value))) this._last = true;
        else this.shouldKeepAlive = true;
      } else if (key === "content-length") hasLength = true;
      else if (key === "transfer-encoding") {
        hasTE = true;
        if (/chunked/i.test(String(value))) this.chunkedEncoding = true;
      } else if (key === "trailer") hasTrailer = true;
      if (Array.isArray(value)) for (const v of value) head += name + ": " + v + "\r\n";
      else head += name + ": " + value + "\r\n";
    };
    if (headersArray) {
      if (Array.isArray(headersArray[0])) for (const [name, value] of headersArray) add(name, value);
      else for (let i = 0; i < headersArray.length; i += 2) add(headersArray[i], headersArray[i + 1]);
    } else {
      for (const [, [name, value]] of this._headers) add(name, value);
    }
    if (!hasConnection) {
      const shouldSendKeepAlive = this.shouldKeepAlive && (hasLength || this.useChunkedEncodingByDefault || this.agent);
      if (shouldSendKeepAlive) head += "Connection: keep-alive\r\n";
      else {
        this._last = true;
        head += "Connection: close\r\n";
      }
    }
    if (!hasLength && !hasTE) {
      if (!this._hasBody) this.chunkedEncoding = false;
      else if (!this.useChunkedEncodingByDefault) this._last = true;
      else if (!hasTrailer && !this._removedContLen && typeof this._contentLength === "number") head += "Content-Length: " + this._contentLength + "\r\n";
      else {
        head += "Transfer-Encoding: chunked\r\n";
        this.chunkedEncoding = true;
      }
    }
    this._header = head + "\r\n";
    this._headerSent = false;
    this.headersSent = true;
  }

  _implicitHeader() {
    if (this._header) throw codeError(Error, "ERR_HTTP_HEADERS_SENT", "Cannot render headers after they are sent to the client");
    this._storeHeader(this.method + " " + this.path + " HTTP/1.1\r\n", null);
  }

  /* bytes for the socket: written now, or kept until it's assigned */
  _writeRaw(data, encoding, callback) {
    const conn = this.socket;
    if (conn?.destroyed) return false;
    if (conn && conn._httpMessage === this && conn.writable) {
      if (this.outputData.length) this._flushOutput(conn);
      return conn.write(data, encoding, callback);
    }
    this.outputData.push({ data, encoding, callback });
    this.outputSize += data.length;
    return this.outputSize < this.writableHighWaterMark;
  }

  /* the head goes with the first bytes: in the same string when it can be */
  _send(data, encoding, callback) {
    if (!this._headerSent && this._header !== null) {
      this._headerSent = true;
      if (typeof data === "string" && (encoding === "utf8" || encoding === "latin1" || !encoding)) data = this._header + data;
      else this._writeRaw(this._header, "latin1", null);
    }
    return this._writeRaw(data, encoding, callback);
  }

  _flushOutput(socket) {
    const output = this.outputData;
    if (output.length === 0) return undefined;
    this.outputData = [];
    this.outputSize = 0;
    let ret;
    for (const { data, encoding, callback } of output) ret = socket.write(data, encoding, callback);
    return ret;
  }

  _flush() {
    const socket = this.socket;
    if (socket?.writable) {
      const ret = this._flushOutput(socket);
      if (!this.finished && ret && this._needDrain) {
        this._needDrain = false;
        this.emit("drain");
      }
    }
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = null;
    }
    const ret = this._write_(chunk, encoding, callback, false);
    if (!ret) this._needDrain = true;
    return ret;
  }

  _write_(chunk, encoding, callback, fromEnd) {
    if (typeof callback !== "function") callback = () => {};
    if (chunk === null) throw codeError(TypeError, "ERR_STREAM_NULL_VALUES", "May not write null values to stream");
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
      throw invalidArgType("chunk", "of type string or an instance of Buffer or Uint8Array", chunk);
    }
    let err;
    if (this.finished) err = codeError(Error, "ERR_STREAM_WRITE_AFTER_END", "write after end");
    else if (this.destroyed) err = codeError(Error, "ERR_STREAM_DESTROYED", "Cannot call write after a stream was destroyed");
    if (err) {
      if (!this.destroyed) process.nextTick(() => this.emit("error", err));
      process.nextTick(callback, err);
      return false;
    }
    const len = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding || "utf8") : chunk.byteLength;
    if (!this._header) {
      if (fromEnd) this._contentLength = len;
      this._implicitHeader();
    }
    if (!this._hasBody) {
      process.nextTick(callback);
      return true;
    }
    if (this.chunkedEncoding && len !== 0) {
      this._send(len.toString(16), "latin1", null);
      this._send("\r\n", "latin1", null);
      this._send(chunk, encoding, null);
      return this._send("\r\n", "latin1", callback);
    }
    return this._send(chunk, encoding, callback);
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = null;
    }
    if (chunk) {
      if (this.finished) {
        this._write_(chunk, encoding, null, true);
        return this;
      }
      this._write_(chunk, encoding, null, true);
    } else if (this.finished) {
      if (typeof callback === "function") {
        if (!this.writableFinished) this.on("finish", callback);
        else callback(codeError(Error, "ERR_STREAM_ALREADY_FINISHED", "Cannot call end after a stream was finished"));
      }
      return this;
    } else if (!this._header) {
      this._contentLength = 0;
      this._implicitHeader();
    }
    if (typeof callback === "function") this.once("finish", callback);
    const finish = () => {
      if (this.socket && this.socket._hadError) return;
      this.writableFinished = true;
      this.emit("finish");
    };
    if (this._hasBody && this.chunkedEncoding) this._send("0\r\n" + this._trailer + "\r\n", "latin1", finish);
    else if (!this._headerSent || chunk) this._send("", "latin1", finish);
    else process.nextTick(finish);
    this.finished = true;
    this.writableEnded = true;
    this.writable = false;
    return this;
  }

  flushHeaders() {
    if (!this._header) this._implicitHeader();
    this._send("");
  }

  /* the socket the agent (or createConnection) gave: its listeners, the parser, then the output */
  onSocket(socket, err) {
    /* as Node's: the socket's request and error listener set now, so an error before the next tick
     * reaches the request, and a request destroyed meanwhile gives its socket back to the agent */
    if (socket && !err) {
      socket._httpMessage = this;
      socket.on("error", socketErrorListener);
    }
    process.nextTick(() => {
      if (this.destroyed || err) {
        this.destroyed = true;
        const done = (er) => {
          if (!this.aborted && !er) er = connReset("socket hang up");
          if (er) this.emit("error", er);
          this._closed = true;
          this.emit("close");
        };
        if (socket) {
          if (!err && this.agent && !socket.destroyed) {
            socket.emit("free");
            socket.removeListener("error", socketErrorListener);
            done(this._error);
          } else {
            socket.once("close", () => done(err || this._error));
            socket.destroy(err || this._error);
          }
          return;
        }
        done(err || this._error);
        return;
      }
      this.socket = socket;
      socket.on("end", socketOnEnd);
      socket.on("close", socketCloseListener);
      if (this.timeout !== undefined || this.agent?.options?.timeout) listenSocketTimeout(this);
      attachParser(socket, this);
      this.emit("socket", socket);
      this._flush();
    });
  }

  get connection() {
    return this.socket;
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    process.nextTick(() => this.emit("abort"));
    this.destroy();
  }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (this.res) this.res._dump();
    this._error = err;
    this.socket?.destroy(err);
    return this;
  }

  setTimeout(msecs, callback) {
    if (this._ended) return this;
    listenSocketTimeout(this);
    if (typeof msecs !== "number") throw invalidArgType("msecs", "of type number", msecs);
    if (callback) this.once("timeout", callback);
    const set = (sock) => {
      if (sock.connecting) sock.once("connect", () => sock.setTimeout(msecs));
      else sock.setTimeout(msecs);
    };
    if (this.socket) set(this.socket);
    else this.once("socket", set);
    return this;
  }

  setNoDelay(noDelay) {
    if (this.socket) this.socket.setNoDelay(noDelay);
    else this.once("socket", (socket) => socket.setNoDelay(noDelay));
  }

  setSocketKeepAlive(enable, initialDelay) {
    if (this.socket) this.socket.setKeepAlive(enable, initialDelay);
    else this.once("socket", (socket) => socket.setKeepAlive(enable, initialDelay));
  }

  clearTimeout(cb) {
    this.setTimeout(0, cb);
  }
}

/* the request path, checked when set too: a path changed after the request was made can't smuggle
 * a header in (Node's) */
Object.defineProperty(ClientRequest.prototype, "path", {
  get() {
    return this[kPath];
  },
  set(value) {
    const path = String(value);
    if (INVALID_PATH_REGEX.test(path)) throw codeError(TypeError, "ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters");
    this[kPath] = path;
  },
  configurable: true,
  enumerable: true,
});

export function request(url, options, cb) {
  return new ClientRequest(url, options, cb);
}

export function get(url, options, cb) {
  const req = request(url, options, cb);
  req.end();
  return req;
}

/** The largest head a parser accepts (bytes): a bigger one is a 431. */
export const maxHeaderSize = 16384;

/** Node keeps a pool of idle parsers; visaljs's are C structs made per connection. */
export function setMaxIdleHTTPParsers(max) {
  validateInteger(max, "max");
  if (max < 1) throw outOfRange("max", ">= 1 && <= 9007199254740991", max);
}

export { Agent, globalAgent };

export default {
  METHODS, STATUS_CODES, Agent, ClientRequest, IncomingMessage, OutgoingMessage, ServerResponse, Server, createServer, get,
  maxHeaderSize, request, setMaxIdleHTTPParsers, validateHeaderName, validateHeaderValue,
  /* an accessor, as Node's: a program may replace the agent requests use by default */
  get globalAgent() {
    return globalAgent;
  },
  set globalAgent(value) {
    setGlobalAgent(value);
  },
};
