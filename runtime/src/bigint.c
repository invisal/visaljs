/* BigInt (ECMAScript §6.1.6.2, §21.2), the bigint component.
 *
 * The arithmetic is ported from QuickJS (https://github.com/bellard/quickjs, upstream commit
 * a38171d37357edff256c28a73eaeb41d2466d1d5, the one runtime/third_party/quickjs-dtoa comes from):
 * the "bigint support" section of quickjs.c, Copyright (c) 2017-2025 Fabrice Bellard and Charlie
 * Gordon, MIT license (runtime/third_party/quickjs-regexp/LICENSE). The algorithms are unchanged.
 * What changed: a JSBigInt is a GC cell (js_bigint.h), so the reference counting is gone and
 * intermediate results are garbage; QuickJS's short (inline) BigInts don't exist here; the
 * realloc()s that grow or shrink a result became a new cell or a shorter `len`; errors are thrown
 * our way, with V8's messages.
 *
 * The core reaches this file only through rt->bigint (JSBigIntOps), which install_bigint sets. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "builtins_util.h"
#include "js_atoms.h"
#include "js_bigint.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_function.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "jscontext.h"
#include "jsnum.h"
#include "jsstring.h"
#include "cutils.h"

#if JS_LIMB_BITS == 32
typedef int32_t js_slimb_t;
typedef int64_t js_sdlimb_t;
typedef uint64_t js_dlimb_t;
#define JS_LIMB_DIGITS 9
#else
typedef int64_t js_slimb_t;
__extension__ typedef __int128 js_sdlimb_t;
__extension__ typedef unsigned __int128 js_dlimb_t;
#define JS_LIMB_DIGITS 19
#endif

#define JS_BIGINT_MAX_SIZE ((1024 * 1024) / JS_LIMB_BITS) /* in limbs: 2^20 bits */

/* A stack BigInt big enough for a 64-bit integer, for operands made on the fly: JSBigInt's
 * layout with room for the limbs. */
typedef JS_STATIC_BIGINT_TYPE((64 + JS_LIMB_BITS - 1) / JS_LIMB_BITS) JSBigIntBuf;

/* ---- Limb arithmetic (QuickJS) ------------------------------------------------------------ */

#define ADDC(res, carry_out, op1, op2, carry_in)        \
do {                                                    \
    js_limb_t __v, __a, __k, __k1;                      \
    __v = (op1);                                        \
    __a = __v + (op2);                                  \
    __k1 = __a < __v;                                   \
    __k = (carry_in);                                   \
    __a = __a + __k;                                    \
    carry_out = (__a < __k) | __k1;                     \
    res = __a;                                          \
} while (0)

#if JS_LIMB_BITS == 32
static inline js_limb_t js_limb_clz(js_limb_t a) { return (js_limb_t)clz32(a); }  /* a != 0 */
#else
static inline js_limb_t js_limb_clz(js_limb_t a) { return (js_limb_t)clz64(a); }
#endif

static inline js_limb_t js_limb_safe_clz(js_limb_t a) { return a == 0 ? JS_LIMB_BITS : js_limb_clz(a); }

static js_limb_t mp_add(js_limb_t *res, const js_limb_t *op1, const js_limb_t *op2, js_limb_t n, js_limb_t carry) {
    for (js_limb_t i = 0; i < n; i++) ADDC(res[i], carry, op1[i], op2[i], carry);
    return carry;
}

static js_limb_t mp_sub(js_limb_t *res, const js_limb_t *op1, const js_limb_t *op2, int n, js_limb_t carry) {
    js_limb_t k = carry, a, v, k1;
    for (int i = 0; i < n; i++) {
        v = op1[i];
        a = v - op2[i];
        k1 = a > v;
        v = a - k;
        k = (v > a) | k1;
        res[i] = v;
    }
    return k;
}

/* res = 0 - op2. */
static js_limb_t mp_neg(js_limb_t *res, const js_limb_t *op2, int n) {
    js_limb_t v, carry = 1;
    for (int i = 0; i < n; i++) {
        v = ~op2[i] + carry;
        carry = v < carry;
        res[i] = v;
    }
    return carry;
}

/* tabr[] = taba[] * b + l. Returns the high carry. */
static js_limb_t mp_mul1(js_limb_t *tabr, const js_limb_t *taba, js_limb_t n, js_limb_t b, js_limb_t l) {
    for (js_limb_t i = 0; i < n; i++) {
        js_dlimb_t t = (js_dlimb_t)taba[i] * (js_dlimb_t)b + l;
        tabr[i] = (js_limb_t)t;
        l = (js_limb_t)(t >> JS_LIMB_BITS);
    }
    return l;
}

static js_limb_t mp_div1(js_limb_t *tabr, const js_limb_t *taba, js_limb_t n, js_limb_t b, js_limb_t r) {
    for (js_slimb_t i = (js_slimb_t)n - 1; i >= 0; i--) {
        js_dlimb_t a1 = ((js_dlimb_t)r << JS_LIMB_BITS) | taba[i];
        tabr[i] = (js_limb_t)(a1 / b);
        r = (js_limb_t)(a1 % b);
    }
    return r;
}

/* tabr[] += taba[] * b. Returns the high word. */
static js_limb_t mp_add_mul1(js_limb_t *tabr, const js_limb_t *taba, js_limb_t n, js_limb_t b) {
    js_limb_t l = 0;
    for (js_limb_t i = 0; i < n; i++) {
        js_dlimb_t t = (js_dlimb_t)taba[i] * (js_dlimb_t)b + l + tabr[i];
        tabr[i] = (js_limb_t)t;
        l = (js_limb_t)(t >> JS_LIMB_BITS);
    }
    return l;
}

/* The result has op1_size + op2_size limbs. */
static void mp_mul_basecase(js_limb_t *result, const js_limb_t *op1, js_limb_t op1_size, const js_limb_t *op2, js_limb_t op2_size) {
    result[op1_size] = mp_mul1(result, op1, op1_size, op2[0], 0);
    for (js_limb_t i = 1; i < op2_size; i++) result[i + op1_size] = mp_add_mul1(result + i, op1, op1_size, op2[i]);
}

/* tabr[] -= taba[] * b. Returns the value to subtract from the high word. */
static js_limb_t mp_sub_mul1(js_limb_t *tabr, const js_limb_t *taba, js_limb_t n, js_limb_t b) {
    js_limb_t l = 0;
    for (js_limb_t i = 0; i < n; i++) {
        js_dlimb_t t = tabr[i] - (js_dlimb_t)taba[i] * (js_dlimb_t)b - l;
        tabr[i] = (js_limb_t)t;
        l = (js_limb_t)-(js_limb_t)(t >> JS_LIMB_BITS);
    }
    return l;
}

/* d must be >= 2^(JS_LIMB_BITS-1) */
static inline js_limb_t udiv1norm_init(js_limb_t d) {
    js_limb_t a1 = -d - 1, a0 = (js_limb_t)-1;
    return (js_limb_t)((((js_dlimb_t)a1 << JS_LIMB_BITS) | a0) / d);
}

/* The quotient, and the remainder in *pr, of (a1*2^JS_LIMB_BITS + a0) / d with 0 <= a1 < d. */
static inline js_limb_t udiv1norm(js_limb_t *pr, js_limb_t a1, js_limb_t a0, js_limb_t d, js_limb_t d_inv) {
    js_limb_t n1m, n_adj, q, r, ah;
    js_dlimb_t a;
    n1m = (js_limb_t)((js_slimb_t)a0 >> (JS_LIMB_BITS - 1));
    n_adj = a0 + (n1m & d);
    a = (js_dlimb_t)d_inv * (a1 - n1m) + n_adj;
    q = (js_limb_t)(a >> JS_LIMB_BITS) + a1;
    /* a - q * d, then q fixed so that the remainder is between 0 and d - 1 */
    a = ((js_dlimb_t)a1 << JS_LIMB_BITS) | a0;
    a = a - (js_dlimb_t)q * d - d;
    ah = (js_limb_t)(a >> JS_LIMB_BITS);
    q += 1 + ah;
    r = (js_limb_t)a + (ah & d);
    *pr = r;
    return q;
}

#define UDIV1NORM_THRESHOLD 3

/* b must be >= 1 << (JS_LIMB_BITS - 1) */
static js_limb_t mp_div1norm(js_limb_t *tabr, const js_limb_t *taba, js_limb_t n, js_limb_t b, js_limb_t r) {
    if (n >= UDIV1NORM_THRESHOLD) {
        js_limb_t b_inv = udiv1norm_init(b);
        for (js_slimb_t i = (js_slimb_t)n - 1; i >= 0; i--) tabr[i] = udiv1norm(&r, r, taba[i], b, b_inv);
    } else {
        for (js_slimb_t i = (js_slimb_t)n - 1; i >= 0; i--) {
            js_dlimb_t a1 = ((js_dlimb_t)r << JS_LIMB_BITS) | taba[i];
            tabr[i] = (js_limb_t)(a1 / b);
            r = (js_limb_t)(a1 % b);
        }
    }
    return r;
}

/* Base case division of taba[0..na-1] by tabb[0..nb-1]: tabb[nb - 1] must be >= 1 <<
 * (JS_LIMB_BITS - 1) and na >= nb. taba ends with the remainder (nb limbs), tabq[0..na-nb] with
 * the quotient (tabq[na - nb] <= 1). */
static void mp_divnorm(js_limb_t *tabq, js_limb_t *taba, js_limb_t na, const js_limb_t *tabb, js_limb_t nb) {
    js_limb_t r, a, c, q, v, b1, b1_inv, n, dummy_r;
    int i, j;

    b1 = tabb[nb - 1];
    if (nb == 1) {
        taba[0] = mp_div1norm(tabq, taba, na, b1, 0);
        return;
    }
    n = na - nb;
    b1_inv = n >= UDIV1NORM_THRESHOLD ? udiv1norm_init(b1) : 0;

    /* first iteration: the quotient is only 0 or 1 */
    q = 1;
    for (j = (int)nb - 1; j >= 0; j--) {
        if (taba[n + (js_limb_t)j] != tabb[j]) {
            if (taba[n + (js_limb_t)j] < tabb[j]) q = 0;
            break;
        }
    }
    tabq[n] = q;
    if (q) mp_sub(taba + n, taba + n, tabb, (int)nb, 0);

    for (i = (int)n - 1; i >= 0; i--) {
        if (taba[(js_limb_t)i + nb] >= b1) {
            q = (js_limb_t)-1;
        } else if (b1_inv) {
            q = udiv1norm(&dummy_r, taba[(js_limb_t)i + nb], taba[(js_limb_t)i + nb - 1], b1, b1_inv);
        } else {
            js_dlimb_t al = ((js_dlimb_t)taba[(js_limb_t)i + nb] << JS_LIMB_BITS) | taba[(js_limb_t)i + nb - 1];
            q = (js_limb_t)(al / b1);
        }
        r = mp_sub_mul1(taba + i, tabb, nb, q);

        v = taba[(js_limb_t)i + nb];
        a = v - r;
        c = (a > v);
        taba[(js_limb_t)i + nb] = a;

        if (c != 0) {  /* negative result */
            for (;;) {
                q--;
                c = mp_add(taba + i, taba + i, tabb, nb, 0);
                /* propagate the carry and test for a positive result */
                if (c != 0 && ++taba[(js_limb_t)i + nb] == 0) break;
            }
        }
        tabq[i] = q;
    }
}

/* 1 <= shift <= JS_LIMB_BITS - 1 */
static js_limb_t mp_shl(js_limb_t *tabr, const js_limb_t *taba, int n, int shift) {
    js_limb_t l = 0, v;
    for (int i = 0; i < n; i++) {
        v = taba[i];
        tabr[i] = (v << shift) | l;
        l = v >> (JS_LIMB_BITS - shift);
    }
    return l;
}

/* r = (a + high*B^n) >> shift. Returns the remainder (0 <= r < 2^shift). 1 <= shift <=
 * JS_LIMB_BITS - 1 */
static js_limb_t mp_shr(js_limb_t *tab_r, const js_limb_t *tab, int n, int shift, js_limb_t high) {
    js_limb_t l = high, a;
    for (int i = n - 1; i >= 0; i--) {
        a = tab[i];
        tab_r[i] = (a >> shift) | (l << (JS_LIMB_BITS - shift));
        l = a;
    }
    return l & (((js_limb_t)1 << shift) - 1);
}

/* ---- BigInt cells -------------------------------------------------------------------------- */

static JSValue throw_too_large(JSContext *ctx) {
    return js_throw_range_error(ctx, "Maximum BigInt size exceeded");
}

/* A new cell of len limbs (contents unset), or NULL with a RangeError past 2^20 bits. */
static JSBigInt *js_bigint_new(JSContext *ctx, int len) {
    if (len > JS_BIGINT_MAX_SIZE) {
        js_discard(throw_too_large(ctx));
        return NULL;
    }
    JSBigInt *r = (JSBigInt *)js_alloc_cell(ctx, JS_CELL_BIGINT, sizeof(JSBigInt) + (size_t)len * sizeof(js_limb_t));
    r->len = (uint32_t)len;
    return r;
}

static JSBigInt *js_bigint_set_si(JSBigIntBuf *buf, js_slimb_t a) {
    JSBigInt *r = (JSBigInt *)buf;
    r->len = 1;
    r->tab[0] = (js_limb_t)a;
    return r;
}

static JSBigInt *js_bigint_set_si64(JSBigIntBuf *buf, int64_t a) {
#if JS_LIMB_BITS == 64
    return js_bigint_set_si(buf, a);
#else
    JSBigInt *r = (JSBigInt *)buf;
    if (a >= INT32_MIN && a <= INT32_MAX) {
        r->len = 1;
        r->tab[0] = (js_limb_t)a;
    } else {
        r->len = 2;
        r->tab[0] = (js_limb_t)a;
        r->tab[1] = (js_limb_t)(a >> JS_LIMB_BITS);
    }
    return r;
#endif
}

static JSBigInt *js_bigint_new_si(JSContext *ctx, js_slimb_t a) {
    JSBigInt *r = js_bigint_new(ctx, 1);
    r->tab[0] = (js_limb_t)a;
    return r;
}

static JSBigInt *js_bigint_new_si64(JSContext *ctx, int64_t a) {
#if JS_LIMB_BITS == 64
    return js_bigint_new_si(ctx, a);
#else
    if (a >= INT32_MIN && a <= INT32_MAX) return js_bigint_new_si(ctx, (js_slimb_t)a);
    JSBigInt *r = js_bigint_new(ctx, 2);
    r->tab[0] = (js_limb_t)a;
    r->tab[1] = (js_limb_t)(a >> 32);
    return r;
#endif
}

static JSBigInt *js_bigint_new_ui64(JSContext *ctx, uint64_t a) {
    if (a <= INT64_MAX) return js_bigint_new_si64(ctx, (int64_t)a);
    JSBigInt *r = js_bigint_new(ctx, (65 + JS_LIMB_BITS - 1) / JS_LIMB_BITS);
#if JS_LIMB_BITS == 64
    r->tab[0] = a;
    r->tab[1] = 0;
#else
    r->tab[0] = (js_limb_t)a;
    r->tab[1] = (js_limb_t)(a >> 32);
    r->tab[2] = 0;
#endif
    return r;
}

/* Drops redundant high limbs (the cell keeps its size: a shorter `len` is all it takes). */
static JSBigInt *js_bigint_normalize1(JSBigInt *a, int l) {
    js_limb_t v;
    while (l > 1) {
        v = a->tab[l - 1];
        if ((v != 0 && v != (js_limb_t)-1) || (v & 1) != (a->tab[l - 2] >> (JS_LIMB_BITS - 1))) break;
        l--;
    }
    a->len = (uint32_t)l;
    return a;
}

static JSBigInt *js_bigint_normalize(JSBigInt *a) { return js_bigint_normalize1(a, (int)a->len); }

/* 0 or 1, the sign bit */
static inline int js_bigint_sign(const JSBigInt *a) { return (int)(a->tab[a->len - 1] >> (JS_LIMB_BITS - 1)); }

static js_slimb_t js_bigint_get_si_sat(const JSBigInt *a) {
    if (a->len == 1) return (js_slimb_t)a->tab[0];
#if JS_LIMB_BITS == 32
    return js_bigint_sign(a) ? INT32_MIN : INT32_MAX;
#else
    return js_bigint_sign(a) ? INT64_MIN : INT64_MAX;
#endif
}

/* r with the limb op1 added on top when it carries information; normalized. */
static JSBigInt *js_bigint_extend(JSContext *ctx, JSBigInt *r, js_limb_t op1) {
    int n2 = (int)r->len;
    if ((op1 != 0 && op1 != (js_limb_t)-1) || (op1 & 1) != r->tab[n2 - 1] >> (JS_LIMB_BITS - 1)) {
        JSBigInt *r1 = js_bigint_new(ctx, n2 + 1);
        if (!r1) return NULL;
        memcpy(r1->tab, r->tab, (size_t)n2 * sizeof(js_limb_t));
        r1->tab[n2] = op1;
        return r1;
    }
    return js_bigint_normalize(r);
}

/* a + b (b_neg = 0) or a - b (b_neg = 1) */
static JSBigInt *js_bigint_add(JSContext *ctx, const JSBigInt *a, const JSBigInt *b, int b_neg) {
    int n2 = max_int((int)a->len, (int)b->len), n1 = min_int((int)a->len, (int)b->len), i;
    js_limb_t carry, op1, op2, a_sign, b_sign;
    JSBigInt *r = js_bigint_new(ctx, n2);
    if (!r) return NULL;
    /* the common part */
    carry = (js_limb_t)b_neg;
    for (i = 0; i < n1; i++) {
        op1 = a->tab[i];
        op2 = b->tab[i] ^ (-(js_limb_t)b_neg);
        ADDC(r->tab[i], carry, op1, op2, carry);
    }
    a_sign = -(js_limb_t)js_bigint_sign(a);
    b_sign = (-(js_limb_t)js_bigint_sign(b)) ^ (-(js_limb_t)b_neg);
    /* the part where one operand is sign-extended */
    if (a->len > b->len) {
        for (i = n1; i < n2; i++) {
            op1 = a->tab[i];
            ADDC(r->tab[i], carry, op1, b_sign, carry);
        }
    } else if (a->len < b->len) {
        for (i = n1; i < n2; i++) {
            op2 = b->tab[i] ^ (-(js_limb_t)b_neg);
            ADDC(r->tab[i], carry, a_sign, op2, carry);
        }
    }
    /* both sign-extended: extend the result if needed */
    return js_bigint_extend(ctx, r, a_sign + b_sign + carry);
}

static JSBigInt *js_bigint_neg(JSContext *ctx, const JSBigInt *a) {
    JSBigIntBuf buf;
    return js_bigint_add(ctx, js_bigint_set_si(&buf, 0), a, 1);
}

static JSBigInt *js_bigint_mul(JSContext *ctx, const JSBigInt *a, const JSBigInt *b) {
    JSBigInt *r = js_bigint_new(ctx, (int)(a->len + b->len));
    if (!r) return NULL;
    mp_mul_basecase(r->tab, a->tab, a->len, b->tab, b->len);
    /* correct the result for negative operands (no overflow is possible) */
    if (js_bigint_sign(a)) mp_sub(r->tab + a->len, r->tab + a->len, b->tab, (int)b->len, 0);
    if (js_bigint_sign(b)) mp_sub(r->tab + b->len, r->tab + b->len, a->tab, (int)a->len, 0);
    return js_bigint_normalize(r);
}

/* The quotient (truncated) or the remainder; NULL with a RangeError for a zero divisor. */
static JSBigInt *js_bigint_divrem(JSContext *ctx, const JSBigInt *a, const JSBigInt *b, bool is_rem) {
    JSBigInt *r, *q;
    js_limb_t *tabb, h;
    int na, nb, a_sign, b_sign, shift;

    if (b->len == 1 && b->tab[0] == 0) {
        js_discard(js_throw_range_error(ctx, "Division by zero"));
        return NULL;
    }
    a_sign = js_bigint_sign(a);
    b_sign = js_bigint_sign(b);
    na = (int)a->len;
    nb = (int)b->len;

    r = js_bigint_new(ctx, na + 2);
    if (!r) return NULL;
    if (a_sign) mp_neg(r->tab, a->tab, na);
    else memcpy(r->tab, a->tab, (size_t)na * sizeof(a->tab[0]));
    while (na > 1 && r->tab[na - 1] == 0) na--;

    tabb = malloc((size_t)nb * sizeof(tabb[0]));
    if (!tabb) js_fatal("out of memory dividing a BigInt");
    if (b_sign) mp_neg(tabb, b->tab, nb);
    else memcpy(tabb, b->tab, (size_t)nb * sizeof(tabb[0]));
    while (nb > 1 && tabb[nb - 1] == 0) nb--;

    if (na < nb) {  /* |a| < |b|: the remainder is a, the quotient 0 */
        free(tabb);
        if (is_rem) {
            r = js_bigint_new(ctx, (int)a->len);
            memcpy(r->tab, a->tab, a->len * sizeof(a->tab[0]));
            return r;
        }
        return js_bigint_new_si(ctx, 0);
    }

    /* normalize b */
    shift = (int)js_limb_clz(tabb[nb - 1]);
    if (shift != 0) {
        mp_shl(tabb, tabb, nb, shift);
        h = mp_shl(r->tab, r->tab, na, shift);
        if (h != 0) r->tab[na++] = h;
    }

    q = js_bigint_new(ctx, na - nb + 2);  /* one more limb for the sign */
    if (!q) {
        free(tabb);
        return NULL;
    }
    mp_divnorm(q->tab, r->tab, (js_limb_t)na, tabb, (js_limb_t)nb);
    free(tabb);

    if (is_rem) {
        if (shift != 0) mp_shr(r->tab, r->tab, nb, shift, 0);
        r->tab[nb++] = 0;
        if (a_sign) mp_neg(r->tab, r->tab, nb);
        return js_bigint_normalize1(r, nb);
    }
    q->tab[na - nb + 1] = 0;
    if (a_sign ^ b_sign) mp_neg(q->tab, q->tab, (int)q->len);
    return js_bigint_normalize(q);
}

/* &, | and ^ */
static JSBigInt *js_bigint_logic(JSContext *ctx, const JSBigInt *a, const JSBigInt *b, JSBigIntOp op) {
    if (a->len < b->len) {
        const JSBigInt *tmp = a;
        a = b;
        b = tmp;
    }
    /* a_len >= b_len */
    int a_len = (int)a->len, b_len = (int)b->len, i;
    js_limb_t b_sign = -(js_limb_t)js_bigint_sign(b);
    JSBigInt *r = js_bigint_new(ctx, a_len);
    if (!r) return NULL;
    switch (op) {
    case JS_BIGINT_OR:
        for (i = 0; i < b_len; i++) r->tab[i] = a->tab[i] | b->tab[i];
        for (i = b_len; i < a_len; i++) r->tab[i] = a->tab[i] | b_sign;
        break;
    case JS_BIGINT_AND:
        for (i = 0; i < b_len; i++) r->tab[i] = a->tab[i] & b->tab[i];
        for (i = b_len; i < a_len; i++) r->tab[i] = a->tab[i] & b_sign;
        break;
    default:
        for (i = 0; i < b_len; i++) r->tab[i] = a->tab[i] ^ b->tab[i];
        for (i = b_len; i < a_len; i++) r->tab[i] = a->tab[i] ^ b_sign;
        break;
    }
    return js_bigint_normalize(r);
}

static JSBigInt *js_bigint_not(JSContext *ctx, const JSBigInt *a) {
    JSBigInt *r = js_bigint_new(ctx, (int)a->len);
    for (uint32_t i = 0; i < a->len; i++) r->tab[i] = ~a->tab[i];
    return r;  /* no normalization needed */
}

static JSBigInt *js_bigint_shl(JSContext *ctx, const JSBigInt *a, unsigned int shift1) {
    if (a->len == 1 && a->tab[0] == 0) return js_bigint_new_si(ctx, 0);
    int d = (int)(shift1 / JS_LIMB_BITS), shift = (int)(shift1 % JS_LIMB_BITS), i;
    if ((int64_t)a->len + d > JS_BIGINT_MAX_SIZE) {
        js_discard(throw_too_large(ctx));
        return NULL;
    }
    JSBigInt *r = js_bigint_new(ctx, (int)a->len + d);
    if (!r) return NULL;
    for (i = 0; i < d; i++) r->tab[i] = 0;
    if (shift == 0) {
        for (i = 0; i < (int)a->len; i++) r->tab[i + d] = a->tab[i];
    } else {
        js_limb_t l = mp_shl(r->tab + d, a->tab, (int)a->len, shift);
        if (js_bigint_sign(a)) l |= (js_limb_t)(-1) << shift;
        r = js_bigint_extend(ctx, r, l);
    }
    return r;
}

static JSBigInt *js_bigint_shr(JSContext *ctx, const JSBigInt *a, unsigned int shift1) {
    int d = (int)(shift1 / JS_LIMB_BITS), shift = (int)(shift1 % JS_LIMB_BITS), a_sign = js_bigint_sign(a), i;
    if (d >= (int)a->len) return js_bigint_new_si(ctx, -a_sign);
    int n1 = (int)a->len - d;
    JSBigInt *r = js_bigint_new(ctx, n1);
    if (shift == 0) {
        for (i = 0; i < n1; i++) r->tab[i] = a->tab[i + d];  /* no normalization needed */
    } else {
        mp_shr(r->tab, a->tab + d, n1, shift, -(js_limb_t)a_sign);
        r = js_bigint_normalize(r);
    }
    return r;
}

static JSBigInt *js_bigint_pow(JSContext *ctx, const JSBigInt *a, const JSBigInt *b) {
    uint32_t e;
    int n_bits, i;
    JSBigInt *r;

    if (js_bigint_sign(b)) {
        js_discard(js_throw_range_error(ctx, "undefined must be positive"));  /* V8's message */
        return NULL;
    }
    if (b->len == 1 && b->tab[0] == 0) return js_bigint_new_si(ctx, 1);  /* a^0 = 1 */
    if (a->len == 1) {
        js_limb_t v = a->tab[0];
        if (v <= 1) return js_bigint_new_si(ctx, (js_slimb_t)v);
        if (v == (js_limb_t)-1) return js_bigint_new_si(ctx, 1 - 2 * (js_slimb_t)(b->tab[0] & 1));
        bool is_neg = (js_slimb_t)v < 0;
        if (is_neg) v = -v;
        if ((v & (v - 1)) == 0) {  /* v = 2^n */
            int n = JS_LIMB_BITS - 1 - (int)js_limb_clz(v);
            if (b->len > 1 || b->tab[0] > INT32_MAX) goto overflow;
            e = (uint32_t)b->tab[0];
            uint64_t e1 = (uint64_t)e * (uint64_t)n;
            if (e1 > (uint64_t)JS_BIGINT_MAX_SIZE * JS_LIMB_BITS) goto overflow;
            e = (uint32_t)e1;
            if (is_neg) is_neg = b->tab[0] & 1;
            r = js_bigint_new(ctx, (int)((e + JS_LIMB_BITS + 1 - is_neg) / JS_LIMB_BITS));
            if (!r) return NULL;
            memset(r->tab, 0, sizeof(r->tab[0]) * r->len);
            r->tab[e / JS_LIMB_BITS] = (js_limb_t)(1 - 2 * (int)is_neg) << (e % JS_LIMB_BITS);
            return r;
        }
    }
    if (b->len > 1 || b->tab[0] > INT32_MAX) goto overflow;
    e = (uint32_t)b->tab[0];
    n_bits = 32 - clz32(e);
    r = js_bigint_new(ctx, (int)a->len);
    memcpy(r->tab, a->tab, a->len * sizeof(a->tab[0]));
    for (i = n_bits - 2; i >= 0; i--) {
        r = js_bigint_mul(ctx, r, r);
        if (!r) return NULL;
        if ((e >> i) & 1) {
            r = js_bigint_mul(ctx, r, a);
            if (!r) return NULL;
        }
    }
    return r;
overflow:
    js_discard(throw_too_large(ctx));
    return NULL;
}

/* (mant, exp) with abs(a) ~ mant*2^(exp - (64 - 1)). a must be != 0. */
static uint64_t js_bigint_get_mant_exp(int *pexp, const JSBigInt *a) {
    js_limb_t t[4 - JS_LIMB_BITS / 32], carry, v, low_bits;
    int n1, n2, sgn, shift, i, j, e;
    uint64_t a1, a0;

    n2 = 4 - JS_LIMB_BITS / 32;
    n1 = (int)a->len - n2;
    sgn = js_bigint_sign(a);

    /* low_bits != 0 when abs(a) has a nonzero low bit */
    low_bits = 0;
    carry = (js_limb_t)sgn;
    for (i = 0; i < n1; i++) {
        v = (a->tab[i] ^ (-(js_limb_t)sgn)) + carry;
        carry = v < carry;
        low_bits |= v;
    }
    /* the n2 high limbs of abs(a) */
    for (j = 0; j < n2; j++) {
        i = j + n1;
        if (i < 0) {
            v = 0;
        } else {
            v = (a->tab[i] ^ (-(js_limb_t)sgn)) + carry;
            carry = v < carry;
        }
        t[j] = v;
    }
#if JS_LIMB_BITS == 32
    a1 = ((uint64_t)t[2] << 32) | t[1];
    a0 = (uint64_t)t[0] << 32;
#else
    a1 = t[1];
    a0 = t[0];
#endif
    a0 |= (low_bits != 0);
    if (a1 == 0) {  /* JS_LIMB_BITS = 64 only */
        shift = 64;
        a1 = a0;
        a0 = 0;
    } else {
        shift = clz64(a1);
        if (shift != 0) {
            a1 = (a1 << shift) | (a0 >> (64 - shift));
            a0 <<= shift;
        }
    }
    a1 |= (a0 != 0);  /* keep the bits for the final rounding */
    e = (int)a->len * JS_LIMB_BITS - shift - 1;
    *pexp = e;
    return a1;
}

/* a >> n rounded to nearest, ties to even. n >= 1 */
static uint64_t shr_rndn(uint64_t a, int n) {
    uint64_t addend = ((a >> n) & 1) + ((UINT64_C(1) << (n - 1)) - 1);
    return (a + addend) >> n;
}

/* To a Number, rounded to nearest, ties to even; +-Infinity when too large. */
static double js_bigint_to_float64(const JSBigInt *a) {
    int sgn, e;
    uint64_t mant;
    if (a->len == 1) return (double)(js_slimb_t)a->tab[0];  /* zero too */
    sgn = js_bigint_sign(a);
    mant = js_bigint_get_mant_exp(&e, a);
    if (e > 1023) {  /* overflow: infinity */
        mant = 0;
        e = 1024;
    } else {
        mant = (mant >> 1) | (mant & 1);  /* no overflow when rounding */
        mant = shr_rndn(mant, 10);
        if (mant >= (UINT64_C(1) << 53)) {  /* rounding can carry */
            mant >>= 1;
            e++;
        }
        mant &= ((UINT64_C(1) << 52) - 1);
    }
    return uint64_as_float64(((uint64_t)sgn << 63) | ((uint64_t)(e + 1023) << 52) | mant);
}

/* An integral Number as a BigInt; NULL when a1 isn't an integer (*pres 1) or not finite (*pres 2). */
static JSBigInt *js_bigint_from_float64(JSContext *ctx, int *pres, double a1) {
    uint64_t a = float64_as_uint64(a1), mant;
    int sgn = (int)(a >> 63), e = (int)((a >> 52) & ((1 << 11) - 1)), shift;
    JSBigIntBuf buf;
    mant = a & ((UINT64_C(1) << 52) - 1);
    if (e == 2047) {  /* NaN, Infinity */
        *pres = 2;
        return NULL;
    }
    if (e == 0 && mant == 0) {
        *pres = 0;
        return js_bigint_new_si(ctx, 0);
    }
    e -= 1023;
    if (e < 0) goto not_an_integer;  /* 0 < |a| < 1 */
    mant |= UINT64_C(1) << 52;
    if (e < 52) {
        shift = 52 - e;
        if (mant & ((UINT64_C(1) << shift) - 1)) {  /* a fractional part */
        not_an_integer:
            *pres = 1;
            return NULL;
        }
        mant >>= shift;
        e = 0;
    } else {
        e -= 52;
    }
    if (sgn) mant = -mant;
    *pres = 0;
    return js_bigint_shl(ctx, js_bigint_set_si64(&buf, (int64_t)mant), (unsigned)e);  /* mant*2^e */
}

/* -1, 0, 1, or 2 (unordered) */
static int js_bigint_float64_cmp(const JSBigInt *a, double b) {
    uint64_t b1 = float64_as_uint64(b), mant, a_mant;
    int b_sign = (int)(b1 >> 63), e = (int)((b1 >> 52) & ((1 << 11) - 1)), a_sign = js_bigint_sign(a), f;
    mant = b1 & ((UINT64_C(1) << 52) - 1);
    if (e == 2047) return mant != 0 ? 2 : 2 * b_sign - 1;  /* NaN, +-Infinity */
    if (e == 0 && mant == 0) {                              /* b = +-0 */
        if (a->len == 1 && a->tab[0] == 0) return 0;
        return 1 - 2 * a_sign;
    }
    if (a->len == 1 && a->tab[0] == 0) return 2 * b_sign - 1;  /* a = 0, b != 0 */
    if (a_sign != b_sign) return 1 - 2 * a_sign;
    e -= 1023;
    /* denormals needn't be handled: an integer compares with f >= 0. 2^f <= abs(a) < 2^(f+1) */
    a_mant = js_bigint_get_mant_exp(&f, a);
    /* visaljs patch: the magnitudes differ, so the larger one is the smaller value when both
     * are negative (upstream returns the magnitudes' order: -(2n ** 64n) < -1e19 was false) */
    if (f != e) return (f < e) != (a_sign != 0) ? -1 : 1;
    mant = (mant | (UINT64_C(1) << 52)) << 11;  /* aligned with a_mant */
    if (a_mant < mant) return 2 * a_sign - 1;
    if (a_mant > mant) return 1 - 2 * a_sign;
    return 0;
}

/* -1, 0 or 1 */
static int js_bigint_cmp(const JSBigInt *a, const JSBigInt *b) {
    int a_sign = js_bigint_sign(a), b_sign = js_bigint_sign(b);
    if (a_sign != b_sign) return 1 - 2 * a_sign;
    if (a->len != b->len) return a->len < b->len ? 2 * a_sign - 1 : 1 - 2 * a_sign;  /* normalized */
    for (int i = (int)a->len - 1; i >= 0; i--)
        if (a->tab[i] != b->tab[i]) return a->tab[i] < b->tab[i] ? -1 : 1;
    return 0;
}

/* ---- To and from strings --------------------------------------------------------------- */

static const js_limb_t js_pow_dec[JS_LIMB_DIGITS + 1] = {
    1U, 10U, 100U, 1000U, 10000U, 100000U, 1000000U, 10000000U, 100000000U, 1000000000U,
#if JS_LIMB_BITS == 64
    10000000000U, 100000000000U, 1000000000000U, 10000000000000U, 100000000000000U,
    1000000000000000U, 10000000000000000U, 100000000000000000U, 1000000000000000000U,
    10000000000000000000U,
#endif
};

static js_limb_t to_digit(int c) {
    if (c >= '0' && c <= '9') return (js_limb_t)(c - '0');
    if (c >= 'A' && c <= 'Z') return (js_limb_t)(c - 'A' + 10);
    if (c >= 'a' && c <= 'z') return (js_limb_t)(c - 'a' + 10);
    return 36;
}

/* [-]digits in radix 10 or a power of two (every digit valid, checked by the caller). */
static JSBigInt *js_bigint_from_string(JSContext *ctx, const char *str, int radix) {
    const char *p = str;
    int is_neg = 0, n_digits, n_limbs, len, log2_radix, n_bits, i;
    size_t n_digits1;
    JSBigInt *r;
    js_limb_t v, c, h;

    if (*p == '-') {
        is_neg = 1;
        p++;
    }
    while (*p == '0') p++;
    n_digits1 = strlen(p);
    if (n_digits1 > (size_t)JS_BIGINT_MAX_SIZE * JS_LIMB_BITS) {  /* js_bigint_new checks; this avoids overflow */
        js_discard(throw_too_large(ctx));
        return NULL;
    }
    n_digits = (int)n_digits1;
    log2_radix = 32 - clz32((unsigned)radix - 1);  /* ceil(log2(radix)) */
    n_bits = radix == 10 ? (n_digits * 27 + 7) / 8 : n_digits * log2_radix;  /* >= the bits needed */
    n_limbs = max_int(1, n_bits / JS_LIMB_BITS + 1);  /* one more bit for the sign */
    r = js_bigint_new(ctx, n_limbs);
    if (!r) return NULL;
    if (radix == 10) {
        len = 1;
        r->tab[0] = 0;
        for (;;) {
            v = 0;
            for (i = 0; i < JS_LIMB_DIGITS; i++) {
                c = to_digit((unsigned char)*p);
                if (c >= (js_limb_t)radix) break;
                p++;
                v = v * 10 + c;
            }
            if (i == 0) break;
            if (len == 1 && r->tab[0] == 0) {
                r->tab[0] = v;
            } else {
                h = mp_mul1(r->tab, r->tab, (js_limb_t)len, js_pow_dec[i], v);
                if (h != 0) r->tab[len++] = h;
            }
        }
        if ((r->tab[len - 1] >> (JS_LIMB_BITS - 1)) != 0) r->tab[len++] = 0;  /* room for the sign */
        r->len = (uint32_t)len;
    } else {  /* a power of two: no multiplication */
        r->len = (uint32_t)n_limbs;
        memset(r->tab, 0, sizeof(r->tab[0]) * (size_t)n_limbs);
        for (i = 0; i < n_digits; i++) {
            c = to_digit((unsigned char)p[n_digits - 1 - i]);
            unsigned int bit_pos = (unsigned)i * (unsigned)log2_radix, shift = bit_pos & (JS_LIMB_BITS - 1), pos = bit_pos / JS_LIMB_BITS;
            r->tab[pos] |= c << shift;
            if (shift + (unsigned)log2_radix > JS_LIMB_BITS) r->tab[pos + 1] |= c >> (JS_LIMB_BITS - shift);
        }
    }
    r = js_bigint_normalize(r);
    return is_neg ? js_bigint_neg(ctx, r) : r;
}

static const char digits[36] = "0123456789abcdefghijklmnopqrstuvwxyz";

/* backwards */
static char *js_u64toa(char *q, uint64_t n, unsigned int base) {
    do {
        *--q = digits[n % base];
        n /= base;
    } while (n != 0);
    return q;
}

/* len >= 1. 2 <= radix <= 36 */
static char *limb_to_a(char *q, js_limb_t n, unsigned int radix, int len) {
    for (int i = 0; i < len; i++) {
        *--q = digits[n % radix];
        n /= radix;
    }
    return q;
}

static const uint8_t digits_per_limb_table[36 - 1] = {
#if JS_LIMB_BITS == 32
    32, 20, 16, 13, 12, 11, 10, 10, 9, 9, 8, 8, 8, 8, 8, 7, 7, 7, 7, 7, 7, 7, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
#else
    64, 40, 32, 27, 24, 22, 21, 20, 19, 18, 17, 17, 16, 16, 16, 15, 15, 15, 14, 14, 14, 14, 13, 13, 13, 13, 13, 13, 13, 12, 12, 12, 12, 12, 12,
#endif
};

static const js_limb_t radix_base_table[36 - 1] = {
#if JS_LIMB_BITS == 32
    0x00000000, 0xcfd41b91, 0x00000000, 0x48c27395, 0x81bf1000, 0x75db9c97, 0x40000000, 0xcfd41b91,
    0x3b9aca00, 0x8c8b6d2b, 0x19a10000, 0x309f1021, 0x57f6c100, 0x98c29b81, 0x00000000, 0x18754571,
    0x247dbc80, 0x3547667b, 0x4c4b4000, 0x6b5a6e1d, 0x94ace180, 0xcaf18367, 0x0b640000, 0x0e8d4a51,
    0x1269ae40, 0x17179149, 0x1cb91000, 0x23744899, 0x2b73a840, 0x34e63b41, 0x40000000, 0x4cfa3cc1,
    0x5c13d840, 0x6d91b519, 0x81bf1000,
#else
    0x0000000000000000, 0xa8b8b452291fe821, 0x0000000000000000, 0x6765c793fa10079d,
    0x41c21cb8e1000000, 0x3642798750226111, 0x8000000000000000, 0xa8b8b452291fe821,
    0x8ac7230489e80000, 0x4d28cb56c33fa539, 0x1eca170c00000000, 0x780c7372621bd74d,
    0x1e39a5057d810000, 0x5b27ac993df97701, 0x0000000000000000, 0x27b95e997e21d9f1,
    0x5da0e1e53c5c8000, 0xd2ae3299c1c4aedb, 0x16bcc41e90000000, 0x2d04b7fdd9c0ef49,
    0x5658597bcaa24000, 0xa0e2073737609371, 0x0c29e98000000000, 0x14adf4b7320334b9,
    0x226ed36478bfa000, 0x383d9170b85ff80b, 0x5a3c23e39c000000, 0x8e65137388122bcd,
    0xdd41bb36d259e000, 0x0aee5720ee830681, 0x1000000000000000, 0x172588ad4f5f0981,
    0x211e44f7d02c1000, 0x2ee56725f06e5c71, 0x41c21cb8e1000000,
#endif
};

/* The digits of a in radix 2..36: a malloc'd, NUL-terminated string; *start is where it begins. */
static char *bigint_digits(JSContext *ctx, const JSBigInt *r, int radix, char **start) {
    bool is_binary_radix = (radix & (radix - 1)) == 0;
    int is_neg = js_bigint_sign(r);
    if (r->len == 1 && r->tab[0] == 0) {
        char *buf = malloc(2);
        if (!buf) js_fatal("out of memory");
        strcpy(buf, "0");
        *start = buf;
        return buf;
    }
    if (is_neg) {
        r = js_bigint_neg(ctx, r);
    } else if (!is_binary_radix) {  /* r is divided in place */
        JSBigInt *tmp = js_bigint_new(ctx, (int)r->len);
        memcpy(tmp->tab, r->tab, r->len * sizeof(r->tab[0]));
        r = tmp;
    }
    int log2_radix = 31 - clz32((unsigned)radix);  /* floor(log2(radix)) */
    int n_bits = (int)(r->len * JS_LIMB_BITS - js_limb_safe_clz(r->tab[r->len - 1]));
    /* exact only for powers of two; otherwise >= the number of digits */
    int n_digits = (n_bits + log2_radix - 1) / log2_radix;
    char *buf = malloc((size_t)n_digits + (size_t)is_neg + 1);
    if (!buf) js_fatal("out of memory converting a BigInt");
    char *q = buf + n_digits + is_neg + 1;
    *--q = '\0';
    if (!is_binary_radix) {
        JSBigInt *w = (JSBigInt *)r;
        js_limb_t radix_base = radix_base_table[radix - 2], v;
        int len = (int)w->len;
        for (;;) {
            while (len > 1 && w->tab[len - 1] == 0) len--;  /* leading zero limbs */
            if (len == 1 && w->tab[0] < radix_base) {
                v = w->tab[0];
                if (v != 0) q = js_u64toa(q, v, (unsigned)radix);
                break;
            }
            v = mp_div1(w->tab, w->tab, (js_limb_t)len, radix_base, 0);
            q = limb_to_a(q, v, (unsigned)radix, digits_per_limb_table[radix - 2]);
        }
    } else {
        for (int i = 0; i < n_digits; i++) {
            unsigned int bit_pos = (unsigned)i * (unsigned)log2_radix, pos = bit_pos / JS_LIMB_BITS, shift = bit_pos % JS_LIMB_BITS;
            js_limb_t c = r->tab[pos] >> shift;
            if (shift + (unsigned)log2_radix > JS_LIMB_BITS && pos + 1 < r->len) c |= r->tab[pos + 1] << (JS_LIMB_BITS - shift);
            *--q = digits[c & (js_limb_t)(radix - 1)];
        }
    }
    if (is_neg) *--q = '-';
    *start = q;
    return buf;
}

static JSValue to_string(JSContext *ctx, JSValue v, int radix) {
    char *start, *buf = bigint_digits(ctx, js_as_bigint(v), radix, &start);
    JSValue s = js_new_string_latin1(ctx, (const uint8_t *)start, (uint32_t)strlen(start));
    free(buf);
    return s;
}

static bool is_str_space(uint32_t c) {  /* StrWhiteSpaceChar: WhiteSpace and LineTerminator */
    return c == ' ' || (c >= 9 && c <= 13) || c == 0xA0 || c == 0xFEFF || c == 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
           c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000;
}

/* StringToBigInt (§7.1.14): EMPTY when the string isn't a StringIntegerLiteral. */
static JSValue from_string(JSContext *ctx, JSValue s) {
    JSStrView v = js_string_view(ctx, s);
    uint32_t start = 0, end = v.length;
    while (start < end && is_str_space(js_view_at(v, start))) start++;
    while (end > start && is_str_space(js_view_at(v, end - 1))) end--;
    if (start == end) return js_cell(&js_bigint_new_si(ctx, 0)->cell);
    int radix = 10;
    bool neg = false;
    uint32_t c = js_view_at(v, start);
    if (c == '+' || c == '-') {
        neg = c == '-';
        start++;
    } else if (c == '0' && end - start > 2) {
        uint32_t x = js_view_at(v, start + 1) | 0x20;
        radix = x == 'x' ? 16 : x == 'o' ? 8 : x == 'b' ? 2 : 10;
        if (radix != 10) start += 2;
    }
    if (start == end) return JS_EMPTY;
    char *digits_buf = malloc((size_t)(end - start) + 2);
    if (!digits_buf) js_fatal("out of memory parsing a BigInt");
    size_t n = 0;
    if (neg) digits_buf[n++] = '-';
    for (uint32_t i = start; i < end; i++) {
        uint32_t d = js_view_at(v, i);
        if (d >= 128 || to_digit((int)d) >= (js_limb_t)radix) {
            free(digits_buf);
            return JS_EMPTY;
        }
        digits_buf[n++] = (char)d;
    }
    digits_buf[n] = '\0';
    JSBigInt *r = js_bigint_from_string(ctx, digits_buf, radix);
    free(digits_buf);
    return r ? js_cell(&r->cell) : JS_EXCEPTION;
}

/* ---- The core's entry points (rt->bigint) --------------------------------------------------- */

static JSValue result(JSBigInt *r) { return r ? js_cell(&r->cell) : JS_EXCEPTION; }

static JSValue arith(JSContext *ctx, JSBigIntOp op, JSValue va, JSValue vb) {
    const JSBigInt *a = js_as_bigint(va), *b = js_as_bigint(vb);
    JSBigIntBuf one;
    switch (op) {
    case JS_BIGINT_ADD: return result(js_bigint_add(ctx, a, b, 0));
    case JS_BIGINT_SUB: return result(js_bigint_add(ctx, a, b, 1));
    case JS_BIGINT_MUL: return result(js_bigint_mul(ctx, a, b));
    case JS_BIGINT_DIV: return result(js_bigint_divrem(ctx, a, b, false));
    case JS_BIGINT_MOD: return result(js_bigint_divrem(ctx, a, b, true));
    case JS_BIGINT_EXP: return result(js_bigint_pow(ctx, a, b));
    case JS_BIGINT_AND:
    case JS_BIGINT_OR:
    case JS_BIGINT_XOR: return result(js_bigint_logic(ctx, a, b, op));
    case JS_BIGINT_SHL:
    case JS_BIGINT_SAR: {
        js_slimb_t shift = js_bigint_get_si_sat(b);
        if (shift > INT32_MAX) shift = INT32_MAX;
        else if (shift < -INT32_MAX) shift = -INT32_MAX;
        if (op == JS_BIGINT_SAR) shift = -shift;
        return result(shift >= 0 ? js_bigint_shl(ctx, a, (unsigned)shift) : js_bigint_shr(ctx, a, (unsigned)-shift));
    }
    case JS_BIGINT_NEG: return result(js_bigint_neg(ctx, a));
    case JS_BIGINT_NOT: return result(js_bigint_not(ctx, a));
    case JS_BIGINT_INC: return result(js_bigint_add(ctx, a, js_bigint_set_si(&one, 1), 0));
    case JS_BIGINT_DEC: return result(js_bigint_add(ctx, a, js_bigint_set_si(&one, 1), 1));
    }
    return JS_EXCEPTION;
}

static int compare(JSContext *ctx, JSValue a, JSValue b) {
    (void)ctx;
    if (js_is_bigint(b)) return js_bigint_cmp(js_as_bigint(a), js_as_bigint(b));
    return js_bigint_float64_cmp(js_as_bigint(a), js_as_number(b));
}

static double to_double(JSValue a) { return js_bigint_to_float64(js_as_bigint(a)); }

static JSValue from_int64(JSContext *ctx, int64_t v) { return js_cell(&js_bigint_new_si64(ctx, v)->cell); }
static JSValue from_uint64(JSContext *ctx, uint64_t v) { return js_cell(&js_bigint_new_ui64(ctx, v)->cell); }

/* The value modulo 2^64 (ToBigInt64 and ToBigUint64 read it as signed or unsigned). */
static uint64_t to_uint64(JSValue v) {
    const JSBigInt *p = js_as_bigint(v);
    uint64_t r = p->tab[0];
#if JS_LIMB_BITS == 32
    r = p->len >= 2 ? r | (uint64_t)p->tab[1] << 32 : (uint64_t)(int64_t)(int32_t)p->tab[0];
#endif
    return r;
}

static JSValue to_bigint(JSContext *ctx, JSValue v);

static const JSBigIntOps bigint_ops = { arith, compare, to_string, to_double, from_string, from_int64, from_uint64, to_uint64, to_bigint };

/* ---- BigInt and BigInt.prototype (§21.2) ------------------------------------------------ */

/* "Cannot convert x to a BigInt", x as V8 shows it */
static JSValue throw_cannot_convert(JSContext *ctx, JSValue v, bool syntax) {
    char what[96];
    js_describe_value(ctx, v, what, sizeof what);
    return syntax ? js_throw_syntax_error(ctx, "Cannot convert %s to a BigInt", what)
                  : js_throw_type_error(ctx, "Cannot convert %s to a BigInt", what);
}

/* ToBigInt (§7.1.13) */
static JSValue to_bigint(JSContext *ctx, JSValue v) {
    if (js_is_object(v)) {
        v = js_to_primitive(ctx, v, JS_HINT_NUMBER);
        if (js_is_exception(v)) return v;
    }
    if (js_is_bigint(v)) return v;
    if (js_is_bool(v)) return js_cell(&js_bigint_new_si(ctx, js_as_bool(v))->cell);
    if (js_is_string(v)) {
        JSValue r = from_string(ctx, v);
        return js_is_empty(r) ? throw_cannot_convert(ctx, v, true) : r;
    }
    return throw_cannot_convert(ctx, v, false);  /* undefined, null, numbers, symbols */
}

/* BigInt(value) (§21.2.1.1) */
BUILTIN(bigint_ctor) {
    (void)callee, (void)this_val;
    if (!js_is_undefined(new_target)) return js_throw_type_error(ctx, "BigInt is not a constructor");
    JSValue prim = js_to_primitive(ctx, ARG(0), JS_HINT_NUMBER);
    if (js_is_exception(prim)) return prim;
    if (!js_is_number(prim)) return to_bigint(ctx, prim);
    /* NumberToBigInt (§21.2.1.1.1) */
    int res;
    JSBigInt *r = js_bigint_from_float64(ctx, &res, js_as_number(prim));
    if (r) return js_cell(&r->cell);
    if (res == 0) return JS_EXCEPTION;
    JSValue s = js_number_to_string(ctx, prim);
    char text[64];
    text[js_view_to_utf8(js_string_view(ctx, s), text, sizeof text - 1)] = '\0';
    return js_throw_range_error(ctx, "The number %s cannot be converted to a BigInt because it is not an integer", text);
}

/* BigInt.asIntN / asUintN (§21.2.2.1, .2) */
static JSValue as_n(JSContext *ctx, JSValue bits_arg, JSValue value, bool as_int_n) {
    double d;
    if (js_to_integer_or_infinity(ctx, &d, bits_arg) < 0) return JS_EXCEPTION;  /* ToIndex */
    if (d < 0 || d > JS_MAX_SAFE_INTEGER) return js_throw_range_error(ctx, "Invalid value: not (convertible to) a safe integer");
    uint64_t bits = (uint64_t)d;
    JSValue va = to_bigint(ctx, value);
    if (js_is_exception(va)) return va;
    const JSBigInt *p = js_as_bigint(va);
    if (bits == 0) return js_cell(&js_bigint_new_si(ctx, 0)->cell);
    if (bits >= (uint64_t)p->len * JS_LIMB_BITS && (as_int_n || !js_bigint_sign(p))) return va;
    int is_neg = js_bigint_sign(p);
    uint64_t len64 = (bits + JS_LIMB_BITS - 1) / JS_LIMB_BITS;
    if (len64 > JS_BIGINT_MAX_SIZE) return throw_too_large(ctx);
    int len = (int)len64, l = min_int(len, (int)p->len), i;
    JSBigInt *r = js_bigint_new(ctx, len);
    if (!r) return JS_EXCEPTION;
    for (i = 0; i < l; i++) r->tab[i] = p->tab[i];
    for (i = l; i < len; i++) r->tab[i] = -(js_limb_t)is_neg;  /* sign extension */
    int shift = (int)((-bits) & (JS_LIMB_BITS - 1));
    js_limb_t v = r->tab[len - 1] << shift;
    r->tab[len - 1] = as_int_n ? (js_limb_t)((js_slimb_t)v >> shift) : v >> shift;
    r = as_int_n ? js_bigint_normalize(r) : js_bigint_extend(ctx, r, 0);
    return result(r);
}

BUILTIN(bigint_as_int_n) {
    UNUSED_ARGS;
    return as_n(ctx, ARG(0), ARG(1), true);
}

BUILTIN(bigint_as_uint_n) {
    UNUSED_ARGS;
    return as_n(ctx, ARG(0), ARG(1), false);
}

/* thisBigIntValue (§21.2.3.4.1) */
static JSValue this_bigint(JSContext *ctx, JSValue v, const char *method) {
    JSValue b = js_this_primitive(v, js_is_bigint);
    if (js_is_empty(b)) return js_throw_type_error(ctx, "BigInt.prototype.%s requires that 'this' be a BigInt", method);
    return b;
}

BUILTIN(bigint_proto_to_string) {
    UNUSED_ARGS;
    JSValue b = this_bigint(ctx, this_val, "toString");
    if (js_is_exception(b)) return b;
    double radix = 10;
    if (!js_is_undefined(ARG(0)) && js_to_integer_or_infinity(ctx, &radix, ARG(0)) < 0) return JS_EXCEPTION;
    if (radix < 2 || radix > 36) return js_throw_range_error(ctx, "toString() radix argument must be between 2 and 36");
    return to_string(ctx, b, (int)radix);
}

/* Until Intl: en-US, as Node prints it (grouped by thousands). */
BUILTIN(bigint_proto_to_locale_string) {
    UNUSED_ARGS;
    JSValue b = this_bigint(ctx, this_val, "toLocaleString");
    if (js_is_exception(b)) return b;
    char *start, *buf = bigint_digits(ctx, js_as_bigint(b), 10, &start);
    size_t n = strlen(start), neg = start[0] == '-', digits_n = n - neg;
    char *out = malloc(n + digits_n / 3 + 1);
    if (!out) js_fatal("out of memory");
    size_t k = 0;
    if (neg) out[k++] = '-';
    for (size_t i = 0; i < digits_n; i++) {
        if (i > 0 && (digits_n - i) % 3 == 0) out[k++] = ',';
        out[k++] = start[neg + i];
    }
    JSValue s = js_new_string_latin1(ctx, (const uint8_t *)out, (uint32_t)k);
    free(out);
    free(buf);
    return s;
}

BUILTIN(bigint_proto_value_of) {
    UNUSED_ARGS;
    return this_bigint(ctx, this_val, "valueOf");
}

static const JSBuiltin bigint_statics[] = {
    JS_BUILTIN_FN("asIntN", bigint_as_int_n, 2),
    JS_BUILTIN_FN("asUintN", bigint_as_uint_n, 2),
};

static const JSBuiltin bigint_proto[] = {  /* V8's order */
    JS_BUILTIN_FN("toLocaleString", bigint_proto_to_locale_string, 0),
    JS_BUILTIN_FN("toString", bigint_proto_to_string, 0),
    JS_BUILTIN_FN("valueOf", bigint_proto_value_of, 0),
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "BigInt", JS_PROP_CONFIGURABLE),
};

static void install_bigint(JSContext *ctx, JSObject *global) {
    JSValue proto = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 4);
    ctx->intrinsics[JS_INTRINSIC_BIGINT_PROTOTYPE] = proto;
    JSValue key = js_atom_from_cstr(ctx, "BigInt");
    JSValue c = js_new_native(ctx, bigint_ctor, key, 1, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), proto, 0);
    js_define_builtins(ctx, js_as_object(c), bigint_statics, JS_COUNTOF(bigint_statics));
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), c, JS_BUILTIN_METHOD_ATTRS);
    js_define_builtins(ctx, js_as_object(proto), bigint_proto, JS_COUNTOF(bigint_proto));
    js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
    ctx->rt->bigint = &bigint_ops;
}

const JSComponent js_component_bigint = { "bigint", install_bigint };
