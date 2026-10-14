// The fetch global, as Node's (undici's, Node 24): Fetch's "main fetch" over node:http's and
// node:https's clients, for programs whose code names fetch (implicitModules in node/index.ts).
// The request is the fetch component's Request (runtime/src/fetch.c); it is sent with undici's
// headers in undici's order, redirects are followed as Fetch's HTTP-redirect fetch, and the
// response's body, decoded as its Content-Encoding says, is a ReadableStream. data: URLs are
// read here; blob: URLs (URL.createObjectURL makes none here), HTTP/2 and proxies aren't
// supported. A failure rejects with Node's TypeError "fetch failed", its cause the reason.
import { fetchHeaderList, fetchRequestBody, fetchResponse } from "visaljs:host";
import { Buffer } from "../buffer.js";
import { Agent as HttpAgent, request as httpRequest } from "../http.js";
import { Agent as HttpsAgent, request as httpsRequest } from "../https.js";
import { constants, createBrotliDecompress, createGunzip, createInflate, createInflateRaw, createZstdDecompress } from "../zlib.js";

/* undici's pools: kept-alive sockets, unref'd while free */
let httpAgent, httpsAgent;

/* Fetch's bad ports: a request to one fails */
const BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
/* the headers that describe a body: dropped with it when a redirect changes the method */
const BODY_HEADERS = new Set(["content-encoding", "content-language", "content-location", "content-type", "content-length"]);
/* dropped on a redirect to another origin */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

/** Fetch's network error: Node's TypeError "fetch failed", its cause the reason. */
function networkError(cause) {
  return new TypeError("fetch failed", { cause: typeof cause === "string" ? new Error(cause) : cause });
}

/** The reason a fetch aborted with: the signal's (an AbortError DOMException by default). */
function abortReason(signal) {
  return signal.reason === undefined ? new DOMException("This operation was aborted", "AbortError") : signal.reason;
}

/** An index of a header in a flat [name, value, …] list, by its lowercase name, or -1. */
function headerIndex(list, lower) {
  for (let i = 0; i < list.length; i += 2) if (list[i].toLowerCase() === lower) return i;
  return -1;
}

/** The list without the headers `drop` names (lowercase). */
function withoutHeaders(list, drop) {
  const out = [];
  for (let i = 0; i < list.length; i += 2) if (!drop.has(list[i].toLowerCase())) out.push(list[i], list[i + 1]);
  return out;
}

/** A URL serialized without its fragment, as Response's url is. */
function withoutFragment(url) {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/* ---- data: URLs (Fetch's data: URL processor) ------------------------------------------------- */

/** A data: URL's response, or a network error. */
function fetchDataURL(href) {
  const input = withoutFragment(href).slice(5);
  const comma = input.indexOf(",");
  if (comma === -1) throw networkError("invalid data: URL");
  let mime = input.slice(0, comma).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  let bytes = Buffer.from(decodeURIComponentBytes(input.slice(comma + 1)));
  const base64 = /;[\t\n\f\r ]*base64[\t\n\f\r ]*$/i.exec(mime);
  if (base64) {
    mime = mime.slice(0, base64.index);
    const text = bytes.toString("latin1").replace(/[\t\n\f\r ]/g, "");
    if (/[^A-Za-z0-9+/=]/.test(text) || /=[^=]/.test(text) || (text.replace(/=+$/, "").length % 4 === 1))
      throw networkError("invalid data: URL");
    bytes = Buffer.from(text, "base64");
  }
  if (mime.startsWith(";")) mime = "text/plain" + mime;
  const type = serializeMime(mime) ?? "text/plain;charset=US-ASCII";
  const headers = new Headers();
  headers.append("content-type", type);
  return fetchResponse(200, "OK", headers, new Response(bytes).body, href, false);
}

/** Percent-decoded bytes of a URL's text (its other characters as they are, UTF-8). */
function decodeURIComponentBytes(text) {
  const raw = Buffer.from(text, "utf8");
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const hex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
    if (raw[i] === 37 && i + 2 < raw.length && hex(raw[i + 1]) && hex(raw[i + 2])) {
      out.push(parseInt(String.fromCharCode(raw[i + 1], raw[i + 2]), 16));
      i += 2;
    } else out.push(raw[i]);
  }
  return out;
}

/** A MIME type's serialization (WHATWG MIME Sniffing's parse, simplified), or null if it isn't one. */
function serializeMime(text) {
  const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\/([!#$%&'*+.^_`|~0-9A-Za-z-]+)[\t\n\r ]*(.*)$/s.exec(text);
  if (!m) return null;
  let out = `${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
  const seen = new Set();
  for (const param of m[3].split(";").slice(1)) {
    const eq = param.indexOf("=");
    if (eq === -1) continue;
    const name = param.slice(0, eq).replace(/^[\t\n\r ]+/, "").toLowerCase();
    let value = param.slice(eq + 1).replace(/[\t\n\r ]+$/, "");
    if (!name || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || seen.has(name) || !value) continue;
    if (value.startsWith('"')) value = value.slice(1).replace(/".*$/s, "").replace(/\\(.)/g, "$1");
    seen.add(name);
    out += `;${name}=${/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value) ? value : `"${value.replace(/(["\\])/g, "\\$1")}"`}`;
  }
  return out;
}

/* ---- the response's body ---------------------------------------------------------------------- */

/** The decoders a Content-Encoding names, last applied first; none for one undici doesn't know. */
function decoders(encoding) {
  const codings = encoding.toLowerCase().split(",").map((c) => c.trim()).filter(Boolean).reverse();
  const out = [];
  for (const coding of codings) {
    if (coding === "gzip" || coding === "x-gzip") out.push(() => createGunzip({ flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH }));
    else if (coding === "deflate") out.push(() => inflater({ flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH }));
    else if (coding === "br") out.push(() => createBrotliDecompress({ flush: constants.BROTLI_OPERATION_FLUSH, finishFlush: constants.BROTLI_OPERATION_FLUSH }));
    else if (coding === "zstd") out.push(() => createZstdDecompress({ flush: constants.ZSTD_e_continue, finishFlush: constants.ZSTD_e_end }));
    else return [];
  }
  return out;
}

/** A deflate decoder, as undici's: zlib's (RFC 1950) when the first byte's low nibble is 8 (its
 *  header's CM, deflate), raw deflate otherwise. */
function inflater(options) {
  let inner = null;
  const out = createInflate(options);
  const write = out.write;
  out.write = function (chunk, ...rest) {
    if (inner === null) {
      inner = (chunk[0] & 0x0f) === 0x08 ? out : createInflateRaw(options);
      if (inner !== out) {
        inner.on("data", (d) => out.push(d));
        inner.on("end", () => out.push(null));
        inner.on("error", (e) => out.destroy(e));
        out.write = (c, ...r) => inner.write(c, ...r);
        out.end = (...r) => inner.end(...r);
        return inner.write(chunk, ...rest);
      }
    }
    return write.call(this, chunk, ...rest);
  };
  return out;
}

/** The body as a ReadableStream of Uint8Arrays: the response's bytes through the decoders. */
function bodyStream(res, coders, controllerOf) {
  let source = res;
  const errorWith = (e) => controllerOf.error(new TypeError("terminated", { cause: e }));
  try {
    for (const make of coders) {
      const next = make();
      source.on("error", (e) => next.destroy(e));
      source.pipe(next);
      source = next;
    }
  } catch (e) {
    res.destroy();
    return new ReadableStream({ start(c) { c.error(e); } });
  }
  return new ReadableStream({
    start(controller) {
      controllerOf.controller = controller;
      source.on("data", (chunk) => {
        if (controllerOf.done) return;
        controller.enqueue(new Uint8Array(chunk));
        if (controller.desiredSize <= 0) source.pause();
      });
      source.on("end", () => {
        if (controllerOf.done) return;
        controllerOf.done = true;
        controller.close();
      });
      source.on("error", (e) => errorWith(e));
      res.on("aborted", () => errorWith(Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })));
    },
    pull() {
      source.resume();
    },
    cancel() {
      controllerOf.done = true;
      res.destroy();
    },
  }, { highWaterMark: 65536, size: (chunk) => chunk.byteLength });
}

/* ---- HTTP -------------------------------------------------------------------------------------- */

/** One request, as undici sends it: a promise of the IncomingMessage. */
function send(state, url, onRequest) {
  return new Promise((resolve, reject) => {
    const https = url.protocol === "https:";
    /* undici closes after a HEAD, for servers that send a body anyway */
    const headers = ["host", url.host, "connection", state.method === "HEAD" ? "close" : "keep-alive", ...state.headers];
    const defaults = [["accept", "*/*"], ["accept-language", "*"], ["sec-fetch-mode", "cors"], ["user-agent", "node"], ["accept-encoding", "gzip, deflate"]];
    for (const [name, value] of defaults) if (headerIndex(headers, name) === -1) headers.push(name, value);
    const body = state.body;
    if (body instanceof Uint8Array) headers.push("content-length", String(body.byteLength));
    else if (body === null && (state.method === "POST" || state.method === "PUT")) headers.push("content-length", "0");
    else if (body !== null) headers.push("transfer-encoding", "chunked");
    const options = {
      protocol: url.protocol,
      hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
      port: url.port || (https ? 443 : 80),
      path: url.pathname + url.search,
      method: state.method,
      headers,
      setHost: false,
      agent: https ? (httpsAgent ??= new HttpsAgent({ keepAlive: true })) : (httpAgent ??= new HttpAgent({ keepAlive: true })),
    };
    let req;
    try {
      req = (https ? httpsRequest : httpRequest)(options);
    } catch (e) {
      reject(networkError(e));
      return;
    }
    onRequest(req);
    req.on("response", resolve);
    req.on("error", (e) => reject(networkError(e)));
    if (body instanceof Uint8Array) req.end(body);
    else if (body === null) req.end();
    else {
      const reader = body.getReader();
      const pump = () => reader.read().then(({ value, done }) => {
        if (done) req.end();
        else if (req.write(value)) pump();
        else req.once("drain", pump);
      }, (e) => req.destroy(e));
      pump();
    }
  });
}

/** fetch(input, init): a promise of the Response. */
function fetch(input, init = undefined) {
  let request;
  try {
    request = new Request(input, init);
  } catch (e) {
    return Promise.reject(e);
  }
  const signal = request.signal;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  let body;
  try {
    body = fetchRequestBody(request);
  } catch (e) {
    return Promise.reject(e);
  }
  const state = {
    method: request.method,
    headers: fetchHeaderList(request.headers),
    body,
    redirect: request.redirect,
  };
  return new Promise((resolve, reject) => {
    let current = null;      // the ClientRequest in flight
    let response = null;     // the IncomingMessage whose body is being read
    const sink = { controller: null, done: false, error(e) {
      if (this.done) return;
      this.done = true;
      this.controller?.error(e);
    } };
    let settled = false;
    const onAbort = () => {
      const reason = abortReason(signal);
      if (!settled) {
        settled = true;
        reject(reason);
      } else sink.error(reason);
      current?.destroy();
      response?.destroy();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const fail = (e) => {
      signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      reject(e);
    };

    const urlList = [request.url];
    const step = () => {
      const href = urlList[urlList.length - 1];
      const url = new URL(href);
      if (url.protocol === "data:") return Promise.resolve(fetchDataURL(href)).then((r) => ({ done: r }));
      if (url.protocol === "blob:") throw networkError("invalid method");
      if (url.protocol === "about:") throw networkError("about scheme is not supported");
      if (url.protocol === "file:") throw networkError("not implemented... yet...");
      if (url.protocol !== "http:" && url.protocol !== "https:") throw networkError("unknown scheme");
      if (BAD_PORTS.has(Number(url.port))) throw networkError("bad port");
      return send(state, url, (req) => (current = req)).then((res) => {
        if (settled) {
          res.destroy();
          return { done: null };
        }
        const status = res.statusCode;
        const headers = new Headers();
        const raw = res.rawHeaders;
        for (let i = 0; i < raw.length; i += 2) headers.append(raw[i], raw[i + 1]);
        const location = REDIRECT_STATUSES.has(status) ? headers.get("location") : null;
        if (location !== null && state.redirect !== "manual") {
          res.resume();
          if (state.redirect === "error") throw networkError("unexpected redirect");
          let next;
          try {
            next = new URL(location, url);
          } catch (e) {
            throw networkError(e);
          }
          if (next.protocol !== "http:" && next.protocol !== "https:") throw networkError("URL scheme must be a HTTP(S) scheme");
          if (urlList.length > 20) throw networkError("redirect count exceeded");
          if (status !== 303 && state.body !== null && !(state.body instanceof Uint8Array)) throw networkError("Cannot follow redirect with a ReadableStream body");
          if (((status === 301 || status === 302) && state.method === "POST") || (status === 303 && state.method !== "GET" && state.method !== "HEAD")) {
            state.method = "GET";
            state.body = null;
            state.headers = withoutHeaders(state.headers, BODY_HEADERS);
          }
          if (next.origin !== url.origin) state.headers = withoutHeaders(state.headers, CREDENTIAL_HEADERS);
          if (next.hash === "" && url.hash !== "") next.hash = url.hash;
          urlList.push(next.href);
          return { done: undefined };
        }
        let stream = null;
        if (state.method === "HEAD" || state.method === "CONNECT" || NULL_BODY_STATUSES.has(status)) res.resume();
        else {
          response = res;
          stream = bodyStream(res, decoders(headers.get("content-encoding") ?? ""), sink);
          res.on("end", () => signal.removeEventListener("abort", onAbort));
        }
        return { done: fetchResponse(status, res.statusMessage ?? "", headers, stream, withoutFragment(href), urlList.length > 1) };
      });
    };
    const loop = () => {
      let next;
      try {
        next = step();
      } catch (e) {
        fail(e);
        return;
      }
      next.then(({ done }) => {
        if (done === undefined) loop();
        else if (done !== null && !settled) {
          settled = true;
          if (!response) signal.removeEventListener("abort", onAbort);
          resolve(done);
        }
      }, fail);
    };
    loop();
  });
}

Object.defineProperty(globalThis, "fetch", { value: fetch, writable: true, enumerable: true, configurable: true });
