// Node's udp_wrap binding (UDP and SendWrap, as src/udp_wrap.cc defines them) over the host's UDP
// handles (src/host_udp.c): what lib/dgram.js calls, with the same results (0 or a negative errno,
// a send's length + 1 when it went at once) and callbacks (onmessage, a SendWrap's oncomplete).
import {
  errnoMessage, errnoName, udpAddress, udpBind, udpBufferSize, udpClose, udpConnect, udpDisconnect, udpFd, udpHasRef, udpMembership, udpOpen, udpOpenFd,
  udpRecvStart, udpRecvStop, udpRef, udpSend, udpSendQueue, udpSetBroadcast, udpSetMulticastInterface, udpSetMulticastLoopback,
  udpSetMulticastTTL, udpSetTTL, udpSourceMembership,
} from "visaljs:host";
import { Buffer } from "../buffer.js";

const UDP_MESSAGE = 0, UDP_SENT = 1;
let nextAsyncId = 1;

export class SendWrap {}

export class UDP {
  constructor() {
    this._id = udpOpen((event, a, b) => this._event(event, a, b));
    this._pending = [];  /* SendWraps whose sends were queued, in order */
    this._closeCallback = null;
    this._asyncId = nextAsyncId++;
    this.onmessage = null;
    this.onerror = null;
  }

  _event(event, a, b) {
    if (event === UDP_MESSAGE) {
      if (typeof a === "number") this.onmessage?.(a, this, undefined, undefined);
      else this.onmessage?.(a.byteLength, this, Buffer.from(a.buffer, a.byteOffset, a.byteLength), { address: b[0], family: b[1], port: b[2] });
    } else if (event === UDP_SENT) {
      const req = this._pending.shift();
      req?.oncomplete?.(a, b);
    } else {
      this._closeCallback?.();
    }
  }

  getAsyncId() {
    return this._asyncId;
  }

  open(fd) {
    return udpOpenFd(this._id, fd);
  }

  get fd() {
    return udpFd(this._id);
  }

  bind(ip, port, flags) {
    return udpBind(this._id, ip, port, flags);
  }

  bind6(ip, port, flags) {
    return udpBind(this._id, ip, port, flags);
  }

  connect(ip, port) {
    return udpConnect(this._id, ip, port);
  }

  connect6(ip, port) {
    return udpConnect(this._id, ip, port);
  }

  disconnect() {
    return udpDisconnect(this._id);
  }

  /** send(req, list, count, port, ip, hasCallback), or a connected socket's send(req, list, count, hasCallback). */
  send(req, list, count, port, ip) {
    const connected = typeof port !== "number";
    const err = udpSend(this._id, list, connected ? null : ip, connected ? 0 : port);
    if (err === 0) this._pending.push(req);
    return err;
  }

  send6(req, list, count, port, ip) {
    return this.send(req, list, count, port, ip);
  }

  recvStart() {
    return udpRecvStart(this._id);
  }

  recvStop() {
    return udpRecvStop(this._id);
  }

  getsockname(out) {
    return address(udpAddress(this._id, false), out);
  }

  getpeername(out) {
    return address(udpAddress(this._id, true), out);
  }

  setBroadcast(on) {
    return udpSetBroadcast(this._id, on);
  }

  setTTL(ttl) {
    return udpSetTTL(this._id, ttl);
  }

  setMulticastTTL(ttl) {
    return udpSetMulticastTTL(this._id, ttl);
  }

  setMulticastLoopback(on) {
    return udpSetMulticastLoopback(this._id, on);
  }

  setMulticastInterface(iface) {
    return udpSetMulticastInterface(this._id, iface);
  }

  addMembership(group, iface) {
    return udpMembership(this._id, group, iface ?? null, true);
  }

  dropMembership(group, iface) {
    return udpMembership(this._id, group, iface ?? null, false);
  }

  addSourceSpecificMembership(source, group, iface) {
    return udpSourceMembership(this._id, source, group, iface ?? null, true);
  }

  dropSourceSpecificMembership(source, group, iface) {
    return udpSourceMembership(this._id, source, group, iface ?? null, false);
  }

  /* the size, or undefined with what failed in ctx (for ERR_SOCKET_BUFFER_SIZE) */
  bufferSize(size, recv, ctx) {
    const r = udpBufferSize(this._id, size, recv);
    if (r >= 0) return r;
    ctx.errno = r;
    ctx.code = errnoName(r);
    ctx.message = errnoMessage(r);
    ctx.syscall = recv ? "uv_recv_buffer_size" : "uv_send_buffer_size";
    return undefined;
  }

  getSendQueueSize() {
    return udpSendQueue(this._id, false);
  }

  getSendQueueCount() {
    return udpSendQueue(this._id, true);
  }

  close(callback) {
    if (typeof callback === "function") this._closeCallback = callback;
    udpClose(this._id);
  }

  ref() {
    udpRef(this._id, true);
  }

  unref() {
    udpRef(this._id, false);
  }

  hasRef() {
    return udpHasRef(this._id);
  }
}

function address(result, out) {
  if (typeof result === "number") return result;
  out.address = result[0];
  out.family = result[1];
  out.port = result[2];
  return 0;
}
