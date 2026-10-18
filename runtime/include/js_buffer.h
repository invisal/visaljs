/*
 * js_buffer.h — ArrayBuffer and DataView (ECMAScript §25.1, §25.3), the binary data component.
 * The layout is here so that core code can read a buffer without linking the
 * component (util.inspect prints its bytes) and so that typed arrays can share it.
 */
#ifndef JS_BUFFER_H
#define JS_BUFFER_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "js_convert.h"
#include "js_object.h"
#include "js_ops.h"

#define JS_BUFFER_RESIZABLE 0x01u
#define JS_BUFFER_DETACHED  0x02u
#define JS_BUFFER_IMMUTABLE 0x04u

typedef struct JSArrayBuffer {
    JSObject obj;
    uint8_t *data;             /* malloc'd (NULL when empty or detached); freed by the finalizer */
    size_t   byte_length;
    size_t   max_byte_length;  /* resizable buffers: resize's limit; else byte_length */
    uint32_t flags;            /* JS_BUFFER_* */
} JSArrayBuffer;

typedef struct JSDataView {
    JSObject obj;
    JSValue  buffer;           /* an ArrayBuffer */
    size_t   byte_offset;
    size_t   byte_length;      /* unless length_tracking */
    bool     length_tracking;  /* a view of a resizable buffer created without a length */
} JSDataView;

/* Typed array element types, in the spec's table order (§23.2, Table 71). The BigInt ones
 * arrive with BigInt. JS_TYPED_ARRAY_TYPES (jscontext.h) counts them. */
typedef enum JSTypedArrayType {
    JS_TA_INT8, JS_TA_UINT8, JS_TA_UINT8C, JS_TA_INT16, JS_TA_UINT16, JS_TA_INT32, JS_TA_UINT32,
    JS_TA_BIGINT64, JS_TA_BIGUINT64, JS_TA_FLOAT16, JS_TA_FLOAT32, JS_TA_FLOAT64,
} JSTypedArrayType;

typedef struct JSTypedArray {
    JSObject obj;
    JSValue  buffer;           /* an ArrayBuffer */
    size_t   byte_offset;
    size_t   length;           /* elements, unless length_tracking */
    uint8_t  type;             /* JSTypedArrayType */
    bool     length_tracking;  /* a view of a resizable buffer created without a length */
} JSTypedArray;

/* Whether v is an ArrayBuffer (class "ArrayBuffer"), without linking the component. */
static inline bool js_is_array_buffer(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls->name[0] == 'A' &&
           strcmp(js_as_object(v)->shape->cls->name, "ArrayBuffer") == 0;
}
static inline JSArrayBuffer *js_as_array_buffer(JSValue v) { return (JSArrayBuffer *)js_as_object(v); }
static inline bool js_buffer_is_detached(const JSArrayBuffer *b) { return (b->flags & JS_BUFFER_DETACHED) != 0; }

/* IEEE 754 binary16 from a double (round to nearest, ties to even), and back. */
uint16_t js_to_float16(double d);
double js_from_float16(uint16_t h);

/* DetachArrayBuffer (§25.1.3.5), for $262.detachArrayBuffer: 0, or -1 with a TypeError (immutable). */
JS_WARN_UNUSED int js_array_buffer_detach(JSContext *ctx, JSValue buffer);
/* A new, zeroed ArrayBuffer of `length` bytes (%ArrayBuffer.prototype%); JS_EXCEPTION when it can't be allocated. */
JS_WARN_UNUSED JSValue js_new_array_buffer(JSContext *ctx, size_t length);

/* For the components that take or make bytes (TextDecoder, structuredClone). These are
 * the typedarray component's: a component that calls them needs it. */
/* The bytes of an ArrayBuffer, a typed array or a DataView (a view's current window; none when
 * it is out of bounds or its buffer is detached): true, or false for any other value. */
bool js_buffer_source_bytes(JSValue v, uint8_t **data, size_t *length);
bool js_is_uint8_array(JSValue v);
/* A typed array's JSTypedArrayType, or -1 for any other value. */
int js_typed_array_type(JSValue v);
/* A new, zeroed Uint8Array of `length` bytes; its bytes are js_buffer_source_bytes'. */
JS_WARN_UNUSED JSValue js_new_uint8_array(JSContext *ctx, size_t length);

/* ---- Generated code: a typed array's elements inline ------------------------------------------ */

/* The bytes of element i of a typed array generated code may read or write inline: a view of a
 * fixed-size buffer (it can't shrink below the view, so i < length is in bounds), not detached,
 * not immutable (for a write). NULL for anything else, which takes js_get_elem / js_set_elem. */
static JS_FAST_PATH uint8_t *js_ta_inline_elem(JSContext *ctx, JSValue obj, int32_t i, bool write) {
    if (!js_is_object(obj) || js_as_object(obj)->shape->cls != ctx->rt->typed_array_class) return NULL;
    const JSTypedArray *ta = (const JSTypedArray *)js_as_object(obj);
    const JSArrayBuffer *b = js_as_array_buffer(ta->buffer);
    uint32_t bad = JS_BUFFER_DETACHED | JS_BUFFER_RESIZABLE | (write ? JS_BUFFER_IMMUTABLE : 0);
    if (ta->length_tracking || i < 0 || (size_t)i >= ta->length || (b->flags & bad)) return NULL;
    return b->data + ta->byte_offset;
}

/* obj[i]: a dense array's element or a typed array's (Int8, Uint8, Int32, Float64) inline. */
static JS_FAST_PATH JSValue js_get_index_ta(JSContext *ctx, JSValue obj, JSValue key) {
    if (JS_LIKELY(js_is_int32(key)) && !js_is_array(obj)) {
        int32_t i = js_as_int32(key);
        const uint8_t *p = js_ta_inline_elem(ctx, obj, i, false);
        if (p) switch (((const JSTypedArray *)js_as_object(obj))->type) {
            case JS_TA_UINT8: case JS_TA_UINT8C: return js_int32(p[i]);
            case JS_TA_INT8: return js_int32((int8_t)p[i]);
            case JS_TA_INT32: { int32_t v; memcpy(&v, p + 4 * (size_t)i, 4); return js_int32(v); }
            case JS_TA_FLOAT64: { double v; memcpy(&v, p + 8 * (size_t)i, 8); return js_number(v); }
            default: break;
        }
    }
    return js_get_index(ctx, obj, key);
}

/* obj[i] = v: the same, for a Number v (no ToNumber code to run). */
static JS_FAST_PATH int js_set_index_ta(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict) {
    if (JS_LIKELY(js_is_int32(key)) && js_is_number(v) && !js_is_array(obj)) {
        int32_t i = js_as_int32(key);
        uint8_t *p = js_ta_inline_elem(ctx, obj, i, true);
        if (p) switch (((const JSTypedArray *)js_as_object(obj))->type) {
            case JS_TA_UINT8: case JS_TA_INT8: p[i] = (uint8_t)(js_is_int32(v) ? js_as_int32(v) : js_double_to_int32(js_as_number(v))); return 1;
            case JS_TA_INT32: { int32_t x = js_is_int32(v) ? js_as_int32(v) : js_double_to_int32(js_as_number(v)); memcpy(p + 4 * (size_t)i, &x, 4); return 1; }
            case JS_TA_FLOAT64: { double x = js_as_number(v); memcpy(p + 8 * (size_t)i, &x, 8); return 1; }
            default: break;
        }
    }
    return js_set_index(ctx, obj, key, v, strict);
}

/* The same with a double key (an unboxed index): an integral one is the int32 key (-0 too: "0"). */
static inline JSValue js_get_index_ta_f64(JSContext *ctx, JSValue obj, double key) {
    int32_t i = (int32_t)key;
    if (key >= -2147483648.0 && key <= 2147483647.0 && (double)i == key) return js_get_index_ta(ctx, obj, js_int32(i));
    return js_get_index_f64(ctx, obj, key);
}
static inline int js_set_index_ta_f64(JSContext *ctx, JSValue obj, double key, JSValue v, bool strict) {
    int32_t i = (int32_t)key;
    if (key >= -2147483648.0 && key <= 2147483647.0 && (double)i == key) return js_set_index_ta(ctx, obj, js_int32(i), v, strict);
    return js_set_index_f64(ctx, obj, key, v, strict);
}

/* A typed array's elements as generated code holds them (the typed-arrays pass): taken once,
 * for an array nothing else can reach, so nothing detaches or resizes its buffer. Empty (length
 * 0) when the value isn't a typed array of that type: every access then takes the generic path. */
typedef struct JSTAView {
    uint8_t *base;
    size_t   length;
    int      type;   /* the element type it's for: a slow path that may have run code takes it again */
} JSTAView;

static inline JSTAView js_ta_view(JSContext *ctx, JSValue obj, int type) {
    JSTAView v = { NULL, 0, type };
    if (!js_is_object(obj) || js_as_object(obj)->shape->cls != ctx->rt->typed_array_class) return v;
    const JSTypedArray *ta = (const JSTypedArray *)js_as_object(obj);
    const JSArrayBuffer *b = js_as_array_buffer(ta->buffer);
    if (ta->type != type || ta->length_tracking || (b->flags & (JS_BUFFER_DETACHED | JS_BUFFER_RESIZABLE | JS_BUFFER_IMMUTABLE)) || !b->data) return v;
    v.base = b->data + ta->byte_offset;
    v.length = ta->length;
    return v;
}

/* Whether v is a typed array of that element type (a typed function's typed array parameter). */
static inline bool js_ta_is(JSContext *ctx, JSValue v, int type) {
    return js_is_object(v) && js_as_object(v)->shape->cls == ctx->rt->typed_array_class && ((const JSTypedArray *)js_as_object(v))->type == type;
}

/* The index a key names when it's in the view, else false. */
static JS_FAST_PATH bool js_tav_index(const JSTAView *v, JSValue key, size_t *i) {
    if (!js_is_int32(key) || js_as_int32(key) < 0 || (size_t)js_as_int32(key) >= v->length) return false;
    *i = (size_t)js_as_int32(key);
    return true;
}
static JS_FAST_PATH bool js_tav_index_d(const JSTAView *v, double key, size_t *i) {
    if (!(key >= 0 && key < (double)v->length) || (double)(size_t)key != key) return false;
    *i = (size_t)key;
    return true;
}

/* Each element type's read and write (a Number, converted as the spec's NumericToRawBytes). */
#define JS_TAV_ACCESS(name, ctype, box, unbox)                                                          \
    static JS_FAST_PATH JSValue js_tav_get_##name(JSContext *ctx, JSTAView *v, JSValue obj, JSValue key) { \
        size_t i;                                                                                        \
        if (JS_LIKELY(js_tav_index(v, key, &i))) { ctype x; memcpy(&x, v->base + i * sizeof x, sizeof x); return box(x); } \
        JSValue r = js_get_elem(ctx, obj, key);                                                          \
        *v = js_ta_view(ctx, obj, v->type);  /* a getter may have run */                                 \
        return r;                                                                                        \
    }                                                                                                    \
    static JS_FAST_PATH JSValue js_tav_get_##name##_d(JSContext *ctx, JSTAView *v, JSValue obj, double key) { \
        size_t i;                                                                                        \
        if (JS_LIKELY(js_tav_index_d(v, key, &i))) { ctype x; memcpy(&x, v->base + i * sizeof x, sizeof x); return box(x); } \
        JSValue r = js_get_elem(ctx, obj, js_number(key));                                               \
        *v = js_ta_view(ctx, obj, v->type);                                                              \
        return r;                                                                                        \
    }                                                                                                    \
    static JS_FAST_PATH JSValue js_tav_get_##name##_i(JSContext *ctx, JSTAView *v, JSValue obj, int32_t key) { \
        if (JS_LIKELY((uint32_t)key < v->length)) { ctype x; memcpy(&x, v->base + (size_t)(uint32_t)key * sizeof x, sizeof x); return box(x); } \
        JSValue r = js_get_elem(ctx, obj, js_int32(key));                                                \
        *v = js_ta_view(ctx, obj, v->type);                                                              \
        return r;                                                                                        \
    }                                                                                                    \
    static JS_FAST_PATH int js_tav_set_##name##_i(JSContext *ctx, JSTAView *v, JSValue obj, int32_t key, JSValue val, bool strict) { \
        if (JS_LIKELY(js_is_number(val) && (uint32_t)key < v->length)) { ctype x = unbox(val); memcpy(v->base + (size_t)(uint32_t)key * sizeof x, &x, sizeof x); return 1; } \
        int r = js_set_elem(ctx, obj, js_int32(key), val, strict);                                       \
        *v = js_ta_view(ctx, obj, v->type);                                                              \
        return r;                                                                                        \
    }                                                                                                    \
    static JS_FAST_PATH JSValue js_tav_get_##name##_l(JSContext *ctx, JSTAView *v, JSValue obj, int64_t key) { \
        if (JS_LIKELY((uint64_t)key < v->length)) { ctype x; memcpy(&x, v->base + (size_t)key * sizeof x, sizeof x); return box(x); } \
        JSValue r = js_get_elem(ctx, obj, js_number((double)key));                                       \
        *v = js_ta_view(ctx, obj, v->type);                                                              \
        return r;                                                                                        \
    }                                                                                                    \
    static JS_FAST_PATH int js_tav_set_##name##_l(JSContext *ctx, JSTAView *v, JSValue obj, int64_t key, JSValue val, bool strict) { \
        if (JS_LIKELY(js_is_number(val) && (uint64_t)key < v->length)) { ctype x = unbox(val); memcpy(v->base + (size_t)key * sizeof x, &x, sizeof x); return 1; } \
        int r = js_set_elem(ctx, obj, js_number((double)key), val, strict);                              \
        *v = js_ta_view(ctx, obj, v->type);                                                              \
        return r;                                                                                        \
    }                                                                                                    \
    static JS_FAST_PATH int js_tav_set_##name(JSContext *ctx, JSTAView *v, JSValue obj, JSValue key, JSValue val, bool strict) { \
        size_t i;                                                                                        \
        if (JS_LIKELY(js_is_number(val) && js_tav_index(v, key, &i))) { ctype x = unbox(val); memcpy(v->base + i * sizeof x, &x, sizeof x); return 1; } \
        int r = js_set_elem(ctx, obj, key, val, strict);  /* valueOf, a setter: they may have run */    \
        *v = js_ta_view(ctx, obj, v->type);                                                              \
        return r;                                                                                        \
    }                                                                                                    \
    static JS_FAST_PATH int js_tav_set_##name##_d(JSContext *ctx, JSTAView *v, JSValue obj, double key, JSValue val, bool strict) { \
        size_t i;                                                                                        \
        if (JS_LIKELY(js_is_number(val) && js_tav_index_d(v, key, &i))) { ctype x = unbox(val); memcpy(v->base + i * sizeof x, &x, sizeof x); return 1; } \
        int r = js_set_elem(ctx, obj, js_number(key), val, strict);                                      \
        *v = js_ta_view(ctx, obj, v->type);                                                              \
        return r;                                                                                        \
    }
static JS_FAST_PATH int32_t js_tav_to_int32(JSValue v) { return js_is_int32(v) ? js_as_int32(v) : js_double_to_int32(js_as_number(v)); }
#define JS_TAV_INT(x) js_int32((int32_t)(x))
JS_TAV_ACCESS(i8, int8_t, JS_TAV_INT, (int8_t)js_tav_to_int32)
JS_TAV_ACCESS(u8, uint8_t, JS_TAV_INT, (uint8_t)js_tav_to_int32)
JS_TAV_ACCESS(i32, int32_t, JS_TAV_INT, js_tav_to_int32)
JS_TAV_ACCESS(f64, double, js_number, js_as_number)

/* A Float64Array's element as a double, for typed code ("use static": its type is number):
 * past the end, undefined as a number (NaN). False with an exception pending. And a store of a
 * double, boxed only on the slow path. */
static inline bool js_tav_num_slow(JSContext *ctx, JSTAView *v, JSValue obj, JSValue key, double *out) {
    JSValue r = js_get_elem(ctx, obj, key);
    *v = js_ta_view(ctx, obj, v->type);
    if (js_is_exception(r)) return false;
    if (js_is_number(r)) { *out = js_as_number(r); return true; }
    return js_to_number(ctx, out, r) == 0;
}
#define JS_TAV_F64(suffix, ktype, in_view, boxed_key)                                                   \
    static JS_FAST_PATH bool js_tav_num_f64##suffix(JSContext *ctx, JSTAView *v, JSValue obj, ktype key, double *out) { \
        size_t i;                                                                                        \
        if (JS_LIKELY(in_view)) { memcpy(out, v->base + i * 8, 8); return true; }                        \
        return js_tav_num_slow(ctx, v, obj, boxed_key, out);                                            \
    }                                                                                                    \
    static JS_FAST_PATH int js_tav_put_f64##suffix(JSContext *ctx, JSTAView *v, JSValue obj, ktype key, double x, bool strict) { \
        size_t i;                                                                                        \
        if (JS_LIKELY(in_view)) { memcpy(v->base + i * 8, &x, 8); return 1; }                            \
        int r = js_set_elem(ctx, obj, boxed_key, js_number(x), strict);                                  \
        *v = js_ta_view(ctx, obj, v->type);                                                              \
        return r;                                                                                        \
    }
JS_TAV_F64(, JSValue, js_tav_index(v, key, &i), key)
JS_TAV_F64(_d, double, js_tav_index_d(v, key, &i), js_number(key))
JS_TAV_F64(_i, int32_t, ((i = (size_t)(uint32_t)key) < v->length), js_int32(key))
JS_TAV_F64(_l, int64_t, ((i = (size_t)(uint64_t)key) < v->length), js_number((double)key))

#endif /* JS_BUFFER_H */
