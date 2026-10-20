// dns.Resolver, dns.promises.Resolver, and the resolve* functions of node:dns and dns/promises
// (Node's lib/internal/dns/utils.js, callback_resolver.js and promises.js) over c-ares
// (src/host_dns.c). A feature module (internal/features.js): linked into programs that name them.
// The queries' answers are read by c-ares's parsers, and shaped here as Node's cares_wrap shapes them.
// Ported from Node.js (Copyright Node.js contributors, MIT): node/third_party/nodejs/LICENSE.
import {
  dnsCancel, dnsChannel, dnsGetServers, dnsParse, dnsQuery, dnsReverse, dnsSetLocalAddress, dnsSetServers, dnsStrerror, errnoName,
} from "visaljs:host";
import { PromisesResolver as PromisesResolverWrapper, Resolver as ResolverWrapper } from "./dns_classes.js";
import { domainToASCII } from "../url.js";
import { bindContext } from "./async_context.js";
import { codeError, invalidArgType, invalidArgValue, outOfRange, validateFunction, validateString } from "./errors.js";
import { features, provideClass } from "./features.js";
import { isIP } from "./net.js";

const IANA_DNS_PORT = 53;
const IPv6RE = /^\[([^[\]]*)\]/;
const addrSplitRE = /(^.+?)(?::(\d+))?$/;

/* ARES_* statuses, by number (ares.h), as Node's ToErrorCodeString names them */
const ARES_CODES = [undefined, "ENODATA", "EFORMERR", "ESERVFAIL", "ENOTFOUND", "ENOTIMP", "EREFUSED", "EBADQUERY", "EBADNAME", "EBADFAMILY",
  "EBADRESP", "ECONNREFUSED", "ETIMEOUT", "EOF", "EFILE", "ENOMEM", "EDESTRUCTION", "EBADSTR", "EBADFLAGS", "ENONAME", "EBADHINTS",
  "ENOTINITIALIZED", "ELOADIPHLPAPI", "EADDRGETNETWORKPARAMS", "ECANCELLED"];
const ARES_SUCCESS = 0, ARES_ENODATA = 1;
const aresCode = (status) => ARES_CODES[status] ?? "UNKNOWN_ARES_ERROR";

/** Node's DNSException: a libuv errno, or a c-ares code */
function dnsException(code, syscall, hostname) {
  let errno;
  if (typeof code === "number") {
    errno = code;
    code = errnoName(code);
    if (code === "EAI_NODATA" || code === "EAI_NONAME") code = "ENOTFOUND";
  }
  const error = new Error(`${syscall} ${code}${hostname ? ` ${hostname}` : ""}`);
  error.errno = errno;
  error.code = code;
  error.syscall = syscall;
  if (hostname) error.hostname = hostname;
  return error;
}

/* ---- the binding: Node's ChannelWrap queries, as cares_wrap shapes their answers ------------- */

/* the DNS types (ares_dns_rec_type_t) */
const T = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, NAPTR: 35, TLSA: 52, ANY: 255, CAA: 257 };
/* dnsParse's kinds for a CNAME or A records (Node's ns_t_cname_or_a), and for ANY's SOA */
const CNAME_OR_A = 0x10000;
const SOA_IN_ANY = 0x10006;

const TYPES = {
  queryA: T.A, queryAaaa: T.AAAA, queryCname: T.CNAME, queryMx: T.MX, queryNs: T.NS, queryTxt: T.TXT, querySrv: T.SRV, queryPtr: T.PTR,
  queryNaptr: T.NAPTR, querySoa: T.SOA, queryCaa: T.CAA, queryTlsa: T.TLSA, queryAny: T.ANY,
};

const mxRecord = ([priority, exchange]) => ({ exchange, priority, type: "MX" });
const srvRecord = ([name, port, priority, weight]) => ({ name, port, priority, weight, type: "SRV" });
const naptrRecord = ([flags, service, regexp, replacement, order, preference]) => ({ flags, service, regexp, replacement, order, preference, type: "NAPTR" });
const soaRecord = ([nsname, hostmaster, serial, refresh, retry, expire, minttl]) => ({ nsname, hostmaster, serial, refresh, retry, expire, minttl });
function caaRecord([critical, property, value]) {
  const record = { critical, type: "CAA" };
  record[property] = value;
  return record;
}
const tlsaRecord = ([certUsage, selector, match, data]) =>
  ({ certUsage, selector, match, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });

/* a query's answer → [status, result, ttls] (Node's Traits::Parse) */
function shape(bindingName, answer) {
  const kind = TYPES[bindingName];
  if (kind === T.ANY) return parseAny(answer);
  const [status, records, ttls] = dnsParse(answer, kind);
  if (status !== ARES_SUCCESS) return [status];
  switch (kind) {
    case T.A:
    case T.AAAA: return [status, records, ttls];
    case T.MX: return [status, records.map(mxRecord)];
    case T.SRV: return [status, records.map(srvRecord)];
    case T.NAPTR: return [status, records.map(naptrRecord)];
    case T.SOA: return records.length ? [status, soaRecord(records[0])] : [ARES_ENODATA];
    case T.CAA: return [status, records.map(caaRecord)];
    case T.TLSA: return [status, records.map(tlsaRecord)];
    default: return [status, records];
  }
}

/* ANY: every kind's records, each with its type, in Node's order; a kind without any is skipped */
function parseAny(answer) {
  const out = [];
  const parse = (kind, add) => {
    const [status, records, ttls, cname] = dnsParse(answer, kind);
    if (status === ARES_SUCCESS) add(records, ttls, cname);
    return status === ARES_SUCCESS || status === ARES_ENODATA ? 0 : status;
  };
  const steps = [
    [CNAME_OR_A, (records, ttls, cname) => {
      for (const [i, value] of records.entries()) out.push(cname ? { value, type: "CNAME" } : { address: value, ttl: ttls[i], type: "A" });
    }],
    [T.AAAA, (records, ttls) => records.forEach((address, i) => out.push({ address, ttl: ttls[i], type: "AAAA" }))],
    [T.MX, (records) => records.forEach((r) => out.push(mxRecord(r)))],
    [T.NS, (records) => records.forEach((value) => out.push({ value, type: "NS" }))],
    [T.TXT, (records) => records.forEach((entries) => out.push({ entries, type: "TXT" }))],
    [T.SRV, (records) => records.forEach((r) => out.push(srvRecord(r)))],
    [T.PTR, (records) => records.forEach((value) => out.push({ value, type: "PTR" }))],
    [T.NAPTR, (records) => records.forEach((r) => out.push(naptrRecord(r)))],
    [SOA_IN_ANY, (records) => records.forEach((r) => out.push({ ...soaRecord(r), type: "SOA" }))],
    [T.TLSA, (records) => records.forEach((r) => out.push({ ...tlsaRecord(r), type: "TLSA" }))],
    [T.CAA, (records) => records.forEach((r) => out.push(caaRecord(r)))],
  ];
  for (const [kind, add] of steps) {
    const status = parse(kind, add);
    if (status !== 0) return [status];
  }
  return [ARES_SUCCESS, out];
}

/* Node's QueryWrap::Send: 0, or what went wrong at once; req.oncomplete(code | null, result, ttls) later */
function send(channel, bindingName, req, name) {
  const done = bindContext((status, answer) => {
    let result, ttls;
    if (status === ARES_SUCCESS) {
      if (bindingName === "getHostByAddr") result = answer;
      else [status, result, ttls] = shape(bindingName, answer);
    }
    if (status !== ARES_SUCCESS) req.oncomplete(aresCode(status));
    else req.oncomplete(null, result, ttls);
  });
  if (bindingName === "getHostByAddr") return dnsReverse(channel, name, done);
  return dnsQuery(channel, domainToASCII(name) || name, TYPES[bindingName], done);
}

/* ---- ResolverBase (Node's internal/dns/utils.js) -------------------------------------------- */

function validateInt32(value, name, min) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value)) throw outOfRange(name, "an integer", value);
  if (value < min || value > 2 ** 31 - 1) throw outOfRange(name, `>= ${min} && <= ${2 ** 31 - 1}`, value);
}

function validateOptions(options) {
  let { timeout = -1, tries = 4, maxTimeout = 0 } = { ...options };
  validateInt32(timeout, "options.timeout", -1);
  validateInt32(tries, "options.tries", 1);
  if (typeof maxTimeout !== "number") throw invalidArgType("options.maxTimeout", "of type number", maxTimeout);
  if (!Number.isInteger(maxTimeout)) throw outOfRange("options.maxTimeout", "an integer", maxTimeout);
  if (maxTimeout < 0 || maxTimeout > 2 ** 32 - 1) throw outOfRange("options.maxTimeout", `>= 0 && <= ${2 ** 32 - 1}`, maxTimeout);
  /* -0 as +0 */
  timeout += 0;
  maxTimeout += 0;
  return [timeout, tries, maxTimeout];
}

function validatePort(port, name = "Port") {
  if ((typeof port !== "number" && typeof port !== "string") || (typeof port === "string" && port.trim().length === 0) ||
      +port !== (+port >>> 0) || port > 0xFFFF) {
    throw codeError(RangeError, "ERR_SOCKET_BAD_PORT", `${name} should be >= 0 and < 65536. Received ${typeof port === "string" ? `type string ('${port}')` : `type number (${port})`}.`);
  }
}

const invalidIP = (ip) => codeError(TypeError, "ERR_INVALID_IP_ADDRESS", `Invalid IP address: ${ip}`);

/* The channel's handle, as Node's ChannelWrap: queries by binding name */
class ChannelWrap {
  constructor(timeout, tries, maxTimeout) {
    this.channel = dnsChannel(timeout, tries, maxTimeout);
  }
  getServers() { return dnsGetServers(this.channel); }
  setServers(servers) { return dnsSetServers(this.channel, servers); }
  setLocalAddress(ipv4, ipv6) {
    const ips = [ipv4, ipv6];
    if (isIP(ipv4) === 0 || (ipv6 !== undefined && isIP(ipv6) === 0)) {
      throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", "Invalid IP address.");
    }
    if (ipv6 !== undefined && isIP(ipv4) === isIP(ipv6)) {
      throw codeError(TypeError, "ERR_INVALID_ARG_VALUE", `Cannot specify two IPv${isIP(ipv4)} addresses.`);
    }
    dnsSetLocalAddress(this.channel, ips.find((ip) => isIP(ip) === 4) ?? null, ips.find((ip) => ip !== undefined && isIP(ip) === 6) ?? null);
  }
  cancel() { dnsCancel(this.channel); }
}
for (const bindingName of [...Object.keys(TYPES), "getHostByAddr"]) {
  ChannelWrap.prototype[bindingName] = function (req, name) {
    return send(this.channel, bindingName, req, name);
  };
}

class ResolverBase {
  constructor(options = undefined) {
    const [timeout, tries, maxTimeout] = validateOptions(options);
    this._handle = new ChannelWrap(timeout, tries, maxTimeout);
  }

  cancel() {
    this._handle.cancel();
  }

  getServers() {
    return (this._handle.getServers() || []).map((val) => {
      if (!val[1] || val[1] === IANA_DNS_PORT) return val[0];
      const host = isIP(val[0]) === 6 ? `[${val[0]}]` : val[0];
      return `${host}:${val[1]}`;
    });
  }

  setServers(servers) {
    if (!Array.isArray(servers)) throw invalidArgType("servers", "an instance of Array", servers);
    const newSet = [];
    servers.forEach((serv, index) => {
      validateString(serv, `servers[${index}]`);
      let ipVersion = isIP(serv);
      if (ipVersion !== 0) return newSet.push([ipVersion, serv, IANA_DNS_PORT]);
      const match = IPv6RE.exec(serv);
      if (match) {
        ipVersion = isIP(match[1]);
        if (ipVersion !== 0) {
          const port = Number.parseInt(serv.replace(addrSplitRE, "$2")) || IANA_DNS_PORT;
          validatePort(port);
          return newSet.push([ipVersion, match[1], port]);
        }
      }
      const addrSplitMatch = addrSplitRE.exec(serv);
      if (addrSplitMatch) {
        const hostIP = addrSplitMatch[1];
        const port = Number.parseInt(addrSplitMatch[2]) || IANA_DNS_PORT;
        ipVersion = isIP(hostIP);
        if (ipVersion !== 0) {
          validatePort(port);
          return newSet.push([ipVersion, hostIP, port]);
        }
      }
      throw invalidIP(serv);
    });
    const orig = (this._handle.getServers() || []).map((val) => [isIP(val[0]), ...val]);
    const errorNumber = this._handle.setServers(newSet);
    if (errorNumber !== 0) {
      this._handle.setServers(orig);
      throw codeError(Error, "ERR_DNS_SET_SERVERS_FAILED", `c-ares failed to set servers: "${dnsStrerror(errorNumber)}" [${servers}]`);
    }
  }

  setLocalAddress(ipv4, ipv6) {
    validateString(ipv4, "ipv4");
    if (ipv6 !== undefined) validateString(ipv6, "ipv6");
    this._handle.setLocalAddress(ipv4, ipv6);
  }
}

function createResolverClass(resolver) {
  const resolveMap = { __proto__: null };
  class Resolver extends ResolverBase {}
  Resolver.prototype.resolveAny = resolveMap.ANY = resolver("queryAny");
  Resolver.prototype.resolve4 = resolveMap.A = resolver("queryA");
  Resolver.prototype.resolve6 = resolveMap.AAAA = resolver("queryAaaa");
  Resolver.prototype.resolveCaa = resolveMap.CAA = resolver("queryCaa");
  Resolver.prototype.resolveCname = resolveMap.CNAME = resolver("queryCname");
  Resolver.prototype.resolveMx = resolveMap.MX = resolver("queryMx");
  Resolver.prototype.resolveNs = resolveMap.NS = resolver("queryNs");
  Resolver.prototype.resolveTlsa = resolveMap.TLSA = resolver("queryTlsa");
  Resolver.prototype.resolveTxt = resolveMap.TXT = resolver("queryTxt");
  Resolver.prototype.resolveSrv = resolveMap.SRV = resolver("querySrv");
  Resolver.prototype.resolvePtr = resolveMap.PTR = resolver("queryPtr");
  Resolver.prototype.resolveNaptr = resolveMap.NAPTR = resolver("queryNaptr");
  Resolver.prototype.resolveSoa = resolveMap.SOA = resolver("querySoa");
  Resolver.prototype.reverse = resolver("getHostByAddr");
  return { resolveMap, Resolver };
}

/* ---- the callback Resolver (Node's callback_resolver.js) ------------------------------------- */

function onresolve(err, result, ttls) {
  if (ttls && this.ttl) result = result.map((address, index) => ({ address, ttl: ttls[index] }));
  if (err) this.callback(dnsException(err, this.bindingName, this.hostname));
  else this.callback(null, result);
}

function callbackResolver(bindingName) {
  function query(name, /* options, */ callback) {
    let options;
    if (arguments.length > 2) {
      options = callback;
      callback = arguments[2];
    }
    validateString(name, "name");
    validateFunction(callback, "callback");
    const req = { bindingName, callback, hostname: name, oncomplete: onresolve, ttl: !!options?.ttl };
    const err = this._handle[bindingName](req, name);
    if (err) throw dnsException(err, bindingName, name);
    return req;
  }
  Object.defineProperty(query, "name", { value: bindingName });
  return query;
}

const callbacks = createResolverClass(callbackResolver);
const Resolver = callbacks.Resolver;
Resolver.prototype.resolve = function resolve(hostname, rrtype, callback) {
  let resolver;
  if (typeof rrtype === "string") {
    resolver = callbacks.resolveMap[rrtype];
  } else if (typeof rrtype === "function") {
    resolver = callbacks.resolveMap.A;
    callback = rrtype;
  } else {
    throw invalidArgType("rrtype", "of type string", rrtype);
  }
  if (typeof resolver === "function") return resolver.call(this, hostname, callback);
  throw invalidArgValue("rrtype", "is invalid", rrtype);
};

/* ---- the promises Resolver (Node's promises.js) -------------------------------------------- */

function onresolvePromise(err, result, ttls) {
  if (err) {
    this.reject(dnsException(err, this.bindingName, this.hostname));
    return;
  }
  if (ttls && this.ttl) result = result.map((address, index) => ({ address, ttl: ttls[index] }));
  this.resolve(result);
}

function promiseResolver(bindingName) {
  function query(name, options) {
    validateString(name, "name");
    const ttl = !!options?.ttl;
    return new Promise((resolve, reject) => {
      const req = { bindingName, hostname: name, oncomplete: onresolvePromise, resolve, reject, ttl };
      const err = this._handle[bindingName](req, name);
      if (err) reject(dnsException(err, bindingName, name));
    });
  }
  Object.defineProperty(query, "name", { value: bindingName });
  return query;
}

const promises = createResolverClass(promiseResolver);
const PromisesResolver = promises.Resolver;
PromisesResolver.prototype.resolve = function resolve(hostname, rrtype) {
  let resolver;
  if (rrtype !== undefined) {
    validateString(rrtype, "rrtype");
    resolver = promises.resolveMap[rrtype];
    if (typeof resolver !== "function") throw invalidArgValue("rrtype", "is invalid", rrtype);
  } else {
    resolver = promises.resolveMap.A;
  }
  return resolver.call(this, hostname);
};

/* ---- the default resolver, whose methods node:dns and dns/promises export ------------------- */

const resolverKeys = ["getServers", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr",
  "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTlsa", "resolveTxt", "reverse"];

let defaultResolver;
const getDefaultResolver = () => (defaultResolver ??= new ResolverBase());

/* each module's exported functions, bound to the default resolver (features["dns.resolve4"], …) */
function bindDefaultResolver() {
  const resolver = getDefaultResolver();
  for (const key of resolverKeys) {
    features[`dns.${key}`] = Resolver.prototype[key].bind(resolver);
    features[`dns.promises.${key}`] = PromisesResolver.prototype[key].bind(resolver);
  }
}
bindDefaultResolver();

/* dns.setServers and dns.promises.setServers: a new default resolver */
function defaultResolverSetServers(servers) {
  const resolver = new Resolver();
  resolver.setServers(servers);
  defaultResolver = resolver;
  bindDefaultResolver();
}
features["dns.setServers"] = defaultResolverSetServers;
features["dns.promises.setServers"] = defaultResolverSetServers;
provideClass(ResolverWrapper, Resolver);
provideClass(PromisesResolverWrapper, PromisesResolver);
