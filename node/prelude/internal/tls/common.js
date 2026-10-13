// node:tls's shared parts: SecureContext and createSecureContext (Node's
// internal/tls/common.js and secure-context.js) over the runtime's contexts (BoringSSL's SSL_CTX);
// protocol versions; and Node's errors for what BoringSSL reports (OpenSSL 3's codes and messages,
// as Node shows them: BoringSSL's reasons are OpenSSL's, its numbers aren't).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import {
  fsReadFile, tlsCiphers, tlsContextAddCA, tlsContextAddRoots, tlsContextNew, tlsContextSetCert, tlsContextSetKey,
} from "visaljs:host";
import { codeError, invalidArgType, invalidArgValue, notSupported, validateString } from "../errors.js";
import { createPrivateKey } from "../crypto/keys.js";
import { kHandle } from "../crypto/util.js";
import { certificatesOf, parseCertificate } from "./x509.js";

/* ---- Cipher suites ------------------------------------------------------------------------------ */

/* TLS 1.3's, which BoringSSL doesn't list among the configurable ones */
const TLS13_SUITES = ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256"];

/** tls.getCiphers(): OpenSSL's names, lowercase, sorted (as Node lists them) */
export const cipherNames = () => [...new Set([...tlsCiphers(), ...TLS13_SUITES].map((n) => n.toLowerCase()))].sort();

/* ---- Versions ----------------------------------------------------------------------------------- */

const VERSIONS = { TLSv1: 0x0301, "TLSv1.1": 0x0302, "TLSv1.2": 0x0303, "TLSv1.3": 0x0304 };
export const VERSION_NAMES = { 0x0301: "TLSv1", 0x0302: "TLSv1.1", 0x0303: "TLSv1.2", 0x0304: "TLSv1.3" };

/* secureProtocol's OpenSSL method names → [min, max] */
const METHODS = {
  TLS_method: [0x0301, 0x0304], SSLv23_method: [0x0301, 0x0304], TLS_client_method: [0x0301, 0x0304], TLS_server_method: [0x0301, 0x0304],
  SSLv23_client_method: [0x0301, 0x0304], SSLv23_server_method: [0x0301, 0x0304],
  TLSv1_method: [0x0301, 0x0301], TLSv1_client_method: [0x0301, 0x0301], TLSv1_server_method: [0x0301, 0x0301],
  TLSv1_1_method: [0x0302, 0x0302], TLSv1_1_client_method: [0x0302, 0x0302], TLSv1_1_server_method: [0x0302, 0x0302],
  TLSv1_2_method: [0x0303, 0x0303], TLSv1_2_client_method: [0x0303, 0x0303], TLSv1_2_server_method: [0x0303, 0x0303],
};

function toV(which, v, def) {
  v ??= def;
  if (Object.hasOwn(VERSIONS, v)) return VERSIONS[v];
  throw codeError(TypeError, "ERR_TLS_INVALID_PROTOCOL_VERSION", `${JSON.stringify(String(v))} is not a valid ${which} TLS protocol version`);
}

/* ---- Errors ------------------------------------------------------------------------------------- */

/* An OpenSSL error as Node shows it: `error:0A00010B:SSL routines::wrong version number`, with
 * code ERR_SSL_WRONG_VERSION_NUMBER, library and reason */
export function sslError(number, reason, library = "SSL routines", code) {
  const error = new Error(`error:${number.toString(16).toUpperCase().padStart(8, "0")}:${library}::${reason}`);
  error.library = library;
  error.reason = reason;
  error.code = code ?? "ERR_SSL_" + reason.toUpperCase().replace(/[ -]/g, "_");
  return error;
}

/* OpenSSL's reason numbers for the SSL library's reasons BoringSSL shares (an alert's is 1000 plus
 * the alert, in both) */
const SSL_REASONS = {
  WRONG_VERSION_NUMBER: 0x10B, PACKET_LENGTH_TOO_LONG: 0xC6, HTTP_REQUEST: 0x9C, HTTPS_PROXY_REQUEST: 0x9B,
  NO_SHARED_CIPHER: 0xC1, PEER_DID_NOT_RETURN_A_CERTIFICATE: 0xC7, NO_APPLICATION_PROTOCOL: 0xEB,
  UNSUPPORTED_PROTOCOL: 0x102, CERTIFICATE_VERIFY_FAILED: 0x86, NO_CIPHER_MATCH: 0xB9,
  DECRYPTION_FAILED_OR_BAD_RECORD_MAC: 0x119, UNEXPECTED_MESSAGE: 0xF4, UNEXPECTED_RECORD: 0xF5, WRONG_CIPHER_RETURNED: 0x105,
  BAD_SIGNATURE: 0x7B, NO_RENEGOTIATION: 0x153, UNSAFE_LEGACY_RENEGOTIATION_DISABLED: 0x152, RECORD_TOO_LARGE: 0x109,
  TLSV1_ALERT_INAPPROPRIATE_FALLBACK: 0x480, INAPPROPRIATE_FALLBACK: 0x175, EXCESSIVE_MESSAGE_SIZE: 0x98,
};

/** The error a BoringSSL failure ([library, reason, name]) is reported as */
export function tlsFailure(err) {
  if (!Array.isArray(err)) return sslError(0x0A0C0103, "internal error");
  const [, code, name] = err;
  /* OpenSSL 3.5 calls the SSL 3 alerts "ssl/tls alert …", and TLS 1.3's "tlsv13 alert …" */
  const reasonName = name.replace(/^SSLV3_ALERT_/, "SSL/TLS_ALERT_").replace(/^TLSV1_ALERT_(CERTIFICATE_REQUIRED|MISSING_EXTENSION)$/, "TLSV13_ALERT_$1");
  const number = 0x0A000000 + (code >= 1000 ? code : SSL_REASONS[name] ?? code);
  return sslError(number, reasonName.toLowerCase().replace(/_/g, " "), "SSL routines", "ERR_SSL_" + reasonName);
}

/* X509_V_ERR_* → OpenSSL's names, which authorizationError and Node's errors carry */
const VERIFY_CODES = {
  2: "UNABLE_TO_GET_ISSUER_CERT", 3: "UNABLE_TO_GET_CRL", 4: "UNABLE_TO_DECRYPT_CERT_SIGNATURE", 5: "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  6: "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY", 7: "CERT_SIGNATURE_FAILURE", 8: "CRL_SIGNATURE_FAILURE", 9: "CERT_NOT_YET_VALID",
  10: "CERT_HAS_EXPIRED", 11: "CRL_NOT_YET_VALID", 12: "CRL_HAS_EXPIRED", 13: "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  14: "ERROR_IN_CERT_NOT_AFTER_FIELD", 15: "ERROR_IN_CRL_LAST_UPDATE_FIELD", 16: "ERROR_IN_CRL_NEXT_UPDATE_FIELD", 17: "OUT_OF_MEM",
  18: "DEPTH_ZERO_SELF_SIGNED_CERT", 19: "SELF_SIGNED_CERT_IN_CHAIN", 20: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  21: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", 22: "CERT_CHAIN_TOO_LONG", 23: "CERT_REVOKED", 24: "INVALID_CA", 25: "PATH_LENGTH_EXCEEDED",
  26: "INVALID_PURPOSE", 27: "CERT_UNTRUSTED", 28: "CERT_REJECTED", 34: "UNHANDLED_CRITICAL_EXTENSION",
  62: "HOSTNAME_MISMATCH",
};

/* their messages, as OpenSSL 3 words them */
const VERIFY_MESSAGES = {
  UNABLE_TO_GET_ISSUER_CERT: "unable to get issuer certificate",
  UNABLE_TO_GET_CRL: "unable to get certificate CRL",
  UNABLE_TO_DECRYPT_CERT_SIGNATURE: "unable to decrypt certificate's signature",
  UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY: "unable to decode issuer public key",
  CERT_SIGNATURE_FAILURE: "certificate signature failure",
  CERT_NOT_YET_VALID: "certificate is not yet valid",
  CERT_HAS_EXPIRED: "certificate has expired",
  ERROR_IN_CERT_NOT_BEFORE_FIELD: "format error in certificate's notBefore field",
  ERROR_IN_CERT_NOT_AFTER_FIELD: "format error in certificate's notAfter field",
  OUT_OF_MEM: "out of memory",
  DEPTH_ZERO_SELF_SIGNED_CERT: "self-signed certificate",
  SELF_SIGNED_CERT_IN_CHAIN: "self-signed certificate in certificate chain",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "unable to get local issuer certificate",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "unable to verify the first certificate",
  CERT_CHAIN_TOO_LONG: "certificate chain too long",
  CERT_REVOKED: "certificate revoked",
  INVALID_CA: "invalid CA certificate",
  PATH_LENGTH_EXCEEDED: "path length constraint exceeded",
  INVALID_PURPOSE: "unsupported certificate purpose",
  CERT_UNTRUSTED: "certificate not trusted",
  CERT_REJECTED: "certificate rejected",
  UNHANDLED_CRITICAL_EXTENSION: "unhandled critical extension",
  HOSTNAME_MISMATCH: "hostname mismatch",
};

/** A certificate verification error (Node's: message, and the code that authorizationError gets),
 *  from X509_V_ERR_* or a name */
export function verifyError(code) {
  const name = typeof code === "number" ? VERIFY_CODES[code] ?? "CERT_REJECTED" : code;
  const error = new Error(VERIFY_MESSAGES[name] ?? name.toLowerCase().replace(/_/g, " "));
  error.code = name;
  return error;
}

/* ---- SecureContext ------------------------------------------------------------------------------ */

const DEFAULT_CIPHERS =
  "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:" +
  "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:" +
  "ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:" +
  "DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";

/* tls's settable defaults (tls.DEFAULT_CIPHERS, …), which contexts read when they're made */
export const defaults = {
  DEFAULT_CIPHERS,
  DEFAULT_ECDH_CURVE: "auto",
  DEFAULT_MIN_VERSION: "TLSv1.2",
  DEFAULT_MAX_VERSION: "TLSv1.3",
  /* setDefaultCACertificates: PEMs that replace the bundled roots, or null */
  defaultCA: null,
};

function validateKeyOrCertOption(name, value) {
  if (typeof value !== "string" && !ArrayBuffer.isView(value)) {
    throw invalidArgType(name, "of type string or an instance of Buffer, TypedArray, or DataView", value);
  }
}

const caLoadError = () => codeError(Error, "ERR_OSSL_PEM_NO_START_LINE", "error:0480006C:PEM routines::no start line");

export function SecureContext(secureProtocol, secureOptions, minVersion, maxVersion) {
  if (!(this instanceof SecureContext)) return new SecureContext(secureProtocol, secureOptions, minVersion, maxVersion);
  let min, max;
  if (secureProtocol) {
    if (minVersion != null) throw codeError(TypeError, "ERR_TLS_PROTOCOL_VERSION_CONFLICT", `TLS protocol version ${minVersion} conflicts with secureProtocol ${secureProtocol}`);
    if (maxVersion != null) throw codeError(TypeError, "ERR_TLS_PROTOCOL_VERSION_CONFLICT", `TLS protocol version ${maxVersion} conflicts with secureProtocol ${secureProtocol}`);
    validateString(secureProtocol, "secureProtocol");
    const method = METHODS[secureProtocol];
    if (!method) throw codeError(TypeError, "ERR_TLS_INVALID_PROTOCOL_METHOD", `Unknown method: ${secureProtocol}`);
    [min, max] = method;
  } else {
    min = toV("minimum", minVersion, defaults.DEFAULT_MIN_VERSION);
    max = toV("maximum", maxVersion, defaults.DEFAULT_MAX_VERSION);
  }
  this._minVersion = min;
  this._maxVersion = max;
  this._secureOptions = secureOptions | 0;
  /* the runtime's; configure() makes it again with the options' cipher suites */
  this.context = tlsContextNew(min, max, null, (this._secureOptions & SERVER_PREFERENCE) !== 0, null, null);
  this._certs = [];     /* the chain sent, as DER (getCertificate) */
  this._cas = [];       /* the trusted certificates given, parsed (getPeerCertificate's chain) */
  this._hasRoots = false;
  this.singleUse = false;
}

/* SSL_OP_CIPHER_SERVER_PREFERENCE */
const SERVER_PREFERENCE = 0x400000;

/** Node's configSecureContext */
function configure(c, options = {}, name = "options") {
  if (typeof options !== "object" || options === null) throw invalidArgType(name, "of type object", options);
  const { ca, cert, key, passphrase, pfx, ciphers = defaults.DEFAULT_CIPHERS, ecdhCurve = defaults.DEFAULT_ECDH_CURVE, sigalgs } = options;
  if (ciphers !== undefined && ciphers !== null) validateString(ciphers, `${name}.ciphers`);
  const list = (ciphers || defaults.DEFAULT_CIPHERS).split(":");
  const tls12 = list.filter((c) => c && !c.startsWith("TLS_") && !c.startsWith("!TLS_")).join(":");
  const tls13 = list.filter((c) => c.startsWith("TLS_") || c.startsWith("!TLS_")).join(":");
  if (tls12 === "" && tls13 === "") throw invalidArgValue(`${name}.ciphers`, "is invalid", list);
  if (ecdhCurve !== undefined) validateString(ecdhCurve, `${name}.ecdhCurve`);
  if (sigalgs !== undefined && sigalgs !== null) {
    validateString(sigalgs, `${name}.sigalgs`);
    if (sigalgs === "") throw invalidArgValue(`${name}.sigalgs`, "is invalid", sigalgs);
  }
  if (pfx !== undefined && pfx !== null) throw notSupported("PKCS#12 (the pfx option)");
  /* only TLS 1.3 suites given: only TLS 1.3 (Node's rule) */
  if (tls12 === "" && c._minVersion < 0x0304 && c._maxVersion > 0x0303) c._minVersion = 0x0304;
  const groups = ecdhCurve && ecdhCurve !== "auto" ? ecdhCurve : null;
  const context = tlsContextNew(c._minVersion, c._maxVersion, tls12 || null, (c._secureOptions & SERVER_PREFERENCE) !== 0, groups,
    sigalgs ?? null);
  if (Array.isArray(context)) {
    if (context[2] === "NO_CIPHER_MATCH") throw sslError(0x0A0000B9, "no cipher match");
    throw tlsFailure(context);
  }
  c.context = context;
  if (ca) {
    for (const [i, value] of (Array.isArray(ca) ? ca : [ca]).entries()) {
      validateKeyOrCertOption(`${name}.ca${Array.isArray(ca) ? `[${i}]` : ""}`, value);
      /* what OpenSSL can't read is left out, as Node leaves it */
      for (const der of certificatesOf(value)) addCA(c, der);
    }
  } else {
    addDefaultCAs(c);
  }
  if (cert) {
    const ders = [];
    for (const [i, value] of (Array.isArray(cert) ? cert : [cert]).entries()) {
      validateKeyOrCertOption(`${name}.cert${Array.isArray(cert) ? `[${i}]` : ""}`, value);
      const found = certificatesOf(value);
      if (found.length === 0) throw caLoadError();
      ders.push(...found);
    }
    autoChain(c, ders);
    if (tlsContextSetCert(c.context, ders) !== 0) throw sslError(0x068000A8, "wrong tag", "asn1 encoding routines", "ERR_OSSL_ASN1_WRONG_TAG");
    c._certs = ders;
  }
  if (key) {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
      const pem = k?.pem !== undefined ? k.pem : k;
      const pass = k?.passphrase !== undefined ? k.passphrase : passphrase;
      validateKeyOrCertOption(`${name}.key`, pem);
      if (pass !== undefined && pass !== null) validateString(pass, `${name}.passphrase`);
      let keyObject;
      try {
        keyObject = createPrivateKey(pass === undefined || pass === null ? pem : { key: pem, passphrase: pass });
      } catch (e) {
        if (e.code === "ERR_VISALJS_UNSUPPORTED") throw e;
        throw sslError(0x1E08010C, "unsupported", "DECODER routines", "ERR_OSSL_UNSUPPORTED");
      }
      const r = tlsContextSetKey(c.context, keyObject[kHandle]);
      if (r === 2) throw sslError(0x05800074, "key values mismatch", "x509 certificate routines", "ERR_OSSL_X509_KEY_VALUES_MISMATCH");
      if (r === 1) throw notSupported(`A ${keyObject.asymmetricKeyType} key for TLS`);
    }
  }
}

/* OpenSSL sends a certificate's issuers too when its trust store has them (the `ca` option):
 * the chain given, then each issuer found, up to a self-signed root */
function autoChain(c, ders) {
  if (c._cas.length === 0) return;
  let last;
  try {
    last = parseCertificate(ders[ders.length - 1]);
  } catch {
    return;
  }
  for (let n = 0; n < 10 && Buffer.compare(last.issuerRaw, last.subjectRaw) !== 0; n++) {
    const issuer = c._cas.find((ca) => Buffer.compare(ca.subjectRaw, last.issuerRaw) === 0);
    if (!issuer || ders.some((d) => Buffer.compare(d, issuer.der) === 0)) break;
    ders.push(Buffer.from(issuer.der));
    last = issuer;
  }
}

function addCA(c, der) {
  if (tlsContextAddCA(c.context, der)) return;
  try {
    c._cas.push(parseCertificate(der));
  } catch {
    /* trusted, but not shown in chains */
  }
}

/* the default store: the bundled roots (or setDefaultCACertificates'), and NODE_EXTRA_CA_CERTS */
function addDefaultCAs(c) {
  if (defaults.defaultCA) {
    for (const pem of defaults.defaultCA) for (const der of certificatesOf(pem)) addCA(c, der);
  } else {
    tlsContextAddRoots(c.context);
    c._hasRoots = true;
  }
  for (const der of extraCAs()) addCA(c, der);
}

let extra;
/** NODE_EXTRA_CA_CERTS's certificates (read once) */
export function extraCAs() {
  if (extra !== undefined) return extra;
  extra = [];
  const file = process.env.NODE_EXTRA_CA_CERTS;
  if (file) {
    const text = fsReadFile(file);
    if (typeof text === "string") extra = certificatesOf(text);
    else process.emitWarning(`Ignoring extra certs from \`${file}\`, load failed: error:80000002:system library::No such file or directory`);
  }
  return extra;
}

export function createSecureContext(options) {
  options ||= {};
  const { honorCipherOrder, minVersion, maxVersion, secureProtocol } = options;
  let { secureOptions } = options;
  if (honorCipherOrder) secureOptions |= SERVER_PREFERENCE;
  const c = new SecureContext(secureProtocol, secureOptions, minVersion, maxVersion);
  configure(c, options);
  return c;
}

/** Node's translatePeerCertificate (the legacy objects are built translated already) */
export const translatePeerCertificate = (c) => c || null;
