/* JSValue encoding. */
#include <float.h>
#include <math.h>

#include "jstest.h"
#include "jsvalue.h"

static uint64_t bits_of(JSValue v) {
    uint64_t b;
    memcpy(&b, &v, 8);
    return b;
}

TEST(jsvalue_immediates) {
    CHECK_EQ_U64(bits_of(JS_EMPTY), 0x00);
    CHECK_EQ_U64(bits_of(JS_NULL), 0x02);
    CHECK_EQ_U64(bits_of(JS_FALSE), 0x06);
    CHECK_EQ_U64(bits_of(JS_TRUE), 0x07);
    CHECK_EQ_U64(bits_of(JS_UNDEFINED), 0x0A);
    CHECK_EQ_U64(bits_of(JS_EXCEPTION), 0x0E);

    CHECK(js_is_null(JS_NULL) && js_is_nullish(JS_NULL));
    CHECK(js_is_undefined(JS_UNDEFINED) && js_is_nullish(JS_UNDEFINED));
    CHECK(!js_is_nullish(JS_FALSE) && !js_is_nullish(JS_EMPTY) && !js_is_nullish(JS_EXCEPTION));

    CHECK(js_is_bool(JS_TRUE) && js_as_bool(JS_TRUE));
    CHECK(js_is_bool(JS_FALSE) && !js_as_bool(JS_FALSE));
    CHECK(js_same_bits(js_bool(true), JS_TRUE));
    CHECK(js_same_bits(js_bool(false), JS_FALSE));

    CHECK(js_is_empty(JS_EMPTY) && !js_is_cell(JS_EMPTY));
    CHECK(js_is_exception(JS_EXCEPTION) && !js_is_cell(JS_EXCEPTION));
}

TEST(jsvalue_int32) {
    static const int32_t cases[] = { 0, 1, -1, 42, -42, INT32_MAX, INT32_MIN, 0x10000, -0x10000 };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        JSValue v = js_int32(cases[i]);
        CHECK(js_is_number(v));
        CHECK(js_is_int32(v));
        CHECK(!js_is_double(v));
        CHECK(!js_is_cell(v));
        CHECK_EQ_INT(js_as_int32(v), cases[i]);
        CHECK_EQ_DBL(js_as_number(v), (double)cases[i]);
        CHECK_EQ_U64(bits_of(v) >> 48, 0xFFFE);
    }
}

TEST(jsvalue_double) {
    static const double cases[] = {
        0.0, -0.0, 0.5, -0.5, 1.5, 3.141592653589793, 1e300, -1e300,
        DBL_MAX, -DBL_MAX, DBL_MIN, 4.9e-324, -4.9e-324, INFINITY, -INFINITY,
        2147483648.0, -2147483649.0,
    };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        JSValue v = js_double(cases[i]);
        CHECK(js_is_number(v));
        CHECK(js_is_double(v));
        CHECK(!js_is_int32(v));
        CHECK(!js_is_cell(v));
        CHECK(!js_is_bool(v) && !js_is_nullish(v));
        double back = js_as_double(v);
        CHECK(memcmp(&back, &cases[i], 8) == 0);  /* bit-exact, keeps -0 */
        uint64_t hi = bits_of(v) >> 48;
        CHECK(hi >= 0x0002 && hi <= 0xFFFC);
    }
    CHECK(signbit(js_as_double(js_double(-0.0))));
}

TEST(jsvalue_nan_canonical) {
    /* Rule 3: a negative NaN plus the offset would collide with the int32 tag space. */
    uint64_t neg_nan_bits = UINT64_C(0xFFFFFFFFFFFFFFFF);
    uint64_t payload_nan_bits = UINT64_C(0x7FF0000000000001);
    double neg_nan, payload_nan;
    memcpy(&neg_nan, &neg_nan_bits, 8);
    memcpy(&payload_nan, &payload_nan_bits, 8);

    JSValue a = js_double(neg_nan), b = js_double(payload_nan), c = js_double(NAN);
    CHECK(js_is_double(a) && js_is_double(b) && js_is_double(c));
    CHECK(isnan(js_as_double(a)));
    CHECK(js_same_bits(a, b) && js_same_bits(b, c));
    CHECK_EQ_U64(bits_of(a), JS_CANON_NAN + JS_DOUBLE_OFF);
    CHECK(js_same_bits(js_number(NAN), c));
}

TEST(jsvalue_number_prefers_int32) {
    CHECK(js_is_int32(js_number(0.0)));
    CHECK(js_is_int32(js_number(7.0)));
    CHECK(js_is_int32(js_number(-7.0)));
    CHECK(js_is_int32(js_number(2147483647.0)));
    CHECK(js_is_int32(js_number(-2147483648.0)));
    CHECK_EQ_INT(js_as_int32(js_number(-2147483648.0)), INT32_MIN);

    /* Rule 2: -0 is always a double. */
    JSValue nz = js_number(-0.0);
    CHECK(js_is_double(nz) && signbit(js_as_double(nz)));

    CHECK(js_is_double(js_number(0.5)));
    CHECK(js_is_double(js_number(2147483648.0)));
    CHECK(js_is_double(js_number(-2147483649.0)));
    CHECK(js_is_double(js_number(1e20)));
    CHECK(js_is_double(js_number(INFINITY)));
    CHECK(js_is_double(js_number(-INFINITY)));
}

TEST(jsvalue_cell) {
    /* Any 8-byte-aligned user-space address works. */
    static _Alignas(16) uint64_t fake_cell[2];
    struct JSCell *p = (struct JSCell *)fake_cell;
    JSValue v = js_cell(p);
    CHECK(js_is_cell(v));
    CHECK(!js_is_number(v) && !js_is_bool(v) && !js_is_nullish(v));
    CHECK(js_as_cell(v) == p);
    CHECK_EQ_U64(bits_of(v), (uint64_t)(uintptr_t)p);  /* pointers are raw */
}

TEST(jsvalue_tests_are_disjoint) {
    static _Alignas(16) uint64_t fake_cell[2];
    const JSValue vals[] = {
        JS_EMPTY, JS_NULL, JS_FALSE, JS_TRUE, JS_UNDEFINED, JS_EXCEPTION,
        js_int32(0), js_int32(-1), js_double(0.0), js_double(-0.0), js_double(NAN),
        js_double(-INFINITY), js_cell((struct JSCell *)fake_cell),
    };
    for (size_t i = 0; i < sizeof vals / sizeof vals[0]; i++) {
        JSValue v = vals[i];
        int kinds = js_is_number(v) + js_is_cell(v) + js_is_bool(v) + js_is_nullish(v) +
                    js_is_empty(v) + js_is_exception(v);
        CHECK_EQ_INT(kinds, 1);
        CHECK(!js_is_number(v) || (js_is_int32(v) != js_is_double(v)));
    }
}
