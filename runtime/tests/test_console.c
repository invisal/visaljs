/* The bootstrap console: differential against Node's util.format. */
#include <stdlib.h>
#include <string.h>

#include "js_builtins.h"
#include "js_console.h"
#include "js_convert.h"
#include "jsnum.h"
#include "jsstring.h"
#include "jstest.h"

#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#endif

static JSRuntime *rt;
static JSContext *ctx;
static void setup(void) {
    rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    ctx = js_context_new(rt);
}
static void teardown(void) {
    js_context_free(ctx);
    js_runtime_free(rt);
}

static uint16_t units_buf[8192];

/* Decodes "hhhhhhhh…" (4 hex digits per unit) into units_buf. */
static uint32_t decode_units(const char *hex) {
    uint32_t n = (uint32_t)(strlen(hex) / 4);
    for (uint32_t i = 0; i < n; i++) {
        char h[5] = { 0 };
        memcpy(h, hex + 4 * i, 4);
        units_buf[i] = (uint16_t)strtoul(h, NULL, 16);
    }
    return n;
}

static double from_bits(const char *hex) {
    uint64_t b = strtoull(hex, NULL, 16);
    double d;
    memcpy(&d, &b, 8);
    return d;
}

static JSValue value_of(const char *tok) {
    switch (tok[0]) {
    case 'u': return JS_UNDEFINED;
    case 'n': return JS_NULL;
    case 't': return JS_TRUE;
    case 'f': return JS_FALSE;
    case 'd': return js_number(from_bits(tok + 2));
    default: {
        uint32_t n = decode_units(tok + 2);
        return js_new_string_utf16(ctx, units_buf, n);
    }
    }
}

static bool same_number(double a, double b) {
    return (a != a && b != b) || (a == b && signbit(a) == signbit(b));
}

static bool string_is_units(JSValue s, const uint16_t *units, uint32_t n) {
    JSStrView v = js_string_view(ctx, s);
    if (v.length != n) return false;
    for (uint32_t i = 0; i < n; i++)
        if (js_view_at(v, i) != units[i]) return false;
    return true;
}

static void show(JSValue s, char *out, size_t cap) {
    size_t n = js_is_string(s) ? js_view_to_utf8(js_string_view(ctx, s), out, cap - 1) : 0;
    out[n < cap - 1 ? n : cap - 1] = '\0';
}

TEST(console_node_fixture) {
    setup();
    FILE *f = fopen(CONSOLE_FIXTURE, "r");
    if (!f) {
        JST_FAIL_("cannot open %s", CONSOLE_FIXTURE);
        teardown();
        return;
    }
    static char line[65536];
    static uint16_t expect[8192];
    int cases = 0, failures = 0;
    while (fgets(line, sizeof line, f)) {
        line[strcspn(line, "\n")] = '\0';
        char *fields[4] = { 0 };
        int nf = 0;
        for (char *p = line; p && nf < 4;) {
            fields[nf++] = p;
            p = strchr(p, '\t');
            if (p) *p++ = '\0';
        }
        cases++;
        bool ok;
        char got[512] = "", want[512] = "";
        if (line[0] == 'F') {
            JSValue args[16];
            uint32_t argc = 0;
            for (char *tok = strtok(fields[1], ","); tok; tok = strtok(NULL, ",")) args[argc++] = value_of(tok);
            uint32_t n = decode_units(fields[2]);
            memcpy(expect, units_buf, n * sizeof *expect);
            JSValue s = js_format(ctx, argc, args);
            ok = !js_is_exception(s) && string_is_units(s, expect, n);
            if (!ok) {
                show(s, got, sizeof got);
                show(js_new_string_utf16(ctx, expect, n), want, sizeof want);
            }
        } else {
            bool is_int = line[0] == 'I';
            JSValue s = value_of(fields[is_int ? 2 : 1]);
            double want_d = from_bits(fields[is_int ? 3 : 2] + 2);
            JSStrView v = js_string_view(ctx, s);
            double d = is_int ? js_parse_int(v, atoi(fields[1])) : js_parse_float(v);
            ok = same_number(d, want_d);
            if (!ok) {
                snprintf(got, sizeof got, "%.17g", d);
                snprintf(want, sizeof want, "%.17g", want_d);
            }
        }
        if (!ok && ++failures <= 20) fprintf(stderr, "  %c case %d: got [%s], want [%s]\n", line[0], cases, got, want);
    }
    fclose(f);
    if (failures) JST_FAIL_("%d of %d console fixture cases differ from Node", failures, cases);
    CHECK(cases > 900);
    teardown();
}

TEST(console_to_string) {
    setup();
    char buf[64];
    JSValue s = js_to_string(ctx, JS_UNDEFINED);
    CHECK(js_is_atom(s));
    show(s, buf, sizeof buf);
    CHECK(strcmp(buf, "undefined") == 0);
    show(js_to_string(ctx, js_double(-0.0)), buf, sizeof buf);
    CHECK(strcmp(buf, "0") == 0);  /* String(-0), unlike console.log(-0) */
    double d = 0;
    CHECK(js_to_number(ctx, &d, js_new_string_cstr(ctx, " 0x10 ")) == 0 && d == 16);
    CHECK(js_to_number(ctx, &d, JS_NULL) == 0 && d == 0);
    CHECK(js_to_number(ctx, &d, JS_TRUE) == 0 && d == 1);
    teardown();
}

#ifndef _WIN32
/* Runs fn in a child with stdout and stderr captured; returns its exit status. */
static int capture(void (*fn)(void), char *out, size_t out_cap, char *err, size_t err_cap) {
    int po[2], pe[2];
    if (pipe(po) || pipe(pe)) return -1;
    fflush(NULL);
    pid_t pid = fork();
    if (pid == 0) {
        dup2(po[1], 1);
        dup2(pe[1], 2);
        fn();
        exit(0);  /* flushes stdio, like a real program */
    }
    close(po[1]);
    close(pe[1]);
    size_t no = 0, ne = 0;
    ssize_t r;
    while ((r = read(po[0], out + no, out_cap - 1 - no)) > 0) no += (size_t)r;
    while ((r = read(pe[0], err + ne, err_cap - 1 - ne)) > 0) ne += (size_t)r;
    out[no] = err[ne] = '\0';
    close(po[0]);
    close(pe[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

static void program(void) {
    setup();
    static const uint16_t lone[] = { 'a', 0xD800, 'b' };
    JSValue args[] = { js_new_string_cstr(ctx, "héllo %s, %d%%"), js_new_string_cstr(ctx, "wörld"),
                       js_double(-0.0), js_new_string_utf16(ctx, lone, 3), JS_NULL };
    JSValue console = js_new_console(ctx);
    JSValue log = js_get_value(ctx, console, js_atom_from_cstr(ctx, "log"));
    JSValue r = js_call(ctx, log, console, 5, args);
    JSValue e[] = { js_new_string_cstr(ctx, "to stderr"), js_int32(1) };
    JSValue error = js_get_value(ctx, console, js_atom_from_cstr(ctx, "error"));
    r = js_call(ctx, error, console, 2, e);
    JSValue p[] = { js_double(0.1) };
    r = js_print(ctx, JS_UNDEFINED, JS_UNDEFINED, 1, p, JS_UNDEFINED);
    r = js_throw_range_error(ctx, "Invalid string length");
    (void)r;
    int status = js_report_uncaught(ctx);
    /* free before exiting, like a compiled program's main: malloc'd runtime tables are
     * referenced only from the GC heap, which LeakSanitizer doesn't scan */
    teardown();
    exit(status);
}

TEST(console_output) {
    char out[1024], err[1024];
    int status = capture(program, out, sizeof out, err, sizeof err);
    CHECK_EQ_INT(status, 1);
    CHECK(strcmp(out, "héllo wörld, -0% a\xEF\xBF\xBD" "b null\n0.1\n") == 0);
    CHECK(strcmp(err, "to stderr 1\nUncaught RangeError: Invalid string length\n") == 0);
    if (strcmp(out, "héllo wörld, -0% a\xEF\xBF\xBD" "b null\n0.1\n") != 0) fprintf(stderr, "  stdout: [%s]\n", out);
    if (strcmp(err, "to stderr 1\nUncaught RangeError: Invalid string length\n") != 0) fprintf(stderr, "  stderr: [%s]\n", err);
}
#else
TEST(console_output) {}
#endif
