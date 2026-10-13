/*
 * js_bigint.h — BigInt values (ECMAScript §6.1.6.2).
 *
 * A BigInt is a heap cell holding its value in two's complement limbs, least significant first,
 * normalized to the fewest limbs that hold it (QuickJS's representation). The arithmetic lives in
 * the bigint component (runtime/src/bigint.c); the core reaches it through rt->bigint, which the
 * component sets when it's installed. Without the component no BigInt value can exist, so the
 * core never calls through a NULL table. Equality and hashing need no arithmetic and are here.
 *
 * Literals are static cells in the generated C file:
 *     static const JS_STATIC_BIGINT_TYPE(1) jsb_0 = JS_STATIC_BIGINT_INIT(1, { 0x2 });
 *     … JS_STATIC_BIGINT(jsb_0) …
 */
#ifndef JS_BIGINT_H
#define JS_BIGINT_H

#include <stdbool.h>
#include <stdint.h>

#include "jscell.h"
#include "jsvalue.h"

typedef struct JSContext JSContext;

/* 64-bit limbs where the compiler has a 128-bit type for the double-limb products, else 32
 * (JS_BIGINT_LIMB32 forces 32, to test that path where 64 is the default). */
#if defined(__SIZEOF_INT128__) && !defined(JS_BIGINT_LIMB32)
#define JS_LIMB_BITS 64
typedef uint64_t js_limb_t;
#else
#define JS_LIMB_BITS 32
typedef uint32_t js_limb_t;
#endif

typedef struct JSBigInt {
    JSCell    cell;   /* JS_CELL_BIGINT */
    uint32_t  len;    /* limbs, >= 1, the fewest that hold the value */
    js_limb_t tab[];  /* two's complement, least significant first */
} JSBigInt;

#define JS_STATIC_BIGINT_TYPE(n) struct { JSCell cell; uint32_t len; js_limb_t tab[n]; }
#define JS_STATIC_BIGINT_INIT(n, ...) { JS_CELL_HEADER(JS_CELL_BIGINT, JS_CELL_STATIC), (n), __VA_ARGS__ }
#define JS_STATIC_BIGINT(s) js_cell((JSCell *)&(s))

static inline bool js_is_bigint(JSValue v) {
    return js_is_cell(v) && js_as_cell(v)->kind == JS_CELL_BIGINT;
}
static inline const JSBigInt *js_as_bigint(JSValue v) { return (const JSBigInt *)js_as_cell(v); }

static inline bool js_bigint_is_zero(JSValue v) {
    const JSBigInt *b = js_as_bigint(v);
    return b->len == 1 && b->tab[0] == 0;
}

/* Two BigInts with the same value (both normalized: the same limbs). */
static inline bool js_bigint_equals(JSValue a, JSValue b) {
    const JSBigInt *x = js_as_bigint(a), *y = js_as_bigint(b);
    if (x->len != y->len) return false;
    for (uint32_t i = 0; i < x->len; i++)
        if (x->tab[i] != y->tab[i]) return false;
    return true;
}

static inline uint32_t js_bigint_hash(JSValue v) {
    const JSBigInt *b = js_as_bigint(v);
    uint64_t h = UINT64_C(0xcbf29ce484222325);
    for (uint32_t i = 0; i < b->len; i++) h = (h ^ (uint64_t)b->tab[i]) * UINT64_C(0x100000001b3);
    return (uint32_t)(h ^ (h >> 32));
}

/* The operators the core sends to the component (both operands BigInts, already ToNumeric'd). */
typedef enum JSBigIntOp {
    JS_BIGINT_ADD, JS_BIGINT_SUB, JS_BIGINT_MUL, JS_BIGINT_DIV, JS_BIGINT_MOD, JS_BIGINT_EXP,
    JS_BIGINT_SHL, JS_BIGINT_SAR, JS_BIGINT_AND, JS_BIGINT_OR, JS_BIGINT_XOR,
    JS_BIGINT_NEG, JS_BIGINT_NOT, JS_BIGINT_INC, JS_BIGINT_DEC,  /* unary: b is ignored */
} JSBigIntOp;

typedef struct JSBigIntOps {
    JSValue (*arith)(JSContext *ctx, JSBigIntOp op, JSValue a, JSValue b);
    /* a BigInt against a BigInt or a Number: -1, 0, 1, or 2 when unordered (NaN) */
    int (*compare)(JSContext *ctx, JSValue a, JSValue b);
    JSValue (*to_string)(JSContext *ctx, JSValue a, int radix);
    double (*to_double)(JSValue a);
    /* StringToBigInt (§7.1.14): a BigInt, or EMPTY when the string isn't one */
    JSValue (*from_string)(JSContext *ctx, JSValue s);
    /* for BigInt64Array, BigUint64Array and DataView: 64-bit integers to and from BigInts */
    JSValue (*from_int64)(JSContext *ctx, int64_t v);
    JSValue (*from_uint64)(JSContext *ctx, uint64_t v);
    uint64_t (*to_uint64)(JSValue v);  /* the value modulo 2^64 */
    JSValue (*to_bigint)(JSContext *ctx, JSValue v);  /* ToBigInt (§7.1.13) */
} JSBigIntOps;

#endif /* JS_BIGINT_H */
