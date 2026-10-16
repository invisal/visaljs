// http.Agent (Node's lib/_http_agent.js): sockets pooled by origin ("host:port:localAddress"),
// at most maxSockets each, the rest of the requests queued; with keepAlive, a socket whose
// response is done goes to freeSockets (unref'd, so it doesn't keep the program running) for
// the next request to the same origin, until the agent's timeout or the server's Keep-Alive hint.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { httpGuard } from "visaljs:host";
import { EventEmitter } from "../events.js";
import { createConnection } from "../net.js";
import { invalidArgType, invalidArgValue, outOfRange } from "./errors.js";
import { isIP } from "./net.js";

function freeSocketErrorListener() {
  this.destroy();
  this.emit("agentRemove");
}

/* Node's free socket data guard: bytes a socket reads while it waits in the pool (no request on it)
 * would be taken for the next request's response; the socket is destroyed instead. The bytes are
 * caught in C (httpGuard), before they reach the socket's stream; attaching the next request's
 * parser takes the guard off. */
const guardedSockets = new Map();  /* the guarded sockets, by their handle's id */

function onGuardedData(id) {
  const socket = guardedSockets.get(id);
  guardedSockets.delete(id);
  socket?.destroy();
}

/* Node's maybeEnableKeylog: the sockets' keylog events become the agent's */
function maybeEnableKeylog(eventName) {
  if (eventName !== "keylog") return;
  this.removeListener("newListener", maybeEnableKeylog);
  const emit = this.emit.bind(this);
  this._onKeylog = function onkeylog(keylog) {
    emit("keylog", keylog, this);  /* this: the socket */
  };
  for (const set of [this.freeSockets, this.sockets]) {
    for (const sockets of Object.values(set)) for (const socket of sockets) socket.on("keylog", this._onKeylog);
  }
}

function installFreeSocketDataGuard(socket) {
  /* a TLS socket's reads are records (session tickets, alerts) before they're data: its own */
  if (socket.encrypted) return;
  if (socket.readableLength > 0) {
    socket.destroy();
    return;
  }
  if (socket.connecting) {
    if (!socket._freeGuardConnect) {  /* once: a socket may come back to the pool before it connects */
      socket._freeGuardConnect = () => {
        socket._freeGuardConnect = undefined;
        installFreeSocketDataGuard(socket);
      };
      socket.once("connect", socket._freeGuardConnect);
    }
    return;
  }
  const id = socket._handle;
  if (typeof id === "number" && httpGuard(id, onGuardedData)) {
    guardedSockets.set(id, socket);
    socket._freeGuardId = id;
    /* one listener while it's guarded, taken off when it's reused (a kept-alive socket comes back
     * to the pool after each request) */
    socket._freeGuardClose = () => removeFreeSocketDataGuard(socket);
    socket.once("close", socket._freeGuardClose);
  }
}

function removeFreeSocketDataGuard(socket) {
  if (socket._freeGuardConnect) {
    socket.removeListener("connect", socket._freeGuardConnect);
    socket._freeGuardConnect = undefined;
  }
  if (socket._freeGuardClose) {
    socket.removeListener("close", socket._freeGuardClose);
    socket._freeGuardClose = undefined;
  }
  const id = socket._freeGuardId;
  if (id !== undefined && guardedSockets.get(id) === socket) guardedSockets.delete(id);
  socket._freeGuardId = undefined;
}

export function Agent(options) {
  if (!(this instanceof Agent)) return new Agent(options);
  EventEmitter.call(this);
  this.defaultPort = 80;
  this.protocol = "http:";
  this.options = { __proto__: null, ...options };
  if (this.options.noDelay === undefined) this.options.noDelay = true;
  this.options.path = null;  /* not a pipe, to net */
  this.requests = { __proto__: null };
  this.sockets = { __proto__: null };
  this.freeSockets = { __proto__: null };
  this.keepAliveMsecs = this.options.keepAliveMsecs || 1000;
  this.keepAlive = this.options.keepAlive || false;
  this.maxSockets = this.options.maxSockets || Agent.defaultMaxSockets;
  this.maxFreeSockets = this.options.maxFreeSockets || 256;
  this.scheduling = this.options.scheduling || "lifo";
  /* what the server's Keep-Alive timeout is cut by, so the socket isn't reused as the server closes it */
  const buffer = this.options.agentKeepAliveTimeoutBuffer;
  this.agentKeepAliveTimeoutBuffer = typeof buffer === "number" && buffer >= 0 && Number.isFinite(buffer) ? buffer : 1000;
  this.maxTotalSockets = this.options.maxTotalSockets;
  this.totalSocketCount = 0;
  if (this.scheduling !== "fifo" && this.scheduling !== "lifo") throw invalidArgValue("scheduling", "must be one of: 'fifo', 'lifo'", this.scheduling);
  if (this.maxTotalSockets !== undefined) {
    if (typeof this.maxTotalSockets !== "number") throw invalidArgType("maxTotalSockets", "of type number", this.maxTotalSockets);
    if (!(this.maxTotalSockets >= 1)) throw outOfRange("maxTotalSockets", ">= 1", this.maxTotalSockets);
  } else {
    this.maxTotalSockets = Infinity;
  }

  /* keylog events only once someone listens: then every socket's, the existing ones' too */
  this.on("newListener", maybeEnableKeylog);

  /* a socket whose request is done: the next queued request's, kept alive, or destroyed */
  this.on("free", (socket, options) => {
    const name = this.getName(options);
    if (!socket.writable) {
      socket.destroy();
      return;
    }
    const requests = this.requests[name];
    if (requests?.length) {
      const req = requests.shift();
      setRequestSocket(this, req, socket);
      if (requests.length === 0) delete this.requests[name];
      return;
    }
    const req = socket._httpMessage;
    if (!req || !req.shouldKeepAlive || !this.keepAlive) {
      socket.destroy();
      return;
    }
    const freeSockets = this.freeSockets[name] || [];
    const freeLen = freeSockets.length;
    let count = freeLen;
    if (this.sockets[name]) count += this.sockets[name].length;
    if (this.totalSocketCount > this.maxTotalSockets || count > this.maxSockets || freeLen >= this.maxFreeSockets || !this.keepSocketAlive(socket)) {
      socket.destroy();
      return;
    }
    this.freeSockets[name] = freeSockets;
    socket._httpMessage = null;
    this.removeSocket(socket, options);
    socket.once("error", freeSocketErrorListener);
    installFreeSocketDataGuard(socket);
    freeSockets.push(socket);
  });
}
Object.setPrototypeOf(Agent.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Agent, EventEmitter);

Agent.defaultMaxSockets = Infinity;

Agent.prototype.createConnection = createConnection;

/* the pool's key: "host:port:localAddress[:family][:socketPath]" */
Agent.prototype.getName = function getName(options = {}) {
  let name = options.host || "localhost";
  name += ":";
  if (options.port) name += options.port;
  name += ":";
  if (options.localAddress) name += options.localAddress;
  if (options.family === 4 || options.family === 6) name += ":" + options.family;
  if (options.socketPath) name += ":" + options.socketPath;
  return name;
};

/* the TLS server name (SNI): the Host header's host, else the host; never an IP address. Plain
 * HTTP ignores it; https's agent reads it, and its sessions are keyed by it (Node's) */
function calculateServerName(options, req) {
  let servername = options.host;
  const hostHeader = req.getHeader("host");
  if (hostHeader) {
    if (typeof hostHeader !== "string") throw invalidArgType("options.headers.host", "of type string", hostHeader);
    if (hostHeader.startsWith("[")) {
      const index = hostHeader.indexOf("]");
      servername = index === -1 ? hostHeader : hostHeader.slice(1, index);
    } else {
      servername = hostHeader.split(":", 1)[0];
    }
  }
  if (isIP(servername)) servername = "";
  return servername;
}

function normalizeServerName(options, req) {
  if (!options.servername && options.servername !== "") options.servername = calculateServerName(options, req);
}

/* a request: a free socket, a new one (under maxSockets), or the queue */
Agent.prototype.addRequest = function addRequest(req, options, port, localAddress) {
  if (typeof options === "string") options = { __proto__: null, host: options, port, localAddress };
  options = { __proto__: null, ...options, ...this.options };
  if (options.socketPath) options.path = options.socketPath;
  normalizeServerName(options, req);
  const name = this.getName(options);
  this.sockets[name] ||= [];
  const freeSockets = this.freeSockets[name];
  let socket;
  if (freeSockets) {
    while (freeSockets.length && freeSockets[0].destroyed) freeSockets.shift();
    socket = this.scheduling === "fifo" ? freeSockets.shift() : freeSockets.pop();
    if (!freeSockets.length) delete this.freeSockets[name];
  }
  const freeLen = freeSockets ? freeSockets.length : 0;
  const sockLen = freeLen + this.sockets[name].length;
  /* a reused socket takes the request's highWaterMark, as Node's */
  if (socket && options.highWaterMark != null && socket.writableHighWaterMark !== options.highWaterMark) {
    socket._writableState.highWaterMark = options.highWaterMark;
  }
  if (socket) {
    removeFreeSocketDataGuard(socket);
    this.reuseSocket(socket, req);
    setRequestSocket(this, req, socket);
    this.sockets[name].push(socket);
  } else if (sockLen < this.maxSockets && this.totalSocketCount < this.maxTotalSockets) {
    this.createSocket(req, options, (err, socket) => {
      if (err) req.onSocket(socket, err);
      else setRequestSocket(this, req, socket);
    });
  } else {
    this.requests[name] ||= [];
    req._agentOptions = options;
    this.requests[name].push(req);
  }
};

Agent.prototype.createSocket = function createSocket(req, options, cb) {
  options = { __proto__: null, ...options, ...this.options };
  if (options.socketPath) options.path = options.socketPath;
  normalizeServerName(options, req);
  const name = this.getName(options);
  options._agentKey = name;
  options.encoding = null;
  let called = false;
  const oncreate = (err, s) => {
    if (called) return;
    called = true;
    if (err) return cb(err);
    if (!this.sockets[name]) this.sockets[name] = [];
    this.sockets[name].push(s);
    this.totalSocketCount++;
    installListeners(this, s, options);
    if (this._onKeylog) s.on("keylog", this._onKeylog);
    cb(null, s);
  };
  if (this.keepAlive) {
    options.keepAlive = this.keepAlive;
    options.keepAliveInitialDelay = this.keepAliveMsecs;
  }
  const newSocket = this.createConnection(options, oncreate);
  if (newSocket) oncreate(null, newSocket);
};

function installListeners(agent, s, options) {
  function onFree() {
    agent.emit("free", s, options);
  }
  s.on("free", onFree);
  /* the one place sockets leave the agent: every error ends in 'close' */
  function onClose() {
    agent.totalSocketCount--;
    agent.removeSocket(s, options);
  }
  s.on("close", onClose);
  function onTimeout() {
    const sockets = agent.freeSockets;
    if (Object.keys(sockets).some((name) => sockets[name].includes(s))) s.destroy();
  }
  s.on("timeout", onTimeout);
  /* an upgraded socket leaves the pool for good */
  function onRemove() {
    agent.totalSocketCount--;
    agent.removeSocket(s, options);
    s.removeListener("close", onClose);
    s.removeListener("free", onFree);
    s.removeListener("timeout", onTimeout);
    s.removeListener("agentRemove", onRemove);
  }
  s.on("agentRemove", onRemove);
}

Agent.prototype.removeSocket = function removeSocket(s, options) {
  const name = this.getName(options);
  const sets = [this.sockets];
  if (!s.writable) sets.push(this.freeSockets);  /* a destroyed socket leaves the free list too */
  for (const sockets of sets) {
    const list = sockets[name];
    if (list) {
      const index = list.indexOf(s);
      if (index !== -1) {
        list.splice(index, 1);
        if (list.length === 0) delete sockets[name];
      }
    }
  }
  let req;
  if (this.requests[name]?.length) {
    req = this.requests[name][0];
  } else {
    for (const prop of Object.keys(this.requests)) {
      if (this.sockets[prop]?.length) break;
      req = this.requests[prop][0];
      options = req._agentOptions;
      break;
    }
  }
  if (req && options) {  /* a socket went away with requests waiting: a new one for them */
    req._agentOptions = undefined;
    this.createSocket(req, options, (err, socket) => {
      if (err) req.onSocket(socket, err);
      else socket.emit("free");
    });
  }
};

/* a kept-alive socket: unref'd while free, timed out by the agent's timeout or the server's hint */
Agent.prototype.keepSocketAlive = function keepSocketAlive(socket) {
  socket.setKeepAlive(true, this.keepAliveMsecs);
  socket.unref();
  let agentTimeout = this.options.timeout || 0;
  let canKeepSocketAlive = true;
  const hint = socket._httpMessage?.res?.headers["keep-alive"];
  const seconds = hint ? /^timeout=(\d+)/.exec(hint)?.[1] : undefined;
  if (seconds) {
    let serverHintTimeout = parseInt(seconds, 10) * 1000 - this.agentKeepAliveTimeoutBuffer;
    serverHintTimeout = serverHintTimeout > 0 ? serverHintTimeout : 0;
    if (serverHintTimeout === 0) canKeepSocketAlive = false;
    else if (serverHintTimeout < agentTimeout) agentTimeout = serverHintTimeout;
  }
  if (socket.timeout !== agentTimeout) socket.setTimeout(agentTimeout);
  return canKeepSocketAlive;
};

Agent.prototype.reuseSocket = function reuseSocket(socket, req) {
  socket.removeListener("error", freeSocketErrorListener);
  req.reusedSocket = true;
  socket.ref();
};

Agent.prototype.destroy = function destroy() {
  for (const set of [this.freeSockets, this.sockets]) {
    for (const name of Object.keys(set)) for (const socket of [...set[name]]) socket.destroy();
  }
};

function setRequestSocket(agent, req, socket) {
  req.onSocket(socket);
  const agentTimeout = agent.options.timeout || 0;
  if (req.timeout === undefined || req.timeout === agentTimeout) return;
  socket.setTimeout(req.timeout);
}

export let globalAgent = new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 });

/* http.globalAgent's setter: the agent requests use by default from then on, as Node's */
export function setGlobalAgent(agent) {
  globalAgent = agent;
}
