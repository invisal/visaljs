// X.509 certificates as Node shows them: the legacy object of getPeerCertificate()
// and X509Certificate's toLegacyObject() (OpenSSL's printing: short attribute names, "IP Address:",
// "Oct  6 22:08:31 2026 GMT", colon-separated fingerprints), from a small DER reader of our own.
// PEM bundles split into DER here too, for SecureContext's `ca` and `cert`.
import { cryptoDigestFinal, cryptoDigestUpdate, cryptoHashNew } from "visaljs:host";

/* ---- DER ---------------------------------------------------------------------------------------- */

/** The TLV at `pos`: { tag, pos (its header), start and end (its contents), next }. Definite lengths only. */
export function tlv(der, pos) {
  if (pos + 2 > der.length) throw new Error("truncated DER");
  const tag = der[pos];
  let len = der[pos + 1];
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || start + n > der.length) throw new Error("bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[start + i];
    start += n;
  }
  const end = start + len;
  if (end > der.length) throw new Error("truncated DER");
  return { tag, pos, start, end, next: end };
}

/** The TLVs inside a constructed one. */
export function children(der, node) {
  const out = [];
  for (let pos = node.start; pos < node.end;) {
    const c = tlv(der, pos);
    out.push(c);
    pos = c.next;
  }
  return out;
}

export function oidString(der, node) {
  const parts = [];
  let value = 0;
  for (let i = node.start; i < node.end; i++) {
    value = value * 128 + (der[i] & 0x7f);
    if (!(der[i] & 0x80)) {
      if (parts.length === 0) {
        const first = value < 80 ? Math.floor(value / 40) : 2;
        parts.push(first, value - first * 40);
      } else {
        parts.push(value);
      }
      value = 0;
    }
  }
  return parts.join(".");
}

const hexOf = (bytes) => Buffer.from(bytes).toString("hex");

/* ---- Names -------------------------------------------------------------------------------------- */

/* OpenSSL's short names for the attributes it knows */
const ATTRIBUTE_NAMES = {
  "2.5.4.3": "CN", "2.5.4.4": "SN", "2.5.4.5": "serialNumber", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST",
  "2.5.4.9": "street", "2.5.4.10": "O", "2.5.4.11": "OU", "2.5.4.12": "title", "2.5.4.13": "description",
  "2.5.4.15": "businessCategory", "2.5.4.17": "postalCode", "2.5.4.41": "name", "2.5.4.42": "GN", "2.5.4.43": "initials",
  "2.5.4.44": "generationQualifier", "2.5.4.46": "dnQualifier", "2.5.4.65": "pseudonym", "2.5.4.97": "organizationIdentifier",
  "1.2.840.113549.1.9.1": "emailAddress", "0.9.2342.19200300.100.1.25": "DC", "0.9.2342.19200300.100.1.1": "UID",
  "1.3.6.1.4.1.311.60.2.1.1": "jurisdictionL", "1.3.6.1.4.1.311.60.2.1.2": "jurisdictionST",
  "1.3.6.1.4.1.311.60.2.1.3": "jurisdictionC",
};

/* A string value: UTF8String, PrintableString, IA5String, T61String (Latin-1), BMPString */
function stringValue(der, node) {
  const bytes = der.subarray(node.start, node.end);
  switch (node.tag) {
    case 0x1e: {  /* BMPString: UTF-16BE */
      let s = "";
      for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] << 8 | bytes[i + 1]);
      return s;
    }
    case 0x14: return Buffer.from(bytes).toString("latin1");
    default: return Buffer.from(bytes).toString("utf8");
  }
}

/** A Name as [[shortName or OID, value], …], in order. */
function nameEntries(der, node) {
  const out = [];
  for (const set of children(der, node)) {
    for (const attr of children(der, set)) {
      const [oid, value] = children(der, attr);
      const id = oidString(der, oid);
      out.push([ATTRIBUTE_NAMES[id] ?? id, stringValue(der, value)]);
    }
  }
  return out;
}

/** The legacy object of a Name: a null-prototype object, repeated attributes as arrays. */
function nameObject(entries) {
  const o = { __proto__: null };
  for (const [k, v] of entries) {
    if (!(k in o)) o[k] = v;
    else if (Array.isArray(o[k])) o[k].push(v);
    else o[k] = [o[k], v];
  }
  return o;
}

/* OpenSSL's one-line form ("C=PT\nO=…"), as X509Certificate's subject shows it */
const nameString = (entries) => entries.map(([k, v]) => k + "=" + v).join("\n");

/* ---- Alt names ---------------------------------------------------------------------------------- */

/* Node's rule: a value that could be misread when the list is split is JSON-quoted */
function safeAltName(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x2c || c === 0x27 || c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

/* Node's escaping: quotes and backslashes escaped, anything else unsafe as \uXXXX */
function escapeAltName(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) out += "\\" + s[i];
    else if (c === 0x2c || c === 0x27 || c < 0x20 || c === 0x7f) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}

const quoteAltName = (s) => (safeAltName(s) ? s : escapeAltName(s));

function ipString(bytes) {
  if (bytes.length === 4) return Array.from(bytes).join(".");
  if (bytes.length === 16) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16).toUpperCase());
    return groups.join(":");
  }
  return "<invalid>";
}

/** A GeneralName as OpenSSL prints it ("DNS:localhost", "IP Address:127.0.0.1", …) */
function generalName(der, node) {
  const bytes = der.subarray(node.start, node.end);
  switch (node.tag) {
    case 0x81: return "email:" + quoteAltName(Buffer.from(bytes).toString("latin1"));
    case 0x82: return "DNS:" + quoteAltName(Buffer.from(bytes).toString("latin1"));
    case 0x86: return "URI:" + quoteAltName(Buffer.from(bytes).toString("latin1"));
    case 0x87: return "IP Address:" + ipString(bytes);
    case 0x88: return "Registered ID:" + oidString(der, node);
    case 0xa4: {
      const name = tlv(der, node.start);
      /* RFC 2253's order: the last attribute first */
      return "DirName:" + quoteAltName(nameEntries(der, name).reverse().map(([k, v]) => k + "=" + v).join(","));
    }
    default: return "othername:<unsupported>";
  }
}

const ACCESS_METHODS = { "1.3.6.1.5.5.7.48.1": "OCSP", "1.3.6.1.5.5.7.48.2": "CA Issuers" };

const GENERAL_NAME_TYPES = { 0x81: "email", 0x82: "DNS", 0x86: "URI", 0x87: "IP Address" };

/* ---- Times -------------------------------------------------------------------------------------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** UTCTime or GeneralizedTime → a Date */
function timeValue(der, node) {
  const s = Buffer.from(der.subarray(node.start, node.end)).toString("latin1");
  const m = node.tag === 0x17 ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s) : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?(?:\.\d+)?Z$/.exec(s);
  if (!m) return new Date(NaN);
  let year = +m[1];
  if (node.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return new Date(Date.UTC(year, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)));
}

const pad2 = (n) => String(n).padStart(2, "0");

/** "Oct  6 22:08:31 2026 GMT" (OpenSSL's ASN1_TIME_print) */
export const opensslTime = (d) =>
  `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`;

/* ---- Keys --------------------------------------------------------------------------------------- */

const CURVES = {
  "1.2.840.10045.3.1.7": ["prime256v1", "P-256", 256],
  "1.3.132.0.34": ["secp384r1", "P-384", 384],
  "1.3.132.0.35": ["secp521r1", "P-521", 521],
  "1.3.132.0.10": ["secp256k1", undefined, 256],
};

const stripZeros = (bytes) => {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return bytes.subarray(i);
};

function bitLength(bytes) {
  const b = stripZeros(bytes);
  if (b.length === 0 || (b.length === 1 && b[0] === 0)) return 0;
  return (b.length - 1) * 8 + (32 - Math.clz32(b[0]));
}

/* ---- Certificates ------------------------------------------------------------------------------- */

const digest = (alg, data) => {
  const h = cryptoHashNew(alg, -1);
  cryptoDigestUpdate(h, data);
  return cryptoDigestFinal(h);
};

/** "AB:CD:…" */
export const fingerprint = (alg, der) => digest(alg, der).toString("hex").toUpperCase().replace(/(..)(?!$)/g, "$1:");

/** A certificate's parts, from its DER. Throws on DER it can't read. */
export function parseCertificate(raw) {
  const der = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const cert = tlv(der, 0);
  const [tbs, sigAlg] = children(der, cert);
  const fields = children(der, tbs);
  let i = 0;
  let version = 1;
  if (fields[0].tag === 0xa0) {
    version = der[children(der, fields[0])[0].start] + 1;
    i = 1;
  }
  const serial = fields[i];
  const issuer = fields[i + 2];
  const [notBefore, notAfter] = children(der, fields[i + 3]);
  const subject = fields[i + 4];
  const spki = fields[i + 5];
  const out = {
    der,
    version,
    serialNumber: hexOf(stripZeros(der.subarray(serial.start, serial.end))).toUpperCase().replace(/^00$/, "0"),
    issuer: nameEntries(der, issuer),
    subject: nameEntries(der, subject),
    validFrom: timeValue(der, notBefore),
    validTo: timeValue(der, notAfter),
    spki: der.subarray(spki.pos, spki.end),
    issuerRaw: der.subarray(issuer.pos, issuer.end),
    subjectRaw: der.subarray(subject.pos, subject.end),
    signatureAlgorithm: oidString(der, children(der, sigAlg)[0]),
    key: null,
    ca: false,
    pathLength: undefined,
    altNames: null,
    infoAccess: null,
    extKeyUsage: null,
    keyUsage: null,
  };
  /* the key */
  const [alg, bits] = children(der, spki);
  const [algOid, params] = children(der, alg);
  const keyOid = oidString(der, algOid);
  const keyBytes = der.subarray(bits.start + 1, bits.end);
  if (keyOid === "1.2.840.113549.1.1.1" || keyOid === "1.2.840.113549.1.1.10") {
    const [n, e] = children(keyBytes, tlv(keyBytes, 0)).map((c) => keyBytes.subarray(c.start, c.end));
    out.key = { type: keyOid.endsWith(".1") ? "rsa" : "rsa-pss", n: stripZeros(n), e: stripZeros(e) };
  } else if (keyOid === "1.2.840.10045.2.1") {
    const curve = params && params.tag === 0x06 ? CURVES[oidString(der, params)] : undefined;
    out.key = { type: "ec", point: keyBytes, curve };
  } else if (keyOid === "1.3.101.112" || keyOid === "1.3.101.113") {
    out.key = { type: keyOid.endsWith("112") ? "ed25519" : "ed448", point: keyBytes };
  }
  /* the extensions */
  for (const f of fields.slice(i + 6)) {
    if (f.tag !== 0xa3) continue;
    for (const ext of children(der, tlv(der, f.start))) {
      const parts = children(der, ext);
      const id = oidString(der, parts[0]);
      const value = parts[parts.length - 1];
      const inner = tlv(der, value.start);
      try {
        switch (id) {
          case "2.5.29.19": {  /* basicConstraints */
            const bc = children(der, inner);
            out.ca = bc.length > 0 && bc[0].tag === 0x01 && der[bc[0].start] !== 0;
            const len = bc.find((c) => c.tag === 0x02);
            if (len) out.pathLength = der.subarray(len.start, len.end).reduce((a, b) => a * 256 + b, 0);
            break;
          }
          case "2.5.29.17":  /* subjectAltName */
            out.altNames = children(der, inner).map((g) => ({ text: generalName(der, g), type: GENERAL_NAME_TYPES[g.tag], value: der.subarray(g.start, g.end) }));
            break;
          case "1.3.6.1.5.5.7.1.1":  /* authorityInfoAccess */
            out.infoAccess = children(der, inner).map((ad) => {
              const [method, location] = children(der, ad);
              const m = oidString(der, method);
              return (ACCESS_METHODS[m] ?? m) + " - " + generalName(der, location);
            });
            break;
          case "2.5.29.37":  /* extKeyUsage */
            out.extKeyUsage = children(der, inner).map((o) => oidString(der, o));
            break;
          case "2.5.29.15": {  /* keyUsage */
            const unused = der[inner.start];
            let bitsSet = 0;
            const bytes = der.subarray(inner.start + 1, inner.end);
            for (let b = 0; b < bytes.length * 8 - unused; b++) if (bytes[b >> 3] & (0x80 >> (b & 7))) bitsSet |= 1 << b;
            out.keyUsage = bitsSet;
            break;
          }
        }
      } catch {
        /* an extension we can't read is left out, as OpenSSL leaves it */
      }
    }
  }
  return out;
}

/** "DNS:a, IP Address:1.2.3.4" */
export const altNamesString = (cert) => (cert.altNames ? cert.altNames.map((n) => n.text).join(", ") : undefined);

/** Node's legacy certificate object (getPeerCertificate, toLegacyObject) */
export function legacyObject(cert) {
  const o = {};
  o.subject = nameObject(cert.subject);
  o.issuer = nameObject(cert.issuer);
  const alt = altNamesString(cert);
  if (alt !== undefined) o.subjectaltname = alt;
  if (cert.infoAccess) o.infoAccess = infoAccessObject(cert.infoAccess);
  o.ca = cert.ca;
  const key = cert.key;
  if (key && (key.type === "rsa" || key.type === "rsa-pss")) {
    o.modulus = hexOf(key.n).toUpperCase();
    o.bits = bitLength(key.n);
    o.exponent = "0x" + hexOf(key.e).replace(/^0+(?=.)/, "");
    o.pubkey = Buffer.from(cert.spki);
  } else if (key && key.type === "ec") {
    if (key.curve) o.bits = key.curve[2];
    o.pubkey = Buffer.from(key.point);
    if (key.curve) {
      o.asn1Curve = key.curve[0];
      if (key.curve[1]) o.nistCurve = key.curve[1];
    }
  }
  o.valid_from = opensslTime(cert.validFrom);
  o.valid_to = opensslTime(cert.validTo);
  o.fingerprint = fingerprint("sha1", cert.der);
  o.fingerprint256 = fingerprint("sha256", cert.der);
  o.fingerprint512 = fingerprint("sha512", cert.der);
  if (cert.extKeyUsage) o.ext_key_usage = cert.extKeyUsage;
  o.serialNumber = cert.serialNumber;
  o.raw = Buffer.from(cert.der);
  return o;
}

/* Node's translatePeerCertificate: "OCSP - URI:http://…" lines as { "OCSP - URI": [ … ] } */
function infoAccessObject(lines) {
  const o = { __proto__: null };
  for (const line of lines) {
    const at = line.indexOf(":");
    const key = line.slice(0, at);
    let val = line.slice(at + 1);
    if (val.charCodeAt(0) === 0x22) val = JSON.parse(val);
    (o[key] ??= []).push(val);
  }
  return o;
}

export { nameString, nameObject };

/** Whether `issuer` issued `cert` (by name: the chain building OpenSSL starts with) */
export const issuedBy = (cert, issuer) => Buffer.compare(cert.issuerRaw, issuer.subjectRaw) === 0;

/* ---- PEM ---------------------------------------------------------------------------------------- */

/** Every block of a label in PEM text, as DER Buffers */
export function pemBlocks(text, label) {
  const out = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----\r?\n([\s\S]*?)-----END \1-----/g;
  for (let m; (m = re.exec(text)) !== null;) if (label === undefined || m[1] === label || (label === "CERTIFICATE" && m[1] === "TRUSTED CERTIFICATE")) out.push(Buffer.from(m[2], "base64"));
  return out;
}

/** A certificate option (`ca`, `cert`): PEM text (one or more) or DER, as DER Buffers */
export function certificatesOf(value) {
  if (typeof value === "string") return pemBlocks(value, "CERTIFICATE");
  const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (buf.length && buf[0] === 0x30) return [buf];
  return pemBlocks(buf.toString("latin1"), "CERTIFICATE");
}

/** DER → PEM */
export const toPem = (der, label = "CERTIFICATE") =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END ${label}-----\n`;
