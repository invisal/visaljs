// node:https (Node's lib/https.js): HTTP over TLS. Server is a tls.Server whose secure connections
// get http.Server's requests (llhttp fed the decrypted bytes: http.js's fed connections); Agent is
// http.Agent connecting with tls.connect, reusing TLS sessions by origin; request and get are
// http's, with https's agent and port 443.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { Agent as HttpAgent, ClientRequest, Server as HttpServer } from "./http.js";
import { invalidArgType } from "./internal/errors.js";
import { Server as TlsServer, connect as tlsConnect } from "./tls.js";
import { urlToHttpOptions } from "./url.js";
import { callableClass } from "./internal/features.js";

/* ---- Server ------------------------------------------------------------------------------------- */

class ServerClass extends TlsServer {
  constructor(options, requestListener) {
    if (typeof options === "function") {
      requestListener = options;
      options = {};
    } else if (options === undefined || options === null) {
      options = {};
    } else if (typeof options !== "object") {
      throw invalidArgType("options", "of type object", options);
    }
    super({ noDelay: true, ALPNProtocols: ["http/1.1"], ...options });
    this._initHttp(options, requestListener, "secureConnection");
    /* a handshake that fails is the client's error, as a request that does */
    this.on("tlsClientError", (err, conn) => {
      if (!this.emit("clientError", err, conn)) conn.destroy(err);
    });
  }
}
export const Server = callableClass(ServerClass, "Server");  /* Server(…) without new, as Node's */

/* http.Server's methods: its requests, timeouts and connections */
for (const key of Object.getOwnPropertyNames(HttpServer.prototype)) {
  if (key === "constructor" || Object.hasOwn(Server.prototype, key)) continue;
  Object.defineProperty(Server.prototype, key, Object.getOwnPropertyDescriptor(HttpServer.prototype, key));
}

export function createServer(options, requestListener) {
  return new Server(options, requestListener);
}

/* ---- Agent -------------------------------------------------------------------------------------- */

/* tls.connect with the agent's options, resuming the origin's last session */
function createConnection(port, host, options) {
  if (port !== null && typeof port === "object") options = port;
  else if (host !== null && typeof host === "object") options = { ...host };
  else if (options === null || typeof options !== "object") options = {};
  else options = { ...options };
  if (typeof port === "number") options.port = port;
  if (typeof host === "string") options.host = host;
  if (options._agentKey) {
    const session = this._getSession(options._agentKey);
    if (session) options = { session, ...options };
  }
  const socket = tlsConnect(options);
  if (options._agentKey) {
    socket.on("session", (session) => this._cacheSession(options._agentKey, session));
    socket.once("close", (err) => {
      if (err) this._evictSession(options._agentKey);
    });
  }
  return socket;
}

/** http.Agent over TLS: port 443, and the TLS options in each origin's name. */
export function Agent(options) {
  if (!(this instanceof Agent)) return new Agent(options);
  HttpAgent.call(this, options);
  this.defaultPort = 443;
  this.protocol = "https:";
  this.maxCachedSessions = this.options.maxCachedSessions;
  if (this.maxCachedSessions === undefined) this.maxCachedSessions = 100;
  this._sessionCache = { map: {}, list: [] };
}
Object.setPrototypeOf(Agent.prototype, HttpAgent.prototype);
Object.setPrototypeOf(Agent, HttpAgent);
Agent.prototype.createConnection = createConnection;

/* the origin with what makes its TLS connections differ: sockets aren't shared across them */
const nameOptions = ["ca", "cert", "clientCertEngine", "ciphers", "key", "pfx", "rejectUnauthorized", "servername", "minVersion",
  "maxVersion", "secureProtocol", "crl", "honorCipherOrder", "ecdhCurve", "dhparam", "secureOptions", "sessionIdContext", "sigalgs",
  "privateKeyIdentifier", "privateKeyEngine"];

Agent.prototype.getName = function getName(options = {}) {
  let name = HttpAgent.prototype.getName.call(this, options);
  for (const key of nameOptions) {
    name += ":";
    const value = options[key];
    if (key === "rejectUnauthorized") {
      if (value !== undefined) name += value;
    } else if (key === "servername") {
      if (value && value !== options.host) name += value;
    } else if (value) {
      name += value;
    }
  }
  return name;
};

Agent.prototype._getSession = function _getSession(key) {
  return this._sessionCache.map[key];
};

Agent.prototype._cacheSession = function _cacheSession(key, session) {
  if (this.maxCachedSessions === 0) return;
  if (this._sessionCache.map[key]) {
    this._sessionCache.map[key] = session;
    return;
  }
  if (this._sessionCache.list.length >= this.maxCachedSessions) {
    const oldKey = this._sessionCache.list.shift();
    delete this._sessionCache.map[oldKey];
  }
  this._sessionCache.list.push(key);
  this._sessionCache.map[key] = session;
};

Agent.prototype._evictSession = function _evictSession(key) {
  const index = this._sessionCache.list.indexOf(key);
  if (index === -1) return;
  this._sessionCache.list.splice(index, 1);
  delete this._sessionCache.map[key];
};

export let globalAgent = new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 });

/* ---- request and get ---------------------------------------------------------------------------- */

/** request(url[, options][, callback]) or request(options[, callback]): an http.ClientRequest
 *  with https's agent. */
export function request(...args) {
  let options = {};
  if (typeof args[0] === "string") options = urlToHttpOptions(new URL(args.shift()));
  else if (args[0] instanceof URL) options = urlToHttpOptions(args.shift());
  if (args[0] && typeof args[0] !== "function") Object.assign(options, args.shift());
  options._defaultAgent = globalAgent;
  args.unshift(options);
  return new ClientRequest(...args);
}

export function get(input, options, cb) {
  const req = request(input, options, cb);
  req.end();
  return req;
}

export default {
  Agent, Server, createServer, get, request,
  /* an accessor, as Node's: a program may replace the agent requests use by default */
  get globalAgent() {
    return globalAgent;
  },
  set globalAgent(value) {
    globalAgent = value;
  },
};
