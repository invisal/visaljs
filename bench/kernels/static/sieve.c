#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int64_t sieve(int64_t n) {
    uint8_t *composite = calloc((size_t)n + 1, 1);
    int64_t count = 0;
    for (int64_t i = 2; i <= n; i++) {
        if (composite[i] == 0) {
            count++;
            for (int64_t j = i * i; j <= n; j += i) composite[j] = 1;
        }
    }
    free(composite);
    return count;
}

int main(int argc, char **argv) {
    int64_t n = argc > 1 ? atoll(argv[1]) : 0, primes = 0;
    for (int k = 0; k < 5; k++) primes += sieve(n);
    printf("%lld\n", (long long)primes);
    return 0;
}
