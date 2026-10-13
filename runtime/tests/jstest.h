/*
 * jstest.h — the small in-tree test framework for runtime unit tests.
 *
 * A test is `TEST(name) { ... }`. Every test is also listed in tests.def,
 * which test_main.c expands into the table of tests to run.
 */
#ifndef JSTEST_H
#define JSTEST_H

#include <stdint.h>
#include <stdio.h>

extern int jstest_failures;

#if defined(__GNUC__) || defined(__clang__)
#define NOINLINE __attribute__((noinline))
#define JST_NO_ASAN __attribute__((no_sanitize_address))
#else
#define NOINLINE __declspec(noinline)
#define JST_NO_ASAN
#endif

#define TEST(name) void test_##name(void)

#define JST_FAIL_(fmt, ...)                                                   \
    do {                                                                      \
        fprintf(stderr, "  %s:%d: " fmt "\n", __FILE__, __LINE__, __VA_ARGS__); \
        jstest_failures++;                                                    \
    } while (0)

#define CHECK(cond)                                                           \
    do { if (!(cond)) JST_FAIL_("CHECK(%s) failed", #cond); } while (0)

#define CHECK_EQ_INT(a, b)                                                    \
    do {                                                                      \
        long long a_ = (long long)(a), b_ = (long long)(b);                   \
        if (a_ != b_) JST_FAIL_("%s == %s: %lld != %lld", #a, #b, a_, b_);    \
    } while (0)

#define CHECK_EQ_U64(a, b)                                                    \
    do {                                                                      \
        uint64_t a_ = (uint64_t)(a), b_ = (uint64_t)(b);                      \
        if (a_ != b_)                                                         \
            JST_FAIL_("%s == %s: 0x%016llx != 0x%016llx", #a, #b,             \
                      (unsigned long long)a_, (unsigned long long)b_);        \
    } while (0)

#define CHECK_EQ_DBL(a, b)                                                    \
    do {                                                                      \
        double a_ = (a), b_ = (b);                                            \
        if (a_ != b_) JST_FAIL_("%s == %s: %.17g != %.17g", #a, #b, a_, b_);  \
    } while (0)

#endif /* JSTEST_H */
