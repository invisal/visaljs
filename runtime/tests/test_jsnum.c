/* Number <-> string conversion. */
#include <inttypes.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "jsnum.h"
#include "jstest.h"

#define CHECK_STR(expr, expected)                                             \
    do {                                                                      \
        size_t n_ = (expr);                                                   \
        if (strcmp(buf, expected) != 0 || n_ != strlen(expected))             \
            JST_FAIL_("%s: got \"%s\" (len %zu), want \"%s\"", #expr, buf, n_, expected); \
    } while (0)

TEST(jsnum_to_string) {
    char buf[JS_NUM_BUF_SIZE];
    CHECK_STR(js_num_to_cstr(buf, 0.0), "0");
    CHECK_STR(js_num_to_cstr(buf, -0.0), "0");
    CHECK_STR(js_num_to_cstr(buf, NAN), "NaN");
    CHECK_STR(js_num_to_cstr(buf, INFINITY), "Infinity");
    CHECK_STR(js_num_to_cstr(buf, -INFINITY), "-Infinity");
    CHECK_STR(js_num_to_cstr(buf, 0.1), "0.1");
    CHECK_STR(js_num_to_cstr(buf, 0.1 + 0.2), "0.30000000000000004");
    CHECK_STR(js_num_to_cstr(buf, -2147483648.0), "-2147483648");
    CHECK_STR(js_num_to_cstr(buf, 2147483648.0), "2147483648");
    CHECK_STR(js_num_to_cstr(buf, 1e21), "1e+21");
    CHECK_STR(js_num_to_cstr(buf, 123456789012345680000.0), "123456789012345680000");
    CHECK_STR(js_num_to_cstr(buf, 0.000001), "0.000001");
    CHECK_STR(js_num_to_cstr(buf, 1e-7), "1e-7");
    CHECK_STR(js_num_to_cstr(buf, 5e-324), "5e-324");
    CHECK_STR(js_num_to_cstr(buf, 1.7976931348623157e308), "1.7976931348623157e+308");
}

TEST(jsnum_to_string_radix) {
    char buf[JS_NUM_BUF_SIZE];
    CHECK_STR(js_num_to_cstr_radix(buf, 255, 16), "ff");
    CHECK_STR(js_num_to_cstr_radix(buf, -255, 2), "-11111111");
    CHECK_STR(js_num_to_cstr_radix(buf, 0.5, 2), "0.1");
    CHECK_STR(js_num_to_cstr_radix(buf, -0.0, 16), "0");
    CHECK_STR(js_num_to_cstr_radix(buf, 1e21, 36), "5v1j4f4ds7c000");  /* never exponential */
    CHECK_STR(js_num_to_cstr_radix(buf, NAN, 7), "NaN");
    CHECK_STR(js_num_to_cstr_radix(buf, -INFINITY, 2), "-Infinity");
    size_t n = js_num_to_cstr_radix(buf, 5e-324, 2);  /* the longest output */
    CHECK(n < JS_NUM_BUF_SIZE && strncmp(buf, "0.000", 5) == 0 && buf[n - 1] == '1');
}

TEST(jsnum_fixed_precision_exponential) {
    char buf[JS_NUM_BUF_SIZE];
    CHECK_STR(js_num_to_fixed(buf, 1.005, 2), "1.00");   /* 1.005 is really 1.00499… */
    CHECK_STR(js_num_to_fixed(buf, 2.5, 0), "3");
    CHECK_STR(js_num_to_fixed(buf, -2.5, 0), "-3");
    CHECK_STR(js_num_to_fixed(buf, -0.0, 2), "0.00");
    CHECK_STR(js_num_to_fixed(buf, -0.0000001, 2), "-0.00");
    CHECK_STR(js_num_to_fixed(buf, 1e21, 2), "1e+21");
    CHECK_STR(js_num_to_fixed(buf, NAN, 2), "NaN");
    CHECK_STR(js_num_to_fixed(buf, 0.1, 20), "0.10000000000000000555");

    CHECK_STR(js_num_to_precision(buf, 123.456, 4), "123.5");
    CHECK_STR(js_num_to_precision(buf, 123.456, 2), "1.2e+2");
    CHECK_STR(js_num_to_precision(buf, 0.00000123, 2), "0.0000012");
    CHECK_STR(js_num_to_precision(buf, 0.000000123, 2), "1.2e-7");
    CHECK_STR(js_num_to_precision(buf, -0.0, 3), "0.00");
    CHECK_STR(js_num_to_precision(buf, INFINITY, 3), "Infinity");

    CHECK_STR(js_num_to_exponential(buf, 123456, 2), "1.23e+5");
    CHECK_STR(js_num_to_exponential(buf, 123456, -1), "1.23456e+5");
    CHECK_STR(js_num_to_exponential(buf, 0, -1), "0e+0");
    CHECK_STR(js_num_to_exponential(buf, -0.0, 2), "0.00e+0");
    CHECK_STR(js_num_to_exponential(buf, NAN, 2), "NaN");
}

static double num(const char *s) { return js_str_to_num(js_view_latin1(s, (uint32_t)strlen(s))); }

static bool same(double a, double b) {
    return (isnan(a) && isnan(b)) || (a == b && signbit(a) == signbit(b));
}

#define CHECK_NUM(s, expected)                                                \
    do {                                                                      \
        double got_ = num(s);                                                 \
        if (!same(got_, expected))                                            \
            JST_FAIL_("Number(\"%s\") = %.17g, want %.17g", s, got_, (double)(expected)); \
    } while (0)

TEST(jsnum_string_to_number) {
    CHECK_NUM("", 0.0);
    CHECK_NUM(" \t\n ", 0.0);
    CHECK_NUM("-0", -0.0);
    CHECK_NUM("010", 10.0);           /* no legacy octal */
    CHECK_NUM("  42  ", 42.0);
    CHECK_NUM("1.", 1.0);
    CHECK_NUM(".5", 0.5);
    CHECK_NUM("-.5", -0.5);
    CHECK_NUM("1e3", 1000.0);
    CHECK_NUM("1E-3", 0.001);
    CHECK_NUM("1e400", INFINITY);
    CHECK_NUM("-1e-400", -0.0);
    CHECK_NUM("0x1F", 31.0);
    CHECK_NUM("0o17", 15.0);
    CHECK_NUM("0B101", 5.0);
    CHECK_NUM("0x20000000000001", 9007199254740992.0);  /* correctly rounded */
    CHECK_NUM("Infinity", INFINITY);
    CHECK_NUM("-Infinity", -INFINITY);
    CHECK_NUM("+Infinity", INFINITY);

    static const char *nans[] = {
        ".", "-", "+", "e5", "1e", "1e+", "-0x10", "+0x10", "0x", "0xg", "0o8", "0b2",
        "infinity", "Inf", "NaN", "1_000", "1n", "12abc", "4 2", "Infinityx",
    };
    for (size_t i = 0; i < sizeof nans / sizeof nans[0]; i++) CHECK_NUM(nans[i], NAN);
}

TEST(jsnum_string_to_number_utf16) {
    static const uint16_t ws[] = { 0xFEFF, 0x3000, '4', '2', 0x2028, 0x00A0 };
    CHECK(num("42") == js_str_to_num(js_view_utf16(ws, 6)));
    static const uint16_t fullwidth[] = { 0xFF11 };  /* "１" is not a digit */
    CHECK(isnan(js_str_to_num(js_view_utf16(fullwidth, 1))));
    static const uint16_t inner_ws[] = { '4', 0x00A0, '2' };
    CHECK(isnan(js_str_to_num(js_view_utf16(inner_ws, 3))));
}

/* ---- Differential fixture generated by Node (gen_jsnum_fixture.mjs) ---- */

static double from_bits(const char *hex) {
    uint64_t b = strtoull(hex, NULL, 16);
    double d;
    memcpy(&d, &b, 8);
    return d;
}

TEST(jsnum_node_fixture) {
    const char *path = getenv("JSNUM_FIXTURE_PATH") ? getenv("JSNUM_FIXTURE_PATH") : JSNUM_FIXTURE;
    FILE *f = fopen(path, "r");
    if (!f) {
        JST_FAIL_("cannot open %s", path);
        return;
    }
    static char line[16384];
    char out[JS_NUM_BUF_SIZE];
    uint16_t units[4096];
    int cases = 0, failures = 0;
    while (fgets(line, sizeof line, f)) {
        line[strcspn(line, "\n")] = '\0';
        char *fields[4] = { 0 };
        int nf = 0;
        for (char *p = line; nf < 4; nf++) {
            fields[nf] = p;
            p = strchr(p, '\t');
            if (!p) { nf++; break; }
            *p++ = '\0';
        }
        cases++;
        char kind = fields[0][0];
        const char *want = fields[nf - 1];
        bool ok;
        if (kind == 'N') {
            size_t n = strlen(fields[1]) / 4;
            for (size_t i = 0; i < n; i++) {
                char h[5] = { 0 };
                memcpy(h, fields[1] + 4 * i, 4);
                units[i] = (uint16_t)strtoul(h, NULL, 16);
            }
            double got = js_str_to_num(js_view_utf16(units, (uint32_t)n));
            ok = same(got, from_bits(want));
            if (!ok) snprintf(out, sizeof out, "%.17g", got);
        } else {
            double d = from_bits(fields[1]);
            int arg = nf > 3 ? atoi(fields[2]) : 0;
            switch (kind) {
            case 'S': js_num_to_cstr(out, d); break;
            case 'R': js_num_to_cstr_radix(out, d, arg); break;
            case 'F': js_num_to_fixed(out, d, arg); break;
            case 'P': js_num_to_precision(out, d, arg); break;
            case 'E': js_num_to_exponential(out, d, arg); break;
            default: JST_FAIL_("bad fixture line: %s", line); continue;
            }
            ok = strcmp(out, want) == 0;
        }
        if (!ok && ++failures <= (getenv("JSNUM_ALL") ? 100000 : 20))
            fprintf(stderr, "  fixture %c %s %s: got %.80s, want %.80s\n", kind, fields[1],
                    nf > 3 ? fields[2] : "", out, want);
    }
    fclose(f);
    if (failures) JST_FAIL_("%d of %d fixture cases differ from Node", failures, cases);
    CHECK(cases > 10000);
}
