// node:net: TCP and Unix domain socket servers and sockets over the host
// primitives of node/src/host_net.c (libuv), following Node's lib/net.js: a Socket is a Duplex
// whose reads start and stop with backpressure, whose end() shuts the write side down, and which
// closes once both sides are done (allowHalfOpen: false ends the write side when the peer's
// ends). Host names go through dns.lookup; with several addresses, they are tried in turn, each
// for autoSelectFamilyAttemptTimeout ms (happy eyeballs, as Node's). Socket timeouts are
// unref'd timers, refreshed by activity. SocketAddress and BlockList are in
// internal/socketaddress.js.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import {
  errnoMessage, errnoName, netAddress, netBind, netCallback, netChmod, netClose, netConnect, netGuessHandle, netKeepAlive, netListen,
  loopNow, netFd, netNoDelay, netOpen, netOpenFd, netReadStart, netReadStop, netRef, netReset, netShutdown, netWrite, timerUnref,
} from "visaljs:host";
import { ADDRCONFIG, lookup } from "./dns.js";
import { EventEmitter } from "./events.js";
import { bindContext } from "./internal/async_context.js";
import { codeError, invalidArgType, invalidArgValue, outOfRange, validateFunction, validateString } from "./internal/errors.js";
import { isIP, isIPv4, isIPv6 } from "./internal/net.js";
import { BlockList, SocketAddress } from "./internal/socketaddress.js";
import { AbortError } from "./internal/streams/errors.js";
import { validateInt32 } from "./internal/streams/validators.js";
import { Duplex } from "./stream.js";
import { callableClass, feature, features, lazyClass, lazyFunction } from "./internal/features.js";

export { BlockList, isIP, isIPv4, isIPv6, SocketAddress };

/* host_net.c's events: cb(event, value) */
const NET_CONNECTION = 0, NET_READ = 1, NET_CONNECT = 2, NET_WRITE = 3, NET_SHUTDOWN = 4, NET_CLOSE = 5;
const UV_EOF = -4095;
const UV_EINVAL = -22;
const TIMEOUT_MAX = 2 ** 31 - 1;

/* ---- Node's error shapes ------------------------------------------------------------------- */

/** `read ECONNRESET` */
function errnoException(errno, syscall) {
  const code = errnoName(errno);
  const error = new Error(syscall + " " + code);
  error.errno = errno;
  error.code = code;
  error.syscall = syscall;
  return error;
}

/* " 127.0.0.1:80", " /tmp/a.sock" or "" */
const hostPort = (address, port) => (port && port > 0 ? " " + address + ":" + port : address ? " " + address : "");

/** `connect ECONNREFUSED 127.0.0.1:1` */
function exceptionWithHostPort(errno, syscall, address, port) {
  const code = errnoName(errno);
  const error = new Error(syscall + " " + code + hostPort(address, port));
  error.errno = errno;
  error.code = code;
  error.syscall = syscall;
  error.address = address;
  if (port) error.port = port;
  return error;
}

/** `listen EADDRINUSE: address already in use :::3000` */
function uvExceptionWithHostPort(errno, syscall, address, port) {
  const code = errnoName(errno);
  const error = new Error(syscall + " " + code + ": " + errnoMessage(errno) + hostPort(address, port));
  error.code = code;
  error.errno = errno;
  error.syscall = syscall;
  error.address = address;
  if (port) error.port = port;
  return error;
}

function validatePort(port, name = "Port", allowZero = true) {
  if ((typeof port !== "number" && typeof port !== "string") || (typeof port === "string" && port.trim().length === 0) ||
    +port !== (+port >>> 0) || port > 0xffff || (port === 0 && !allowZero)) {
    const shown = typeof port === "string" ? "type string ('" + port + "')" : typeof port === "number" ? "type number (" + port + ")" : String(port);
    throw codeError(RangeError, "ERR_SOCKET_BAD_PORT", name + " should be >= 0 and < 65536. Received " + shown + ".");
  }
  return +port;
}

/* for internal/net_bound.js (BoundSocket) */
features.net = { errnoException, exceptionWithHostPort, validatePort };

const toNumber = (x) => ((x = Number(x)) >= 0 ? x : false);
const isPipeName = (s) => typeof s === "string" && toNumber(s) === false;

const normalizedArgs = Symbol("normalizedArgs");

/* connect(options[, cb]), connect(port[, host][, cb]), connect(path[, cb]), and listen's: [options, cb] */
function normalizeArgs(args) {
  let options = {};
  if (args.length > 0) {
    const arg0 = args[0];
    if (typeof arg0 === "object" && arg0 !== null) options = arg0;
    else if (isPipeName(arg0)) options.path = arg0;
    else {
      options.port = arg0;
      if (args.length > 1 && typeof args[1] === "string") options.host = args[1];
    }
  }
  const cb = args[args.length - 1];
  const normalized = [options, typeof cb === "function" ? cb : null];
  normalized[normalizedArgs] = true;
  return normalized;
}

let autoSelectFamily = true;
let autoSelectFamilyAttemptTimeout = 250;
export const getDefaultAutoSelectFamily = () => autoSelectFamily;
export function setDefaultAutoSelectFamily(value) {
  if (typeof value !== "boolean") throw invalidArgType("value", "of type boolean", value);
  autoSelectFamily = value;
}
export const getDefaultAutoSelectFamilyAttemptTimeout = () => autoSelectFamilyAttemptTimeout;
export function setDefaultAutoSelectFamilyAttemptTimeout(value) {
  if (typeof value !== "number") throw invalidArgType("value", "of type number", value);
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw outOfRange("value", ">= 1 && <= 2147483647", value);
  autoSelectFamilyAttemptTimeout = value < 10 ? 10 : value;
}

/* a descriptor as a handle: Node's createHandle */
function handleForFd(fd, cb) {
  validateInt32(fd, "fd", 0);
  const type = netGuessHandle(fd);
  if (type !== "PIPE" && type !== "TCP") throw codeError(TypeError, "ERR_INVALID_FD_TYPE", "Unsupported fd type: " + type);
  return netOpen(type === "PIPE", bindContext(cb));
}

function validateBlockList(value, name) {
  if (value !== undefined && !BlockList.isBlockList(value)) throw invalidArgType(name, "an net.BlockList", value);
}

/* Node's ERR_INVALID_ADDRESS_FAMILY, with the host and port */
function addressFamilyError(addressType, host, port) {
  const err = codeError(RangeError, "ERR_INVALID_ADDRESS_FAMILY", "Invalid address family: " + addressType + " " + host + ":" + port);
  err.host = host;
  err.port = port;
  return err;
}

const ipBlocked = (ip) => codeError(Error, "ERR_IP_BLOCKED", "IP(" + ip + ") is blocked by net.BlockList");

/* ---- Socket -------------------------------------------------------------------------------- */

function onReadableStreamEnd() {
  if (!this.allowHalfOpen) this.write = writeAfterFIN;
}

/* the peer ended and so did we: writing fails, as Node's writeAfterFIN */
function writeAfterFIN(chunk, encoding, cb) {
  if (!this.writableEnded) return Duplex.prototype.write.call(this, chunk, encoding, cb);
  if (typeof encoding === "function") cb = encoding;
  const er = new Error("This socket has been ended by the other party");
  er.code = "EPIPE";
  if (typeof cb === "function") process.nextTick(cb, er);
  this.destroy(er);
  return false;
}

class SocketClass extends Duplex {
  constructor(options) {
    if (typeof options === "number") options = { fd: options };
    else options = { ...options };
    if (options.objectMode) throw invalidArgValue("options.objectMode", "is not supported", options.objectMode);
    if (options.readableObjectMode || options.writableObjectMode) {
      const name = options.readableObjectMode ? "readableObjectMode" : "writableObjectMode";
      throw invalidArgValue("options." + name, "is not supported", options[name]);
    }
    /* Node's: not half-open by default, 'close' emitted by the socket itself, strings written as given */
    const allowHalfOpen = Boolean(options.allowHalfOpen);
    super({ ...options, signal: undefined, allowHalfOpen, emitClose: false, autoDestroy: true, decodeStrings: false });
    /* the signal option, as Node's socket has it: aborted, the socket is destroyed with an AbortError
     * (one already aborted: on the next tick, once connect() has begun) */
    if (options.signal !== undefined) {
      const signal = options.signal;
      if (signal === null || typeof signal !== "object" || !("aborted" in signal)) throw invalidArgType("options.signal", "an instance of AbortSignal", signal);
      const onAbort = () => this.destroy(new AbortError(undefined, { cause: signal.reason }));
      if (signal.aborted) process.nextTick(onAbort);
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        this.once("close", () => signal.removeEventListener("abort", onAbort));
      }
    }
    this.connecting = false;
    this._hadError = false;
    this._handle = null;     /* the host handle's id while open */
    this._isPipe = false;
    this._host = null;
    this._peername = null;
    this._sockname = null;
    this._pendingData = null;
    this._pendingEncoding = "";
    this.server = null;
    this._server = null;
    this._reading = false;
    this._writeCallbacks = [];  /* callbacks of the writes still pending, in order */
    this._shutdownCallback = null;
    this._closeCallback = null;
    this._closingId = -1;
    this._resetAndClosing = false;
    this._bytesRead = 0;
    this._bytesDispatched = 0;
    this._noDelay = options.noDelay === true;
    this._keepAlive = options.keepAlive === true ? [true, ~~((options.keepAliveInitialDelay ?? 0) / 1000)] : null;
    this._unref = false;
    this._timer = null;         /* the timeout: an unref'd timer, re-armed for the idle time left when it fires */
    this._timerDue = 0;         /* when _timer fires (loopNow's clock) */
    this._timeoutMs = 0;        /* 0: off; a pending _timer then finds nothing to do */
    this._lastActive = 0;
    this._onread = null;
    if (options.typeOfService !== undefined) feature("validateTypeOfService")(options.typeOfService);
    this._tos = options.typeOfService;  /* internal/net_tos.js's: the type of service, set at connect when given before it */
    this._boundSource = false;  /* the handle is an adopted BoundSocket's */
    this._boundPath = undefined;  /* an adopted pipe BoundSocket's path, its local address */
    this._perfConnect = null;  /* a TCP connect's start, while a PerformanceObserver takes 'net' entries */  /* set at connect when given before it */
    this._onreadRest = null;  /* internal/net_onread.js's: the bytes read but not yet given when reading stopped */
    this.timeout = undefined;
    this.autoSelectFamilyAttemptedAddresses = undefined;
    validateBlockList(options.blockList, "options.blockList");
    this.blockList = options.blockList;
    const onread = options.onread;
    if (onread !== null && typeof onread === "object" && (typeof onread.buffer === "function" || onread.buffer instanceof Uint8Array) &&
      typeof onread.callback === "function") {
      feature("onread");  /* internal/net_onread.js's */
      this._onread = onread;
    }
    this.on("end", onReadableStreamEnd);
    /* an adopted BoundSocket's handle: bound, not yet connected, so not read until it is */
    const bound = options.handle !== undefined ? features.adoptBoundSocket?.(options.handle) : null;
    if (bound) {
      const { id, path } = bound;
      this._handle = id;
      this._boundSource = true;
      this._isPipe = path !== undefined;
      netCallback(id, bindContext((event, value) => this._onEvent(event, value, id)));
      if (path !== undefined) {
        this._boundPath = path;
        /* a pipe's bind leaves its stream unopened: opened on its own descriptor, as Node's */
        const fd = netFd(id);
        if (fd >= 0) {
          const err = netOpenFd(id, fd);
          if (err) throw errnoException(err, "open");
        }
      }
    } else if (options.handle !== undefined) {
      const id = options.handle;
      this._isPipe = !!options._isPipe;
      this._attach(id);
      netCallback(id, bindContext((event, value) => this._onEvent(event, value, id)));
    } else if (options.fd !== undefined) {
      const fd = options.fd;
      if (typeof fd !== "number") throw invalidArgType("options.fd", "of type number", fd);
      let id;
      id = handleForFd(fd, (event, value) => this._onEvent(event, value, id));
      this._isPipe = netGuessHandle(fd) === "PIPE";
      const err = netOpenFd(id, fd);
      if (err) {
        netClose(id);
        throw errnoException(err, "open");
      }
      this._attach(id);
    }
    if (this._handle !== null && !bound && options.readable !== false) {
      if (options.pauseOnCreate) this._readableState.flowing = false;
      else if (!options.manualStart) this.read(0);
    }
  }

  _attach(id) {
    this._handle = id;
    if (this._noDelay) netNoDelay(id, true);
    if (this._keepAlive) netKeepAlive(id, true, this._keepAlive[1]);
    if (this._unref) netRef(id, false);
  }

  /* the handle's events; reads only from the socket's current handle, 'close' from the one it closed */
  _onEvent(event, value, id) {
    switch (event) {
      case NET_READ:
        if (id === this._handle) this._onRead(value);
        break;
      case NET_WRITE: {
        const cb = this._writeCallbacks.shift();
        if (cb) cb(value);
        break;
      }
      case NET_SHUTDOWN: {
        const cb = this._shutdownCallback;
        this._shutdownCallback = null;
        if (cb) cb(value);
        break;
      }
      case NET_CLOSE: {
        if (id !== this._closingId) break;
        const cb = this._closeCallback;
        this._closeCallback = null;
        if (cb) cb();
        break;
      }
    }
  }

  /* Node's onStreamRead: bytes are pushed (reading stops when the buffer is full), or with
   * `onread` copied into its buffer; EOF pushes null */
  _onRead(value) {
    if (this.destroyed) return;
    if (typeof value !== "number") {
      this._bytesRead += value.byteLength;
      this._unrefTimer();
      let more;
      if (this._onread) more = features.onread.deliver(this, value);
      else more = this.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      if (!more) {
        this._reading = false;
        if (this._handle !== null) {
          const err = netReadStop(this._handle);
          if (err) this.destroy(errnoException(err, "read"));
        }
      }
      return;
    }
    this._reading = false;
    if (value !== UV_EOF) {
      this.destroy(errnoException(value, "read"));
      return;
    }
    if (this._onread) features.onread.eof(this);
    this.push(null);
    this.read(0);
  }

  /* with onread, pausing stops reading from the handle and resuming starts it, as Node's */
  pause() {
    if (this._onread) features.onread.pause(this);
    return super.pause();
  }

  resume() {
    if (this._onread) features.onread.resume(this);
    return super.resume();
  }

  /* reading from the handle again (with onread, the bytes left from the last read first) */
  _startReading() {
    this._reading = true;
    if (this._onreadRest) {
      features.onread.rest(this);
      return;
    }
    const err = netReadStart(this._handle);
    if (err) this.destroy(errnoException(err, "read"));
  }

  get pending() {
    return this._handle === null || this.connecting;
  }

  get readyState() {
    if (this.connecting) return "opening";
    if (this.readable && this.writable) return "open";
    if (this.readable && !this.writable) return "readOnly";
    if (!this.readable && this.writable) return "writeOnly";
    return "closed";
  }

  get bufferSize() {
    return this._handle !== null || this.connecting ? this.writableLength : undefined;
  }

  get _connecting() {
    return this.connecting;
  }

  get bytesRead() {
    return this._bytesRead;
  }

  /* Node's: what was sent, and what's still buffered (undefined on the prototype) */
  get bytesWritten() {
    const writableBuffer = this.writableBuffer;
    if (!writableBuffer) return undefined;
    let bytes = this._bytesDispatched;
    for (const el of writableBuffer) bytes += typeof el.chunk === "string" ? Buffer.byteLength(el.chunk, el.encoding) : el.chunk.length;
    const data = this._pendingData;
    if (Array.isArray(data)) {
      for (const el of data) bytes += typeof el.chunk === "string" ? Buffer.byteLength(el.chunk, el.encoding) : el.chunk.length;
    } else if (data) {
      bytes += typeof data === "string" ? Buffer.byteLength(data, this._pendingEncoding) : data.length;
    }
    return bytes;
  }

  /* a pipe's ends have no address object: Node's Pipe has no getpeername/getsockname;
   * once closed, the address read while connected */
  _getpeername() {
    if (this._handle === null || this._isPipe || this.connecting) return this._peername || {};
    if (!this._peername) {
      const a = netAddress(this._handle, true);
      if (typeof a === "number") return {};
      this._peername = { address: a[0], family: a[1], port: a[2] };
    }
    return this._peername;
  }

  _getsockname() {
    if (this._boundPath !== undefined) return { address: this._boundPath };
    if (this._handle === null || this._isPipe) return this._sockname || {};
    if (!this._sockname) {
      const a = netAddress(this._handle, false);
      if (typeof a === "number") return {};
      this._sockname = { address: a[0], family: a[1], port: a[2] };
    }
    return this._sockname;
  }

  get remoteAddress() {
    return this._getpeername().address;
  }

  get remoteFamily() {
    return this._getpeername().family;
  }

  get remotePort() {
    return this._getpeername().port;
  }

  get localAddress() {
    return this._getsockname().address;
  }

  get localFamily() {
    return this._getsockname().family;
  }

  get localPort() {
    return this._getsockname().port;
  }

  address() {
    return this._getsockname();
  }

  setNoDelay(enable) {
    const on = enable === undefined ? true : !!enable;
    this._noDelay = on;
    if (this._handle !== null) netNoDelay(this._handle, on);
    return this;
  }

  setKeepAlive(enable, initialDelay) {
    const on = !!enable;
    const seconds = ~~((initialDelay ?? 0) / 1000);
    this._keepAlive = on ? [true, seconds] : null;
    if (this._handle !== null) netKeepAlive(this._handle, on, seconds);
    return this;
  }

  /* setTimeout(msecs[, callback]): 'timeout' after msecs without activity (0 turns it off) */
  setTimeout(msecs, callback) {
    if (this.destroyed) return this;
    this.timeout = msecs;
    if (typeof msecs !== "number") throw invalidArgType("msecs", "of type number", msecs);
    if (!(msecs >= 0 && msecs !== Infinity)) throw outOfRange("msecs", "a non-negative finite number", msecs);
    if (msecs > TIMEOUT_MAX) msecs = TIMEOUT_MAX;
    /* the pending timer stays when it fires no later than the new deadline: _onTimer re-arms it
     * for the rest, so a keep-alive socket, off for each request and on after it, sets no timer */
    if (msecs === 0) {
      this._timeoutMs = 0;
      if (callback !== undefined) {
        validateFunction(callback, "callback");
        this.removeListener("timeout", callback);
      }
    } else {
      this._timeoutMs = msecs;
      this._lastActive = loopNow();
      if (this._timer !== null && this._timerDue > this._lastActive + msecs) this._stopTimer();
      if (this._timer === null) this._armTimeout(msecs);
      if (callback !== undefined) {
        validateFunction(callback, "callback");
        this.once("timeout", callback);
      }
    }
    return this;
  }

  _armTimeout(ms) {
    this._timerDue = loopNow() + ms;
    this._timer = timerUnref(() => this._onTimer(), ms);
  }

  _onTimer() {
    this._timer = null;
    if (this._timeoutMs === 0) return;
    const idle = loopNow() - this._lastActive;
    if (idle < this._timeoutMs - 1) this._armTimeout(this._timeoutMs - idle);
    else this.emit("timeout");
  }

  _stopTimer() {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
  }

  _clearTimeout() {
    this._stopTimer();
    this._timeoutMs = 0;
  }

  /* activity: the timeout counts from now (Node's timer.refresh(), which re-arms a fired one) */
  _unrefTimer() {
    if (this._timeoutMs) {
      this._lastActive = loopNow();
      if (this._timer === null) this._armTimeout(this._timeoutMs);
    }
  }

  ref() {
    this._unref = false;
    if (this._handle !== null) netRef(this._handle, true);
    return this;
  }

  unref() {
    this._unref = true;
    if (this._handle !== null) netRef(this._handle, false);
    return this;
  }

  _read(n) {
    if (this.connecting || this._handle === null) this.once("connect", () => this._read(n));
    else if (!this._reading) this._startReading();
  }

  /* Node's _writeGeneric: a write before the connection waits for it; a write the kernel takes at
   * once calls back synchronously, as Node's does */
  _write(data, encoding, cb) {
    if (this.connecting) {
      this._pendingData = data;
      this._pendingEncoding = encoding;
      const onClose = () => cb(codeError(Error, "ERR_SOCKET_CLOSED_BEFORE_CONNECTION", "Socket closed before the connection was established"));
      this.once("connect", () => {
        this.off("close", onClose);
        this._write(data, encoding, cb);
      });
      this.once("close", onClose);
      return;
    }
    this._pendingData = null;
    if (this._handle === null) {
      cb(codeError(Error, "ERR_SOCKET_CLOSED", "Socket is closed"));
      return;
    }
    this._unrefTimer();
    const bytes = typeof data === "string" ? Buffer.from(data, encoding) : data;
    const r = netWrite(this._handle, bytes);
    if (r < 0) {
      this.destroy(errnoException(r, "write"), cb);
      return;
    }
    this._bytesDispatched += bytes.length;
    if (r === 0) {
      cb();
      return;
    }
    this._writeCallbacks.push((status) => {
      if (this.destroyed) cb(null);
      else if (status < 0) cb(errnoException(status, "write"));
      else {
        this._unrefTimer();
        cb();
      }
    });
  }

  /* end(): shut the write side down once the writes are out */
  _final(cb) {
    if (this.connecting) {
      this.once("connect", () => this._final(cb));
      return;
    }
    if (this._handle === null) {
      cb();
      return;
    }
    const err = netShutdown(this._handle);
    if (err < 0 && errnoName(err) === "ENOTCONN") cb();  /* by name: libuv's code differs by platform */
    else if (err < 0) cb(errnoException(err, "shutdown"));
    else this._shutdownCallback = () => cb();
  }

  _destroy(exception, cb) {
    this.connecting = false;
    this._clearTimeout();
    if (this._handle !== null) {
      const isException = !!exception;
      const id = this._handle;
      this._closeCallback = () => this.emit("close", isException);
      this._closingId = id;
      if (this._resetAndClosing) {
        this._resetAndClosing = false;
        const err = netReset(id);
        if (err) {
          this.emit("error", errnoException(err, "reset"));
          netClose(id);
        }
      } else {
        netClose(id);
      }
      this._handle = null;
      this._sockname = null;
      cb(exception);
    } else {
      cb(exception);
      process.nextTick(() => this.emit("close"));
    }
    if (this._server) {
      this._server._connections--;
      this._server._emitCloseIfDrained();
    }
  }

  destroySoon() {
    if (this.writable) this.end();
    if (this.writableFinished) this.destroy();
    else this.once("finish", this.destroy);
  }

  /* close with a TCP RST instead of a FIN */
  resetAndDestroy() {
    if (this._handle !== null || this.connecting) {
      if (this._isPipe) throw codeError(TypeError, "ERR_INVALID_HANDLE_TYPE", "This handle type cannot be sent");
      if (this.connecting) this.once("connect", () => this._reset());
      else this._reset();
    } else {
      this.destroy(codeError(Error, "ERR_SOCKET_CLOSED", "Socket is closed"));
    }
    return this;
  }

  _reset() {
    this._resetAndClosing = true;
    return this.destroy();
  }

  end(data, encoding, callback) {
    Duplex.prototype.end.call(this, data, encoding, callback);
    return this;
  }

  connect(...args) {
    const [options, cb] = args[0] && args[0][normalizedArgs] ? args[0] : normalizeArgs(args);
    if (this.write !== Socket.prototype.write) this.write = Socket.prototype.write;
    if (options.port === undefined && options.path == null) {
      throw codeError(TypeError, "ERR_MISSING_ARGS", 'The "options" or "port" or "path" argument must be specified');
    }
    /* a closed socket connects again, as Node's: its streams undestroyed, its counts the new handle's */
    if (this.destroyed) {
      this._handle = null;
      this._peername = null;
      this._sockname = null;
      this._bytesRead = 0;
      this._bytesDispatched = 0;
      this._hadError = false;
      this._perfConnect = null;
      this._undestroy();
    }
    const { path } = options;
    if (cb !== null) this.once("connect", cb);
    this._unrefTimer();
    this.connecting = true;
    /* an adopted handle is a pipe or not whatever the options say; once it's gone, the path does */
    const pipe = this._boundSource && this._handle !== null ? this._isPipe : !!path;
    if (pipe) {
      validateString(path, "options.path");
      this._isPipe = true;
      this._internalConnect(path);
    } else {
      this._lookupAndConnect(options);
    }
    return this;
  }

  _lookupAndConnect(options) {
    const { localAddress, localPort } = options;
    const host = options.host || "localhost";
    let { port, autoSelectFamilyAttemptTimeout: attemptTimeout, autoSelectFamily: selectFamily } = options;
    if (localAddress && !isIP(localAddress)) throw codeError(TypeError, "ERR_INVALID_IP_ADDRESS", "Invalid IP address: " + localAddress);
    if (localPort && typeof localPort !== "number") throw invalidArgType("options.localPort", "of type number", localPort);
    if (typeof host !== "string") throw invalidArgType("options.host", "of type string", host);
    if (host.includes("\0")) throw invalidArgValue("options.host", "must be a string without null bytes", host);
    /* an adopted BoundSocket owns the local end and the address family */
    if (this._boundSource) {
      if (localAddress !== undefined || localPort !== undefined) {
        throw invalidArgValue("options", "localAddress and localPort cannot be used with an adopted bound socket", options);
      }
      selectFamily = false;
    }
    if (typeof port !== "undefined") {
      if (typeof port !== "number" && typeof port !== "string") throw invalidArgType("options.port", "of type number or string", port);
      port = validatePort(port);
    }
    port |= 0;
    if (selectFamily != null && typeof selectFamily !== "boolean") throw invalidArgType("options.autoSelectFamily", "of type boolean", selectFamily);
    selectFamily ??= autoSelectFamily;
    if (attemptTimeout != null) {
      validateInt32(attemptTimeout, "options.autoSelectFamilyAttemptTimeout", 1);
      if (attemptTimeout < 10) attemptTimeout = 10;
    } else {
      attemptTimeout = autoSelectFamilyAttemptTimeout;
    }
    this._host = host;
    const addressType = isIP(host);
    /* an adopted BoundSocket connects in this tick, so its local address is known at once (a
     * failure still comes as an 'error' event) */
    if (addressType && this._boundSource) {
      this._internalConnect(host, port, addressType, localAddress, localPort);
      return;
    }
    if (addressType) {
      process.nextTick(() => {
        if (this.connecting) this._internalConnect(host, port, addressType, localAddress, localPort);
      });
      return;
    }
    let family = options.family ?? 0;
    if (family === "IPv4") family = 4;
    else if (family === "IPv6") family = 6;
    const lookupFn = options.lookup ?? lookup;
    if (typeof lookupFn !== "function") throw invalidArgType("options.lookup", "of type function", lookupFn);
    const dnsopts = { family, hints: options.hints || 0, all: false };
    if (process.platform !== "win32" && family !== 4 && family !== 6 && dnsopts.hints === 0) dnsopts.hints = ADDRCONFIG;
    dnsopts.all = family !== 4 && family !== 6 && !localAddress && selectFamily;
    if (!dnsopts.all) {
      lookupFn(host, dnsopts, (err, ip, addressType) => {
        this.emit("lookup", err, ip, addressType, host);
        if (!this.connecting) return;
        if (err) process.nextTick(() => this.destroy(err));
        else if (typeof ip !== "string" || !isIP(ip)) process.nextTick(() => this.destroy(codeError(TypeError, "ERR_INVALID_IP_ADDRESS", "Invalid IP address: " + ip)));
        else if (addressType !== 4 && addressType !== 6) {
          process.nextTick(() => this.destroy(addressFamilyError(addressType, host, options.port)));
        } else {
          this._unrefTimer();
          this._internalConnect(ip, port, addressType, localAddress, localPort);
        }
      });
      return;
    }
    lookupFn(host, dnsopts, (err, addresses) => {
      if (!this.connecting) return;
      if (err) {
        this.emit("lookup", err, undefined, undefined, host);
        process.nextTick(() => this.destroy(err));
        return;
      }
      /* the first address's family first, then alternating, each address once */
      const byFamily = [[], []];
      let order;
      for (const { address, family } of addresses) {
        this.emit("lookup", null, address, family, host);
        if (!this.connecting) return;
        if (isIP(address) && (family === 4 || family === 6)) {
          order ||= family === 6 ? { 6: 0, 4: 1 } : { 4: 0, 6: 1 };
          const list = byFamily[order[family]];
          if (!list.some((a) => a.address === address)) list.push({ address, family });
        }
      }
      if (!byFamily[0].length && !byFamily[1].length) {
        const first = addresses[0];
        const error = !first || !isIP(first.address)
          ? codeError(TypeError, "ERR_INVALID_IP_ADDRESS", "Invalid IP address: " + first?.address)
          : addressFamilyError(first.family, host, options.port);
        process.nextTick(() => this.destroy(error));
        return;
      }
      const toAttempt = [];
      for (let i = 0; i < Math.max(byFamily[0].length, byFamily[1].length); i++) {
        if (i in byFamily[0]) toAttempt.push(byFamily[0][i]);
        if (i in byFamily[1]) toAttempt.push(byFamily[1][i]);
      }
      this._unrefTimer();
      if (toAttempt.length === 1) {
        const { address, family } = toAttempt[0];
        process.nextTick(() => {
          if (this.connecting) this._internalConnect(address, port, family, localAddress, localPort);
        });
        return;
      }
      this.autoSelectFamilyAttemptedAddresses = [];
      const context = { addresses: toAttempt, current: 0, port, localPort, timeout: attemptTimeout, timer: null, errors: [] };
      process.nextTick(() => this._connectMultiple(context));
    });
  }

  /* a new handle bound to the local address, if any, and connecting: 0 or the failure as Node reports it */
  _open(address, port, addressType, localAddress, localPort, onConnect) {
    let id;
    const cb = bindContext((event, value) => {
      if (event === NET_CONNECT) {
        if (this._handle === id) onConnect(value, id);
      } else {
        this._onEvent(event, value, id);
      }
    });
    if (this._boundSource && this._handle !== null) {  /* an adopted BoundSocket's, already bound */
      id = this._handle;
      netCallback(id, cb);
    } else {
      id = netOpen(this._isPipe, cb);
      this._handle = id;
    }
    if (!this._isPipe && this._perfConnect === null && features.perfObserving?.("net")) {
      this._perfConnect = { start: features.perfNow(), host: address, port };
    }
    if (!this._isPipe && (localAddress || localPort)) {
      localAddress ||= addressType === 4 ? "0.0.0.0" : "::";
      const err = netBind(id, localAddress, localPort | 0, 0);
      if (err) return exceptionWithHostPort(err, "bind", localAddress, localPort);
    }
    const err = netConnect(id, address, port);
    if (err) return exceptionWithHostPort(err, "connect", address, port);
    return null;
  }

  _internalConnect(address, port, addressType, localAddress, localPort) {
    if (!this._isPipe && this.blockList?.check(address, "ipv" + addressType)) {
      this.destroy(ipBlocked(address));
      return;
    }
    const ex = this._open(address, port, addressType, localAddress, localPort, (status) => this._afterConnect(status, address, port));
    if (ex) this.destroy(ex);
  }

  /* happy eyeballs: each address in turn, the next one after `timeout` ms */
  _connectMultiple(context, canceled) {
    clearTimeout(context.timer);
    if (!this.connecting) return;
    if (canceled || context.current === context.addresses.length) {
      if (context.errors.length === 0) {
        this.destroy(codeError(Error, "ERR_SOCKET_CONNECTION_TIMEOUT", "Socket connection timeout"));
        return;
      }
      const error = new AggregateError(context.errors);
      error.code = context.errors[0].code;
      this.destroy(error);
      return;
    }
    const { address, family } = context.addresses[context.current++];
    const { port, localPort } = context;
    if (this.blockList?.check(address, "ipv" + family)) {
      this.destroy(ipBlocked(address));
      return;
    }
    this.autoSelectFamilyAttemptedAddresses.push(address + ":" + port);
    this.emit("connectionAttempt", address, port, family);
    const failed = (ex) => {
      context.errors.push(ex);
      this.emit("connectionAttemptFailed", address, port, family, ex);
      this._connectMultiple(context);
    };
    const localAddress = localPort ? (family === 4 ? "0.0.0.0" : "::") : undefined;
    const ex = this._open(address, port, family, localAddress, localPort, (status, id) => {
      clearTimeout(context.timer);
      if (status === 0) {
        this._afterConnect(0, address, port);
        return;
      }
      this._handle = null;
      netClose(id);
      failed(exceptionWithHostPort(status, "connect", address, port));
    });
    if (ex) {
      netClose(this._handle);
      this._handle = null;
      failed(ex);
      return;
    }
    if (context.current < context.addresses.length) {
      const id = this._handle;
      context.timer = setTimeout(() => {
        if (!this.connecting || this._handle !== id) return;
        this.emit("connectionAttemptTimeout", address, port, family);
        this._handle = null;
        netClose(id);
        this._connectMultiple(context);
      }, context.timeout);
    }
  }

  _afterConnect(status, address, port) {
    if (this.destroyed) return;
    this.connecting = false;
    this._sockname = null;
    if (status !== 0) {
      this.destroy(exceptionWithHostPort(status, "connect", address, port));
      return;
    }
    this._attach(this._handle);
    this._unrefTimer();
    if (this._perfConnect !== null) {
      const { start, host, port } = this._perfConnect;
      this._perfConnect = null;
      features.perfObserve(features.perfEntry("connect", "net", start, features.perfNow() - start, { host, port }));
    }
    if (this._tos !== undefined && !this._isPipe) features.applyTypeOfService(this);
    this.emit("connect");
    this.emit("ready");
    if (this.readable && !this.isPaused()) this.read(0);
  }
}
/* internal/net_tos.js's, linked when the program names them */
SocketClass.prototype.setTypeOfService = lazyFunction("setTypeOfService", 1);
SocketClass.prototype.getTypeOfService = lazyFunction("getTypeOfService");
export const Socket = callableClass(SocketClass, "Socket");  /* Socket(…) without new, as Node's */

export const Stream = Socket;

/* ---- Server -------------------------------------------------------------------------------- */

class ServerClass extends EventEmitter {
  constructor(options, connectionListener) {
    super();
    if (typeof options === "function") {
      connectionListener = options;
      options = {};
    } else if (options === undefined || options === null) {
      options = {};
    } else if (typeof options !== "object") {
      throw invalidArgType("options", "of type object", options);
    }
    if (typeof connectionListener === "function") this.on("connection", connectionListener);
    this._connections = 0;
    this._listeningId = 1;  /* a listen or close since a lookup began makes the lookup's result stale */
    this._handle = null;
    this._isPipe = false;
    this._pipeName = undefined;
    this._unref = false;
    this.allowHalfOpen = options.allowHalfOpen || false;
    this.pauseOnConnect = !!options.pauseOnConnect;
    this.noDelay = Boolean(options.noDelay);
    this.keepAlive = Boolean(options.keepAlive);
    this.keepAliveInitialDelay = ~~((options.keepAliveInitialDelay ?? 0) / 1000);
    validateBlockList(options.blockList, "options.blockList");
    this.blockList = options.blockList;
  }

  get listening() {
    return this._handle !== null;
  }

  /* listen([port[, host[, backlog]]][, cb]), listen(path[, backlog][, cb]), listen(options[, cb]),
   * listen(handle[, backlog][, cb]): a Server's or Socket's, or { fd } */
  listen(...args) {
    let [options, cb] = normalizeArgs(args);
    if (typeof options.callback === "function") cb = options.callback;
    if (this._handle !== null) throw codeError(Error, "ERR_SERVER_ALREADY_LISTEN", "Listen method has been called more than once without closing.");
    if (cb !== null) this.once("listening", cb);
    this._listeningId++;
    const backlogFromArgs = toNumber(args.length > 1 && args[1]) || toNumber(args.length > 2 && args[2]);
    /* listen(boundSocket) or listen({ handle: boundSocket }): the server takes its handle */
    const bound = features.adoptBoundSocket?.(options) ?? features.adoptBoundSocket?.(options.handle);
    if (bound) {
      if (bound.path !== undefined) this._pipeName = bound.path;
      this._isPipe = bound.path !== undefined;
      this._setupListen(null, -1, -1, backlogFromArgs, undefined, 0, bound.id);
      return this;
    }
    if (options._handle !== undefined && options._handle !== null) options = options._handle;
    else if (options.handle !== undefined && options.handle !== null) options = options.handle;
    const flags = (options.ipv6Only ? 1 : 0) | (options.reusePort ? 2 : 0);
    if (options.signal !== undefined) this._addAbortSignal(options.signal);
    if (typeof options === "number") {  /* another Server's or Socket's handle */
      this._setupListen(null, -1, -1, backlogFromArgs, undefined, 0, options);
      return this;
    }
    if (typeof options.fd === "number" && options.fd >= 0) {
      this._setupListen(null, null, null, backlogFromArgs, options.fd, 0);
      return this;
    }
    if (args.length === 0 || typeof args[0] === "function" || (typeof options.port === "undefined" && "port" in options) || options.port === null) {
      options.port = 0;
    }
    if (typeof options.port === "number" || typeof options.port === "string") {
      validatePort(options.port, "options.port");
      const backlog = options.backlog || backlogFromArgs;
      if (options.host) this._lookupAndListen(options.port | 0, options.host, backlog, flags);
      else this._setupListen(null, options.port | 0, 4, backlog, undefined, flags);
      return this;
    }
    if (options.path && isPipeName(options.path)) {
      this._pipeName = options.path;
      this._setupListen(this._pipeName, -1, -1, options.backlog || backlogFromArgs, undefined, 0);
      if (this._handle === null) return this;
      const mode = (options.readableAll === true ? 1 : 0) | (options.writableAll === true ? 2 : 0);
      if (mode !== 0) {
        const err = netChmod(this._handle, mode);
        if (err) {
          netClose(this._handle);
          this._handle = null;
          throw errnoException(err, "uv_pipe_chmod");
        }
      }
      return this;
    }
    if (!("port" in options || "path" in options)) throw invalidArgValue("options", 'must have the property "port" or "path"', options);
    throw invalidArgValue("options", "is invalid", options);
  }

  _addAbortSignal(signal) {
    if (signal === null || typeof signal !== "object" || !("aborted" in signal)) throw invalidArgType("options.signal", "an instance of AbortSignal", signal);
    const onAborted = () => this.close();
    if (signal.aborted) process.nextTick(onAborted);
    else {
      signal.addEventListener("abort", onAborted, { once: true });
      this.once("close", () => signal.removeEventListener("abort", onAborted));
    }
  }

  _lookupAndListen(port, address, backlog, flags) {
    const listeningId = this._listeningId;
    lookup(address, (err, ip, addressType) => {
      if (listeningId !== this._listeningId) return;
      if (err) this.emit("error", err);
      else this._setupListen(ip, port, ip ? addressType : 4, backlog, undefined, flags);
    });
  }

  /* Node's createServerHandle: a handle, bound; -errno when it can't be */
  _createHandle(address, port, addressType, fd, flags) {
    let id;
    const cb = (event, value) => {
      if (event === NET_CONNECTION && this._handle === id) this._onConnection(value);
    };
    let isTCP = false;
    if (typeof fd === "number" && fd >= 0) {
      try {
        id = handleForFd(fd, cb);
      } catch {
        return UV_EINVAL;
      }
      this._isPipe = netGuessHandle(fd) === "PIPE";
      const err = netOpenFd(id, fd);
      if (err) {
        netClose(id);
        return err;
      }
    } else if (port === -1 && addressType === -1) {
      id = netOpen(true, bindContext(cb));
      this._isPipe = true;
    } else {
      id = netOpen(false, bindContext(cb));
      this._isPipe = false;
      isTCP = true;
    }
    if (address || port || isTCP) {
      let err;
      if (!address) {  /* IPv6 first, dual-stack; IPv4 when there's no IPv6 */
        err = netBind(id, "::", port, flags);
        if (err) {
          netClose(id);
          return this._createHandle("0.0.0.0", port, 4, undefined, 0);
        }
      } else {
        err = netBind(id, address, port, addressType === 6 ? flags : flags & 2);
      }
      if (err) {
        netClose(id);
        return err;
      }
    }
    return id;
  }

  /* Node's setupListenHandle */
  _setupListen(address, port, addressType, backlog, fd, flags, existing) {
    let id;
    if (existing !== undefined) {
      id = existing;
      netCallback(id, bindContext((event, value) => {
        if (event === NET_CONNECTION && this._handle === id) this._onConnection(value);
      }));
    } else {
      let rval = null;
      if (!address && typeof fd !== "number") {
        rval = this._createHandle("::", port, 6, fd, flags);
        if (rval < 0) {
          rval = null;
          address = "0.0.0.0";
          addressType = 4;
        } else {
          address = "::";
          addressType = 6;
        }
      }
      if (rval === null) rval = this._createHandle(address, port, addressType, fd, flags);
      if (rval < 0) {
        const error = uvExceptionWithHostPort(rval, "listen", address, port);
        process.nextTick(() => this.emit("error", error));
        return;
      }
      id = rval;
    }
    this._handle = id;
    const err = netListen(id, backlog || 511);
    if (err) {
      const ex = uvExceptionWithHostPort(err, "listen", address, port);
      netClose(id);
      this._handle = null;
      process.nextTick(() => this.emit("error", ex));
      return;
    }
    this._connectionKey = addressType + ":" + address + ":" + port;
    if (this._unref) netRef(id, false);
    process.nextTick(() => {
      if (this._handle !== null) this.emit("listening");
    });
  }

  _onConnection(value) {
    if (value < 0) {
      this.emit("error", errnoException(value, "accept"));
      return;
    }
    if (this.maxConnections != null && this._connections >= this.maxConnections) {
      if (this._isPipe) this.emit("drop");
      else {
        const data = { __proto__: null };
        const local = netAddress(value, false), remote = netAddress(value, true);
        if (typeof local !== "number") [data.localAddress, data.localFamily, data.localPort] = local;
        if (typeof remote !== "number") [data.remoteAddress, data.remoteFamily, data.remotePort] = remote;
        this.emit("drop", data);
      }
      netClose(value);
      return;
    }
    if (this.blockList && !this._isPipe) {
      const remote = netAddress(value, true);
      const addressType = typeof remote === "number" ? 0 : isIP(remote[0]);
      if (addressType && this.blockList.check(remote[0], "ipv" + addressType)) {
        netClose(value);
        return;
      }
    }
    const socket = new Socket({
      handle: value, _isPipe: this._isPipe, allowHalfOpen: this.allowHalfOpen, pauseOnCreate: this.pauseOnConnect, readable: true, writable: true,
      noDelay: this.noDelay, keepAlive: this.keepAlive, keepAliveInitialDelay: this.keepAliveInitialDelay * 1000,
    });
    this._connections++;
    socket.server = this;
    socket._server = this;
    this.emit("connection", socket);
  }

  /* { address, family, port }, or a pipe's path */
  address() {
    if (this._handle !== null) {
      const a = netAddress(this._handle, false);
      if (typeof a === "string") return a;
      return typeof a === "number" ? {} : { address: a[0], family: a[1], port: a[2] };
    }
    if (this._pipeName) return this._pipeName;
    return null;
  }

  /* close([cb]): stop accepting; 'close' once the open connections end too */
  close(cb) {
    this._listeningId++;
    if (typeof cb === "function") {
      if (this._handle === null) this.once("close", () => cb(codeError(Error, "ERR_SERVER_NOT_RUNNING", "Server is not running.")));
      else this.once("close", cb);
    }
    if (this._handle !== null) {
      netClose(this._handle);
      this._handle = null;
    }
    this._emitCloseIfDrained();
    return this;
  }

  /* captureRejections: a 'connection' listener's rejection destroys the socket, as Node's */
  [Symbol.for("nodejs.rejection")](err, event, sock) {
    if (event === "connection") sock.destroy(err);
    else this.emit("error", err);
  }

  _emitCloseIfDrained() {
    if (this._handle !== null || this._connections) return;
    process.nextTick(() => this.emit("close"));
  }

  getConnections(cb) {
    process.nextTick(cb, null, this._connections);
    return this;
  }

  ref() {
    this._unref = false;
    if (this._handle !== null) netRef(this._handle, true);
    return this;
  }

  unref() {
    this._unref = true;
    if (this._handle !== null) netRef(this._handle, false);
    return this;
  }

  [Symbol.asyncDispose]() {
    if (this._handle === null) return Promise.resolve();
    return new Promise((resolve, reject) => this.close((err) => (err ? reject(err) : resolve())));
  }
}
export const Server = callableClass(ServerClass, "Server");  /* Server(…) without new, as Node's */

export function createServer(options, connectionListener) {
  return new Server(options, connectionListener);
}

/* connect(port[, host][, cb]), connect(path[, cb]), connect(options[, cb]) */
export function connect(...args) {
  const normalized = normalizeArgs(args);
  const [options] = normalized;
  const socket = new Socket(options);
  if (options.timeout) socket.setTimeout(options.timeout);
  return socket.connect(normalized);
}

export const createConnection = connect;

/* internal/net_bound.js's, linked when the program names it */
export const BoundSocket = lazyClass("BoundSocket");

export default {
  BlockList, BoundSocket, SocketAddress, isIP, isIPv4, isIPv6, Socket, Stream, Server, connect, createConnection, createServer,
  getDefaultAutoSelectFamily, setDefaultAutoSelectFamily, getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout,
};
