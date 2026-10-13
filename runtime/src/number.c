/* Number (§21.1), and the global functions on numbers: parseFloat, parseInt (the same functions
 * as Number's), isNaN and isFinite (§19.2). Their entries are in js_core.def. */
#include <math.h>
#include <string.h>

#include "internal.h"
#include "builtins_util.h"
#include "js_convert.h"
#include "js_ops.h"
#include "jsnum.h"

/* thisNumberValue (§21.1.3.7.1): a number, or a Number wrapper's. */
static JSValue this_number(JSContext *ctx, JSValue v, const char *method) {
    JSValue x = js_this_primitive(v, js_is_number);
    if (!js_is_empty(x)) return x;
    return js_throw_type_error(ctx, "Number.prototype.%s requires that 'this' be a Number", method);
}

static JSValue ascii(JSContext *ctx, const char *s, size_t n) {
    return js_new_string_latin1(ctx, (const uint8_t *)s, (uint32_t)n);
}

static bool is_integral(JSValue v) {
    if (!js_is_number(v)) return false;
    double d = js_as_number(v);
    return isfinite(d) && trunc(d) == d;
}

/* ---- The constructor and its functions --------------------------------------------------------- */

BUILTIN(number_ctor) {
    UNUSED_ARGS;
    double d = 0;
    if (argc) {  /* ToNumeric, then a BigInt's value as a Number (§21.1.1.1) */
        JSValue prim = js_to_numeric(ctx, argv[0]);
        if (js_is_exception(prim)) return prim;
        d = js_is_bigint(prim) ? ctx->rt->bigint->to_double(prim) : js_as_number(prim);
    }
    if (js_is_undefined(new_target)) return js_number(d);
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_NUMBER_PROTOTYPE);
    return js_is_exception(proto) ? proto : js_new_wrapper(ctx, js_number(d), proto);
}

CORE(number_is_finite) {
    UNUSED_ARGS;
    return js_bool(js_is_number(ARG(0)) && isfinite(js_as_number(ARG(0))));
}

CORE(number_is_integer) {
    UNUSED_ARGS;
    return js_bool(is_integral(ARG(0)));
}

CORE(number_is_nan) {
    UNUSED_ARGS;
    return js_bool(js_is_number(ARG(0)) && isnan(js_as_number(ARG(0))));
}

CORE(number_is_safe_integer) {
    UNUSED_ARGS;
    return js_bool(is_integral(ARG(0)) && fabs(js_as_number(ARG(0))) <= JS_MAX_SAFE_INTEGER);
}

/* parseFloat (§19.2.4) */
CORE(number_parse_float) {
    UNUSED_ARGS;
    JSValue s = js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return JS_EXCEPTION;
    return js_number(js_parse_float(js_string_view(ctx, s)));
}

/* parseInt (§19.2.5) */
CORE(number_parse_int) {
    UNUSED_ARGS;
    JSValue s = js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return JS_EXCEPTION;
    double radix = 0;
    if (js_to_number(ctx, &radix, ARG(1)) < 0) return JS_EXCEPTION;
    return js_number(js_parse_int(js_string_view(ctx, s), js_double_to_int32(radix)));
}

/* isNaN, isFinite (§19.2.2, §19.2.3): after ToNumber, unlike Number's */
CORE(global_is_nan) {
    UNUSED_ARGS;
    double d;
    if (js_to_number(ctx, &d, ARG(0)) < 0) return JS_EXCEPTION;
    return js_bool(isnan(d));
}

CORE(global_is_finite) {
    UNUSED_ARGS;
    double d;
    if (js_to_number(ctx, &d, ARG(0)) < 0) return JS_EXCEPTION;
    return js_bool(isfinite(d));
}

/* ---- Number.prototype -------------------------------------------------------------------------- */

CORE(number_proto_to_exponential) {
    UNUSED_ARGS;
    double x, f;
    JSValue self = this_number(ctx, this_val, "toExponential");
    if (js_is_exception(self)) return JS_EXCEPTION;
    x = js_as_number(self);
    if (js_to_integer_or_infinity(ctx, &f, ARG(0)) < 0) return JS_EXCEPTION;
    if (!isfinite(x)) return js_to_string(ctx, self);
    if (f < 0 || f > 100) return js_throw_range_error(ctx, "toExponential() argument must be between 0 and 100");
    char buf[128];
    size_t n = js_num_to_exponential(buf, x, js_is_undefined(ARG(0)) ? -1 : (int)f);
    return ascii(ctx, buf, n);
}

CORE(number_proto_to_fixed) {
    UNUSED_ARGS;
    double x, f;
    JSValue self = this_number(ctx, this_val, "toFixed");
    if (js_is_exception(self)) return JS_EXCEPTION;
    x = js_as_number(self);
    if (js_to_integer_or_infinity(ctx, &f, ARG(0)) < 0) return JS_EXCEPTION;
    if (f < 0 || f > 100) return js_throw_range_error(ctx, "toFixed() digits argument must be between 0 and 100");
    char buf[160];
    size_t n = js_num_to_fixed(buf, x, (int)f);
    return ascii(ctx, buf, n);
}

CORE(number_proto_to_precision) {
    UNUSED_ARGS;
    double x, p;
    JSValue self = this_number(ctx, this_val, "toPrecision");
    if (js_is_exception(self)) return JS_EXCEPTION;
    x = js_as_number(self);
    if (js_is_undefined(ARG(0))) return js_to_string(ctx, self);
    if (js_to_integer_or_infinity(ctx, &p, ARG(0)) < 0) return JS_EXCEPTION;
    if (!isfinite(x)) return js_to_string(ctx, self);
    if (p < 1 || p > 100) return js_throw_range_error(ctx, "toPrecision() argument must be between 1 and 100");
    char buf[160];
    size_t n = js_num_to_precision(buf, x, (int)p);
    return ascii(ctx, buf, n);
}

CORE(number_proto_to_string) {
    UNUSED_ARGS;
    double x, radix = 10;
    JSValue self = this_number(ctx, this_val, "toString");
    if (js_is_exception(self)) return JS_EXCEPTION;
    x = js_as_number(self);
    if (!js_is_undefined(ARG(0)) && js_to_integer_or_infinity(ctx, &radix, ARG(0)) < 0) return JS_EXCEPTION;
    if (radix < 2 || radix > 36) return js_throw_range_error(ctx, "toString() radix argument must be between 2 and 36");
    if (radix == 10) return js_to_string(ctx, self);
    char buf[1100];
    size_t n = js_num_to_cstr_radix(buf, x, (int)radix);
    return ascii(ctx, buf, n);
}

CORE(number_proto_value_of) {
    UNUSED_ARGS;
    return this_number(ctx, this_val, "valueOf");
}

/* Until Intl: en-US, as Node prints it (ICU: grouped, at most three fraction digits). */
CORE(number_proto_to_locale_string) {
    UNUSED_ARGS;
    double x;
    JSValue self = this_number(ctx, this_val, "toLocaleString");
    if (js_is_exception(self)) return JS_EXCEPTION;
    x = js_as_number(self);
    char buf[512];
    size_t n = js_num_to_locale(buf, x);
    return js_new_string_utf8(ctx, buf, n);
}

/* ---- Realm --------------------------------------------------------------------------------------- */

JSValue js_number_realm_init(JSContext *ctx, JSObject *global, JSDefineConstructor define_constructor) {
    return define_constructor(ctx, global, "Number", number_ctor, 1, ctx->intrinsics[JS_INTRINSIC_NUMBER_PROTOTYPE]);
}
