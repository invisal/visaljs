#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static bool is_token(const unsigned char *s, size_t n) {
    for (size_t i = 0; i < n; i++) {
        unsigned c = s[i];
        bool alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
        if (!alnum && c != 33 && !(c >= 35 && c <= 39) && c != 42 && c != 43 && c != 45 && c != 46 && c != 94 && c != 95 && c != 96 && c != 124 && c != 126) return false;
    }
    return n > 0;
}

int main(int argc, char **argv) {
    static const char *names[] = {"Content-Type", "X-Request-Id", "bad header", "Accept-Encoding", "x-forwarded-for", "Set-Cookie", "Cache-Control", "caf\xe9"};
    long rounds = argc > 1 ? atol(argv[1]) : 0, valid = 0;
    for (long r = 0; r < rounds; r++)
        for (size_t k = 0; k < sizeof names / sizeof *names; k++)
            if (is_token((const unsigned char *)names[k], strlen(names[k]))) valid++;
    printf("%ld\n", valid);
    return 0;
}
