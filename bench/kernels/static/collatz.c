#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int64_t longest(int64_t limit) {
    int64_t best = 0, best_length = 0;
    for (int64_t start = 1; start < limit; start++) {
        int64_t n = start, length = 1;
        while (n != 1) {
            n = n % 2 == 0 ? n / 2 : 3 * n + 1;
            length++;
        }
        if (length > best_length) {
            best_length = length;
            best = start;
        }
    }
    return best;
}

int main(int argc, char **argv) {
    printf("%lld\n", (long long)longest(argc > 1 ? atoll(argv[1]) : 0));
    return 0;
}
