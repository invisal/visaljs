// node:dns (Node's lib/dns.js, and dns.promises as lib/internal/dns/promises.js): lookup through
// getaddrinfo on libuv's thread pool, as Node's is; lookupService through getnameinfo; Resolver
// and the resolve* functions through c-ares (internal/dns_resolver.js, linked into programs that
// name them).
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import { dnsLookup, dnsLookupService, errnoName } from "visaljs:host";
import { bindContext } from "./internal/async_context.js";
import { codeError, invalidArgType, invalidArgValue, validateFunction, validateString } from "./internal/errors.js";
import { PromisesResolver, Resolver } from "./internal/dns_classes.js";
import { lazyFunction } from "./internal/features.js";
import { isIP } from "./internal/net.js";

/* getaddrinfo's hints (Node's AI_*), and the error codes of the resolver */
export const ADDRCONFIG = 1024;
export const V4MAPPED = 2048;
export const ALL = 256;
export const NODATA = "ENODATA";
export const FORMERR = "EFORMERR";
export const SERVFAIL = "ESERVFAIL";
export const NOTFOUND = "ENOTFOUND";
export const NOTIMP = "ENOTIMP";
export const REFUSED = "EREFUSED";
export const BADQUERY = "EBADQUERY";
export const BADNAME = "EBADNAME";
export const BADFAMILY = "EBADFAMILY";
export const BADRESP = "EBADRESP";
export const CONNREFUSED = "ECONNREFUSED";
export const TIMEOUT = "ETIMEOUT";
export const EOF = "EOF";
export const FILE = "EFILE";
export const NOMEM = "ENOMEM";
export const DESTRUCTION = "EDESTRUCTION";
export const BADSTR = "EBADSTR";
export const BADFLAGS = "EBADFLAGS";
export const NONAME = "ENONAME";
export const BADHINTS = "EBADHINTS";
export const NOTINITIALIZED = "ENOTINITIALIZED";
export const LOADIPHLPAPI = "ELOADIPHLPAPI";
export const ADDRGETNETWORKPARAMS = "EADDRGETNETWORKPARAMS";
export const CANCELLED = "ECANCELLED";

/** Node's DNSException: a libuv errno (its name when the host gives it: libuv's for getaddrinfo's EAI_*;
 *  EAI_NODATA and EAI_NONAME are ENOTFOUND), or a c-ares code */
function dnsException(code, syscall, hostname, name = undefined) {
  let errno;
  if (typeof code === "number") {
    errno = code;
    code = name ?? errnoName(code);
    if (code === "EAI_NODATA" || code === "EAI_NONAME") code = "ENOTFOUND";
  }
  const error = new Error(`${syscall} ${code}${hostname ? ` ${hostname}` : ""}`);
  error.errno = errno;
  error.code = code;
  error.syscall = syscall;
  if (hostname) error.hostname = hostname;
  return error;
}

/* ---- validation (Node's internal/validators, as dns uses them) ------------------------------ */

const validDnsOrders = ["verbatim", "ipv4first", "ipv6first"];
const validFamilies = [0, 4, 6];

function validateOneOf(value, name, oneOf) {
  if (!oneOf.includes(value)) {
    const allowed = oneOf.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(", ");
    throw invalidArgValue(name, `must be one of: ${allowed}`, value);
  }
}

function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw invalidArgType(name, "of type boolean", value);
}

function validateStringWithoutNullBytes(value, name) {
  validateString(value, name);
  if (value.includes("\u0000")) throw invalidArgValue(name, "must be a string without null bytes", value);
}

function validatePort(port, name = "Port") {
  if ((typeof port !== "number" && typeof port !== "string") || (typeof port === "string" && port.trim().length === 0) ||
      +port !== (+port >>> 0) || port > 0xFFFF) {
    throw codeError(RangeError, "ERR_SOCKET_BAD_PORT",
      `${name} should be >= 0 and < 65536. Received ${typeof port === "string" ? `type string ('${port}')` : `type number (${port})`}.`);
  }
}

function validateHints(hints) {
  if ((hints & ~(ADDRCONFIG | ALL | V4MAPPED)) !== 0) throw invalidArgValue("hints", "is invalid", hints);
}

let invalidHostnameWarningEmitted = false;
function emitInvalidHostnameWarning(hostname) {
  if (invalidHostnameWarningEmitted) return;
  process.emitWarning(`The provided hostname "${hostname}" is not a valid hostname, and is supported in the dns module solely for compatibility.`,
    "DeprecationWarning", "DEP0118");
  invalidHostnameWarningEmitted = true;
}

let dnsOrder = "verbatim";

export function setDefaultResultOrder(value) {
  validateOneOf(value, "dnsOrder", validDnsOrders);
  dnsOrder = value;
}

export function getDefaultResultOrder() {
  return dnsOrder;
}

/* ---- lookup and lookupService ------------------------------------------------------------- */

/* lookup's options → [family, all, hints, order] (Node's argument parsing) */
function lookupOptions(options) {
  let family = 0, all = false, hints = 0, order = dnsOrder;
  if (typeof options === "number") {
    validateOneOf(options, "family", validFamilies);
    return [options + 0, all, hints, order];
  }
  if (options?.hints != null) {
    if (typeof options.hints !== "number") throw invalidArgType("options.hints", "of type number", options.hints);
    hints = options.hints >>> 0;
    validateHints(hints);
  }
  if (options?.family != null) {
    if (options.family === "IPv4") family = 4;
    else if (options.family === "IPv6") family = 6;
    else {
      validateOneOf(options.family, "options.family", validFamilies);
      family = options.family + 0;
    }
  }
  if (options?.all != null) {
    validateBoolean(options.all, "options.all");
    all = options.all;
  }
  if (options?.verbatim != null) {
    validateBoolean(options.verbatim, "options.verbatim");
    order = options.verbatim ? "verbatim" : "ipv4first";
  }
  if (options?.order != null) {
    validateOneOf(options.order, "options.order", validDnsOrders);
    order = options.order;
  }
  return [family, all, hints, order];
}

/* getaddrinfo's addresses in the order asked for (Node's sorts them in C, stably) */
function ordered(list, order) {
  if (order === "verbatim") return list;
  const first = order === "ipv4first" ? 4 : 6;
  return [...list.filter(([, f]) => f === first), ...list.filter(([, f]) => f !== first)];
}

/* getaddrinfo: done(error | null, [[address, family], …]); the hostname is neither empty nor an IP */
function getaddrinfo(hostname, family, order, done) {
  const r = dnsLookup(hostname, family, bindContext((errno, code, list) => {
    if (errno) done(dnsException(errno, "getaddrinfo", hostname, code));
    else done(null, ordered(list, order));
  }));
  if (r < 0) process.nextTick(done, dnsException(r, "getaddrinfo", hostname));
}

/** lookup(hostname[, options | family], callback): callback(err, address, family), or with
 *  { all: true } callback(err, [{ address, family }, …]) */
export function lookup(hostname, options, callback) {
  if (hostname) validateStringWithoutNullBytes(hostname, "hostname");
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  } else if (typeof options === "number") {
    validateFunction(callback, "callback");
  } else if (options !== undefined && typeof options !== "object") {
    validateFunction(arguments.length === 2 ? options : callback, "callback");
    throw invalidArgType("options", "of type integer or an instance of Object", options);
  } else {
    validateFunction(callback, "callback");
  }
  const [family, all] = lookupOptions(options);
  if (!hostname) {
    emitInvalidHostnameWarning(hostname);
    if (all) process.nextTick(callback, null, []);
    else process.nextTick(callback, null, null, family === 6 ? 6 : 4);
    return {};
  }
  const matched = isIP(hostname);
  if (matched) {
    if (all) process.nextTick(callback, null, [{ address: hostname, family: matched }]);
    else process.nextTick(callback, null, hostname, matched);
    return {};
  }
  getaddrinfo(hostname, family, lookupOptions(options)[3], (err, list) => {
    if (err) callback(err);
    else if (all) callback(null, list.map(([address, f]) => ({ address, family: f })));
    else callback(null, list[0][0], list[0][1]);
  });
  return {};
}
Object.defineProperty(lookup, Symbol.for("nodejs.util.promisify.customArgs"), { value: ["address", "family"], enumerable: false });

function lookupServiceArgs(args, names) {
  if (args.length !== names.length) {
    throw codeError(TypeError, "ERR_MISSING_ARGS", `The ${names.map((n) => `"${n}"`).join(", ").replace(/, ([^,]*)$/, " and $1")} arguments must be specified`);
  }
  const [address, port] = args;
  validateString(address, "address");
  if (isIP(address) === 0) throw invalidArgValue("address", "is invalid", address);
  validatePort(port);
  return [address, +port + 0];
}

/* getnameinfo: done(error | null, hostname, service) */
function getnameinfo(address, port, done) {
  return dnsLookupService(address, port, bindContext((errno, hostname, service) => {
    if (errno) done(dnsException(errno, "getnameinfo", address));
    else done(null, hostname, service);
  }));
}

/** lookupService(address, port, callback): callback(err, hostname, service) */
export function lookupService(address, port, callback) {
  [address, port] = lookupServiceArgs(arguments, ["address", "port", "callback"]);
  validateFunction(callback, "callback");
  const err = getnameinfo(address, port, callback);
  if (err) throw dnsException(err, "getnameinfo", address);
  return {};
}
Object.defineProperty(lookupService, Symbol.for("nodejs.util.promisify.customArgs"), { value: ["hostname", "service"], enumerable: false });

/* ---- Resolver and the default resolver's functions (internal/dns_resolver.js) ---------------- */

export { Resolver };

const resolverFunction = (prefix, key) => {
  const f = lazyFunction(`${prefix}${key}`, key === "getServers" ? 0 : 2);
  Object.defineProperty(f, "name", { value: key });
  return f;
};

export const getServers = /* @__PURE__ */ resolverFunction("dns.", "getServers");
export const setServers = /* @__PURE__ */ resolverFunction("dns.", "setServers");
export const resolve = /* @__PURE__ */ resolverFunction("dns.", "resolve");
export const resolve4 = /* @__PURE__ */ resolverFunction("dns.", "resolve4");
export const resolve6 = /* @__PURE__ */ resolverFunction("dns.", "resolve6");
export const resolveAny = /* @__PURE__ */ resolverFunction("dns.", "resolveAny");
export const resolveCaa = /* @__PURE__ */ resolverFunction("dns.", "resolveCaa");
export const resolveCname = /* @__PURE__ */ resolverFunction("dns.", "resolveCname");
export const resolveMx = /* @__PURE__ */ resolverFunction("dns.", "resolveMx");
export const resolveNaptr = /* @__PURE__ */ resolverFunction("dns.", "resolveNaptr");
export const resolveNs = /* @__PURE__ */ resolverFunction("dns.", "resolveNs");
export const resolvePtr = /* @__PURE__ */ resolverFunction("dns.", "resolvePtr");
export const resolveSoa = /* @__PURE__ */ resolverFunction("dns.", "resolveSoa");
export const resolveSrv = /* @__PURE__ */ resolverFunction("dns.", "resolveSrv");
export const resolveTlsa = /* @__PURE__ */ resolverFunction("dns.", "resolveTlsa");
export const resolveTxt = /* @__PURE__ */ resolverFunction("dns.", "resolveTxt");
export const reverse = /* @__PURE__ */ resolverFunction("dns.", "reverse");

/* ---- dns.promises ------------------------------------------------------------------------------ */

const errorCodes = {
  NODATA, FORMERR, SERVFAIL, NOTFOUND, NOTIMP, REFUSED, BADQUERY, BADNAME, BADFAMILY, BADRESP, CONNREFUSED, TIMEOUT, EOF, FILE, NOMEM,
  DESTRUCTION, BADSTR, BADFLAGS, NONAME, BADHINTS, NOTINITIALIZED, LOADIPHLPAPI, ADDRGETNETWORKPARAMS, CANCELLED,
};

const resolverKeys = ["getServers", "setServers", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx",
  "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTlsa", "resolveTxt", "reverse"];

/* in a pure call, so a program that only looks names up drops the promise API */
export const promises = /* @__PURE__ */ (() => {
  const promises = {
    lookup(hostname, options) {
      if (hostname) validateStringWithoutNullBytes(hostname, "hostname");
      if (options !== undefined && typeof options !== "number" && typeof options !== "object") {
        throw invalidArgType("options", "of type integer or an instance of Object", options);
      }
      const [family, all, , order] = lookupOptions(options);
      return new Promise((resolvePromise, reject) => {
        if (!hostname) {
          emitInvalidHostnameWarning(hostname);
          resolvePromise(all ? [] : { address: null, family: family === 6 ? 6 : 4 });
          return;
        }
        const matched = isIP(hostname);
        if (matched !== 0) {
          const result = { address: hostname, family: matched };
          resolvePromise(all ? [result] : result);
          return;
        }
        getaddrinfo(hostname, family, order, (err, list) => {
          if (err) reject(err);
          else if (all) resolvePromise(list.map(([address, f]) => ({ address, family: f })));
          else resolvePromise({ address: list[0][0], family: list[0][1] });
        });
      });
    },
    lookupService(address, port) {
      [address, port] = lookupServiceArgs(arguments, ["address", "port"]);
      return new Promise((resolvePromise, reject) => {
        const err = getnameinfo(address, port, (e, hostname, service) => (e ? reject(e) : resolvePromise({ hostname, service })));
        if (err) reject(dnsException(err, "getnameinfo", address));
      });
    },
    Resolver: PromisesResolver,
    getDefaultResultOrder,
    setDefaultResultOrder,
    ...errorCodes,
  };
  for (const key of resolverKeys) promises[key] = resolverFunction("dns.promises.", key);
  return promises;
})();

export default {
  lookup, lookupService, Resolver, getDefaultResultOrder, setDefaultResultOrder, getServers, setServers, resolve, resolve4, resolve6,
  resolveAny, resolveCaa, resolveCname, resolveMx, resolveNaptr, resolveNs, resolvePtr, resolveSoa, resolveSrv, resolveTlsa, resolveTxt,
  reverse, ADDRCONFIG, V4MAPPED, ALL, ...errorCodes, promises,
};
