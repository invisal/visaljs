// node:dns/promises: dns.promises (see dns.js).
import { promises } from "./dns.js";

export {
  ADDRGETNETWORKPARAMS, BADFAMILY, BADFLAGS, BADHINTS, BADNAME, BADQUERY, BADRESP, BADSTR, CANCELLED, CONNREFUSED, DESTRUCTION, EOF, FILE,
  FORMERR, LOADIPHLPAPI, NODATA, NOMEM, NONAME, NOTFOUND, NOTIMP, NOTINITIALIZED, REFUSED, SERVFAIL, TIMEOUT,
} from "./dns.js";
export const lookup = promises.lookup;

export default promises;
