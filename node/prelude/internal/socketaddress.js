// net.SocketAddress and net.BlockList (Node's lib/internal/socketaddress.js and blocklist.js,
// whose C++ side is here in JS): an address is its bytes, 4 or 16; an IPv4 address checked
// against an IPv6 rule, or the reverse, compares as an IPv4-mapped IPv6 address (::ffff:a.b.c.d).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { codeError, invalidArgType, invalidArgValue, outOfRange, validateString } from "./errors.js";
import { isIPv4, isIPv6 } from "./net.js";

const kInspect = Symbol.for("nodejs.util.inspect.custom");

/* "1.2.3.4" → 4 bytes */
function parseIPv4(s) {
  return s.split(".").map(Number);
}

/* "2001:db8::1" (an IPv4 tail, a zone id ignored) → 16 bytes */
function parseIPv6(s) {
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  let tail = [];
  const lastColon = s.lastIndexOf(":");
  if (s.indexOf(".", lastColon) !== -1) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1);  /* "::ffff:" → "::ffff", "::" stays */
    if (!s.endsWith("::")) s = s.slice(0, -1);
  }
  const halves = s.split("::");
  const groups = (part) => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  let words;
  if (halves.length === 2) {
    const head = groups(halves[0]);
    const rest = groups(halves[1]).concat(tail);
    words = head.concat(new Array(8 - head.length - rest.length).fill(0), rest);
  } else {
    words = groups(halves[0]).concat(tail);
  }
  const bytes = [];
  for (const w of words) bytes.push(w >> 8, w & 0xff);
  return bytes;
}

/* 16 bytes → RFC 5952 text: lower case, the longest run of zero groups (two or more) as "::" */
function formatIPv6(bytes) {
  const words = [];
  for (let i = 0; i < 16; i += 2) words.push((bytes[i] << 8) | bytes[i + 1]);
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen && j - i > 1) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  /* ::ffff:a.b.c.d and ::a.b.c.d keep their IPv4 tail, as inet_ntop writes them */
  if (best === 0 && (bestLen === 6 || (bestLen === 5 && words[5] === 0xffff))) {
    const v4 = bytes.slice(12).join(".");
    return bestLen === 6 ? "::" + v4 : "::ffff:" + v4;
  }
  const hex = (from, to) => words.slice(from, to).map((w) => w.toString(16)).join(":");
  if (best === -1) return hex(0, 8);
  return hex(0, best) + "::" + hex(best + bestLen, 8);
}

/* the bytes of an address of the given family, or null when it isn't one */
function addressBytes(address, family) {
  if (family === "ipv4") return isIPv4(address) ? parseIPv4(address) : null;
  return isIPv6(address) ? parseIPv6(address) : null;
}

const v4Mapped = (bytes) => (bytes.length === 16 ? bytes : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff].concat(bytes));

function compare(a, b) {
  if (a.length !== b.length) {
    a = v4Mapped(a);
    b = v4Mapped(b);
  }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function inNetwork(bytes, network, prefix) {
  if (bytes.length !== network.length) {
    if (network.length === 4) prefix += 96;
    bytes = v4Mapped(bytes);
    network = v4Mapped(network);
  }
  for (let i = 0; i < bytes.length && prefix > 0; i++, prefix -= 8) {
    const mask = prefix >= 8 ? 0xff : (0xff << (8 - prefix)) & 0xff;
    if ((bytes[i] & mask) !== (network[i] & mask)) return false;
  }
  return true;
}

function validatePort(port, name) {
  if ((typeof port !== "number" && typeof port !== "string") || (typeof port === "string" && port.trim().length === 0) ||
    +port !== (+port >>> 0) || port > 0xffff) {
    throw codeError(RangeError, "ERR_SOCKET_BAD_PORT", name + " should be >= 0 and < 65536. Received " +
      (typeof port === "string" ? "type string ('" + port + "')" : typeof port === "number" ? "type number (" + port + ")" : String(port)) + ".");
  }
}

const kDetail = Symbol("kDetail");

export class SocketAddress {
  static isSocketAddress(value) {
    return value?.[kDetail] !== undefined;
  }

  constructor(options = {}) {
    if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
    let { family = "ipv4" } = options;
    const { address = family === "ipv4" ? "127.0.0.1" : "::", port = 0, flowlabel = 0 } = options;
    if (typeof family?.toLowerCase === "function") family = family.toLowerCase();
    if (family !== "ipv4" && family !== "ipv6") throw invalidArgValue("options.family", "is invalid", options.family);
    validateString(address, "options.address");
    validatePort(port, "options.port");
    if (typeof flowlabel !== "number") throw invalidArgType("options.flowlabel", "of type number", flowlabel);
    if (!Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 4294967295) throw outOfRange("options.flowlabel", ">= 0 && <= 4294967295", flowlabel);
    const bytes = addressBytes(address, family);
    if (bytes === null) throw codeError(Error, "ERR_INVALID_ADDRESS", "Invalid socket address");
    this[kDetail] = {
      bytes,
      address: family === "ipv4" ? bytes.join(".") : formatIPv6(bytes),
      port: port | 0,
      family,
      flowlabel: family === "ipv6" ? flowlabel | 0 : 0,
    };
  }

  get address() {
    return this[kDetail].address;
  }

  get port() {
    return this[kDetail].port;
  }

  get family() {
    return this[kDetail].family;
  }

  get flowlabel() {
    return this[kDetail].flowlabel;
  }

  [kInspect](depth, options, inspect) {
    if (depth < 0) return this;
    const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
    return "SocketAddress " + inspect(this.toJSON(), opts);
  }

  toJSON() {
    return { address: this.address, port: this.port, family: this.family, flowlabel: this.flowlabel };
  }

  /* "1.2.3.4:80", "[::1]:80" → a SocketAddress, or undefined */
  static parse(input) {
    validateString(input, "input");
    try {
      const { hostname: address, port } = new URL("http://" + input);
      if (address.startsWith("[") && address.endsWith("]")) return new SocketAddress({ address: address.slice(1, -1), port: port | 0, family: "ipv6" });
      return new SocketAddress({ address, port: port | 0 });
    } catch {
      return undefined;
    }
  }
}

const familyName = (sa) => (sa.family === "ipv4" ? "IPv4" : "IPv6");

function toSocketAddress(value, name, family) {
  if (SocketAddress.isSocketAddress(value)) return value;
  validateString(value, name);
  validateString(family, "family");
  return new SocketAddress({ address: value, family });
}

const kRules = Symbol("kRules");

export class BlockList {
  constructor() {
    this[kRules] = [];  /* newest first, as Node lists them: addresses, then subnets, then ranges */
  }

  static isBlockList(value) {
    return value?.[kRules] !== undefined;
  }

  [kInspect](depth, options, inspect) {
    if (depth < 0) return this;
    const opts = { ...options, depth: options.depth == null ? null : options.depth - 1 };
    return "BlockList " + inspect({ rules: this.rules }, opts);
  }

  addAddress(address, family = "ipv4") {
    const sa = toSocketAddress(address, "address", family);
    const bytes = sa[kDetail].bytes;
    const text = "Address: " + familyName(sa) + " " + sa.address;
    if (this[kRules].some((rule) => rule.text === text)) return;  /* once each, as Node 24 keeps them */
    this[kRules].unshift({ kind: 0, text, test: (b) => compare(b, bytes) === 0 });
  }

  addRange(start, end, family = "ipv4") {
    const from = toSocketAddress(start, "start", family);
    const to = toSocketAddress(end, "end", family);
    const a = from[kDetail].bytes, b = to[kDetail].bytes;
    if (compare(a, b) > 0) throw invalidArgValue("start", "must come before end", from);
    this[kRules].unshift({
      kind: 2,
      text: "Range: " + familyName(from) + " " + from.address + "-" + to.address,
      test: (x) => compare(x, a) >= 0 && compare(x, b) <= 0,
    });
  }

  addSubnet(network, prefix, family = "ipv4") {
    const sa = toSocketAddress(network, "network", family);
    const max = sa.family === "ipv4" ? 32 : 128;
    if (typeof prefix !== "number") throw invalidArgType("prefix", "of type number", prefix);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw outOfRange("prefix", ">= 0 && <= " + max, prefix);
    const bytes = sa[kDetail].bytes;
    this[kRules].unshift({ kind: 1, text: "Subnet: " + familyName(sa) + " " + sa.address + "/" + prefix, test: (x) => inNetwork(x, bytes, prefix) });
  }

  check(address, family = "ipv4") {
    let sa;
    if (SocketAddress.isSocketAddress(address)) sa = address;
    else {
      validateString(address, "address");
      validateString(family, "family");
      try {
        sa = new SocketAddress({ address, family });
      } catch {
        return false;
      }
    }
    const bytes = sa[kDetail].bytes;
    return this[kRules].some((rule) => rule.test(bytes));
  }

  get rules() {
    return this[kRules].toSorted((a, b) => a.kind - b.kind).map((rule) => rule.text);
  }

  toJSON() {
    return this.rules;
  }
}
