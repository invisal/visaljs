/*
 * js_ops.h — the JS operators generated code calls (generic
 * operators on boxed JSValues, and the optimizer's inline ones on proven Numbers).
 *
 * Every function that can fail returns JS_EXCEPTION with the error pending.
 */
#ifndef JS_OPS_H
#define JS_OPS_H

#include "js_bigint.h"
#include "js_exception.h"
#include "js_object.h"
#include "jsstring.h"

/* ---- Arithmetic and bitwise ------------------------------------------- */

JS_WARN_UNUSED JSValue js_add(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_sub(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_mul(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_div(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_mod(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_exp(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_shl(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_sar(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_shr(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_bitand(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_bitor(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_bitxor(JSContext *ctx, JSValue a, JSValue b);

JS_WARN_UNUSED JSValue js_neg(JSContext *ctx, JSValue v);
JS_WARN_UNUSED JSValue js_bitnot(JSContext *ctx, JSValue v);
JS_WARN_UNUSED JSValue js_to_number_value(JSContext *ctx, JSValue v);  /* unary + */
JS_WARN_UNUSED JSValue js_to_numeric(JSContext *ctx, JSValue v);       /* ++/-- operand */
JS_WARN_UNUSED JSValue js_inc(JSContext *ctx, JSValue v);              /* v is numeric */
JS_WARN_UNUSED JSValue js_dec(JSContext *ctx, JSValue v);

/* ---- Comparison ---------------------------------------------------------- */

JS_WARN_UNUSED JSValue js_eq(JSContext *ctx, JSValue a, JSValue b);   /* == */
JS_WARN_UNUSED JSValue js_ne(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_lt(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_le(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_gt(JSContext *ctx, JSValue a, JSValue b);
JS_WARN_UNUSED JSValue js_ge(JSContext *ctx, JSValue a, JSValue b);

/* ===, !==: never throw (strings compare by content). */
bool js_strict_equals(JSContext *ctx, JSValue a, JSValue b);
static inline JSValue js_strict_eq(JSContext *ctx, JSValue a, JSValue b) { return js_bool(js_strict_equals(ctx, a, b)); }
static inline JSValue js_strict_ne(JSContext *ctx, JSValue a, JSValue b) { return js_bool(!js_strict_equals(ctx, a, b)); }

/* A switch whose cases are all string literals: the index of the first case `v` is === to, or
 * -1. `cases` are the literals' static strings (NULL: the empty string), atoms but for those of
 * one unit: an atom `v` matches its case by address, after one call instead of one per case. */
int32_t js_switch_string(JSContext *ctx, JSValue v, const JSString *const *cases, uint32_t n);

/* ---- Never throw -------------------------------------------------------- */

/* ToBoolean, as a C bool: branches test this. */
/* for…of: whether iter_next produced a value (EMPTY: the iterator is done). */
static inline JSValue js_not_empty(JSValue v) { return js_bool(!js_is_empty(v)); }

static inline bool js_truthy(JSValue v) {
    if (js_is_bool(v)) return js_as_bool(v);
    if (js_is_int32(v)) return js_as_int32(v) != 0;
    if (js_is_number(v)) {
        double d = js_as_double(v);
        return d == d && d != 0;
    }
    if (js_is_nullish(v)) return false;
    if (js_is_string(v)) return js_string_length(v) != 0;
    if (js_is_bigint(v)) return !js_bigint_is_zero(v);
    return true;  /* symbols and objects */
}

static inline JSValue js_to_boolean(JSValue v) { return js_bool(js_truthy(v)); }
static inline JSValue js_not(JSValue v) { return js_bool(!js_truthy(v)); }
static inline JSValue js_is_nullish_value(JSValue v) { return js_bool(js_is_nullish(v)); }

/* typeof: an atom ("undefined", "number", …). */
JSValue js_typeof(JSContext *ctx, JSValue v);

/* ---- Bindings -------------------------------------------------------------- */

/* v itself, or a ReferenceError if it's still uninitialized (JS_EMPTY: the TDZ). */
static inline JSValue js_check_tdz(JSContext *ctx, JSValue v, const char *name) {
    if (JS_UNLIKELY(js_is_empty(v)))
        return js_throw_reference_error(ctx, "Cannot access '%s' before initialization", name);
    return v;
}

/* A name no declaration binds: the global object's property, or a ReferenceError (global.c). */
JS_WARN_UNUSED JSValue js_global_name(JSContext *ctx, const char *name);
/* The same with the name's key (an atom) at hand: an own data property of the global object
 * (Math, Array, console…) in one lookup, anything else as js_global_name. */
JS_WARN_UNUSED JSValue js_global_get(JSContext *ctx, JSValue key, const char *name);
/* A sloppy function's `this` (§10.2.1.2): undefined and null become the
 * global object, other primitives their wrapper (ToObject). */
static inline JSValue js_sloppy_this(JSContext *ctx, JSValue v) {
    if (js_is_nullish(v)) return ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT];
    return js_is_object(v) ? v : js_new_wrapper(ctx, v, JS_UNDEFINED);
}

/* A classic script's top-level `var` and function declarations (§16.1.7): properties of the
 * global object, not configurable. 0, or -1 on exception (a TypeError: can't declare it). */
JS_WARN_UNUSED int js_declare_global_var(JSContext *ctx, JSValue key);
JS_WARN_UNUSED int js_declare_global_function(JSContext *ctx, JSValue key, JSValue fn);
/* `name = v` where no declaration binds name: a global property (sloppy), or a
 * ReferenceError if strict code names one that doesn't exist. 1/0 like js_set, -1. */
JS_WARN_UNUSED int js_set_global_name(JSContext *ctx, JSValue key, JSValue v, bool strict);

/* The same for `typeof name`: undefined instead of the ReferenceError. */
JS_WARN_UNUSED JSValue js_global_typeof_name(JSContext *ctx, const char *name);
JS_WARN_UNUSED JSValue js_throw_const_assign(JSContext *ctx);

/* ToInt32 / ToUint32 of a number (ECMAScript §7.1.6). */
int32_t js_double_to_int32(double d);

/* ---- Number operators (the optimizer's num_* ops) ------------------------------
 * Both operands are proven Numbers (int32 or double JSValues), so these never throw, allocate
 * or run user code: inline, with the int32 case first. Where the optimizer unboxes the values,
 * the operators are plain C on doubles instead; these serve generator and async functions. */

static inline JSValue js_num_add(JSValue a, JSValue b) {
    int32_t r;
    if (js_is_int32(a) && js_is_int32(b) && !__builtin_add_overflow(js_as_int32(a), js_as_int32(b), &r)) return js_int32(r);
    return js_number(js_as_number(a) + js_as_number(b));
}
static inline JSValue js_num_sub(JSValue a, JSValue b) {
    int32_t r;
    if (js_is_int32(a) && js_is_int32(b) && !__builtin_sub_overflow(js_as_int32(a), js_as_int32(b), &r)) return js_int32(r);
    return js_number(js_as_number(a) - js_as_number(b));
}
static inline JSValue js_num_mul(JSValue a, JSValue b) {
    int32_t r;
    /* a zero product of a negative operand is -0: a double */
    if (js_is_int32(a) && js_is_int32(b) && !__builtin_mul_overflow(js_as_int32(a), js_as_int32(b), &r) &&
        (r != 0 || (js_as_int32(a) >= 0 && js_as_int32(b) >= 0))) return js_int32(r);
    return js_number(js_as_number(a) * js_as_number(b));
}
static inline JSValue js_num_div(JSValue a, JSValue b) { return js_number(js_as_number(a) / js_as_number(b)); }
static inline JSValue js_num_mod(JSValue a, JSValue b) {
    if (js_is_int32(a) && js_is_int32(b) && js_as_int32(a) >= 0 && js_as_int32(b) > 0) return js_int32(js_as_int32(a) % js_as_int32(b));
    return js_number(fmod(js_as_number(a), js_as_number(b)));
}
static inline JSValue js_num_neg(JSValue v) {
    if (js_is_int32(v) && js_as_int32(v) != 0 && js_as_int32(v) != INT32_MIN) return js_int32(-js_as_int32(v));
    return js_number(-js_as_number(v));
}
static inline JSValue js_num_inc(JSValue v) { return js_num_add(v, js_int32(1)); }
static inline JSValue js_num_dec(JSValue v) { return js_num_sub(v, js_int32(1)); }

static inline JSValue js_num_lt(JSValue a, JSValue b) { return js_bool(js_as_number(a) < js_as_number(b)); }
static inline JSValue js_num_le(JSValue a, JSValue b) { return js_bool(js_as_number(a) <= js_as_number(b)); }
static inline JSValue js_num_gt(JSValue a, JSValue b) { return js_bool(js_as_number(a) > js_as_number(b)); }
static inline JSValue js_num_ge(JSValue a, JSValue b) { return js_bool(js_as_number(a) >= js_as_number(b)); }
static inline JSValue js_num_eq(JSValue a, JSValue b) { return js_bool(js_as_number(a) == js_as_number(b)); }
static inline JSValue js_num_ne(JSValue a, JSValue b) { return js_bool(js_as_number(a) != js_as_number(b)); }

/* ToInt32 of a double: below 2^63 in magnitude, truncating to int64 and keeping the low 32 bits
 * is exactly ToInt32 (a hash's `(h * 31 + c) | 0` lands there), else the general one (NaN and
 * the infinities fail the comparisons). */
static inline int32_t js_f64_to_int32(double d) {
    if (d > -9223372036854775808.0 && d < 9223372036854775808.0) return (int32_t)(uint32_t)(int64_t)d;
    return js_double_to_int32(d);
}
/* A Number the compiler proved an int32, from its boxed form: an int32 holding one
 * may still be a double (runtime code making 3.0 with js_double). */
static inline int32_t js_as_int32_value(JSValue v) {
    return js_is_int32(v) ? js_as_int32(v) : (int32_t)js_as_double(v);
}
/* a % b on doubles: integer % when both are integers in int32 range and the dividend isn't
 * negative (a negative one can give -0), else fmod (a libm call, much slower) */
static inline double js_f64_mod(double a, double b) {
    if (a <= 2147483647.0 && !signbit(a) && b >= 1.0 && b <= 2147483647.0) {
        int32_t x = (int32_t)a, y = (int32_t)b;
        if ((double)x == a && (double)y == b) return (double)(x % y);
    }
    return fmod(a, b);
}
/* ToInt32 of a Number */
static inline int32_t js_num_int32(JSValue v) { return js_is_int32(v) ? js_as_int32(v) : js_f64_to_int32(js_as_double(v)); }
static inline JSValue js_num_bitand(JSValue a, JSValue b) { return js_int32(js_num_int32(a) & js_num_int32(b)); }
static inline JSValue js_num_bitor(JSValue a, JSValue b) { return js_int32(js_num_int32(a) | js_num_int32(b)); }
static inline JSValue js_num_bitxor(JSValue a, JSValue b) { return js_int32(js_num_int32(a) ^ js_num_int32(b)); }
static inline JSValue js_num_bitnot(JSValue v) { return js_int32(~js_num_int32(v)); }
static inline JSValue js_num_shl(JSValue a, JSValue b) { return js_int32((int32_t)((uint32_t)js_num_int32(a) << (js_num_int32(b) & 31))); }
static inline JSValue js_num_sar(JSValue a, JSValue b) { return js_int32(js_num_int32(a) >> (js_num_int32(b) & 31)); }
static inline JSValue js_num_shr(JSValue a, JSValue b) { return js_number((double)((uint32_t)js_num_int32(a) >> (js_num_int32(b) & 31))); }

/* Operators on values the compiler couldn't type, in loops: the Number path
 * inline when both operands are Numbers, else the generic operator. */
#define JS_NUMBER_FIRST2(op)                                                                    \
    static inline JSValue js_##op##_fast(JSContext *ctx, JSValue a, JSValue b) {               \
        if (JS_LIKELY(js_is_number(a) && js_is_number(b))) return js_num_##op(a, b);           \
        return js_##op(ctx, a, b);                                                              \
    }
#define JS_NUMBER_FIRST1(op)                                                                    \
    static inline JSValue js_##op##_fast(JSContext *ctx, JSValue a) {                          \
        if (JS_LIKELY(js_is_number(a))) return js_num_##op(a);                                  \
        return js_##op(ctx, a);                                                                 \
    }
JS_NUMBER_FIRST2(add) JS_NUMBER_FIRST2(sub) JS_NUMBER_FIRST2(mul) JS_NUMBER_FIRST2(div) JS_NUMBER_FIRST2(mod)
JS_NUMBER_FIRST2(lt) JS_NUMBER_FIRST2(le) JS_NUMBER_FIRST2(gt) JS_NUMBER_FIRST2(ge) JS_NUMBER_FIRST2(eq) JS_NUMBER_FIRST2(ne)
JS_NUMBER_FIRST2(bitand) JS_NUMBER_FIRST2(bitor) JS_NUMBER_FIRST2(bitxor) JS_NUMBER_FIRST2(shl) JS_NUMBER_FIRST2(sar)
JS_NUMBER_FIRST2(shr)
JS_NUMBER_FIRST1(neg) JS_NUMBER_FIRST1(inc) JS_NUMBER_FIRST1(dec) JS_NUMBER_FIRST1(bitnot)
static inline JSValue js_to_numeric_fast(JSContext *ctx, JSValue v) {
    return JS_LIKELY(js_is_number(v)) ? v : js_to_numeric(ctx, v);
}
#undef JS_NUMBER_FIRST1
#undef JS_NUMBER_FIRST2

#endif /* JS_OPS_H */
