/* regexp-compile: compiles a program's regular expression literals when the program is built.
 * The driver builds it from this file and the vendored libregexp, caches it next to
 * libjsrt, and runs it once per build.
 *
 * stdin:  one literal per line, "<flags> <pattern>": the LRE_FLAG_* bits in decimal, then the
 *         pattern's bytes in hex (UTF-8, or CESU-8 without the u and v flags; see
 *         compiler/src/emit/regexp.ts).
 * stdout: one line per literal, "ok <bytecode in hex>" or "error <message, in V8's words>". */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cutils.h"
#include "libregexp.h"
#include "regexp_anchor.h"
#include "regexp_message.h"

int lre_check_stack_overflow(void *opaque, size_t alloca_size) {
    (void)opaque, (void)alloca_size;
    return 0;  /* libregexp's own depth limits suffice for patterns in source code */
}

int lre_check_timeout(void *opaque) {
    (void)opaque;
    return 0;
}

void *lre_realloc(void *opaque, void *ptr, size_t size) {
    (void)opaque;
    if (size == 0) {
        free(ptr);
        return NULL;
    }
    return realloc(ptr, size);
}

static int hex_digit(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

/* The next line of stdin, without its newline (portable getline): its length, or -1 at the end. */
static long read_line(char **line, size_t *cap) {
    size_t n = 0;
    int c;
    while ((c = getchar()) != EOF && c != '\n') {
        if (n + 1 >= *cap) {
            *cap = *cap ? *cap * 2 : 256;
            *line = realloc(*line, *cap);
            if (!*line) exit(1);
        }
        (*line)[n++] = (char)c;
    }
    if (c == EOF && n == 0) return -1;
    if (!*line && !(*line = malloc(*cap = 1))) exit(1);
    (*line)[n] = '\0';
    return (long)n;
}

int main(void) {
    size_t cap = 0;
    char *line = NULL;
    long n;
    while ((n = read_line(&line, &cap)) >= 0) {
        char *p = line;
        int flags = (int)strtol(p, &p, 10);
        if (*p == ' ') p++;
        size_t len = 0;
        char *pattern = malloc((size_t)n / 2 + 1);
        if (!pattern) return 1;
        for (int hi, lo; (hi = hex_digit(p[0])) >= 0 && (lo = hex_digit(p[1])) >= 0; p += 2) pattern[len++] = (char)(hi << 4 | lo);
        pattern[len] = '\0';
        char error[64], buf[64];
        int bc_len;
        uint8_t *bc = lre_compile(&bc_len, error, sizeof error, pattern, len, flags, NULL);
        free(pattern);
        if (!bc) {
            printf("error %s\n", js_regexp_message(error, buf, sizeof buf));
            continue;
        }
        js_regexp_anchor(bc, bc_len);
        fputs("ok ", stdout);
        for (int i = 0; i < bc_len; i++) printf("%02x", bc[i]);
        putchar('\n');
        free(bc);
    }
    free(line);
    return 0;
}
