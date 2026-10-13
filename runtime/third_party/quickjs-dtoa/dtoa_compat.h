/*
 * dtoa_compat.h — the subset of QuickJS's cutils.h that dtoa.c uses (ADR 0013).
 * Portable to GCC, Clang and MSVC.
 */
#ifndef DTOA_COMPAT_H
#define DTOA_COMPAT_H

#include <stdint.h>
#include <string.h>

#if defined(_MSC_VER) && !defined(__clang__)
#include <intrin.h>
#define likely(x)    (x)
#define unlikely(x)  (x)
#define no_inline    __declspec(noinline)
#define __maybe_unused
#else
#define likely(x)    __builtin_expect(!!(x), 1)
#define unlikely(x)  __builtin_expect(!!(x), 0)
#define no_inline    __attribute__((noinline))
#define __maybe_unused __attribute__((unused))
#endif

typedef int BOOL;
#ifndef FALSE
enum { FALSE = 0, TRUE = 1 };
#endif

static inline int max_int(int a, int b) { return a > b ? a : b; }
static inline int min_int(int a, int b) { return a < b ? a : b; }

/* WARNING: undefined if a = 0 */
static inline int clz32(unsigned int a) {
#if defined(_MSC_VER) && !defined(__clang__)
    unsigned long i;
    _BitScanReverse(&i, a);
    return 31 - (int)i;
#else
    return __builtin_clz(a);
#endif
}

/* WARNING: undefined if a = 0 */
static inline int clz64(uint64_t a) {
#if defined(_MSC_VER) && !defined(__clang__)
    unsigned long i;
    _BitScanReverse64(&i, a);
    return 63 - (int)i;
#else
    return __builtin_clzll(a);
#endif
}

/* WARNING: undefined if a = 0 */
static inline int ctz32(unsigned int a) {
#if defined(_MSC_VER) && !defined(__clang__)
    unsigned long i;
    _BitScanForward(&i, a);
    return (int)i;
#else
    return __builtin_ctz(a);
#endif
}

static inline uint64_t float64_as_uint64(double d) {
    uint64_t u;
    memcpy(&u, &d, 8);
    return u;
}

static inline double uint64_as_float64(uint64_t u) {
    double d;
    memcpy(&d, &u, 8);
    return d;
}

/* If str starts with val, store the position after it in *ptr and return 1. */
static inline int strstart(const char *str, const char *val, const char **ptr) {
    const char *p = str, *q = val;
    while (*q != '\0') {
        if (*p != *q) return 0;
        p++;
        q++;
    }
    if (ptr) *ptr = p;
    return 1;
}

#endif /* DTOA_COMPAT_H */
