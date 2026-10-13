/* Number <-> string conversion. */
#include "jsnum.h"

#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dtoa.h"

/* QuickJS's integer formatters return the length without NUL-terminating. */
size_t js_i32_to_cstr(char *buf, int32_t i) {
    size_t n = i32toa(buf, i);
    buf[n] = '\0';
    return n;
}

static bool fits_int32(double d) {
    return d >= -2147483648.0 && d <= 2147483647.0 && (double)(int32_t)d == d;
}

static size_t dtoa(char *buf, double d, int radix, int n_digits, int flags) {
    JSDTOATempMem tmp;  /* 296 bytes, no malloc */
    return (size_t)js_dtoa(buf, d, radix, n_digits, flags, &tmp);
}

size_t js_num_to_cstr(char *buf, double d) {
    if (fits_int32(d)) return js_i32_to_cstr(buf, (int32_t)d);  /* also -0 → "0" */
    return dtoa(buf, d, 10, 0, JS_DTOA_FORMAT_FREE);
}

/* Binary exponent of d as significand * 2^e with a 53-bit significand
 * (V8's Double::Exponent). Positive means d >= 2^53. */
static int binary_exponent(double d) {
    uint64_t b;
    memcpy(&b, &d, 8);
    int biased = (int)((b >> 52) & 0x7FF);
    return biased == 0 ? -1074 : biased - 1075;
}

static double next_double_up(double d) {
    return nextafter(d, INFINITY);
}

/* Radix other than 10, with V8's algorithm so the output matches Node
 * byte for byte: fraction digits until they are within half an
 * ulp, and integer digits beyond 2^53 filled with zeros. */
static size_t radix_to_cstr(char *out, double value, int radix) {
    static const char chars[] = "0123456789abcdefghijklmnopqrstuvwxyz";
    char buffer[2200];
    const int mid = (int)sizeof buffer / 2;
    int integer_cursor = mid, fraction_cursor = mid;

    bool negative = value < 0;
    if (negative) value = -value;

    double integer = floor(value);
    double fraction = value - integer;
    double delta = 0.5 * (next_double_up(value) - value);
    if (delta < next_double_up(0.0)) delta = next_double_up(0.0);

    if (fraction >= delta) {
        buffer[fraction_cursor++] = '.';
        do {
            fraction *= radix;
            delta *= radix;
            int digit = (int)fraction;
            buffer[fraction_cursor++] = chars[digit];
            fraction -= digit;
            /* Round half to even; carry back through written digits. */
            if (fraction > 0.5 || (fraction == 0.5 && (digit & 1))) {
                if (fraction + delta > 1) {
                    for (;;) {
                        fraction_cursor--;
                        if (fraction_cursor == mid) {  /* reached the '.' */
                            integer += 1;
                            break;
                        }
                        char c = buffer[fraction_cursor];
                        int prev = c > '9' ? c - 'a' + 10 : c - '0';
                        if (prev + 1 < radix) {
                            buffer[fraction_cursor++] = chars[prev + 1];
                            break;
                        }
                    }
                    break;
                }
            }
        } while (fraction >= delta);
    }

    /* Digits below the double's precision are zeros. */
    while (binary_exponent(integer / radix) > 0) {
        integer /= radix;
        buffer[--integer_cursor] = '0';
    }
    do {
        double remainder = fmod(integer, radix);
        buffer[--integer_cursor] = chars[(int)remainder];
        integer = (integer - remainder) / radix;
    } while (integer > 0);

    if (negative) buffer[--integer_cursor] = '-';
    size_t n = (size_t)(fraction_cursor - integer_cursor);
    memcpy(out, buffer + integer_cursor, n);
    out[n] = '\0';
    return n;
}

size_t js_num_to_cstr_radix(char *buf, double d, int radix) {
    if (radix == 10 || !isfinite(d)) return js_num_to_cstr(buf, d);
    if (fits_int32(d)) {
        size_t n = i64toa_radix(buf, (int32_t)d, (unsigned)radix);
        buf[n] = '\0';
        return n;
    }
    return radix_to_cstr(buf, d, radix);
}

size_t js_num_to_fixed(char *buf, double d, int digits) {
    if (!(fabs(d) < 1e21)) return js_num_to_cstr(buf, d);  /* also NaN */
    return dtoa(buf, d, 10, digits, JS_DTOA_FORMAT_FRAC);
}

size_t js_num_to_precision(char *buf, double d, int digits) {
    if (!isfinite(d)) return js_num_to_cstr(buf, d);
    return dtoa(buf, d, 10, digits, JS_DTOA_FORMAT_FIXED);
}

size_t js_num_to_exponential(char *buf, double d, int digits) {
    if (!isfinite(d)) return js_num_to_cstr(buf, d);
    if (digits < 0) return dtoa(buf, d, 10, 0, JS_DTOA_FORMAT_FREE | JS_DTOA_EXP_ENABLED);
    return dtoa(buf, d, 10, digits + 1, JS_DTOA_FORMAT_FIXED | JS_DTOA_EXP_ENABLED);
}

/* ---- StringToNumber ---- */

/* StrWhiteSpaceChar: WhiteSpace and LineTerminator. */
static bool is_str_whitespace(uint32_t c) {
    switch (c) {
    case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20:
    case 0xA0: case 0x1680: case 0x2028: case 0x2029: case 0x202F:
    case 0x205F: case 0x3000: case 0xFEFF:
        return true;
    default:
        return c >= 0x2000 && c <= 0x200A;
    }
}

static int digit_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'z') return c - 'a' + 10;
    if (c >= 'A' && c <= 'Z') return c - 'A' + 10;
    return 99;
}

static bool is_decimal(char c) { return c >= '0' && c <= '9'; }

/* `p` is ASCII, NUL-terminated, non-empty and has no surrounding whitespace. */
static double ascii_to_num(const char *p, size_t n) {
    JSATODTempMem tmp;

    /* NonDecimalIntegerLiteral: unsigned only. */
    if (n > 2 && p[0] == '0') {
        int radix = 0;
        switch (p[1]) {
        case 'x': case 'X': radix = 16; break;
        case 'o': case 'O': radix = 8; break;
        case 'b': case 'B': radix = 2; break;
        }
        if (radix) {
            for (size_t i = 2; i < n; i++)
                if (digit_value(p[i]) >= radix) return NAN;
            return js_atod(p + 2, NULL, radix, JS_ATOD_INT_ONLY, &tmp);
        }
    }

    /* StrDecimalLiteral: [+-] (Infinity | digits [. digits] [e [+-] digits] | . digits [e ...]) */
    size_t i = 0;
    bool neg = false;
    if (p[0] == '+' || p[0] == '-') {
        neg = p[0] == '-';
        i = 1;
    }
    if (n - i == 8 && memcmp(p + i, "Infinity", 8) == 0) return neg ? -INFINITY : INFINITY;

    size_t mantissa_digits = 0;
    while (i < n && is_decimal(p[i])) i++, mantissa_digits++;
    if (i < n && p[i] == '.') {
        i++;
        while (i < n && is_decimal(p[i])) i++, mantissa_digits++;
    }
    if (mantissa_digits == 0) return NAN;
    if (i < n && (p[i] == 'e' || p[i] == 'E')) {
        i++;
        if (i < n && (p[i] == '+' || p[i] == '-')) i++;
        if (i == n || !is_decimal(p[i])) return NAN;
        while (i < n && is_decimal(p[i])) i++;
    }
    if (i != n) return NAN;
    return js_atod(p, NULL, 10, 0, &tmp);
}

double js_str_to_num(JSStrView s) {
    uint32_t start = 0, end = s.length;
    while (start < end && is_str_whitespace(js_view_at(s, start))) start++;
    while (end > start && is_str_whitespace(js_view_at(s, end - 1))) end--;
    if (start == end) return 0.0;

    size_t n = end - start;
    char small[64];
    char *buf = n < sizeof small ? small : malloc(n + 1);
    if (!buf) abort();  /* out of memory; the heap's OOM policy isn't defined yet */

    double result = NAN;
    for (size_t i = 0; i < n; i++) {
        uint32_t c = js_view_at(s, start + (uint32_t)i);
        if (c > 0x7F) goto done;  /* non-ASCII inside the literal */
        buf[i] = (char)c;
    }
    buf[n] = '\0';
    result = ascii_to_num(buf, n);
done:
    if (buf != small) free(buf);
    return result;
}

size_t js_num_to_locale(char *buf, double d) {
    if (isnan(d)) return (size_t)sprintf(buf, "NaN");
    size_t n = 0;
    if (signbit(d)) buf[n++] = '-';  /* also -0, as ICU */
    if (isinf(d)) return n + (size_t)sprintf(buf + n, "\xe2\x88\x9e");
    /* the shortest decimal, positional, rounded half-up to three fraction digits (ICU rounds
     * the shortest decimal, not the binary value: 1.0005 is "1.001") */
    char digits[400];
    size_t len = dtoa(digits, fabs(d), 10, 0, JS_DTOA_FORMAT_FREE | JS_DTOA_EXP_DISABLED);
    digits[len] = '\0';
    char *dot = strchr(digits, '.');
    size_t int_len = dot ? (size_t)(dot - digits) : len;
    char frac[4] = { 0 };
    size_t frac_len = 0;
    if (dot) {
        const char *f = dot + 1;
        for (; frac_len < 3 && f[frac_len]; frac_len++) frac[frac_len] = f[frac_len];
        if (f[frac_len] >= '5' && f[frac_len] <= '9') {  /* round up, carrying into the integer part */
            size_t i = frac_len;
            while (i > 0 && frac[i - 1] == '9') frac[--i] = '0';
            if (i > 0) frac[i - 1]++;
            else {
                size_t j = int_len;
                while (j > 0 && digits[j - 1] == '9') digits[--j] = '0';
                if (j > 0) digits[j - 1]++;
                else {
                    memmove(digits + 1, digits, int_len);
                    digits[0] = '1';
                    int_len++;
                }
            }
        }
        while (frac_len > 0 && frac[frac_len - 1] == '0') frac_len--;
    }
    for (size_t i = 0; i < int_len; i++) {
        if (i > 0 && (int_len - i) % 3 == 0) buf[n++] = ',';
        buf[n++] = digits[i];
    }
    if (frac_len) {
        buf[n++] = '.';
        memcpy(buf + n, frac, frac_len);
        n += frac_len;
    }
    buf[n] = '\0';
    return n;
}

/* ---- parseFloat / parseInt: the scanner in prefix mode ----------------- */

static uint32_t skip_whitespace(JSStrView s) {
    uint32_t i = 0;
    while (i < s.length && is_str_whitespace(js_view_at(s, i))) i++;
    return i;
}

static int unit_digit(JSStrView s, uint32_t i) {
    uint32_t c = js_view_at(s, i);
    return c < 0x80 ? digit_value((char)c) : 99;
}

/* Correctly rounded value of the ASCII units [start, end) of s in `radix`. */
static double atod_range(JSStrView s, uint32_t start, uint32_t end, int radix, int flags) {
    size_t n = end - start;
    char small[64];
    char *buf = n < sizeof small ? small : malloc(n + 1);
    if (!buf) abort();
    for (size_t i = 0; i < n; i++) buf[i] = (char)js_view_at(s, start + (uint32_t)i);
    buf[n] = '\0';
    JSATODTempMem tmp;
    double d = js_atod(buf, NULL, radix, flags, &tmp);
    if (buf != small) free(buf);
    return d;
}

static bool unit_is(JSStrView s, uint32_t i, char c) { return i < s.length && js_view_at(s, i) == (uint32_t)c; }

double js_parse_float(JSStrView s) {
    uint32_t i = skip_whitespace(s), start = i;
    bool neg = false;
    if (unit_is(s, i, '+') || unit_is(s, i, '-')) neg = js_view_at(s, i++) == '-';
    static const char inf[] = "Infinity";
    uint32_t k = 0;
    while (k < 8 && unit_is(s, i + k, inf[k])) k++;
    if (k == 8) return neg ? -INFINITY : INFINITY;

    uint32_t digits = 0;
    while (i < s.length && unit_digit(s, i) < 10) i++, digits++;
    if (unit_is(s, i, '.')) {
        uint32_t dot = i++;
        while (i < s.length && unit_digit(s, i) < 10) i++, digits++;
        if (!digits) i = dot;
    }
    if (!digits) return NAN;
    if (unit_is(s, i, 'e') || unit_is(s, i, 'E')) {  /* only if a digit follows */
        uint32_t j = i + 1;
        if (unit_is(s, j, '+') || unit_is(s, j, '-')) j++;
        if (j < s.length && unit_digit(s, j) < 10) {
            while (j < s.length && unit_digit(s, j) < 10) j++;
            i = j;
        }
    }
    return atod_range(s, start, i, 10, 0);
}

double js_parse_int(JSStrView s, int32_t radix) {
    uint32_t i = skip_whitespace(s);
    bool neg = false;
    if (unit_is(s, i, '+') || unit_is(s, i, '-')) neg = js_view_at(s, i++) == '-';
    bool strip_prefix = true;
    if (radix != 0) {
        if (radix < 2 || radix > 36) return NAN;
        if (radix != 16) strip_prefix = false;
    } else {
        radix = 10;
    }
    if (strip_prefix && unit_is(s, i, '0') && (unit_is(s, i + 1, 'x') || unit_is(s, i + 1, 'X'))) {
        i += 2;
        radix = 16;
    }
    uint32_t start = i;
    while (i < s.length && unit_digit(s, i) < radix) i++;
    if (i == start) return NAN;
    double d = atod_range(s, start, i, radix, JS_ATOD_INT_ONLY);
    return neg ? -d : d;  /* "-0" is -0 */
}
