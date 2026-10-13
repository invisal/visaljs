/* Math (§21.3), an optional component. The transcendental functions are V8's
 * fdlibm port, so results match Node's to the last bit; the rest are exact. */
#include "js_builtins.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <time.h>

#include "ieee754.h"
#include "internal.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_ops.h"

#define NATIVE(name) static JSValue name(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, \
                                         const JSValue *argv, JSValue new_target)
#define UNUSED_ARGS (void)callee, (void)this_val, (void)new_target
#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)

/* A function of one number: ToNumber(x), then f. */
#define MATH1(name, f)                                       \
    NATIVE(name) {                                           \
        UNUSED_ARGS;                                         \
        double x;                                            \
        if (js_to_number(ctx, &x, ARG(0))) return JS_EXCEPTION; \
        return js_number(f(x));                              \
    }

static double js_round(double x) {
    if (!isfinite(x) || x == 0) return x;
    if (x > 0 && x < 0.5) return 0.0;
    if (x < 0 && x >= -0.5) return -0.0;
    double r = floor(x);
    return x - r >= 0.5 ? r + 1 : r;  /* halves round up, toward +Infinity */
}

static double js_sign(double x) {
    return x > 0 ? 1 : x < 0 ? -1 : x;  /* ±0 and NaN as they are */
}

static double js_fround(double x) {
    return (double)(float)x;
}

MATH1(math_abs, fabs)
MATH1(math_acos, js_ieee754_acos)
MATH1(math_acosh, js_ieee754_acosh)
MATH1(math_asin, js_ieee754_asin)
MATH1(math_asinh, js_ieee754_asinh)
MATH1(math_atan, js_ieee754_atan)
MATH1(math_atanh, js_ieee754_atanh)
MATH1(math_cbrt, js_ieee754_cbrt)
MATH1(math_ceil, ceil)
MATH1(math_cos, js_ieee754_cos)
MATH1(math_cosh, js_ieee754_cosh)
MATH1(math_exp, js_ieee754_exp)
MATH1(math_expm1, js_ieee754_expm1)
MATH1(math_floor, floor)
MATH1(math_fround, js_fround)
MATH1(math_log, js_ieee754_log)
MATH1(math_log1p, js_ieee754_log1p)
MATH1(math_log10, js_ieee754_log10)
MATH1(math_log2, js_ieee754_log2)
MATH1(math_round, js_round)
MATH1(math_sign, js_sign)
MATH1(math_sin, js_ieee754_sin)
MATH1(math_sinh, js_ieee754_sinh)
MATH1(math_sqrt, sqrt)
MATH1(math_tan, js_ieee754_tan)
MATH1(math_tanh, js_ieee754_tanh)
MATH1(math_trunc, trunc)

NATIVE(math_atan2) {
    UNUSED_ARGS;
    double y, x;
    if (js_to_number(ctx, &y, ARG(0)) || js_to_number(ctx, &x, ARG(1))) return JS_EXCEPTION;
    return js_number(js_ieee754_atan2(y, x));
}

NATIVE(math_pow) {
    UNUSED_ARGS;
    double x, y;
    if (js_to_number(ctx, &x, ARG(0)) || js_to_number(ctx, &y, ARG(1))) return JS_EXCEPTION;
    return js_number(js_ieee754_pow(x, y));
}

NATIVE(math_clz32) {
    UNUSED_ARGS;
    double x;
    if (js_to_number(ctx, &x, ARG(0))) return JS_EXCEPTION;
    uint32_t n = (uint32_t)js_double_to_int32(x);
    int count = 0;
    for (uint32_t bit = 0x80000000u; bit && !(n & bit); bit >>= 1) count++;
    return js_int32(count);
}

NATIVE(math_imul) {
    UNUSED_ARGS;
    double a, b;
    if (js_to_number(ctx, &a, ARG(0)) || js_to_number(ctx, &b, ARG(1))) return JS_EXCEPTION;
    return js_int32((int32_t)((uint32_t)js_double_to_int32(a) * (uint32_t)js_double_to_int32(b)));
}

/* max and min convert every argument first (§21.3.2.24), then compare; -0 < +0, NaN wins. */
static JSValue min_max(JSContext *ctx, uint32_t argc, const JSValue *argv, bool max) {
    double r = max ? -INFINITY : INFINITY;
    bool nan = false;
    for (uint32_t i = 0; i < argc; i++) {
        double x;
        if (js_to_number(ctx, &x, argv[i])) return JS_EXCEPTION;
        if (x != x) nan = true;
        else if (max ? (x > r || (x == 0 && r == 0 && !signbit(x))) : (x < r || (x == 0 && r == 0 && signbit(x)))) r = x;
    }
    return js_number(nan ? NAN : r);
}

NATIVE(math_max) {
    UNUSED_ARGS;
    return min_max(ctx, argc, argv, true);
}

NATIVE(math_min) {
    UNUSED_ARGS;
    return min_max(ctx, argc, argv, false);
}

/* hypot as V8 computes it: scaled by the largest, with Kahan summation. */
NATIVE(math_hypot) {
    UNUSED_ARGS;
    double small[8], *abs_values = argc <= 8 ? small : malloc(argc * sizeof *abs_values);
    if (!abs_values) js_fatal("out of memory");
    double max = 0;
    bool nan = false;
    for (uint32_t i = 0; i < argc; i++) {
        double x;
        if (js_to_number(ctx, &x, argv[i])) {
            if (abs_values != small) free(abs_values);
            return JS_EXCEPTION;
        }
        abs_values[i] = fabs(x);
        if (x != x) nan = true;
        else if (abs_values[i] > max) max = abs_values[i];
    }
    double r;
    if (max == INFINITY) r = INFINITY;
    else if (nan) r = NAN;
    else if (max == 0) r = 0;
    else {
        double sum = 0, compensation = 0;
        for (uint32_t i = 0; i < argc; i++) {
            double n = abs_values[i] / max;
            double summand = n * n - compensation;
            double preliminary = sum + summand;
            compensation = (preliminary - sum) - summand;
            sum = preliminary;
        }
        r = sqrt(sum) * max;
    }
    if (abs_values != small) free(abs_values);
    return js_number(r);
}

/* random: xorshift128+, as V8 uses, seeded once per program. */
static uint64_t random_state[2];

static uint64_t splitmix(uint64_t *x) {
    uint64_t z = (*x += 0x9E3779B97F4A7C15u);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9u;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBu;
    return z ^ (z >> 31);
}

NATIVE(math_random) {
    UNUSED_ARGS;
    (void)ctx, (void)argc, (void)argv;
    if (!random_state[0] && !random_state[1]) {
        uint64_t seed = (uint64_t)time(NULL) ^ ((uint64_t)(uintptr_t)&seed << 16) ^ (uint64_t)clock();
        random_state[0] = splitmix(&seed);
        random_state[1] = splitmix(&seed);
    }
    uint64_t s1 = random_state[0];
    const uint64_t s0 = random_state[1];
    random_state[0] = s0;
    s1 ^= s1 << 23;
    random_state[1] = s1 ^ s0 ^ (s1 >> 17) ^ (s0 >> 26);
    return js_double((double)(random_state[1] >> 11) * 0x1.0p-53);  /* [0, 1) */
}

/* in V8's order (Object.getOwnPropertyNames(Math) is the same as Node's) */
static const JSBuiltin math_entries[] = {
    JS_BUILTIN_FN("abs", math_abs, 1),
    JS_BUILTIN_FN("acos", math_acos, 1),
    JS_BUILTIN_FN("acosh", math_acosh, 1),
    JS_BUILTIN_FN("asin", math_asin, 1),
    JS_BUILTIN_FN("asinh", math_asinh, 1),
    JS_BUILTIN_FN("atan", math_atan, 1),
    JS_BUILTIN_FN("atanh", math_atanh, 1),
    JS_BUILTIN_FN("atan2", math_atan2, 2),
    JS_BUILTIN_FN("ceil", math_ceil, 1),
    JS_BUILTIN_FN("cbrt", math_cbrt, 1),
    JS_BUILTIN_FN("expm1", math_expm1, 1),
    JS_BUILTIN_FN("clz32", math_clz32, 1),
    JS_BUILTIN_FN("cos", math_cos, 1),
    JS_BUILTIN_FN("cosh", math_cosh, 1),
    JS_BUILTIN_FN("exp", math_exp, 1),
    JS_BUILTIN_FN("floor", math_floor, 1),
    JS_BUILTIN_FN("fround", math_fround, 1),
    JS_BUILTIN_FN("hypot", math_hypot, 2),
    JS_BUILTIN_FN("imul", math_imul, 2),
    JS_BUILTIN_FN("log", math_log, 1),
    JS_BUILTIN_FN("log1p", math_log1p, 1),
    JS_BUILTIN_FN("log2", math_log2, 1),
    JS_BUILTIN_FN("log10", math_log10, 1),
    JS_BUILTIN_FN("max", math_max, 2),
    JS_BUILTIN_FN("min", math_min, 2),
    JS_BUILTIN_FN("pow", math_pow, 2),
    JS_BUILTIN_FN("random", math_random, 0),
    JS_BUILTIN_FN("round", math_round, 1),
    JS_BUILTIN_FN("sign", math_sign, 1),
    JS_BUILTIN_FN("sin", math_sin, 1),
    JS_BUILTIN_FN("sinh", math_sinh, 1),
    JS_BUILTIN_FN("sqrt", math_sqrt, 1),
    JS_BUILTIN_FN("tan", math_tan, 1),
    JS_BUILTIN_FN("tanh", math_tanh, 1),
    JS_BUILTIN_FN("trunc", math_trunc, 1),
    JS_BUILTIN_NUMBER("E", 2.718281828459045, 0),
    JS_BUILTIN_NUMBER("LN10", 2.302585092994046, 0),
    JS_BUILTIN_NUMBER("LN2", 0.6931471805599453, 0),
    JS_BUILTIN_NUMBER("LOG10E", 0.4342944819032518, 0),
    JS_BUILTIN_NUMBER("LOG2E", 1.4426950408889634, 0),
    JS_BUILTIN_NUMBER("PI", 3.141592653589793, 0),
    JS_BUILTIN_NUMBER("SQRT1_2", 0.7071067811865476, 0),
    JS_BUILTIN_NUMBER("SQRT2", 1.4142135623730951, 0),
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "Math", JS_PROP_CONFIGURABLE),
};

const JSNativeFn js_math_inline[JS_MATH_INLINE_COUNT] = { math_sqrt, math_abs, math_floor, math_ceil, math_trunc };

static void install_math(JSContext *ctx, JSObject *global) {
    JSValue math = js_new_builtin_object(ctx, math_entries, JS_COUNTOF(math_entries));
    js_define_data(ctx, global, js_atom_from_cstr(ctx, "Math"), math, JS_BUILTIN_METHOD_ATTRS);
}

const JSComponent js_component_math = { "math", install_math };
