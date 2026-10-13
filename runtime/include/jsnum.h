/*
 * jsnum.h — number <-> string conversion.
 *
 * Digit generation and rounding come from the vendored QuickJS dtoa.c.
 * The JS grammar (StringNumericLiteral) is ours.
 */
#ifndef JSNUM_H
#define JSNUM_H

#include <stddef.h>
#include <stdint.h>

#include "jsstring.h"

/* Fits any output: toString(2) of the smallest subnormal is ~1,080 characters. */
#define JS_NUM_BUF_SIZE 1100

/* All functions write a NUL-terminated ASCII string and return its length. */

size_t js_i32_to_cstr(char *buf, int32_t i);
/* Number::toString(x, 10): shortest round-trip. "NaN", "Infinity", -0 → "0". */
size_t js_num_to_cstr(char *buf, double d);
/* Number.prototype.toString(radix), 2 <= radix <= 36. */
size_t js_num_to_cstr_radix(char *buf, double d, int radix);

/* The caller has range-checked `digits` and thrown RangeError if needed. */
size_t js_num_to_fixed(char *buf, double d, int digits);        /* 0..100 */
size_t js_num_to_precision(char *buf, double d, int digits);    /* 1..100 */
size_t js_num_to_exponential(char *buf, double d, int digits);  /* 0..100, or -1: as many as needed */
/* Number.prototype.toLocaleString until Intl: en-US as ICU prints it ("1,234.568", "-∞"), UTF-8.
 * `buf` holds 512 bytes. */
size_t js_num_to_locale(char *buf, double d);

/* StringToNumber (ToNumber on a string). Never fails: bad input is NaN. */
double js_str_to_num(JSStrView s);

/* parseFloat(s) and parseInt(s, radix): the longest valid prefix after leading
 * whitespace. `radix` is already ToInt32'd; 0 means 10, or 16 after "0x". */
double js_parse_float(JSStrView s);
double js_parse_int(JSStrView s, int32_t radix);

#endif /* JSNUM_H */
