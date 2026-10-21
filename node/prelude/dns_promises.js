// node:dns/promises: dns.promises (see dns.js).
import { promises } from "./dns.js";

export {
  ADDRGETNETWORKPARAMS, BADFAMILY, BADFLAGS, BADHINTS, BADNAME, BADQUERY, BADRESP, BADSTR, CANCELLED, CONNREFUSED, DESTRUCTION, EOF, FILE,
  FORMERR, LOADIPHLPAPI, NODATA, NOMEM, NONAME, NOTFOUND, NOTIMP, NOTINITIALIZED, REFUSED, SERVFAIL, TIMEOUT, getDefaultResultOrder,
  setDefaultResultOrder,
} from "./dns.js";
export { PromisesResolver as Resolver } from "./internal/dns_classes.js";

export const {
  lookup, lookupService, getServers, setServers, resolve, resolve4, resolve6, resolveAny, resolveCaa, resolveCname, resolveMx, resolveNaptr,
  resolveNs, resolvePtr, resolveSoa, resolveSrv, resolveTlsa, resolveTxt, reverse,
} = promises;

export default promises;
