// node:dns: lookup, through getaddrinfo on libuv's thread pool, as Node's
// is (results in the system's order, Node's default "verbatim"). Not yet: the resolve* queries
// (c-ares) and Resolver.
import { dnsLookup, errnoName } from "visaljs:host";
import { bindContext } from "./internal/async_context.js";
import { codeError, invalidArgType, invalidArgValue } from "./internal/errors.js";
import { isIP } from "./internal/net.js";

/* getaddrinfo hints, and the error codes of the resolver */
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

/** getaddrinfo's failure as Node reports it: `getaddrinfo ENOTFOUND nosuch.invalid` */
function dnsException(errno, code, syscall, hostname) {
  if (code === "EAI_NODATA" || code === "EAI_NONAME") code = "ENOTFOUND";
  const error = new Error(syscall + " " + code + (hostname ? " " + hostname : ""));
  error.errno = errno;
  error.code = code;
  error.syscall = syscall;
  if (hostname) error.hostname = hostname;
  return error;
}

function familyOf(family) {
  if (family === undefined || family === 0 || family === null) return 0;
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "The property 'options.family' must be one of: 0, 4, 6. Received " + String(family));
}

/** lookup(hostname[, options | family], callback): callback(err, address, family), or with
 *  { all: true } callback(err, [{ address, family }, …]) */
export function lookup(hostname, options, callback) {
  let family = 0;
  let all = false;
  if (typeof hostname !== "string" && hostname) throw invalidArgType("hostname", "of type string", hostname);
  if (typeof options === "function") {
    callback = options;
  } else if (typeof options === "number") {
    family = familyOf(options);
  } else if (options !== undefined && options !== null) {
    family = familyOf(options.family);
    all = options.all === true;
    /* hints are checked, as Node's; getaddrinfo isn't given them */
    if (options.hints != null) {
      if (typeof options.hints !== "number") throw invalidArgType("options.hints", "of type number", options.hints);
      const hints = options.hints >>> 0;
      if ((hints & ~(ADDRCONFIG | ALL | V4MAPPED)) !== 0) throw invalidArgValue("hints", "is invalid", hints);
    }
  }
  if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
  if (!hostname) {
    process.nextTick(() => (all ? callback(null, []) : callback(null, null, family === 6 ? 6 : 4)));
    return {};
  }
  const matched = isIP(hostname);
  if (matched) {
    process.nextTick(() => (all ? callback(null, [{ address: hostname, family: matched }]) : callback(null, hostname, matched)));
    return {};
  }
  const r = dnsLookup(hostname, family, bindContext((errno, code, list) => {
    if (errno) callback(dnsException(errno, code, "getaddrinfo", hostname));
    else if (all) callback(null, list.map(([address, family]) => ({ address, family })));
    else callback(null, list[0][0], list[0][1]);
  }));
  if (r < 0) process.nextTick(callback, dnsException(r, errnoName(r), "getaddrinfo", hostname));
  return {};
}

export const promises = {
  lookup(hostname, options) {
    return new Promise((resolve, reject) => {
      lookup(hostname, options, (err, address, family) => {
        if (err) reject(err);
        else resolve(Array.isArray(address) ? address : { address, family });
      });
    });
  },
};

export default { lookup, promises, ADDRCONFIG, V4MAPPED, ALL, NODATA, FORMERR, SERVFAIL, NOTFOUND, NOTIMP, REFUSED, BADQUERY, BADNAME, BADFAMILY, BADRESP, CONNREFUSED, TIMEOUT, EOF, FILE, NOMEM, DESTRUCTION, BADSTR, BADFLAGS, NONAME, BADHINTS, NOTINITIALIZED, LOADIPHLPAPI, ADDRGETNETWORKPARAMS, CANCELLED };
