/*
 * jsvalue.h — JS value representation.
 *
 * NaN-boxing with raw pointers (JavaScriptCore layout):
 *
 *   High 16 bits   Meaning
 *   0x0000         cell pointer (low 48 bits = address) or immediate
 *   0x0002-0xFFFC  double, stored as bits(double) + 2^49
 *   0xFFFE         int32, low 32 bits = value
 *
 * Only this header may touch JSValue.bits. Everything else uses the accessors.
 */
#ifndef JSVALUE_H
#define JSVALUE_H

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#if defined(__GNUC__) || defined(__clang__)
#define JS_LIKELY(x)   __builtin_expect(!!(x), 1)
#define JS_UNLIKELY(x) __builtin_expect(!!(x), 0)
/* An inline cache's hit, at every site of a big function too (the compiler's size limits would
 * otherwise leave a call there): only fast paths of a few instructions. */
#define JS_FAST_PATH   inline __attribute__((always_inline))
#else
#define JS_LIKELY(x)   (x)
#define JS_UNLIKELY(x) (x)
#define JS_FAST_PATH   inline
#endif

/* On every runtime function that can fail: ignoring its result is an error. */
#if defined(__GNUC__) || defined(__clang__)
#define JS_WARN_UNUSED __attribute__((warn_unused_result))
#elif defined(_MSC_VER)
#define JS_WARN_UNUSED _Check_return_
#else
#define JS_WARN_UNUSED
#endif

/* On generated functions that may never be called. */
#if defined(__GNUC__) || defined(__clang__)
#define JS_MAYBE_UNUSED __attribute__((unused))
#else
#define JS_MAYBE_UNUSED
#endif

struct JSCell;

/* A struct for type safety; still passed in one register on SysV and Win64. */
typedef struct { uint64_t bits; } JSValue;

#define JS_NUMBER_TAG  UINT64_C(0xFFFE000000000000)
#define JS_OTHER_TAG   UINT64_C(0x2)
#define JS_NOT_CELL    (JS_NUMBER_TAG | JS_OTHER_TAG)
#define JS_DOUBLE_OFF  (UINT64_C(1) << 49)
#define JS_CANON_NAN   UINT64_C(0x7FF8000000000000)

/* Immediates. All below 16, never a valid cell address. */
#define JS_TAG_EMPTY      UINT64_C(0x00)  /* internal: holes, TDZ, "no value" */
#define JS_TAG_NULL       UINT64_C(0x02)
#define JS_TAG_FALSE      UINT64_C(0x06)
#define JS_TAG_TRUE       UINT64_C(0x07)
#define JS_TAG_UNDEFINED  UINT64_C(0x0A)
#define JS_TAG_EXCEPTION  UINT64_C(0x0E)  /* internal: "an exception is pending" */

#define JS_EMPTY      ((JSValue){ JS_TAG_EMPTY })
#define JS_NULL       ((JSValue){ JS_TAG_NULL })
#define JS_FALSE      ((JSValue){ JS_TAG_FALSE })
#define JS_TRUE       ((JSValue){ JS_TAG_TRUE })
#define JS_UNDEFINED  ((JSValue){ JS_TAG_UNDEFINED })
#define JS_EXCEPTION  ((JSValue){ JS_TAG_EXCEPTION })

/* ---- Constructors ---- */

static inline JSValue js_int32(int32_t i) {
    return (JSValue){ JS_NUMBER_TAG | (uint32_t)i };
}

static inline JSValue js_double(double d) {
    uint64_t b;
    memcpy(&b, &d, 8);            /* no UB; compiles to a mov */
    if (d != d) b = JS_CANON_NAN; /* rule 3: NaN is canonical */
    return (JSValue){ b + JS_DOUBLE_OFF };
}

/* Boxes a number, preferring int32 when the value is integral and not -0. */
static inline JSValue js_number(double d) {
    if (d >= -2147483648.0 && d <= 2147483647.0) {
        int32_t i = (int32_t)d;
        if ((double)i == d && !(i == 0 && signbit(d))) return js_int32(i);
    }
    return js_double(d);
}

static inline JSValue js_bool(bool b) {
    return (JSValue){ b ? JS_TAG_TRUE : JS_TAG_FALSE };
}

static inline JSValue js_cell(struct JSCell *c) {
    return (JSValue){ (uint64_t)(uintptr_t)c };
}

/* ---- Type tests ---- */

static inline bool js_is_number(JSValue v)    { return (v.bits & JS_NUMBER_TAG) != 0; }
static inline bool js_is_int32(JSValue v)     { return (v.bits & JS_NUMBER_TAG) == JS_NUMBER_TAG; }
static inline bool js_is_double(JSValue v)    { return js_is_number(v) && !js_is_int32(v); }
static inline bool js_is_cell(JSValue v)      { return (v.bits & JS_NOT_CELL) == 0 && v.bits != JS_TAG_EMPTY; }
static inline bool js_is_bool(JSValue v)      { return (v.bits & ~UINT64_C(1)) == JS_TAG_FALSE; }
static inline bool js_is_nullish(JSValue v)   { return (v.bits & ~UINT64_C(0x08)) == JS_TAG_NULL; }
static inline bool js_is_null(JSValue v)      { return v.bits == JS_TAG_NULL; }
static inline bool js_is_undefined(JSValue v) { return v.bits == JS_TAG_UNDEFINED; }
static inline bool js_is_empty(JSValue v)     { return v.bits == JS_TAG_EMPTY; }
static inline bool js_is_exception(JSValue v) { return JS_UNLIKELY(v.bits == JS_TAG_EXCEPTION); }

/* ---- Accessors (caller has checked the type) ---- */

static inline int32_t js_as_int32(JSValue v) { return (int32_t)(uint32_t)v.bits; }

static inline double js_as_double(JSValue v) {
    uint64_t b = v.bits - JS_DOUBLE_OFF;
    double d;
    memcpy(&d, &b, 8);
    return d;
}

/* Either number encoding, as a double. */
static inline double js_as_number(JSValue v) {
    return js_is_int32(v) ? (double)js_as_int32(v) : js_as_double(v);
}

static inline bool js_as_bool(JSValue v) { return (v.bits & 1) != 0; }

static inline struct JSCell *js_as_cell(JSValue v) {
    return (struct JSCell *)(uintptr_t)v.bits;
}

/* Drops a value deliberately (gcc ignores `(void)` on warn_unused_result). */
static inline void js_discard(JSValue v) { (void)v; }

/* Bitwise identity. Not `===`: numbers have two encodings (rule 1). */
static inline bool js_same_bits(JSValue a, JSValue b) { return a.bits == b.bits; }

#endif /* JSVALUE_H */
