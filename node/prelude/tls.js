// node:tls: TLS 1.0–1.3 clients and servers on BoringSSL, following Node's lib/tls.js.
// TLSSocket, Server and connect are in internal/tls/wrap.js; SecureContext, the cipher suites and
// the errors in internal/tls/common.js; certificates in internal/tls/x509.js. The root
// certificates are the ones Node bundles (Mozilla's), built into the runtime.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { fsReadFile, tlsRootCertificates } from "visaljs:host";
import { EventEmitter } from "./events.js";
import { invalidArgType, invalidArgValue, validateString } from "./internal/errors.js";
import { cipherNames, createSecureContext, defaults, extraCAs, SecureContext } from "./internal/tls/common.js";
import { checkServerIdentity, connect, convertALPNProtocols, createServer, Server, TLSSocket } from "./internal/tls/wrap.js";
import { toPem } from "./internal/tls/x509.js";
import { Duplex } from "./stream.js";

export { checkServerIdentity, connect, convertALPNProtocols, createSecureContext, createServer, SecureContext, Server, TLSSocket };

export const CLIENT_RENEG_LIMIT = 3;
export const CLIENT_RENEG_WINDOW = 600;

export const getCiphers = () => cipherNames();

/* RFC 8879's: none (BoringSSL takes the algorithms from its user, and visaljs gives it none) */
const compressionAlgorithms = [];
export const getCertificateCompressionAlgorithms = () => compressionAlgorithms;

let bundled;
const bundledRoots = () => (bundled ??= Object.freeze(tlsRootCertificates()));

/* where Linux distributions and macOS keep the system's trusted certificates */
const SYSTEM_BUNDLES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem", "/etc/ssl/cert.pem"];
let system;
function systemRoots() {
  if (system) return system;
  let pems = [];
  for (const file of SYSTEM_BUNDLES) {
    const text = fsReadFile(file);
    if (typeof text === "string") {
      pems = (text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).map((p) => p.replace(/\r\n/g, "\n") + "\n");
      break;
    }
  }
  return (system = Object.freeze(pems));
}

let extraPems;
const extraRoots = () => (extraPems ??= Object.freeze(extraCAs().map((der) => toPem(der))));

let defaultPems;
function defaultRoots() {
  if (defaultPems) return defaultPems;
  const out = defaults.defaultCA ? [...defaults.defaultCA] : [...bundledRoots()];
  if (!defaults.defaultCA) out.push(...extraRoots());
  return (defaultPems = Object.freeze(out));
}

export function getCACertificates(type = "default") {
  validateString(type, "type");
  switch (type) {
    case "default": return defaultRoots();
    case "bundled": return bundledRoots();
    case "system": return systemRoots();
    case "extra": return extraRoots();
    default: throw invalidArgValue("type", "is invalid", type);
  }
}

export function setDefaultCACertificates(certs) {
  if (!Array.isArray(certs)) throw invalidArgType("certs", "an instance of Array", certs);
  for (let i = 0; i < certs.length; i++) {
    if (typeof certs[i] !== "string" && !ArrayBuffer.isView(certs[i])) {
      throw invalidArgType(`certs[${i}]`, "of type string or an instance of ArrayBufferView", certs[i]);
    }
  }
  defaults.defaultCA = certs.map((c) => (typeof c === "string" ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength).toString("latin1")));
  defaultPems = undefined;
}

/* ---- createSecurePair (deprecated): a TLSSocket over one end of an in-memory pair ---------------- */

class PairSide extends Duplex {
  constructor() {
    super();
    this.other = null;
  }

  _read() {}

  _write(chunk, encoding, cb) {
    this.other.push(chunk);
    cb();
  }

  _final(cb) {
    this.other.push(null);
    cb();
  }
}

class SecurePair extends EventEmitter {
  constructor(secureContext = createSecureContext(), isServer = false, requestCert = !isServer, rejectUnauthorized = false) {
    super();
    const encrypted = new PairSide();
    const inner = new PairSide();
    encrypted.other = inner;
    inner.other = encrypted;
    this.server = undefined;
    this.encrypted = encrypted;
    this.cleartext = new TLSSocket(inner, { secureContext, isServer, requestCert, rejectUnauthorized });
    this.cleartext.once("secure", () => this.emit("secure"));
    if (!isServer) this.cleartext._start();
  }
}

let securePairWarned = false;
export function createSecurePair(...args) {
  if (!securePairWarned) {
    securePairWarned = true;
    process.emitWarning("tls.createSecurePair() is deprecated. Please use tls.TLSSocket instead.", "DeprecationWarning", "DEP0064");
  }
  return new SecurePair(...args);
}

/* Node's settable defaults: assigning tls.DEFAULT_CIPHERS (on require("tls")) changes what new
 * contexts use */
const tls = {
  CLIENT_RENEG_LIMIT, CLIENT_RENEG_WINDOW,
  get DEFAULT_CIPHERS() { return defaults.DEFAULT_CIPHERS; },
  set DEFAULT_CIPHERS(v) { defaults.DEFAULT_CIPHERS = v; },
  get DEFAULT_ECDH_CURVE() { return defaults.DEFAULT_ECDH_CURVE; },
  set DEFAULT_ECDH_CURVE(v) { defaults.DEFAULT_ECDH_CURVE = v; },
  get DEFAULT_MIN_VERSION() { return defaults.DEFAULT_MIN_VERSION; },
  set DEFAULT_MIN_VERSION(v) { defaults.DEFAULT_MIN_VERSION = v; },
  get DEFAULT_MAX_VERSION() { return defaults.DEFAULT_MAX_VERSION; },
  set DEFAULT_MAX_VERSION(v) { defaults.DEFAULT_MAX_VERSION = v; },
  getCiphers, getCertificateCompressionAlgorithms,
  get rootCertificates() { return bundledRoots(); },
  getCACertificates, setDefaultCACertificates, convertALPNProtocols, checkServerIdentity, createSecureContext, SecureContext,
  TLSSocket, Server, createServer, connect, createSecurePair,
};

export const DEFAULT_CIPHERS = defaults.DEFAULT_CIPHERS;
export const DEFAULT_ECDH_CURVE = defaults.DEFAULT_ECDH_CURVE;
export const DEFAULT_MIN_VERSION = defaults.DEFAULT_MIN_VERSION;
export const DEFAULT_MAX_VERSION = defaults.DEFAULT_MAX_VERSION;
export const rootCertificates = bundledRoots();

export default tls;
