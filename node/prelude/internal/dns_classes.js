// dns.Resolver and dns.promises.Resolver as node:dns exports them: wrappers internal/dns_resolver.js
// gives its classes (internal/features.js), so programs that don't name them don't link c-ares.
import { lazyClass } from "./features.js";

export const Resolver = lazyClass("Resolver", "dnsResolver");
export const PromisesResolver = lazyClass("Resolver", "dnsPromisesResolver");
