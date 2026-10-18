#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int64_t fib(int64_t n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

int main(int argc, char **argv) {
    printf("%lld\n", (long long)fib(argc > 1 ? atoll(argv[1]) : 0));
    return 0;
}
