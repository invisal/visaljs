/*
 * Runtime unit test driver.
 *
 *   jsrt_tests            run every test
 *   jsrt_tests <substr>   run the tests whose name contains <substr>
 */
#include <string.h>

#include "jstest.h"

int jstest_failures = 0;

#define X(name) void test_##name(void);
#include "tests.def"
#undef X

static const struct { const char *name; void (*fn)(void); } tests[] = {
#define X(name) { #name, test_##name },
#include "tests.def"
#undef X
};

/* Zeroes the stack below the caller, so a test never starts with stale
 * pointers left by the previous one: they would look like live roots to the
 * GC's conservative stack scan, since mmap reuses addresses. */
static NOINLINE JST_NO_ASAN void scrub_stack(void) {
    volatile char buf[256 * 1024];
    for (size_t i = 0; i < sizeof buf; i++) buf[i] = 0;
}

int main(int argc, char **argv) {
    const char *filter = argc > 1 ? argv[1] : NULL;
    int run = 0, failed = 0;
    for (size_t i = 0; i < sizeof tests / sizeof tests[0]; i++) {
        if (filter && !strstr(tests[i].name, filter)) continue;
        int before = jstest_failures;
        scrub_stack();
        tests[i].fn();
        run++;
        if (jstest_failures != before) {
            failed++;
            fprintf(stderr, "FAIL %s\n", tests[i].name);
        } else {
            printf("ok   %s\n", tests[i].name);
        }
    }
    printf("%d tests, %d failed\n", run, failed);
    return failed ? 1 : 0;
}
