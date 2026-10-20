// TLSSocket, tls.Server and tls.connect, following Node's internal/tls/wrap.js: the
// same events and the same order ('secure', then the client's verification and 'secureConnect',
// or the server's 'secureConnection'; errors before control is released go to the server's
// 'tlsClientError'). Where Node's TLSWrap (C++) sits between the socket's handle and OpenSSL,
// a TLSSocket here drives the runtime's BoringSSL connection itself: records from the transport go in
// (tlsRun), application data comes out and is pushed; written data goes in and records come out
// to the transport. The transport is a net.Socket's handle, taken over as Node's TLSWrap takes
// it (its events come to the TLSSocket), or any Duplex stream (Node's JSStreamSocket case).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import {
  errnoName, netReadStart, netReadStop, netShutdown, netWrite, tlsExportKeyingMaterial, tlsFinished, tlsInfo, tlsNew, tlsPeerCerts,
  tlsContextTicketKeys, tlsEnableKeylog, tlsRootCertificates, tlsRun, tlsSession, tlsSetMaxSendFragment, tlsSetNoRenegotiation, tlsShutdown, tlsTicket, tlsVerifyError,
} from "visaljs:host";
import { codeError, invalidArgType, invalidArgValue, outOfRange, validateFunction, validateInteger, validateString } from "../errors.js";
import { callableClass, feature, features } from "../features.js";
import { isIP } from "../net.js";
import { Server as NetServer, Socket } from "../../net.js";
import { domainToASCII } from "../../url.js";
import { createSecureContext, SecureContext, sslError, tlsFailure, VERSION_NAMES, verifyError } from "./common.js";
import { certificatesOf, legacyObject, parseCertificate } from "./x509.js";

const UV_EOF = -4095;
/* tlsRun's state */
const TLS_FAILED = 2, TLS_PEER_CLOSED = 4, TLS_NEW_SESSION = 8;

const kConnectOptions = Symbol("connect-options");
const kDisableRenegotiation = Symbol("disable-renegotiation");
const kErrorEmitted = Symbol("error-emitted");
const kHandshakeTimeout = Symbol("handshake-timeout");
const kSNICallback = Symbol("snicallback");
const kALPNCallback = Symbol("alpncallback");
const kIsVerified = Symbol("verified");
const kPendingSession = Symbol("pendingSession");
const kMaxSendFragment = Symbol("maxSendFragment");

const connReset = (message) => codeError(Error, "ECONNRESET", message);

/** `read ECONNRESET`: a read fails so on Windows, where the peer's reset isn't an end first */
function errnoException(errno, syscall) {
  const code = errnoName(errno);
  const e = new Error(syscall + " " + code);
  e.errno = errno;
  e.code = code;
  e.syscall = syscall;
  return e;
}

/** The protocols of an ALPN option (Node's wire format, as convertALPNProtocols makes it) as names */
function alpnNames(buf) {
  if (!buf) return null;
  const names = [];
  for (let i = 0; i < buf.length;) {
    const n = buf[i++];
    names.push(Buffer.from(buf.subarray(i, i + n)).toString("latin1"));
    i += n;
  }
  return names;
}

/* Convert protocols array into the wire format ("\x08http/1.1\x08http/1.0") */
function convertProtocols(protocols) {
  const parts = protocols.map((p, i) => {
    const b = Buffer.from(p);
    if (b.length === 0) throw invalidArgValue(`protocols[${i}]`, "must be a non-empty string", p);
    if (b.length > 255) {
      throw codeError(RangeError, "ERR_OUT_OF_RANGE", `The byte length of the protocol at index ${i} exceeds the maximum length. It must be <= 255. Received ${b.length}`);
    }
    return b;
  });
  const out = Buffer.allocUnsafe(parts.reduce((n, b) => n + 1 + b.length, 0));
  let at = 0;
  for (const b of parts) {
    out[at++] = b.length;
    b.copy(out, at);
    at += b.length;
  }
  return out;
}

/* the wire format: <len><protocol>…, each 1–255 bytes, nothing after (empty: no ALPN) */
function validateALPNBuffer(buffer) {
  for (let at = 0; at < buffer.length; at += 1 + buffer[at]) {
    if (buffer[at] === 0) throw invalidArgValue("ALPNProtocols", "must not contain zero-length protocol", buffer);
    if (at + 1 + buffer[at] > buffer.length) throw invalidArgValue("ALPNProtocols", "contains truncated protocol", buffer);
  }
}

export function convertALPNProtocols(protocols, out) {
  let buf;
  if (Array.isArray(protocols)) {
    out.ALPNProtocols = convertProtocols(protocols);
    return;
  }
  if (protocols instanceof Uint8Array) buf = Buffer.from(protocols);
  else if (ArrayBuffer.isView(protocols)) buf = Buffer.from(protocols.buffer.slice(protocols.byteOffset, protocols.byteOffset + protocols.byteLength));
  else return;
  validateALPNBuffer(buf);
  out.ALPNProtocols = buf;
}

/* ---- Sessions: a client's carry the server name they were verified for (Node 24.21) ------------ */

const kSessionStatePrefix = Buffer.from("\0nodejs:tls:session:1\0");

const sessionServerIdentity = (options) => options?.servername || options?.host || options?.socket?._host || "localhost";

function wrapSessionState(session, options) {
  if (!Buffer.isBuffer(session) || options?.isServer) return session;
  const servername = Buffer.from(sessionServerIdentity(options), "utf8");
  const length = Buffer.allocUnsafe(2);
  length.writeUInt16BE(servername.length, 0);
  return Buffer.concat([kSessionStatePrefix, length, servername, session]);
}

function unwrapSessionState(session) {
  const start = kSessionStatePrefix.length;
  if (!Buffer.isBuffer(session) || session.length < start + 2 || Buffer.compare(session.subarray(0, start), kSessionStatePrefix) !== 0) return;
  const end = start + 2 + session.readUInt16BE(start);
  if (session.length < end) return;
  return { servername: session.toString("utf8", start + 2, end), session: session.subarray(end) };
}

/* a session another server name was verified for isn't resumed; nor a raw one, by a client that verifies */
function sessionForReuse(session, options) {
  if (typeof session === "string") session = Buffer.from(session, "latin1");
  if (options?.isServer) return session;
  const wrapped = unwrapSessionState(session);
  if (wrapped !== undefined) return wrapped.servername === sessionServerIdentity(options) ? wrapped.session : undefined;
  if (Buffer.isBuffer(session) && options?.rejectUnauthorized !== false) return;
  return session;
}

/* ---- The ClientHello: what a server needs before it can choose a context --------------------- */

/** The SNI host name and ALPN protocols of a ClientHello in its first record, or null while
 *  the record is incomplete; { servername: null, protocols: null } when it can't be read. */
function readClientHello(buf) {
  const none = { servername: null, protocols: null };
  if (buf.length < 5) return null;
  if (buf[0] !== 22) return none;
  const len = (buf[3] << 8) | buf[4];
  if (buf.length < 5 + len) return len > 16384 + 2048 ? none : null;
  const hs = buf.subarray(5, 5 + len);
  if (hs[0] !== 1 || hs.length < 4) return none;
  const end = Math.min(hs.length, 4 + ((hs[1] << 16) | (hs[2] << 8) | hs[3]));
  let p = 4 + 2 + 32;
  const skip8 = () => (p += 1 + hs[p]);
  const skip16 = () => (p += 2 + ((hs[p] << 8) | hs[p + 1]));
  if (p >= end) return none;
  skip8();  /* session id */
  skip16(); /* cipher suites */
  skip8();  /* compression methods */
  if (p + 2 > end) return none;
  const extEnd = Math.min(end, p + 2 + ((hs[p] << 8) | hs[p + 1]));
  p += 2;
  const out = { servername: null, protocols: null };
  while (p + 4 <= extEnd) {
    const type = (hs[p] << 8) | hs[p + 1];
    const n = (hs[p + 2] << 8) | hs[p + 3];
    const body = hs.subarray(p + 4, p + 4 + n);
    p += 4 + n;
    if (type === 0 && body.length > 5 && body[2] === 0) {
      const nameLen = (body[3] << 8) | body[4];
      out.servername = Buffer.from(body.subarray(5, 5 + nameLen)).toString("latin1");
    } else if (type === 16 && body.length >= 2) {
      out.protocols = alpnNames(body.subarray(2, 2 + ((body[0] << 8) | body[1])));
    }
  }
  return out;
}

/* ---- Root certificates, parsed when a detailed chain needs them -------------------------------- */

let rootsParsed;
function rootCertificate(subjectRaw) {
  rootsParsed ??= tlsRootCertificates().map((pem) => {
    try {
      return parseCertificate(certificatesOf(pem)[0]);
    } catch {
      return null;
    }
  }).filter(Boolean);
  return rootsParsed.find((c) => Buffer.compare(c.subjectRaw, subjectRaw) === 0);
}

/* ---- TLSSocket ---------------------------------------------------------------------------------- */

export class TLSSocket extends Socket {
  constructor(socket, opts) {
    const tlsOptions = { ...opts };
    if (tlsOptions.enableTrace !== undefined && typeof tlsOptions.enableTrace !== "boolean") {
      throw invalidArgType("options.enableTrace", "of type boolean", tlsOptions.enableTrace);
    }
    if (tlsOptions.ALPNProtocols) convertALPNProtocols(tlsOptions.ALPNProtocols, tlsOptions);
    /* a connected net.Socket: its handle becomes this socket's (Node's TLSWrap on its handle) */
    const takeHandle = socket instanceof Socket && socket._handle !== null && !socket.connecting;
    const handle = takeHandle ? socket._handle : undefined;
    super({
      handle,
      _isPipe: takeHandle ? socket._isPipe : false,
      allowHalfOpen: socket ? socket.allowHalfOpen : tlsOptions.allowHalfOpen,
      pauseOnCreate: tlsOptions.pauseOnConnect,
      manualStart: true,
      highWaterMark: tlsOptions.highWaterMark,
      onread: !socket ? tlsOptions.onread : null,
    });
    this._tlsOptions = tlsOptions;
    this._secureEstablished = false;
    this._securePending = false;
    this._newSessionPending = false;
    this._controlReleased = false;
    this.secureConnecting = true;
    this._SNICallback = null;
    this[kALPNCallback] = null;
    this.servername = null;
    this.alpnProtocol = null;
    this.authorized = false;
    this.authorizationError = null;
    this[kIsVerified] = false;
    this[kPendingSession] = null;
    this.encrypted = true;
    this._conn = null;          /* the engine, once started */
    this._handshakes = 0;
    this._tlsClosed = false;    /* the engine closed (close_notify, or an error) */
    this._pendingWrites = [];   /* written before the handshake: [bytes, cb] */
    this._hello = null;         /* a server's first bytes, until the ClientHello is read */
    this._servernameOut = null; /* a client's SNI */
    this._sessionIn = null;     /* a client's session to resume */
    this._stream = null;        /* a Duplex transport (not a net.Socket handle) */
    this._secureContext = tlsOptions.secureContext || tlsOptions.credentials || createSecureContext(tlsOptions);
    if (!(this._secureContext instanceof SecureContext)) throw codeError(TypeError, "ERR_TLS_INVALID_CONTEXT", "context must be a SecureContext");
    this.ssl = null;

    if (takeHandle) {
      /* bytes the socket had already read, and writes still pending, are this socket's now */
      this._writeCallbacks = socket._writeCallbacks.splice(0);
      this._reading = socket._reading;
      socket._handle = null;
      this._parent = socket;
      this._parentBuffered = socket.readableLength ? socket.read() : null;
      socket.on("close", () => this.destroy());
    } else if (socket) {
      this._wrapStream(socket);
    }
    this.on("error", this._tlsError);
    this._init(socket);
    process.nextTick(() => this._initRead());
  }

  /* a Duplex (or a net.Socket not connected yet): records travel through its write() and 'data' */
  _wrapStream(socket) {
    /* as Node's JSStreamSocket: paused until the engine reads (_startReading); not a stream, a TypeError */
    if (!(socket instanceof Socket)) socket.pause();
    this._stream = socket;
    this._parent = socket instanceof Socket ? socket : null;
    socket.on("data", (chunk) => this._onCipher(chunk));
    socket.on("end", () => this._onCipherEnd());
    socket.on("error", (err) => this._emitTLSError(err));
    socket.on("close", () => this.destroy());
    if (socket instanceof Socket && socket.connecting) {
      this.connecting = true;
      socket.once("connect", () => {
        this.connecting = false;
        this.emit("connect");
      });
    }
  }

  get pending() {
    return this._stream ? this.connecting : super.pending;
  }

  _init(socket) {
    const options = this._tlsOptions;
    this.server = options.server;
    const requestCert = !!options.requestCert || !options.isServer;
    this._requestCert = requestCert;
    this._rejectUnauthorized = !!options.rejectUnauthorized;
    if (options.isServer) {
      if (options.ALPNCallback) {
        validateFunction(options.ALPNCallback, "options.ALPNCallback");
        this[kALPNCallback] = options.ALPNCallback;
      }
      if (options.SNICallback && (options.SNICallback !== SNICallback || (options.server && options.server._contexts.length))) {
        validateFunction(options.SNICallback, "options.SNICallback");
        this._SNICallback = options.SNICallback;
      }
    } else if (options.session) {
      this.setSession(options.session);
    }
    if (options.handshakeTimeout > 0) this.setTimeout(options.handshakeTimeout, this._handleTimeout);
    if (socket instanceof Socket && this._stream === null) {
      this._parent = socket;
      this.connecting = false;
    }
    if (!socket) this.connecting = true;
  }

  /* reading starts on the next tick, so listeners are on (Node's initRead) */
  _initRead() {
    if (this.destroyed) return;
    if (this._parentBuffered) {
      const buffered = this._parentBuffered;
      this._parentBuffered = null;
      this._onCipher(buffered);
    }
    if (this._tlsOptions.isServer) this._startReading();
  }

  _startReading() {
    if (this._stream) {
      this._stream.resume();
      return;
    }
    if (this._handle === null || this._reading || this.connecting) return;
    this._reading = true;
    const err = netReadStart(this._handle);
    if (err) this.destroy(errnoException(err, "read"));
  }

  /* ---- the engine ---- */

  /* a client's handshake starts once connected (Node's _start) */
  _start() {
    if (this.connecting) {
      this.once("connect", this._start);
      return;
    }
    if (this.destroyed || this._conn !== null) return;
    this._createEngine(this._secureContext, this._servernameOut, alpnNames(this._tlsOptions.ALPNProtocols), false);
    if (this._conn === null) return;
    this._run(null, null);
    this._startReading();
  }

  _createEngine(context, servername, alpn, strict) {
    const options = this._tlsOptions;
    /* a server that rejects the unauthorized fails a handshake without a client certificate, as OpenSSL's does */
    const request = options.isServer && options.requestCert ? (options.rejectUnauthorized ? 2 : 1) : 0;
    const conn = tlsNew(context.context, !!options.isServer, servername, alpn, this._sessionIn, request, strict);
    if (Array.isArray(conn)) {
      this._onTlsError(tlsFailure(conn));
      return;
    }
    this._conn = conn;
    this.ssl = conn;
    this._activeContext = context;
    if (this.listenerCount("keylog") > 0) tlsEnableKeylog(conn);
    else this.on("newListener", keylogNewListener);
    if (this[kMaxSendFragment] !== undefined) tlsSetMaxSendFragment(conn, this[kMaxSendFragment]);
    if (this[kDisableRenegotiation]) tlsSetNoRenegotiation(conn);
  }

  /** Runs the engine with records received and data to send: sends the records it makes (`cb`
   *  when the last of `plain`'s are written), pushes the data it decrypts, and reports handshakes,
   *  sessions, the peer's close_notify and failures. Returns how much of `plain` it took. */
  /* each line (with its \n), as Node's onkeylog */
  _emitKeylog(lines) {
    for (let at = 0; at < lines.length;) {
      const end = lines.indexOf(0x0a, at) + 1;
      this.emit("keylog", lines.subarray(at, end));
      at = end;
    }
  }

  _run(cipher, plain, cb) {
    if (this._conn === null || this._tlsClosed) {
      if (cb) cb();
      return plain ? plain.length : 0;
    }
    const [out, app, taken, state, err, handshakes, keylog] = tlsRun(this._conn, cipher, plain);
    if (keylog) this._emitKeylog(keylog);
    /* the callback goes with the last record of the data, once the engine took all of it */
    const all = !plain || taken === plain.length;
    if (handshakes > this._handshakes) {
      /* As Node's TLSWrap: the handshake's last flight goes out after 'secure' is handled, so a
       * side that rejects the peer's certificate there never sends it (the peer sees the end);
       * whatever the handlers write goes after it. */
      this._handshakes = handshakes;
      this._flight = out;
      this._onHandshakeDone();
      const flight = this._flight;
      this._flight = null;
      if (flight && !this.destroyed) this._sendCipher(flight);
      if (cb && all) cb();
    } else if (out) {
      this._sendCipher(out, all ? cb : undefined);
    } else if (cb && all) {
      cb();
    }
    if (app && !this.destroyed) this._pushPlain(app);
    if (state & TLS_NEW_SESSION && !this._tlsOptions.isServer) this._onNewSession();
    if (state & TLS_FAILED && !this._tlsClosed) {
      this._tlsClosed = true;
      this._onTlsError(tlsFailure(err));
    } else if (state & TLS_PEER_CLOSED) {
      this._peerEnded();
    }
    return taken;
  }

  /* a session the server gave (a TLS 1.3 ticket comes after the handshake): 'session', once the
   * server is verified (Node's onnewsessionclient) */
  _onNewSession() {
    const session = wrapSessionState(tlsSession(this._conn), this[kConnectOptions] || this._tlsOptions);
    if (!session) return;
    if (this[kIsVerified]) this.emit("session", session);
    else this[kPendingSession] = session;
  }

  _pushPlain(bytes) {
    this._unrefTimer();
    let more;
    if (this._onread) more = features.onread.deliverAll(this, bytes);
    else more = this.push(bytes);
    if (!more && this._secureEstablished) this._stopReading();
  }

  _stopReading() {
    if (this._stream) {
      this._stream.pause();
      return;
    }
    if (this._handle !== null && this._reading) {
      this._reading = false;
      netReadStop(this._handle);
    }
  }

  _sendCipher(bytes, cb) {
    if (this._writeShut) {  /* the write side is shut */
      if (cb) cb();
      return;
    }
    if (this._flight) {
      const flight = this._flight;
      this._flight = null;
      this._sendCipher(flight);
    }
    this._bytesDispatched += bytes.length;
    if (this._stream) {
      this._stream.write(bytes, cb);
      return;
    }
    if (this._handle === null) {
      if (cb) cb(codeError(Error, "ERR_SOCKET_CLOSED", "Socket is closed"));
      return;
    }
    const r = netWrite(this._handle, bytes);
    if (r < 0) {
      this.destroy(errnoException(r, "write"));
      return;
    }
    if (r === 0) {
      if (cb) cb();
      return;
    }
    this._writeCallbacks.push((status) => {
      if (!cb) return;
      if (this.destroyed) cb(null);
      else if (status < 0) cb(errnoException(status, "write"));
      else cb();
    });
  }

  /* records from the transport: a server reads the ClientHello first, to choose its context */
  _onCipher(bytes) {
    if (this.destroyed) return;
    this._unrefTimer();
    if (this._tlsOptions.isServer && this._conn === null) {
      this._hello = this._hello ? Buffer.concat([this._hello, bytes]) : Buffer.from(bytes);
      if (this._helloPending) return;
      const hello = readClientHello(this._hello);
      if (hello === null) return;
      this._helloPending = true;
      this._onClientHello(hello);
      return;
    }
    this._run(bytes, null);
  }

  _peerEnded() {
    if (this._readEnded) return;
    this._readEnded = true;
    this.push(null);
    this.read(0);
  }

  /* the transport's end: the peer sends no more (with or without its close_notify); before the
   * handshake is done, that's the end of it */
  _onCipherEnd() {
    if (this.destroyed) return;
    this._reading = false;
    if (!this._secureEstablished) this._tlsClosed = true;
    this._peerEnded();
    if (this._finalPending) {
      const cb = this._finalPending;
      this._finalPending = null;
      this._final(cb);
    }
  }

  /* net.Socket's reads from the handle */
  _onRead(value) {
    if (this.destroyed) return;
    if (typeof value !== "number") {
      this._bytesRead += value.byteLength;
      this._onCipher(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      return;
    }
    this._reading = false;
    if (value !== UV_EOF) {
      this.destroy(errnoException(value, "read"));
      return;
    }
    this._onCipherEnd();
  }

  _read() {
    if (this._conn === null && !this._tlsOptions.isServer) return;  /* the handshake starts reading */
    this._startReading();
  }

  _onClientHello(hello) {
    const options = this._tlsOptions;
    const finish = (context) => {
      this._helloPending = false;
      if (this.destroyed) return;
      let alpn = alpnNames(options.ALPNProtocols);
      let strict = !!alpn;
      if (this[kALPNCallback] && hello.protocols) {
        let selected;
        try {
          selected = this[kALPNCallback]({ servername: hello.servername ?? undefined, protocols: hello.protocols });
        } catch (err) {
          this.destroy(err);
          return;
        }
        if (selected !== undefined && !hello.protocols.includes(selected)) {
          this.destroy(codeError(TypeError, "ERR_TLS_ALPN_CALLBACK_INVALID_RESULT",
            `ALPN callback returned a value (${selected}) that did not match any of the client's offered protocols (${hello.protocols.join(", ")})`));
          return;
        }
        alpn = [selected === undefined ? "\u0000" : selected];
        strict = true;
      }
      this._createEngine(context ?? this._secureContext, null, alpn, strict);
      const buffered = this._hello;
      this._hello = null;
      if (this._conn !== null) this._run(buffered, null);
    };
    this.servername = hello.servername ?? false;
    if (!hello.servername || !this._SNICallback) {
      finish(null);
      return;
    }
    let once = false;
    try {
      this._SNICallback(hello.servername, (err, context) => {
        if (once) return this.destroy(codeError(Error, "ERR_MULTIPLE_CALLBACK", "Callback called multiple times"));
        once = true;
        if (err) return this.destroy(err);
        const secureContext = !context ? null : context instanceof SecureContext ? context : context.context instanceof SecureContext ? context.context : undefined;
        /* Node's TLSWrap: the handshake fails, as a TLS error the server reports */
        if (secureContext === undefined) return this._onTlsError(new TypeError("Invalid SNI context"));
        finish(secureContext);
      });
    } catch (err) {
      this.destroy(err);
    }
  }

  _onHandshakeDone() {
    const first = !this._secureEstablished;
    if (this._tlsOptions.isServer) {
      if (first && this.server) {
        /* Node's server limits client renegotiations: tls.CLIENT_RENEG_LIMIT in CLIENT_RENEG_WINDOW */
      }
      if (!first && this[kDisableRenegotiation]) {
        this._emitTLSError(codeError(Error, "ERR_TLS_RENEGOTIATION_DISABLED", "TLS session renegotiation disabled for this socket"));
        return;
      }
    }
    this._finishInit();
    const pending = this._pendingWrites;
    this._pendingWrites = [];
    for (const [bytes, cb] of pending) this._writeNow(bytes, cb);
    if (first) {
      if (this._finalPending) {
        const cb = this._finalPending;
        this._finalPending = null;
        this._final(cb);
      }
    }
    if (this.readableFlowing !== false || this.readableLength < this.readableHighWaterMark) this._startReading();
  }

  /* Node's onerror */
  _onTlsError(err) {
    if (this._hadError) return;
    this._hadError = true;
    if (!this._secureEstablished) {
      this._closeAfterHandlingError = true;
      this.destroy(err);
    } else if (this._tlsOptions.isServer && this._rejectUnauthorized && /peer did not return a certificate/.test(err.message)) {
      this.destroy();
    } else {
      this._emitTLSError(err);
    }
  }

  /* ---- writing ---- */

  _write(data, encoding, cb) {
    if (this.connecting && this._stream === null && this._handle === null) {
      this.once("connect", () => this._write(data, encoding, cb));
      return;
    }
    const bytes = typeof data === "string" ? Buffer.from(data, encoding) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (!this._secureEstablished || this._conn === null) {
      this._pendingWrites.push([bytes, cb]);
      return;
    }
    this._writeNow(bytes, cb);
  }

  _writeNow(bytes, cb) {
    if (this.destroyed) {
      cb(codeError(Error, "ERR_SOCKET_CLOSED", "Socket is closed"));
      return;
    }
    this._unrefTimer();
    if (bytes.length === 0) {
      this._run(null, null);
      cb();
      return;
    }
    const taken = this._run(null, bytes, cb);
    /* a renegotiation holds data back until it finishes */
    if (taken < bytes.length && !this._tlsClosed) this._pendingWrites.push([bytes.subarray(taken), cb]);
  }

  /* end(): close_notify, then the transport's write side */
  _final(cb) {
    if (this.connecting) {
      this.once("connect", () => this._final(cb));
      return;
    }
    if (this._conn !== null && !this._secureEstablished && !this._tlsClosed) {
      this._finalPending = cb;
      return;
    }
    if (this._conn !== null && !this._tlsClosed) {
      const out = tlsShutdown(this._conn);
      if (out) this._sendCipher(out);
    }
    this._writeShut = true;
    if (this._stream) {
      this._stream.end();
      cb();
      return;
    }
    if (this._handle === null) {
      cb();
      return;
    }
    const err = netShutdown(this._handle);
    if (err === -107) cb();
    else if (err < 0) cb(errnoException(err, "shutdown"));
    else this._shutdownCallback = () => cb();
  }

  _destroy(exception, cb) {
    this._pendingWrites = [];
    super._destroy(exception, cb);
    /* as Node's handle: the connection's details are gone with it */
    this._conn = null;
    if (this._stream) {
      if (!this._stream.destroyed) this._stream.destroy();
    } else if (this._parent && !this._parent.destroyed) {
      /* the socket whose handle this was closes with the handle, after this one's 'error' (pg
       * hears its 'close' as the end of the connection) */
      const parent = this._parent;
      this.once("close", () => parent.destroy());
    }
  }

  /* ---- Node's TLSSocket API ---- */

  disableRenegotiation() {
    this[kDisableRenegotiation] = true;
    if (this._conn !== null) tlsSetNoRenegotiation(this._conn);
  }

  renegotiate(options, callback) {
    if (typeof options !== "object" || options === null) throw invalidArgType("options", "of type object", options);
    if (callback !== undefined) validateFunction(callback, "callback");
    if (this.destroyed) return;
    if (options.requestCert !== undefined) this._requestCert = !!options.requestCert;
    if (options.rejectUnauthorized !== undefined) this._rejectUnauthorized = !!options.rejectUnauthorized;
    /* BoringSSL never starts a renegotiation (a client follows a server's request); TLS 1.3 has
     * none, which OpenSSL 3 reports as its wrong version */
    const err = this.getProtocol() === "TLSv1.3" ? sslError(0x0A00010A, "wrong ssl version") : sslError(0x0A000153, "no renegotiation");
    if (callback) process.nextTick(callback, err);
    return false;
  }

  exportKeyingMaterial(length, label, context) {
    if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > 2 ** 32 - 1) {
      if (typeof length !== "number") throw invalidArgType("length", "of type number", length);
      throw outOfRange("length", ">= 1 && <= 4294967295", length);
    }
    validateString(label, "label");
    if (context !== undefined && !ArrayBuffer.isView(context)) throw invalidArgType("context", "an instance of Buffer, TypedArray, or DataView", context);
    if (!this._secureEstablished) throw codeError(Error, "ERR_TLS_INVALID_STATE", "TLS socket connection must be securely established");
    return tlsExportKeyingMaterial(this._conn, length, label, context);
  }

  setMaxSendFragment(size) {
    validateInteger(size, "size");
    if (size < -(2 ** 31) || size > 2 ** 31 - 1) throw outOfRange("size", `>= ${-(2 ** 31)} && <= ${2 ** 31 - 1}`, size);
    /* OpenSSL's range: BoringSSL would clamp what's outside it, and report success */
    if (size < 512 || size > 16384) return false;
    if (this._conn) tlsSetMaxSendFragment(this._conn, size);
    else this[kMaxSendFragment] = size;
    return true;
  }

  _handleTimeout() {
    this._emitTLSError(codeError(Error, "ERR_TLS_HANDSHAKE_TIMEOUT", "TLS handshake timeout"));
  }

  _emitTLSError(err) {
    const e = this._tlsError(err);
    if (e) this.emit("error", e);
  }

  _tlsError(err) {
    this.emit("_tlsError", err);
    if (this._controlReleased) return err;
    return null;
  }

  _releaseControl() {
    if (this._controlReleased) return false;
    this._controlReleased = true;
    this.removeListener("error", this._tlsError);
    return true;
  }

  _finishInit() {
    if (this._conn === null) return;
    const info = tlsInfo(this._conn);
    this.alpnProtocol = info[2];
    if (this.servername === null) this.servername = this._tlsOptions.isServer ? info[3] ?? false : this._servernameOut ?? false;
    this._secureEstablished = true;
    if (this._tlsOptions.handshakeTimeout > 0) this.setTimeout(0, this._handleTimeout);
    this.emit("secure");
  }

  setServername(name) {
    validateString(name, "name");
    if (this._tlsOptions.isServer) throw codeError(Error, "ERR_TLS_SNI_FROM_SERVER", "Cannot issue SNI from a TLS server-side socket");
    this._servernameOut = name;
  }

  /* a session is BoringSSL's (i2d_SSL_SESSION's), with the server's chain and verification as
   * OpenSSL's has them */
  setSession(session) {
    session = sessionForReuse(session, this[kConnectOptions] || this._tlsOptions);
    if (ArrayBuffer.isView(session)) this._sessionIn = session;
  }

  getSession() {
    return this._conn === null ? null : wrapSessionState(tlsSession(this._conn), this[kConnectOptions] || this._tlsOptions);
  }

  /** The peer's chain, parsed: the leaf, then each certificate's issuer among the rest */
  _peerChain() {
    if (this._conn === null) return [];
    const certs = [];
    for (const der of tlsPeerCerts(this._conn)) {
      try {
        certs.push(parseCertificate(der));
      } catch {
        break;
      }
    }
    if (certs.length === 0) return certs;
    const out = [certs[0]];
    const rest = certs.slice(1);
    for (let last = certs[0]; Buffer.compare(last.issuerRaw, last.subjectRaw) !== 0;) {
      const i = rest.findIndex((c) => Buffer.compare(last.issuerRaw, c.subjectRaw) === 0);
      if (i < 0) break;
      last = rest.splice(i, 1)[0];
      out.push(last);
    }
    return out;
  }

  /** The verification result: null, or Node's error (code and message) */
  _verifyError() {
    if (this._conn === null) return null;
    const err = tlsVerifyError(this._conn);
    if (err === -1) return verifyError("UNABLE_TO_GET_ISSUER_CERT");
    return err === 0 ? null : verifyError(err);
  }

  getPeerCertificate(detailed) {
    if (this._conn === null) return this.destroyed ? null : {};
    /* OpenSSL keeps no peer chain in a resumed session, so Node's client shows none */
    if (!this._tlsOptions.isServer && tlsInfo(this._conn)[4]) return {};
    const chain = this._peerChain();
    if (chain.length === 0) return {};
    const objects = chain.map(legacyObject);
    if (!detailed) return objects[0];
    /* each certificate's issuer: the next one sent, or a trusted one; a root is its own */
    let last = chain[chain.length - 1];
    let lastObject = objects[objects.length - 1];
    for (let i = 0; i < objects.length - 1; i++) objects[i].issuerCertificate = objects[i + 1];
    while (lastObject) {
      if (Buffer.compare(last.issuerRaw, last.subjectRaw) === 0) {
        lastObject.issuerCertificate = lastObject;
        break;
      }
      const ctx = this._activeContext;
      const issuer = ctx._cas.find((c) => Buffer.compare(c.subjectRaw, last.issuerRaw) === 0) ??
        (ctx._hasRoots ? rootCertificate(last.issuerRaw) : undefined);
      if (!issuer) break;
      const o = legacyObject(issuer);
      lastObject.issuerCertificate = o;
      last = issuer;
      lastObject = o;
    }
    return objects[0];
  }

  getCertificate() {
    if (this._conn === null && this.destroyed) return null;
    const ctx = this._activeContext ?? this._secureContext;
    if (!ctx._certs.length) return {};
    return legacyObject(parseCertificate(ctx._certs[0]));
  }

  getPeerX509Certificate() {
    const chain = this._peerChain();
    return chain.length ? feature("x509CertificateChain")(chain.map((c) => c.der)) : undefined;
  }

  getX509Certificate() {
    const ctx = this._activeContext ?? this._secureContext;
    return ctx._certs.length ? feature("x509CertificateChain")([ctx._certs[0]]) : undefined;
  }

  setKeyCert(context) {
    if (this._conn === null) this._secureContext = context instanceof SecureContext ? context : createSecureContext(context);
  }

  getCipher() {
    if (this._conn === null) return null;
    const cipher = tlsInfo(this._conn)[1];
    return cipher ? { name: cipher[0], standardName: cipher[1], version: cipher[2] } : null;
  }

  getProtocol() {
    if (this._conn === null) return null;
    if (!this._secureEstablished) return "unknown";
    return VERSION_NAMES[tlsInfo(this._conn)[0]] ?? "unknown";
  }

  getEphemeralKeyInfo() {
    if (this._conn === null || this._tlsOptions.isServer) return null;
    const group = tlsInfo(this._conn)[5];
    const known = { "P-256": ["prime256v1", 256], "P-384": ["secp384r1", 384], "P-521": ["secp521r1", 521], X25519: ["X25519", 253] }[group];
    return known ? { type: "ECDH", name: known[0], size: known[1] } : {};
  }

  getFinished() {
    return this._conn === null ? undefined : tlsFinished(this._conn, false);
  }

  getPeerFinished() {
    return this._conn === null ? undefined : tlsFinished(this._conn, true);
  }

  getTLSTicket() {
    return this._conn === null ? undefined : tlsTicket(this._conn);
  }

  getSharedSigalgs() {
    return this._conn === null ? null : [];
  }

  isSessionReused() {
    return this._conn === null ? null : tlsInfo(this._conn)[4];
  }

  enableTrace() {}
}

/* ---- Server ------------------------------------------------------------------------------------- */

function onServerSocketSecure() {
  if (this._requestCert) {
    const err = this._verifyError();
    if (err) {
      this.authorizationError = err.code;
      if (this._rejectUnauthorized) this.destroy();
    } else {
      this.authorized = true;
    }
  }
  if (!this.destroyed && this._releaseControl()) {
    this.secureConnecting = false;
    this._tlsOptions.server.emit("secureConnection", this);
  }
}

function onSocketTLSError(err) {
  if (!this._controlReleased && !this[kErrorEmitted]) {
    this[kErrorEmitted] = true;
    this._tlsOptions.server.emit("tlsClientError", err, this);
  }
}

function onSocketClose(err) {
  if (err) return;
  if (!this._controlReleased && !this[kErrorEmitted]) {
    this[kErrorEmitted] = true;
    this._tlsOptions.server.emit("tlsClientError", connReset("socket hang up"), this);
  }
}

function keylogNewListener(event) {
  if (event !== "keylog") return;
  if (this._conn !== null) tlsEnableKeylog(this._conn);
  this.removeListener("newListener", keylogNewListener);
}

function onSocketKeylog(line) {
  this._tlsOptions.server.emit("keylog", line, this);
}

function tlsConnectionListener(rawSocket) {
  const socket = new TLSSocket(rawSocket, {
    secureContext: this._sharedCreds,
    isServer: true,
    server: this,
    requestCert: this.requestCert,
    rejectUnauthorized: this.rejectUnauthorized,
    handshakeTimeout: this[kHandshakeTimeout],
    ALPNProtocols: this.ALPNProtocols,
    ALPNCallback: this.ALPNCallback,
    SNICallback: this[kSNICallback] || SNICallback,
    pauseOnConnect: this.pauseOnConnect,
  });
  socket.on("secure", onServerSocketSecure);
  socket[kErrorEmitted] = false;
  socket.on("close", onSocketClose);
  socket.on("_tlsError", onSocketTLSError);
  socket.on("error", onSocketTLSError);
  if (this.listenerCount("keylog") > 0) socket.on("keylog", onSocketKeylog);
}

function SNICallback(servername, callback) {
  const contexts = this.server._contexts;
  for (let i = contexts.length - 1; i >= 0; --i) {
    if (contexts[i][0].test(servername)) {
      callback(null, contexts[i][1]);
      return;
    }
  }
  callback(null, undefined);
}

class ServerClass extends NetServer {
  constructor(options, listener) {
    if (typeof options === "function") {
      listener = options;
      options = {};
    } else if (options == null) {
      options = {};
    } else if (typeof options !== "object") {
      throw invalidArgType("options", "of type object", options);
    }
    super(options, tlsConnectionListener);
    this._contexts = [];
    this.requestCert = options.requestCert === true;
    this.rejectUnauthorized = options.rejectUnauthorized !== false;
    this.ALPNCallback = options.ALPNCallback;
    if (this.ALPNCallback && options.ALPNProtocols) {
      throw codeError(TypeError, "ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS", "The ALPNCallback and ALPNProtocols TLS options are mutually exclusive");
    }
    if (options.sessionTimeout) this.sessionTimeout = options.sessionTimeout;
    if (options.ticketKeys) this.ticketKeys = options.ticketKeys;
    if (options.ALPNProtocols) convertALPNProtocols(options.ALPNProtocols, this);
    this.setSecureContext(options);
    this[kHandshakeTimeout] = options.handshakeTimeout || 120 * 1000;
    this[kSNICallback] = options.SNICallback;
    if (typeof this[kHandshakeTimeout] !== "number") throw invalidArgType("options.handshakeTimeout", "of type number", this[kHandshakeTimeout]);
    if (this[kSNICallback]) validateFunction(this[kSNICallback], "options.SNICallback");
    if (options.pskCallback) throw codeError(Error, "ERR_VISALJS_UNSUPPORTED", "TLS-PSK (pskCallback) is not supported by visaljs yet");
    if (listener) this.on("secureConnection", listener);
  }

  setSecureContext(options) {
    if (typeof options !== "object" || options === null) throw invalidArgType("options", "of type object", options);
    for (const k of ["pfx", "key", "passphrase", "cert", "clientCertEngine", "ca", "minVersion", "maxVersion", "secureProtocol", "crl", "ciphers", "dhparam"]) {
      this[k] = options[k] ? options[k] : undefined;
    }
    this.sigalgs = options.sigalgs;
    this.ecdhCurve = options.ecdhCurve;
    this.honorCipherOrder = options.honorCipherOrder !== undefined ? !!options.honorCipherOrder : true;
    this.secureOptions = options.secureOptions || undefined;
    this.sessionIdContext = options.sessionIdContext || undefined;
    if (options.sessionTimeout) this.sessionTimeout = options.sessionTimeout;
    if (options.ticketKeys) this.ticketKeys = options.ticketKeys;
    this.privateKeyIdentifier = options.privateKeyIdentifier;
    this.privateKeyEngine = options.privateKeyEngine;
    this.certificateCompression = options.certificateCompression;
    this._sharedCreds = createSecureContext({
      pfx: this.pfx, key: this.key, passphrase: this.passphrase, cert: this.cert, clientCertEngine: this.clientCertEngine, ca: this.ca,
      ciphers: this.ciphers, sigalgs: this.sigalgs, ecdhCurve: this.ecdhCurve, dhparam: this.dhparam, minVersion: this.minVersion,
      maxVersion: this.maxVersion, secureProtocol: this.secureProtocol, secureOptions: this.secureOptions,
      honorCipherOrder: this.honorCipherOrder, crl: this.crl, sessionIdContext: this.sessionIdContext, ticketKeys: this.ticketKeys,
      sessionTimeout: this.sessionTimeout, privateKeyIdentifier: this.privateKeyIdentifier, privateKeyEngine: this.privateKeyEngine,
      certificateCompression: this.certificateCompression,
    });
  }

  addContext(servername, context) {
    if (!servername) throw codeError(Error, "ERR_TLS_REQUIRED_SERVER_NAME", '"servername" is required parameter for Server.addContext');
    const re = new RegExp(`^${servername.replace(/([.^$+?\-\\[\]{}])/g, "\\$1").replaceAll("*", "[^.]*")}$`, "i");
    const secureContext = context instanceof SecureContext ? context : createSecureContext(context);
    this._contexts.push([re, secureContext]);
  }

  getTicketKeys() {
    return tlsContextTicketKeys(this._sharedCreds.context, null);
  }

  setTicketKeys(keys) {
    if (!ArrayBuffer.isView(keys)) throw invalidArgType("buffer", "an instance of Buffer, TypedArray, or DataView", keys);
    if (keys.byteLength !== 48) {
      throw codeError(Error, "ERR_INTERNAL_ASSERTION", "Session ticket keys must be a 48-byte buffer\nThis is caused by either a bug in Node.js " +
        "or incorrect usage of Node.js internals.\nPlease open an issue with this stack trace at https://github.com/nodejs/node/issues\n");
    }
    tlsContextTicketKeys(this._sharedCreds.context, keys);
  }
}

export const Server = callableClass(ServerClass, "Server");  /* Server(…) without new, as Node's */

export function createServer(options, listener) {
  return new Server(options, listener);
}

/* ---- connect ------------------------------------------------------------------------------------ */

function onConnectSecure() {
  const options = this[kConnectOptions];
  let verifyErr = this._verifyError();
  if (!verifyErr && !this.isSessionReused()) {
    const hostname = options.servername || options.host || options.socket?._host || "localhost";
    const cert = this.getPeerCertificate(true);
    verifyErr = options.checkServerIdentity(hostname, cert);
  }
  if (verifyErr) {
    this.authorized = false;
    this.authorizationError = verifyErr.code || verifyErr.message;
    if (options.rejectUnauthorized !== false) {
      this.destroy(verifyErr);
      return;
    }
  } else {
    this.authorized = true;
  }
  this.secureConnecting = false;
  this.emit("secureConnect");
  this[kIsVerified] = true;
  const session = this[kPendingSession];
  this[kPendingSession] = null;
  if (session) this.emit("session", session);
  this.removeListener("end", onConnectEnd);
}

function onConnectEnd() {
  if (!this._hadError) {
    const options = this[kConnectOptions];
    this._hadError = true;
    const error = connReset("Client network socket disconnected before secure TLS connection was established");
    error.path = options.path;
    error.host = options.host;
    error.port = options.port;
    error.localAddress = options.localAddress;
    this.destroy(error);
  }
}

/* connect(port[, host][, options][, cb]), connect(path[, options][, cb]), connect(options[, cb]) */
function normalizeConnectArgs(listArgs) {
  let options = {};
  const a0 = listArgs[0];
  if (typeof a0 === "object" && a0 !== null) options = { ...a0 };
  else if (typeof a0 === "string" && Number.isNaN(Number(a0))) options.path = a0;
  else {
    options.port = a0;
    if (listArgs.length > 1 && typeof listArgs[1] === "string") options.host = listArgs[1];
  }
  if (listArgs[1] !== null && typeof listArgs[1] === "object") Object.assign(options, listArgs[1]);
  else if (listArgs[2] !== null && typeof listArgs[2] === "object") Object.assign(options, listArgs[2]);
  const cb = listArgs[listArgs.length - 1];
  return [options, typeof cb === "function" ? cb : undefined];
}

let ipServernameWarned = false;

export function connect(...args) {
  let [options, cb] = normalizeConnectArgs(args);
  options = {
    rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
    ciphers: undefined,
    checkServerIdentity,
    minDHSize: 1024,
    ...options,
  };
  if (!options.keepAlive) options.singleUse = true;
  validateFunction(options.checkServerIdentity, "options.checkServerIdentity");
  if (typeof options.minDHSize !== "number") throw invalidArgType("options.minDHSize", "of type number", options.minDHSize);
  if (options.minDHSize < 1) throw outOfRange("options.minDHSize", ">= 1", options.minDHSize);
  if (options.pskCallback) throw codeError(Error, "ERR_VISALJS_UNSUPPORTED", "TLS-PSK (pskCallback) is not supported by visaljs yet");
  const context = options.secureContext || createSecureContext(options);
  const tlssock = new TLSSocket(options.socket, {
    allowHalfOpen: options.allowHalfOpen,
    pipe: !!options.path,
    secureContext: context,
    isServer: false,
    requestCert: true,
    rejectUnauthorized: options.rejectUnauthorized !== false,
    session: options.session,
    ALPNProtocols: options.ALPNProtocols,
    highWaterMark: options.highWaterMark,
    onread: options.onread,
  });
  options.rejectUnauthorized = options.rejectUnauthorized !== false;
  tlssock[kConnectOptions] = options;
  if (cb) tlssock.once("secureConnect", cb);
  if (!options.socket) {
    if (options.timeout) tlssock.setTimeout(options.timeout);
    tlssock.connect(options, tlssock._start);
  }
  tlssock._releaseControl();
  if (options.session) tlssock.setSession(options.session);
  if (options.servername) {
    if (!ipServernameWarned && isIP(options.servername)) {
      process.emitWarning("Setting the TLS ServerName to an IP address is not permitted by RFC 6066. This will be ignored in a future version.",
        "DeprecationWarning", "DEP0123");
      ipServernameWarned = true;
    }
    tlssock.setServername(options.servername);
  }
  if (options.socket) tlssock._start();
  tlssock.on("secure", onConnectSecure);
  tlssock.prependListener("end", onConnectEnd);
  return tlssock;
}

/* ---- checkServerIdentity (Node's lib/tls.js) ------------------------------------------------------ */

const unfqdn = (host) => host.replace(/[.]$/, "");
const splitHost = (host) => unfqdn(host).replace(/[A-Z]/g, (c) => String.fromCharCode(32 + c.charCodeAt(0))).split(".");

function check(hostParts, pattern, wildcards) {
  if (!pattern) return false;
  const patternParts = splitHost(pattern);
  if (hostParts.length !== patternParts.length) return false;
  if (patternParts.includes("")) return false;
  const isBad = (s) => /[^!-\u007F]/u.test(s);
  if (patternParts.some(isBad)) return false;
  for (let i = hostParts.length - 1; i > 0; i -= 1) if (hostParts[i] !== patternParts[i]) return false;
  const hostSubdomain = hostParts[0];
  const patternSubdomain = patternParts[0];
  const patternSubdomainParts = patternSubdomain.split("*", 3);
  if (patternSubdomainParts.length === 1 || patternSubdomain.includes("xn--")) return hostSubdomain === patternSubdomain;
  if (!wildcards) return false;
  if (patternSubdomainParts.length > 2) return false;
  if (patternParts.length <= 2) return false;
  const [prefix, suffix] = patternSubdomainParts;
  if (prefix.length + suffix.length > hostSubdomain.length) return false;
  if (!hostSubdomain.startsWith(prefix)) return false;
  if (!hostSubdomain.endsWith(suffix)) return false;
  return true;
}

// eslint-disable-next-line no-control-regex
const jsonStringPattern = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/;

function splitEscapedAltNames(altNames) {
  const result = [];
  let currentToken = "";
  let offset = 0;
  while (offset !== altNames.length) {
    const nextSep = altNames.indexOf(",", offset);
    const nextQuote = altNames.indexOf('"', offset);
    if (nextQuote !== -1 && (nextSep === -1 || nextQuote < nextSep)) {
      currentToken += altNames.substring(offset, nextQuote);
      const match = jsonStringPattern.exec(altNames.substring(nextQuote));
      if (!match) throw codeError(SyntaxError, "ERR_TLS_CERT_ALTNAME_FORMAT", "Invalid subject alternative name string");
      currentToken += JSON.parse(match[0]);
      offset = nextQuote + match[0].length;
    } else if (nextSep !== -1) {
      currentToken += altNames.substring(offset, nextSep);
      result.push(currentToken);
      currentToken = "";
      offset = nextSep + 2;
    } else {
      currentToken += altNames.substring(offset);
      offset = altNames.length;
    }
  }
  result.push(currentToken);
  return result;
}

/** An IP address in one form: IPv4 dotted; IPv6 compressed, lowercase (c-ares's canonicalizeIP) */
function canonicalizeIP(ip) {
  const v = isIP(ip);
  if (v === 4) return ip.split(".").map(Number).join(".");
  if (v !== 6) return undefined;
  let s = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1].split(".").map(Number);
    s = s.slice(0, v4.index) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  const words = groups.map((g) => parseInt(g, 16).toString(16));
  /* the longest run of two or more zero groups becomes "::" */
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (words[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === "0") j++;
    if (j - i > bestLen && j - i > 1) [best, bestLen] = [i, j - i];
    i = j;
  }
  if (best < 0) return words.join(":");
  return words.slice(0, best).join(":") + "::" + words.slice(best + bestLen).join(":");
}

export function checkServerIdentity(hostname, cert) {
  const subject = cert.subject;
  const altNames = cert.subjectaltname;
  const dnsNames = [];
  const ips = [];
  hostname = "" + hostname;
  const hostnameASCII = unfqdn(domainToASCII(hostname));
  if (altNames) {
    const splitAltNames = altNames.includes('"') ? splitEscapedAltNames(altNames) : altNames.split(", ");
    splitAltNames.forEach((name) => {
      if (name.startsWith("DNS:")) dnsNames.push(name.slice(4));
      else if (name.startsWith("IP Address:")) ips.push(canonicalizeIP(name.slice(11)));
    });
  }
  let valid = false;
  let reason = "Unknown reason";
  hostname = unfqdn(hostname);
  if (isIP(hostname)) {
    valid = ips.includes(canonicalizeIP(hostname));
    if (!valid) reason = `IP: ${hostname} is not in the cert's list: ` + ips.join(", ");
  } else if (dnsNames.length > 0 || subject?.CN) {
    const hostParts = splitHost(hostnameASCII);
    const wildcard = (pattern) => check(hostParts, pattern, true);
    if (dnsNames.length > 0) {
      valid = dnsNames.some(wildcard);
      if (!valid) reason = `Host: ${hostname}. is not in the cert's altnames: ${altNames}`;
    } else {
      const cn = subject.CN;
      if (Array.isArray(cn)) valid = cn.some(wildcard);
      else if (cn) valid = wildcard(cn);
      if (!valid) reason = `Host: ${hostname}. is not cert's CN: ${cn}`;
    }
  } else {
    reason = "Cert does not contain a DNS name";
  }
  if (!valid) {
    const err = codeError(Error, "ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames: " + reason);
    err.reason = reason;
    err.host = hostname;
    err.cert = cert;
    return err;
  }
}
