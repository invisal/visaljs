/* The reachability flags of Apple's SystemConfiguration c-ares reads (its DNS configuration's
 * resolvers), with Apple's values, for prebuilt.ts: Zig's macOS headers have no frameworks. */
#ifndef VISALJS_DARWIN_SCNETWORKCONFIGURATION_H
#define VISALJS_DARWIN_SCNETWORKCONFIGURATION_H
enum {
    kSCNetworkReachabilityFlagsReachable = 1u << 1,
    kSCNetworkReachabilityFlagsConnectionOnTraffic = 1u << 3,
    kSCNetworkFlagsReachable = kSCNetworkReachabilityFlagsReachable,
};
#endif
