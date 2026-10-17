// net.BoundSocket, as Node's: a TCP or pipe handle bound at once (its errors thrown by the
// constructor), neither listening nor connecting until one Server (server.listen(bound)) or Socket
// (new net.Socket({ handle: bound })) adopts it, which then owns it. No DNS: a host is an IP.
// Linked into programs that name BoundSocket (internal/features.js); net.js adopts the handle
// through features.adoptBoundSocket.
import { netAddress, netBind, netClose, netFd, netOpen } from "visaljs:host";
import { BoundSocket as Wrapper } from "../net.js";
import { codeError, invalidArgType, invalidArgValue, validateString } from "./errors.js";
import { features, provideClass } from "./features.js";
import { isIP } from "./net.js";

const kConsume = Symbol("kBoundSocketConsume");

const adopted = () => codeError(Error, "ERR_SOCKET_HANDLE_ADOPTED", "The bound socket has already been adopted by a server or socket");

function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw invalidArgType(name, "of type boolean", value);
}

class BoundSocket {
  #handle = null;  /* the host handle's id, until adopted or closed */
  #address = {};
  #path;

  constructor(options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw invalidArgType("options", "of type object", options);
    if (options.path !== undefined) {
      this.#bindPipe(options);
      return;
    }
    const { exceptionWithHostPort, validatePort } = features.net;
    const port = validatePort(options.port ?? 0, "options.port");
    const ipv6Only = options.ipv6Only ?? false;
    validateBoolean(ipv6Only, "options.ipv6Only");
    const reusePort = options.reusePort ?? false;
    validateBoolean(reusePort, "options.reusePort");
    let { host } = options;
    if (host === undefined || host === null) {
      host = ipv6Only ? "::" : "0.0.0.0";
    } else {
      validateString(host, "options.host");
      if (isIP(host) === 0) {
        throw invalidArgValue("options.host", "must be a numeric IP address; net.BoundSocket does not perform DNS resolution", host);
      }
    }
    const id = netOpen(false);
    let err = netBind(id, host, port, (ipv6Only ? 1 : 0) | (reusePort ? 2 : 0));
    /* libuv keeps a bind's EADDRINUSE for the next getsockname, listen or connect: asked now, so it
     * throws here, as Node's */
    if (err === 0) {
      const a = netAddress(id, false);
      if (typeof a === "number") err = a;
      else this.#address = { address: a[0], family: a[1], port: a[2] };
    }
    if (err) {
      netClose(id);
      throw exceptionWithHostPort(err, "bind", host, port);
    }
    this.#handle = id;
  }

  /* a Unix domain socket's path (or a Windows named pipe's); one starting with "\0" is in Linux's
   * abstract namespace */
  #bindPipe(options) {
    const { path, host, port, ipv6Only, reusePort } = options;
    if (host !== undefined || port !== undefined || ipv6Only !== undefined || reusePort !== undefined) {
      throw invalidArgValue("options", "path is mutually exclusive with host, port, ipv6Only, and reusePort", options);
    }
    validateString(path, "options.path");
    if (path[0] === "\0" && process.platform !== "linux") {
      throw invalidArgValue("options.path", "abstract socket paths are only supported on Linux", path);
    }
    const id = netOpen(true);
    const err = netBind(id, path);
    if (err) {
      netClose(id);
      throw features.net.errnoException(err, "bind");
    }
    this.#handle = id;
    this.#path = path;
  }

  /* { address, family, port }, or a pipe's path */
  address() {
    if (this.#handle === null) throw adopted();
    return this.#path ?? this.#address;
  }

  /* the descriptor, or -1 where sockets have none (Windows) */
  fd() {
    if (this.#handle === null) throw adopted();
    const fd = netFd(this.#handle);
    return fd < 0 ? -1 : fd;
  }

  close() {
    if (this.#handle === null) throw adopted();
    netClose(this.#handle);
    this.#handle = null;
  }

  [Symbol.dispose]() {
    if (this.#handle !== null) {
      netClose(this.#handle);
      this.#handle = null;
    }
  }

  get isPipe() {
    return this.#path !== undefined;
  }

  [kConsume]() {
    if (this.#handle === null) throw adopted();
    const id = this.#handle;
    this.#handle = null;
    return { id, path: this.#path };
  }
}

/* the handle of a BoundSocket being adopted ({ id, path }), or null for anything else */
features.adoptBoundSocket = (value) => (value instanceof BoundSocket ? value[kConsume]() : null);
provideClass(Wrapper, BoundSocket);
