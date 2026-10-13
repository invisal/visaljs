/* The JS operators on primitives (ECMAScript §13, §7.2). */
#include "js_ops.h"

#include <math.h>

#include "ieee754.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_function.h"
#include "js_symbol.h"
#include "jsnum.h"

int32_t js_double_to_int32(double d) {
    if (!isfinite(d)) return 0;
    if (d > -9223372036854775808.0 && d < 9223372036854775808.0) return (int32_t)(uint32_t)(int64_t)d;  /* truncates toward zero */
    double m = fmod(trunc(d), 4294967296.0);  /* exact: |d| < 2^1024, fmod is exact */
    if (m < 0) m += 4294967296.0;
    return (int32_t)(uint32_t)m;
}

/* ToNumeric (§7.1.3): a Number value or a BigInt, or JS_EXCEPTION. */
static JSValue to_numeric(JSContext *ctx, JSValue v) {
    if (js_is_number(v) || js_is_bigint(v)) return v;
    if (js_is_object(v)) {
        v = js_to_primitive(ctx, v, JS_HINT_NUMBER);
        if (js_is_exception(v) || js_is_bigint(v)) return v;
    }
    double d;
    if (js_to_number(ctx, &d, v)) return JS_EXCEPTION;
    return js_number(d);
}

/* Both operands' ToNumeric, left first: 0, 1 when either is a BigInt, -1 with an exception. */
static int numerics(JSContext *ctx, JSValue *a, JSValue *b) {
    *a = to_numeric(ctx, *a);
    if (js_is_exception(*a)) return -1;
    *b = to_numeric(ctx, *b);
    if (js_is_exception(*b)) return -1;
    return js_is_bigint(*a) || js_is_bigint(*b);
}

/* A binary operator on ToNumeric'd operands of which one is a BigInt. */
static JSValue bigint_binary(JSContext *ctx, JSBigIntOp op, JSValue a, JSValue b) {
    if (!js_is_bigint(a) || !js_is_bigint(b)) return js_throw_type_error(ctx, "Cannot mix BigInt and other types, use explicit conversions");
    return ctx->rt->bigint->arith(ctx, op, a, b);
}

#if defined(__GNUC__) || defined(__clang__)
#define ADD_OVERFLOW(a, b, r) __builtin_add_overflow(a, b, r)
#define SUB_OVERFLOW(a, b, r) __builtin_sub_overflow(a, b, r)
#define MUL_OVERFLOW(a, b, r) __builtin_mul_overflow(a, b, r)
#else
static bool fits(int64_t v, int32_t *r) { *r = (int32_t)v; return v != (int64_t)*r; }
#define ADD_OVERFLOW(a, b, r) fits((int64_t)(a) + (b), r)
#define SUB_OVERFLOW(a, b, r) fits((int64_t)(a) - (b), r)
#define MUL_OVERFLOW(a, b, r) fits((int64_t)(a) * (b), r)
#endif

/* ---- Arithmetic --------------------------------------------------------------- */

JSValue js_add(JSContext *ctx, JSValue a, JSValue b) {
    if (js_is_int32(a) && js_is_int32(b)) {
        int32_t r;
        if (!ADD_OVERFLOW(js_as_int32(a), js_as_int32(b), &r)) return js_int32(r);
    }
    if (js_is_object(a) || js_is_object(b)) {  /* ToPrimitive both, left first (§13.15.3) */
        a = js_to_primitive(ctx, a, JS_HINT_DEFAULT);
        if (js_is_exception(a)) return JS_EXCEPTION;
        b = js_to_primitive(ctx, b, JS_HINT_DEFAULT);
        if (js_is_exception(b)) return JS_EXCEPTION;
    }
    if (js_is_string(a) || js_is_string(b)) {
        JSValue sa = js_to_string(ctx, a);
        if (js_is_exception(sa)) return JS_EXCEPTION;
        JSValue sb = js_to_string(ctx, b);
        if (js_is_exception(sb)) return JS_EXCEPTION;
        return js_concat(ctx, sa, sb);
    }
    int n = numerics(ctx, &a, &b);
    if (n < 0) return JS_EXCEPTION;
    if (n) return bigint_binary(ctx, JS_BIGINT_ADD, a, b);
    return js_number(js_as_number(a) + js_as_number(b));
}

JSValue js_sub(JSContext *ctx, JSValue a, JSValue b) {
    if (js_is_int32(a) && js_is_int32(b)) {
        int32_t r;
        if (!SUB_OVERFLOW(js_as_int32(a), js_as_int32(b), &r)) return js_int32(r);
    }
    int n = numerics(ctx, &a, &b);
    if (n < 0) return JS_EXCEPTION;
    if (n) return bigint_binary(ctx, JS_BIGINT_SUB, a, b);
    double x = js_as_number(a), y = js_as_number(b);
    return js_number(x - y);
}

JSValue js_mul(JSContext *ctx, JSValue a, JSValue b) {
    if (js_is_int32(a) && js_is_int32(b)) {
        int32_t r;
        /* 0 * negative is -0: only the double path gets that right */
        if (!MUL_OVERFLOW(js_as_int32(a), js_as_int32(b), &r) && r != 0) return js_int32(r);
    }
    int n = numerics(ctx, &a, &b);
    if (n < 0) return JS_EXCEPTION;
    if (n) return bigint_binary(ctx, JS_BIGINT_MUL, a, b);
    double x = js_as_number(a), y = js_as_number(b);
    return js_number(x * y);
}

JSValue js_div(JSContext *ctx, JSValue a, JSValue b) {
    int n = numerics(ctx, &a, &b);
    if (n < 0) return JS_EXCEPTION;
    if (n) return bigint_binary(ctx, JS_BIGINT_DIV, a, b);
    double x = js_as_number(a), y = js_as_number(b);
    return js_number(x / y);
}

JSValue js_mod(JSContext *ctx, JSValue a, JSValue b) {
    if (js_is_int32(a) && js_is_int32(b)) {
        int32_t x = js_as_int32(a), y = js_as_int32(b);
        /* x < 0 with a zero result is -0; y == -1 avoids INT32_MIN % -1 */
        if (x >= 0 && y > 0) return js_int32(x % y);
    }
    int n = numerics(ctx, &a, &b);
    if (n < 0) return JS_EXCEPTION;
    if (n) return bigint_binary(ctx, JS_BIGINT_MOD, a, b);
    double x = js_as_number(a), y = js_as_number(b);
    return js_number(fmod(x, y));  /* C's fmod has JS's semantics, signs and NaNs included */
}

JSValue js_exp(JSContext *ctx, JSValue a, JSValue b) {
    int n = numerics(ctx, &a, &b);
    if (n < 0) return JS_EXCEPTION;
    if (n) return bigint_binary(ctx, JS_BIGINT_EXP, a, b);
    double x = js_as_number(a), y = js_as_number(b);
    return js_number(js_ieee754_pow(x, y));  /* V8's: Node's results to the last bit */
}

/* ---- Bitwise ------------------------------------------------------------------ */

/* Int32 operands, or the BigInt operator (op < 0: none, >>>) */
#define INT32_OP(name, op, expr)                                                          \
    JSValue name(JSContext *ctx, JSValue a, JSValue b) {                                  \
        if (!js_is_int32(a) || !js_is_int32(b)) {                                         \
            int n = numerics(ctx, &a, &b);                                                \
            if (n < 0) return JS_EXCEPTION;                                               \
            if (n) {                                                                      \
                if ((int)(op) < 0 && js_is_bigint(a) && js_is_bigint(b))                  \
                    return js_throw_type_error(ctx, "BigInts have no unsigned right shift, use >> instead"); \
                return bigint_binary(ctx, (JSBigIntOp)(op), a, b);                        \
            }                                                                             \
        }                                                                                 \
        int32_t x = js_is_int32(a) ? js_as_int32(a) : js_double_to_int32(js_as_number(a)); \
        int32_t y = js_is_int32(b) ? js_as_int32(b) : js_double_to_int32(js_as_number(b)); \
        return (expr);                                                                    \
    }

INT32_OP(js_shl, JS_BIGINT_SHL, js_int32((int32_t)((uint32_t)x << (y & 31))))
INT32_OP(js_sar, JS_BIGINT_SAR, js_int32(x >> (y & 31)))
INT32_OP(js_shr, -1, js_number((double)((uint32_t)x >> (y & 31))))
INT32_OP(js_bitand, JS_BIGINT_AND, js_int32(x & y))
INT32_OP(js_bitor, JS_BIGINT_OR, js_int32(x | y))
INT32_OP(js_bitxor, JS_BIGINT_XOR, js_int32(x ^ y))

JSValue js_bitnot(JSContext *ctx, JSValue v) {
    if (js_is_int32(v)) return js_int32(~js_as_int32(v));
    v = to_numeric(ctx, v);
    if (js_is_exception(v)) return v;
    if (js_is_bigint(v)) return ctx->rt->bigint->arith(ctx, JS_BIGINT_NOT, v, v);
    return js_int32(~js_double_to_int32(js_as_number(v)));
}

/* ---- Unary ----------------------------------------------------------------------- */

JSValue js_neg(JSContext *ctx, JSValue v) {
    if (js_is_int32(v) && js_as_int32(v) != 0 && js_as_int32(v) != INT32_MIN) return js_int32(-js_as_int32(v));
    v = to_numeric(ctx, v);
    if (js_is_exception(v)) return v;
    if (js_is_bigint(v)) return ctx->rt->bigint->arith(ctx, JS_BIGINT_NEG, v, v);
    return js_number(-js_as_number(v));
}

JSValue js_to_number_value(JSContext *ctx, JSValue v) {
    if (js_is_number(v)) return v;
    double d;
    if (js_to_number(ctx, &d, v)) return JS_EXCEPTION;
    return js_number(d);
}

JSValue js_to_numeric(JSContext *ctx, JSValue v) {
    return to_numeric(ctx, v);
}

JSValue js_inc(JSContext *ctx, JSValue v) {
    if (js_is_bigint(v)) return ctx->rt->bigint->arith(ctx, JS_BIGINT_INC, v, v);
    return js_add(ctx, v, js_int32(1));
}

JSValue js_dec(JSContext *ctx, JSValue v) {
    if (js_is_bigint(v)) return ctx->rt->bigint->arith(ctx, JS_BIGINT_DEC, v, v);
    return js_sub(ctx, v, js_int32(1));
}

/* ---- Comparison ------------------------------------------------------------------- */

bool js_strict_equals(JSContext *ctx, JSValue a, JSValue b) {
    if (js_is_number(a) && js_is_number(b)) {
        if (js_is_int32(a) && js_is_int32(b)) return js_as_int32(a) == js_as_int32(b);
        return js_as_number(a) == js_as_number(b);  /* NaN != NaN, 0 == -0 */
    }
    if (js_is_string(a) && js_is_string(b)) return js_string_equals(ctx, a, b);
    if (js_is_bigint(a) && js_is_bigint(b)) return js_bigint_equals(a, b);
    return js_same_bits(a, b);
}

int32_t js_switch_string(JSContext *ctx, JSValue v, const JSString *const *cases, uint32_t n) {
    if (!js_is_string(v)) return -1;
    const JSCell *c = js_as_cell(v);
    uint32_t length = js_string_length(v);
    bool atom = js_is_atom(v);
    for (uint32_t i = 0; i < n; i++) {
        const JSString *s = cases[i];
        if (s == NULL) {
            if (length == 0) return (int32_t)i;
            continue;
        }
        if (&s->cell == c) return (int32_t)i;
        if (s->length != length || (atom && (s->cell.flags & JS_STR_ATOM))) continue;  /* distinct atoms differ */
        if (js_string_equals(ctx, v, js_cell((JSCell *)s))) return (int32_t)i;
    }
    return -1;
}

/* StringToBigInt of a string: the BigInt, or EMPTY when it isn't one. */
static JSValue string_to_bigint(JSContext *ctx, JSValue s) {
    return ctx->rt->bigint->from_string(ctx, s);
}

/* IsLooselyEqual (§7.2.14), primitives. */
JSValue js_eq(JSContext *ctx, JSValue a, JSValue b) {
    for (;;) {
        if (js_is_number(a) && js_is_number(b)) return js_bool(js_strict_equals(ctx, a, b));
        if (js_is_string(a) && js_is_string(b)) return js_bool(js_string_equals(ctx, a, b));
        if (js_is_nullish(a) || js_is_nullish(b)) return js_bool(js_is_nullish(a) && js_is_nullish(b));
        if (js_is_bool(a) && js_is_bool(b)) return js_bool(js_same_bits(a, b));
        /* booleans become numbers; then a number and a string compare as numbers */
        if (js_is_bool(a)) { a = js_int32(js_as_bool(a)); continue; }
        if (js_is_bool(b)) { b = js_int32(js_as_bool(b)); continue; }
        if (js_is_number(a) && js_is_string(b)) { b = js_number(js_str_to_num(js_string_view(ctx, b))); continue; }
        if (js_is_string(a) && js_is_number(b)) { a = js_number(js_str_to_num(js_string_view(ctx, a))); continue; }
        if (js_is_bigint(a) || js_is_bigint(b)) {  /* compared by mathematical value */
            if (js_is_bigint(a) && js_is_bigint(b)) return js_bool(js_bigint_equals(a, b));
            JSValue big = js_is_bigint(a) ? a : b, other = js_is_bigint(a) ? b : a;
            if (js_is_number(other)) return js_bool(ctx->rt->bigint->compare(ctx, big, other) == 0);
            if (js_is_string(other)) {
                JSValue n = string_to_bigint(ctx, other);
                if (js_is_exception(n)) return n;
                return js_bool(!js_is_empty(n) && js_bigint_equals(big, n));
            }
        }
        if (js_is_object(a) && js_is_object(b)) return js_bool(js_same_bits(a, b));  /* identity */
        if (js_is_object(a)) {
            a = js_to_primitive(ctx, a, JS_HINT_DEFAULT);
            if (js_is_exception(a)) return JS_EXCEPTION;
            continue;
        }
        if (js_is_object(b)) {
            b = js_to_primitive(ctx, b, JS_HINT_DEFAULT);
            if (js_is_exception(b)) return JS_EXCEPTION;
            continue;
        }
        return js_bool(js_same_bits(a, b));  /* symbols */
    }
}

JSValue js_ne(JSContext *ctx, JSValue a, JSValue b) {
    JSValue r = js_eq(ctx, a, b);
    return js_is_exception(r) ? r : js_bool(!js_as_bool(r));
}

/* IsLessThan (§7.2.13): 1 true, 0 false, -1 undefined (NaN), -2 exception. */
static int less_than(JSContext *ctx, JSValue a, JSValue b, bool left_first) {
    if (js_is_int32(a) && js_is_int32(b)) return js_as_int32(a) < js_as_int32(b);
    if (js_is_object(a) || js_is_object(b)) {  /* ToPrimitive in source order (§7.2.13 LeftFirst) */
        JSValue *first = left_first ? &a : &b, *second = left_first ? &b : &a;
        *first = js_to_primitive(ctx, *first, JS_HINT_NUMBER);
        if (js_is_exception(*first)) return -2;
        *second = js_to_primitive(ctx, *second, JS_HINT_NUMBER);
        if (js_is_exception(*second)) return -2;
    }
    if (js_is_string(a) && js_is_string(b)) return js_string_compare(ctx, a, b) < 0;
    /* a BigInt and a string: the string as a BigInt, undefined if it isn't one */
    if (js_is_bigint(a) && js_is_string(b)) {
        b = string_to_bigint(ctx, b);
        if (js_is_exception(b)) return -2;
        if (js_is_empty(b)) return -1;
    } else if (js_is_string(a) && js_is_bigint(b)) {
        a = string_to_bigint(ctx, a);
        if (js_is_exception(a)) return -2;
        if (js_is_empty(a)) return -1;
    }
    int n = numerics(ctx, &a, &b);
    if (n < 0) return -2;
    if (n) {
        int c = js_is_bigint(a) ? ctx->rt->bigint->compare(ctx, a, b) : -ctx->rt->bigint->compare(ctx, b, a);
        return c == 2 || c == -2 ? -1 : c < 0;
    }
    double x = js_as_number(a), y = js_as_number(b);
    if (x != x || y != y) return -1;
    return x < y;
}

static JSValue relational(int r, bool negate) {
    if (r == -2) return JS_EXCEPTION;
    if (r == -1) return JS_FALSE;
    return js_bool(negate ? !r : r);
}

JSValue js_lt(JSContext *ctx, JSValue a, JSValue b) { return relational(less_than(ctx, a, b, true), false); }
JSValue js_gt(JSContext *ctx, JSValue a, JSValue b) { return relational(less_than(ctx, b, a, false), false); }
JSValue js_le(JSContext *ctx, JSValue a, JSValue b) { return relational(less_than(ctx, b, a, false), true); }
JSValue js_ge(JSContext *ctx, JSValue a, JSValue b) { return relational(less_than(ctx, a, b, true), true); }

/* ---- typeof and bindings -------------------------------------------------------- */

JSValue js_typeof(JSContext *ctx, JSValue v) {
    (void)ctx;
    if (js_is_number(v)) return JS_ATOM(number);
    if (js_is_string(v)) return JS_ATOM(string);
    if (js_is_bool(v)) return JS_ATOM(boolean);
    if (js_is_undefined(v)) return JS_ATOM(undefined);
    if (js_is_symbol(v)) return JS_ATOM(symbol);
    if (js_is_bigint(v)) return JS_ATOM(bigint);
    if (js_is_callable(v)) return JS_ATOM(function);
    return JS_ATOM(object);  /* null and other objects */
}

JSValue js_throw_const_assign(JSContext *ctx) {
    return js_throw_type_error(ctx, "Assignment to constant variable.");
}
