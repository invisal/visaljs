// crypto.X509Certificate (Node's lib/internal/crypto/x509.js): what it shows comes from our DER
// reader (internal/tls/x509.js, OpenSSL's printing); the checks are BoringSSL's X509 functions.
// A feature module (internal/features.js): linked into programs that name the class.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { x509Check, x509CheckIssued, x509CheckKey } from "visaljs:host";
import { X509Certificate as X509CertificateWrapper } from "../crypto.js";
import { inspect } from "../util.js";
import { codeError, invalidArgType, invalidArgValue, validateString } from "./errors.js";
import { features, provideClass } from "./features.js";
import { altNamesString, certificatesOf, fingerprint, legacyObject, nameString, opensslTime, parseCertificate, toPem } from "./tls/x509.js";
import { createPublicKey, KeyObject } from "./crypto/keys.js";
import { kHandle } from "./crypto/util.js";

/* BoringSSL's X509_CHECK_FLAG_*: it has no multi-label wildcards or single-label subdomains, and
 * always checks the subject when a certificate has no names of the kind */
const NO_WILDCARDS = 0x2, NEVER_CHECK_SUBJECT = 0x20;

/* OpenSSL's long names (OBJ_nid2ln) of the signature algorithms certificates use */
const SIGNATURE_ALGORITHMS = {
  "1.2.840.113549.1.1.4": "md5WithRSAEncryption", "1.2.840.113549.1.1.5": "sha1WithRSAEncryption",
  "1.2.840.113549.1.1.10": "rsassaPss", "1.2.840.113549.1.1.11": "sha256WithRSAEncryption",
  "1.2.840.113549.1.1.12": "sha384WithRSAEncryption", "1.2.840.113549.1.1.13": "sha512WithRSAEncryption",
  "1.2.840.113549.1.1.14": "sha224WithRSAEncryption", "1.2.840.10045.4.1": "ecdsa-with-SHA1",
  "1.2.840.10045.4.3.1": "ecdsa-with-SHA224", "1.2.840.10045.4.3.2": "ecdsa-with-SHA256",
  "1.2.840.10045.4.3.3": "ecdsa-with-SHA384", "1.2.840.10045.4.3.4": "ecdsa-with-SHA512", "1.3.101.112": "ED25519",
  "1.3.101.113": "ED448",
};

const kCert = Symbol("kCert");
const kIssuer = Symbol("kIssuer");
const kCache = Symbol("kCache");

const noCertificate = () => codeError(Error, "ERR_OSSL_PEM_NO_START_LINE", "error:0480006C:PEM routines::no start line");

function checkFlags(options = {}) {
  if (typeof options !== "object" || options === null || Array.isArray(options)) throw invalidArgType("options", "of type object", options);
  const { subject = "default", wildcards = true, partialWildcards = true, multiLabelWildcards = false, singleLabelSubdomains = false } = options;
  validateString(subject, "options.subject");
  for (const [name, value] of [["wildcards", wildcards], ["partialWildcards", partialWildcards], ["multiLabelWildcards", multiLabelWildcards],
    ["singleLabelSubdomains", singleLabelSubdomains]]) {
    if (typeof value !== "boolean") throw invalidArgType(`options.${name}`, "of type boolean", value);
  }
  let flags = 0;
  switch (subject) {
    case "default":
    case "always":
      break;
    case "never":
      flags |= NEVER_CHECK_SUBJECT;
      break;
    default:
      throw invalidArgValue("options.subject", "is invalid", subject);
  }
  if (!wildcards) flags |= NO_WILDCARDS;
  return flags;
}

export function isX509Certificate(value) {
  return value?.[kCert] !== undefined;
}

class X509Certificate {
  constructor(buffer) {
    if (typeof buffer === "string") buffer = Buffer.from(buffer);
    if (!ArrayBuffer.isView(buffer)) throw invalidArgType("buffer", "of type string or an instance of Buffer, TypedArray, or DataView", buffer);
    const der = certificatesOf(buffer)[0];
    if (der === undefined) throw noCertificate();
    let cert;
    try {
      cert = parseCertificate(der);
    } catch {
      throw codeError(Error, "ERR_OSSL_ASN1_HEADER_TOO_LONG", "error:0680007B:asn1 encoding routines::header too long");
    }
    this[kCert] = cert;
    this[kIssuer] = undefined;
    this[kCache] = new Map();
  }

  #cached(name, compute) {
    const cache = this[kCache];
    if (!cache.has(name)) cache.set(name, compute(this[kCert]));
    return cache.get(name);
  }

  [inspect.custom](depth, options) {
    if (depth < 0) return this;
    const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
    return `X509Certificate ${inspect({
      subject: this.subject, subjectAltName: this.subjectAltName, issuer: this.issuer, infoAccess: this.infoAccess,
      validFrom: this.validFrom, validTo: this.validTo, validFromDate: this.validFromDate, validToDate: this.validToDate,
      fingerprint: this.fingerprint, fingerprint256: this.fingerprint256, fingerprint512: this.fingerprint512, keyUsage: this.keyUsage,
      serialNumber: this.serialNumber, signatureAlgorithm: this.signatureAlgorithm, signatureAlgorithmOid: this.signatureAlgorithmOid,
    }, opts)}`;
  }

  get subject() { return this.#cached("subject", (c) => nameString(c.subject)); }
  get subjectAltName() { return this.#cached("subjectAltName", altNamesString); }
  get issuer() { return this.#cached("issuer", (c) => nameString(c.issuer)); }
  get issuerCertificate() { return this[kIssuer]; }
  get infoAccess() { return this.#cached("infoAccess", (c) => c.infoAccess?.join("\n")); }
  get validFrom() { return this.#cached("validFrom", (c) => opensslTime(c.validFrom)); }
  get validTo() { return this.#cached("validTo", (c) => opensslTime(c.validTo)); }
  get validFromDate() { return this.#cached("validFromDate", (c) => new Date(c.validFrom)); }
  get validToDate() { return this.#cached("validToDate", (c) => new Date(c.validTo)); }
  get fingerprint() { return this.#cached("fingerprint", (c) => fingerprint("sha1", c.der)); }
  get fingerprint256() { return this.#cached("fingerprint256", (c) => fingerprint("sha256", c.der)); }
  get fingerprint512() { return this.#cached("fingerprint512", (c) => fingerprint("sha512", c.der)); }
  /* Node's keyUsage: the extended key usages' OIDs */
  get keyUsage() { return this.#cached("keyUsage", (c) => c.extKeyUsage ?? undefined); }
  get serialNumber() { return this.#cached("serialNumber", (c) => c.serialNumber); }
  get signatureAlgorithm() { return this.#cached("signatureAlgorithm", (c) => SIGNATURE_ALGORITHMS[c.signatureAlgorithm]); }
  get signatureAlgorithmOid() { return this.#cached("signatureAlgorithmOid", (c) => c.signatureAlgorithm); }
  get raw() { return this.#cached("raw", (c) => Buffer.from(c.der)); }
  get publicKey() { return this.#cached("publicKey", (c) => createPublicKey({ key: Buffer.from(c.spki), format: "der", type: "spki" })); }
  get ca() { return this.#cached("ca", (c) => c.ca); }

  toString() { return this.#cached("pem", (c) => toPem(c.der)); }
  toJSON() { return this.toString(); }
  toLegacyObject() { return legacyObject(this[kCert]); }

  checkHost(name, options) {
    validateString(name, "name");
    return x509Check(this[kCert].der, 0, name, checkFlags(options));
  }

  checkEmail(email, options) {
    validateString(email, "email");
    return x509Check(this[kCert].der, 1, email, checkFlags(options));
  }

  checkIP(ip, options) {
    validateString(ip, "ip");
    return x509Check(this[kCert].der, 2, ip, checkFlags(options));
  }

  checkIssued(otherCert) {
    if (!isX509Certificate(otherCert)) throw invalidArgType("otherCert", "an instance of X509Certificate", otherCert);
    return x509CheckIssued(this[kCert].der, otherCert[kCert].der);
  }

  checkPrivateKey(pkey) {
    if (!(pkey instanceof KeyObject)) throw invalidArgType("pkey", "an instance of KeyObject", pkey);
    if (pkey.type !== "private") throw invalidArgValue("pkey", "is invalid", pkey);
    return x509CheckKey(this[kCert].der, pkey[kHandle]);
  }

  verify(pkey) {
    if (!(pkey instanceof KeyObject)) throw invalidArgType("pkey", "an instance of KeyObject", pkey);
    if (pkey.type !== "public") throw invalidArgValue("pkey", "is invalid", pkey);
    return x509CheckKey(this[kCert].der, pkey[kHandle]);
  }
}

provideClass(X509CertificateWrapper, X509Certificate);

/* a chain's first certificate, each one's issuerCertificate the next (getPeerX509Certificate) */
features.x509CertificateChain = (ders) => {
  const certs = ders.map((der) => new X509Certificate(der));
  for (let i = 0; i + 1 < certs.length; i++) certs[i][kIssuer] = certs[i + 1];
  return certs[0];
};
