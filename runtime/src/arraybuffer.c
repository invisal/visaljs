/* ArrayBuffer and DataView (ECMAScript §25.1, §25.3), the arraybuffer component:
 * resizable buffers, transfer, and the immutable-ArrayBuffer proposal; DataView with Float16.
 * The BigInt64 accessors exist when the bigint component does.
 *
 * A buffer's bytes are malloc'd and freed by its finalizer, and counted as the heap's external
 * memory: byte_length of them while it has any. A detached buffer has no
 * bytes and length 0. Views read the buffer's current data pointer and length on every access, since a
 * resize or a transfer may move or drop the bytes. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "builtins_util.h"
#include "js_atoms.h"
#include "js_buffer.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_function.h"
#include "js_ops.h"
#include "jscontext.h"

#define MAX_INDEX 9007199254740991.0  /* 2^53 - 1 */
#define MAX_ALLOC ((size_t)1 << 34)    /* larger buffers fail as V8's do: "Array buffer allocation failed" */
#define MAX_RESERVE 140737488355328.0  /* 2^47: a larger maxByteLength fails, as V8 can't reserve it */

/* ---- ArrayBuffer objects --------------------------------------------------------------------- */

static void buffer_finalize(JSRuntime *rt, JSCell *c) {
    JSArrayBuffer *b = (JSArrayBuffer *)c;
    if (b->data) js_gc_external_sub(rt, b->byte_length);
    free(b->data);
}

static const JSClass array_buffer_class = { "ArrayBuffer", sizeof(JSArrayBuffer), NULL, NULL, NULL, NULL, NULL, buffer_finalize, NULL };

static void data_view_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((JSDataView *)c)->buffer); }

static const JSClass data_view_class = { "DataView", sizeof(JSDataView), NULL, NULL, NULL, NULL, data_view_visit, NULL, NULL };

/* ToIndex (§7.1.22): 0, or -1 with a RangeError saying `what`. */
static int to_index(JSContext *ctx, JSValue v, double *out, const char *what) {
    if (js_is_undefined(v)) {
        *out = 0;
        return 0;
    }
    double d;
    if (js_to_integer_or_infinity(ctx, &d, v) < 0) return -1;
    if (d < 0 || d > MAX_INDEX) {
        js_discard(js_throw_range_error(ctx, "%s", what));
        return -1;
    }
    *out = d;
    return 0;
}

/* Zeroed bytes, or NULL with a RangeError. Zero bytes need no memory. */
static int alloc_bytes(JSContext *ctx, double length, uint8_t **out) {
    *out = NULL;
    if (length == 0) return 0;
    if (length > (double)MAX_ALLOC || !(*out = calloc(1, (size_t)length))) {
        js_discard(js_throw_range_error(ctx, "Array buffer allocation failed"));
        return -1;
    }
    return 0;
}

/* A buffer's bytes went from `from` to `to` (0: none). */
static void resize_external(JSContext *ctx, size_t from, size_t to) {
    if (to > from) js_gc_external_add(ctx->rt, to - from);
    else js_gc_external_sub(ctx->rt, from - to);
}

/* AllocateArrayBuffer (§25.1.3.1): the prototype first, then the bytes. max < 0: not resizable. */
static JSValue allocate(JSContext *ctx, JSValue new_target, double length, double max) {
    if (max >= 0 && length > max) return js_throw_range_error(ctx, "Invalid array buffer max length");
    JSValue proto = js_is_undefined(new_target) ? ctx->intrinsics[JS_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]
                                                : js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_ARRAY_BUFFER_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    uint8_t *data;
    if (alloc_bytes(ctx, length, &data) < 0) return JS_EXCEPTION;
    JSArrayBuffer *b = (JSArrayBuffer *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &array_buffer_class, proto, 0));
    b->data = data;
    b->byte_length = (size_t)length;
    if (data) js_gc_external_add(ctx->rt, b->byte_length);
    b->max_byte_length = max >= 0 ? (size_t)max : (size_t)length;
    b->flags = max >= 0 ? JS_BUFFER_RESIZABLE : 0;
    return js_object_value(&b->obj);
}

JSValue js_new_array_buffer(JSContext *ctx, size_t length) {
    return allocate(ctx, JS_UNDEFINED, (double)length, -1);
}

int js_array_buffer_detach(JSContext *ctx, JSValue buffer) {
    JSArrayBuffer *b = js_as_array_buffer(buffer);
    if (b->flags & JS_BUFFER_IMMUTABLE) {
        js_discard(js_throw_type_error(ctx, "Cannot detach an immutable ArrayBuffer"));
        return -1;
    }
    if (b->data) js_gc_external_sub(ctx->rt, b->byte_length);
    free(b->data);
    b->data = NULL;
    b->byte_length = 0;
    b->max_byte_length = 0;
    b->flags |= JS_BUFFER_DETACHED;
    return 0;
}

static JSArrayBuffer *this_buffer(JSContext *ctx, JSValue v, const char *method) {
    if (js_is_object(v) && js_as_object(v)->shape->cls == &array_buffer_class) return js_as_array_buffer(v);
    char what[128];
    js_describe_value(ctx, v, what, sizeof what);
    js_discard(js_throw_type_error(ctx, "Method %s called on incompatible receiver %s", method, what));
    return NULL;
}

#define THIS_BUFFER(method)                                \
    JSArrayBuffer *b = this_buffer(ctx, this_val, method); \
    if (!b) return JS_EXCEPTION

static JSValue throw_incompatible_buffer(JSContext *ctx, const char *method, JSValue v) {
    char what[128];
    js_describe_value(ctx, v, what, sizeof what);
    return js_throw_type_error(ctx, "Method %s called on incompatible receiver %s", method, what);
}

static JSValue throw_detached(JSContext *ctx, const char *method) {
    return js_throw_type_error(ctx, "Cannot perform %s on a detached ArrayBuffer", method);
}

/* new ArrayBuffer(length, options) (§25.1.4.1) */
BUILTIN(array_buffer_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_type_error(ctx, "Constructor ArrayBuffer requires 'new'");
    double length, max = -1;
    if (to_index(ctx, ARG(0), &length, "Invalid array buffer length") < 0) return JS_EXCEPTION;
    if (js_is_object(ARG(1))) {  /* GetArrayBufferMaxByteLengthOption */
        JSValue m = js_get_value(ctx, ARG(1), js_atom_from_cstr(ctx, "maxByteLength"));
        if (js_is_exception(m)) return m;
        if (!js_is_undefined(m) && to_index(ctx, m, &max, "Invalid array buffer max length") < 0) return JS_EXCEPTION;
        if (max > MAX_RESERVE) return js_throw_range_error(ctx, "Invalid array buffer max length");
    }
    return allocate(ctx, new_target, length, max);
}

/* ArrayBuffer.isView(arg) */
BUILTIN(array_buffer_is_view) {
    UNUSED_ARGS;
    JSValue v = ARG(0);
    if (!js_is_object(v)) return JS_FALSE;
    const JSClass *cls = js_as_object(v)->shape->cls;
    return js_bool(cls == &data_view_class || (ctx->rt->is_typed_array && ctx->rt->is_typed_array(v)));
}

BUILTIN(get_species) {
    UNUSED_ARGS;
    return this_val;
}

BUILTIN(array_buffer_byte_length) {
    UNUSED_ARGS;
    THIS_BUFFER("get ArrayBuffer.prototype.byteLength");
    return js_number((double)b->byte_length);
}

BUILTIN(array_buffer_max_byte_length) {
    UNUSED_ARGS;
    THIS_BUFFER("get ArrayBuffer.prototype.maxByteLength");
    return js_number((double)(js_buffer_is_detached(b) ? 0 : b->max_byte_length));
}

BUILTIN(array_buffer_resizable) {
    UNUSED_ARGS;
    THIS_BUFFER("get ArrayBuffer.prototype.resizable");
    return js_bool(b->flags & JS_BUFFER_RESIZABLE);
}

BUILTIN(array_buffer_detached) {
    UNUSED_ARGS;
    THIS_BUFFER("get ArrayBuffer.prototype.detached");
    return js_bool(js_buffer_is_detached(b));
}

BUILTIN(array_buffer_immutable) {
    UNUSED_ARGS;
    THIS_BUFFER("get ArrayBuffer.prototype.immutable");
    return js_bool(b->flags & JS_BUFFER_IMMUTABLE);
}

/* resize(newLength) (§25.1.6.6) */
BUILTIN(array_buffer_resize) {
    UNUSED_ARGS;
    THIS_BUFFER("ArrayBuffer.prototype.resize");
    if (!(b->flags & JS_BUFFER_RESIZABLE)) return throw_incompatible_buffer(ctx, "ArrayBuffer.prototype.resize", this_val);
    double length;
    if (to_index(ctx, ARG(0), &length, "ArrayBuffer.prototype.resize: Invalid length parameter") < 0) return JS_EXCEPTION;
    if (js_buffer_is_detached(b)) return throw_detached(ctx, "ArrayBuffer.prototype.resize");
    if (length > (double)b->max_byte_length) return js_throw_range_error(ctx, "ArrayBuffer.prototype.resize: Invalid length parameter");
    size_t n = (size_t)length;
    if (n == 0) {
        free(b->data);
        b->data = NULL;
    } else if (n != b->byte_length) {
        uint8_t *data = realloc(b->data, n);
        if (!data) return js_throw_range_error(ctx, "Array buffer allocation failed");
        if (n > b->byte_length) memset(data + b->byte_length, 0, n - b->byte_length);
        b->data = data;
    }
    resize_external(ctx, b->byte_length, n);
    b->byte_length = n;
    return JS_UNDEFINED;
}

/* SpeciesConstructor(o, %ArrayBuffer%) (§7.3.22) */
static JSValue species_constructor(JSContext *ctx, JSValue o) {
    JSValue dflt = js_get_value(ctx, ctx->intrinsics[JS_INTRINSIC_ARRAY_BUFFER_PROTOTYPE], JS_ATOM(constructor));
    JSValue c = js_get_value(ctx, o, JS_ATOM(constructor));
    if (js_is_exception(c)) return c;
    if (js_is_undefined(c)) return dflt;
    if (!js_is_object(c)) return js_throw_type_error(ctx, "object.constructor is not an object");
    JSValue s = js_get_value(ctx, c, JS_SYMBOL(species));
    if (js_is_exception(s)) return s;
    if (js_is_nullish(s)) return dflt;
    if (!js_is_constructor(s)) return js_throw_type_error(ctx, "object.constructor[Symbol.species] is not a constructor");
    return s;
}

/* ResolveBounds: a relative start and end, clamped to 0..len. */
static int resolve_bounds(JSContext *ctx, JSValue start, JSValue end, double len, double *from, double *to) {
    double s, e = len;
    if (js_to_integer_or_infinity(ctx, &s, start) < 0) return -1;
    if (!js_is_undefined(end) && js_to_integer_or_infinity(ctx, &e, end) < 0) return -1;
    *from = s < 0 ? fmax(len + s, 0) : fmin(s, len);
    *to = e < 0 ? fmax(len + e, 0) : fmin(e, len);
    return 0;
}

/* slice(start, end) (§25.1.6.7) */
BUILTIN(array_buffer_slice) {
    UNUSED_ARGS;
    THIS_BUFFER("ArrayBuffer.prototype.slice");
    if (js_buffer_is_detached(b)) return throw_detached(ctx, "ArrayBuffer.prototype.slice");
    double first, final;
    if (resolve_bounds(ctx, ARG(0), ARG(1), (double)b->byte_length, &first, &final) < 0) return JS_EXCEPTION;
    double new_len = fmax(final - first, 0);
    JSValue c = species_constructor(ctx, this_val);
    if (js_is_exception(c)) return c;
    JSValue arg = js_number(new_len);
    JSValue r = js_construct(ctx, c, 1, &arg, JS_UNDEFINED, NULL);
    if (js_is_exception(r)) return r;
    if (!js_is_object(r) || js_as_object(r)->shape->cls != &array_buffer_class)
        return throw_incompatible_buffer(ctx, "ArrayBuffer.prototype.slice", r);
    JSArrayBuffer *nb = js_as_array_buffer(r);
    if (nb->flags & JS_BUFFER_IMMUTABLE) return js_throw_type_error(ctx, "ArrayBuffer.prototype.slice: the new ArrayBuffer is immutable");
    if (js_buffer_is_detached(nb)) return throw_detached(ctx, "ArrayBuffer.prototype.slice");
    if (nb == b) return js_throw_type_error(ctx, "ArrayBuffer subclass returned this from species constructor");
    if ((double)nb->byte_length < new_len) return js_throw_type_error(ctx, "Derived ArrayBuffer constructor created a buffer which was too small");
    if (js_buffer_is_detached(b)) return throw_detached(ctx, "ArrayBuffer.prototype.slice");
    double current = (double)b->byte_length;  /* the species constructor may have shrunk it */
    if (first < current) {
        size_t count = (size_t)fmin(new_len, current - first);
        if (count) memcpy(nb->data, b->data + (size_t)first, count);
    }
    return r;
}

/* sliceToImmutable(start, end): an immutable copy of the range. */
BUILTIN(array_buffer_slice_to_immutable) {
    UNUSED_ARGS;
    THIS_BUFFER("ArrayBuffer.prototype.sliceToImmutable");
    if (js_buffer_is_detached(b)) return throw_detached(ctx, "ArrayBuffer.prototype.sliceToImmutable");
    double first, final;
    if (resolve_bounds(ctx, ARG(0), ARG(1), (double)b->byte_length, &first, &final) < 0) return JS_EXCEPTION;
    double new_len = fmax(final - first, 0);
    if (js_buffer_is_detached(b)) return throw_detached(ctx, "ArrayBuffer.prototype.sliceToImmutable");
    if ((double)b->byte_length < final) return js_throw_range_error(ctx, "ArrayBuffer.prototype.sliceToImmutable: the buffer shrank");
    JSValue r = allocate(ctx, JS_UNDEFINED, new_len, -1);
    if (js_is_exception(r)) return r;
    JSArrayBuffer *nb = js_as_array_buffer(r);
    if (new_len) memcpy(nb->data, b->data + (size_t)first, (size_t)new_len);
    nb->flags |= JS_BUFFER_IMMUTABLE;
    return r;
}

enum { KEEP_RESIZABLE, FIXED_LENGTH, IMMUTABLE };

/* ArrayBufferCopyAndDetach (§25.1.3.3): the bytes move to a new buffer, this one is detached. */
static JSValue copy_and_detach(JSContext *ctx, JSValue this_val, JSValue new_length, int mode, const char *method) {
    THIS_BUFFER(method);
    double length = (double)b->byte_length;
    if (!js_is_undefined(new_length) && to_index(ctx, new_length, &length, "Invalid array buffer length") < 0) return JS_EXCEPTION;
    if (js_buffer_is_detached(b)) return throw_detached(ctx, method);
    if (b->flags & JS_BUFFER_IMMUTABLE) return js_throw_type_error(ctx, "Cannot perform %s on an immutable ArrayBuffer", method);
    double max = mode == KEEP_RESIZABLE && (b->flags & JS_BUFFER_RESIZABLE) ? (double)b->max_byte_length : -1;
    if (max >= 0 && length > max) return js_throw_range_error(ctx, "%s: Invalid length parameter", method);
    if (length > (double)MAX_ALLOC) return js_throw_range_error(ctx, "Array buffer allocation failed");
    size_t n = (size_t)length;
    uint8_t *data = b->data;  /* the bytes move: grow or shrink them in place */
    if (n == 0) {
        free(data);
        data = NULL;
    } else if (n != b->byte_length) {
        data = realloc(data, n);
        if (!data) return js_throw_range_error(ctx, "Array buffer allocation failed");
        if (n > b->byte_length) memset(data + b->byte_length, 0, n - b->byte_length);
    }
    resize_external(ctx, b->byte_length, n);  /* counted for nb from here on */
    b->data = NULL;  /* allocate() may collect: b must not free them */
    JSValue r = allocate(ctx, JS_UNDEFINED, 0, max);
    JSArrayBuffer *nb = js_as_array_buffer(r);
    nb->data = data;
    nb->byte_length = n;
    if (mode == IMMUTABLE) nb->flags |= JS_BUFFER_IMMUTABLE;
    b->byte_length = b->max_byte_length = 0;
    b->flags |= JS_BUFFER_DETACHED;
    return r;
}

BUILTIN(array_buffer_transfer) {
    UNUSED_ARGS;
    return copy_and_detach(ctx, this_val, ARG(0), KEEP_RESIZABLE, "ArrayBuffer.prototype.transfer");
}

BUILTIN(array_buffer_transfer_to_fixed_length) {
    UNUSED_ARGS;
    return copy_and_detach(ctx, this_val, ARG(0), FIXED_LENGTH, "ArrayBuffer.prototype.transferToFixedLength");
}

BUILTIN(array_buffer_transfer_to_immutable) {
    UNUSED_ARGS;
    return copy_and_detach(ctx, this_val, ARG(0), IMMUTABLE, "ArrayBuffer.prototype.transferToImmutable");
}

/* ---- DataView ----------------------------------------------------------------------------------- */

/* The view's length now, or -1 if it is out of bounds (or its buffer detached). */
static double view_length(const JSDataView *v) {
    const JSArrayBuffer *b = js_as_array_buffer(v->buffer);
    if (js_buffer_is_detached(b)) return -1;
    if (v->byte_offset > b->byte_length) return -1;
    if (v->length_tracking) return (double)(b->byte_length - v->byte_offset);
    if (v->byte_offset + v->byte_length > b->byte_length) return -1;
    return (double)v->byte_length;
}

/* new DataView(buffer, byteOffset, byteLength) (§25.3.2.1) */
BUILTIN(data_view_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_type_error(ctx, "Constructor DataView requires 'new'");
    JSValue buffer = ARG(0);
    if (!js_is_object(buffer) || js_as_object(buffer)->shape->cls != &array_buffer_class)
        return js_throw_type_error(ctx, "First argument to DataView constructor must be an ArrayBuffer");
    char msg[96];
    double offset;
    if (!js_is_undefined(ARG(1)) && js_is_number(ARG(1)))
        snprintf(msg, sizeof msg, "Start offset %.17g is outside the bounds of the buffer", js_as_number(ARG(1)));
    else
        snprintf(msg, sizeof msg, "Start offset is outside the bounds of the buffer");
    if (to_index(ctx, ARG(1), &offset, msg) < 0) return JS_EXCEPTION;
    JSArrayBuffer *b = js_as_array_buffer(buffer);
    if (js_buffer_is_detached(b)) return throw_detached(ctx, "DataView constructor");
    double buffer_len = (double)b->byte_length;
    if (offset > buffer_len) return js_throw_range_error(ctx, "Start offset %.17g is outside the bounds of the buffer", offset);
    bool tracking = js_is_undefined(ARG(2)) && (b->flags & JS_BUFFER_RESIZABLE);
    double length = 0;
    if (js_is_undefined(ARG(2))) {
        length = buffer_len - offset;
    } else {
        if (to_index(ctx, ARG(2), &length, "Invalid DataView length") < 0) return JS_EXCEPTION;
        if (offset + length > buffer_len) return js_throw_range_error(ctx, "Invalid DataView length %.17g", length);
    }
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_DATA_VIEW_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    /* the prototype lookup ran user code: check the buffer again */
    if (js_buffer_is_detached(b)) return throw_detached(ctx, "DataView constructor");
    buffer_len = (double)b->byte_length;
    if (offset > buffer_len) return js_throw_range_error(ctx, "Start offset %.17g is outside the bounds of the buffer", offset);
    if (!js_is_undefined(ARG(2)) && offset + length > buffer_len) return js_throw_range_error(ctx, "Invalid DataView length %.17g", length);
    JSDataView *v = (JSDataView *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &data_view_class, proto, 0));
    js_store(ctx, &v->obj.cell, &v->buffer, buffer);
    v->byte_offset = (size_t)offset;
    v->byte_length = tracking ? 0 : (size_t)length;
    v->length_tracking = tracking;
    return js_object_value(&v->obj);
}

static JSDataView *this_view(JSContext *ctx, JSValue v, const char *method) {
    if (js_is_object(v) && js_as_object(v)->shape->cls == &data_view_class) return (JSDataView *)js_as_object(v);
    char what[128];
    js_describe_value(ctx, v, what, sizeof what);
    js_discard(js_throw_type_error(ctx, "Method %s called on incompatible receiver %s", method, what));
    return NULL;
}

#define THIS_VIEW(method)                              \
    JSDataView *dv = this_view(ctx, this_val, method); \
    if (!dv) return JS_EXCEPTION

BUILTIN(data_view_buffer) {
    UNUSED_ARGS;
    THIS_VIEW("get DataView.prototype.buffer");
    return dv->buffer;
}

BUILTIN(data_view_byte_length) {
    UNUSED_ARGS;
    THIS_VIEW("get DataView.prototype.byteLength");
    double len = view_length(dv);
    return len < 0 ? throw_detached(ctx, "get DataView.prototype.byteLength") : js_number(len);
}

BUILTIN(data_view_byte_offset) {
    UNUSED_ARGS;
    THIS_VIEW("get DataView.prototype.byteOffset");
    return view_length(dv) < 0 ? throw_detached(ctx, "get DataView.prototype.byteOffset") : js_number((double)dv->byte_offset);
}

/* Float16 (IEEE 754 binary16) from a double, rounding to nearest, ties to even; and back. */
uint16_t js_to_float16(double d) {
    uint16_t sign = signbit(d) ? 0x8000 : 0;
    if (isnan(d)) return 0x7E00;
    double a = fabs(d);
    if (a >= 65520.0) return sign | 0x7C00;           /* past the largest finite half (65504) */
    if (a < 0x1p-14) return sign | (uint16_t)nearbyint(a * 0x1p24);  /* subnormal: m × 2^-24 */
    int e;
    double f = frexp(a, &e);                          /* a = f × 2^e, f in [0.5, 1) */
    double m = nearbyint((f * 2 - 1) * 1024);
    int exp = e - 1 + 15;
    if (m == 1024) {
        m = 0;
        exp++;
    }
    if (exp >= 31) return sign | 0x7C00;
    return (uint16_t)(sign | (exp << 10) | (uint16_t)m);
}

double js_from_float16(uint16_t h) {
    int exp = (h >> 10) & 0x1F, m = h & 0x3FF;
    double v = exp == 0 ? ldexp(m, -24) : exp == 31 ? (m ? NAN : INFINITY) : ldexp(m + 1024, exp - 25);
    return (h & 0x8000) ? -v : v;
}

enum { T_INT8, T_UINT8, T_INT16, T_UINT16, T_INT32, T_UINT32, T_FLOAT16, T_FLOAT32, T_FLOAT64, T_BIGINT64, T_BIGUINT64 };
static const uint8_t type_size[] = { 1, 1, 2, 2, 4, 4, 2, 4, 8, 8, 8 };

static bool host_little_endian(void) {
    const uint16_t one = 1;
    return *(const uint8_t *)&one == 1;
}

static void copy_ordered(uint8_t *dst, const uint8_t *src, size_t n, bool little) {
    if (little == host_little_endian()) {
        memcpy(dst, src, n);
    } else {
        for (size_t i = 0; i < n; i++) dst[i] = src[n - 1 - i];
    }
}

/* GetViewValue (§25.3.1.5) */
static JSValue get_view_value(JSContext *ctx, JSValue this_val, JSValue request, JSValue little_endian, int type, const char *method) {
    THIS_VIEW(method);
    double index;
    if (to_index(ctx, request, &index, "Offset is outside the bounds of the DataView") < 0) return JS_EXCEPTION;
    bool little = js_truthy(little_endian);
    double len = view_length(dv);
    if (len < 0) return throw_detached(ctx, method);
    if (index + type_size[type] > len) return js_throw_range_error(ctx, "Offset is outside the bounds of the DataView");
    union { uint8_t b[8]; int8_t i8; uint8_t u8; int16_t i16; uint16_t u16; int32_t i32; uint32_t u32; float f32; double f64; int64_t i64; uint64_t u64; } u;
    const uint8_t *p = js_as_array_buffer(dv->buffer)->data + dv->byte_offset + (size_t)index;
    copy_ordered(u.b, p, type_size[type], little);
    switch (type) {
    case T_BIGINT64: return ctx->rt->bigint->from_int64(ctx, u.i64);
    case T_BIGUINT64: return ctx->rt->bigint->from_uint64(ctx, u.u64);
    case T_INT8: return js_int32(u.i8);
    case T_UINT8: return js_int32(u.u8);
    case T_INT16: return js_int32(u.i16);
    case T_UINT16: return js_int32(u.u16);
    case T_INT32: return js_int32(u.i32);
    case T_UINT32: return js_number(u.u32);
    case T_FLOAT16: return js_number(js_from_float16(u.u16));
    case T_FLOAT32: return js_number(u.f32);
    default: return js_number(u.f64);
    }
}

/* SetViewValue (§25.3.1.6) */
static JSValue set_view_value(JSContext *ctx, JSValue this_val, JSValue request, JSValue value, JSValue little_endian, int type, const char *method) {
    THIS_VIEW(method);
    if (js_as_array_buffer(dv->buffer)->flags & JS_BUFFER_IMMUTABLE)
        return js_throw_type_error(ctx, "Cannot perform %s on an immutable ArrayBuffer", method);
    double index, d = 0;
    uint64_t big = 0;
    if (to_index(ctx, request, &index, "Offset is outside the bounds of the DataView") < 0) return JS_EXCEPTION;
    if (type == T_BIGINT64 || type == T_BIGUINT64) {  /* ToBigInt, then its value modulo 2^64 */
        JSValue b = ctx->rt->bigint->to_bigint(ctx, value);
        if (js_is_exception(b)) return b;
        big = ctx->rt->bigint->to_uint64(b);
    } else if (js_to_number(ctx, &d, value) < 0) {
        return JS_EXCEPTION;
    }
    bool little = js_truthy(little_endian);
    double len = view_length(dv);
    if (len < 0) return throw_detached(ctx, method);
    if (index + type_size[type] > len) return js_throw_range_error(ctx, "Offset is outside the bounds of the DataView");
    union { uint8_t b[8]; int8_t i8; uint8_t u8; int16_t i16; uint16_t u16; int32_t i32; uint32_t u32; float f32; double f64; uint64_t u64; } u;
    switch (type) {
    case T_BIGINT64: case T_BIGUINT64: u.u64 = big; break;
    case T_INT8: case T_UINT8: u.u8 = (uint8_t)(uint32_t)js_double_to_int32(d); break;
    case T_INT16: case T_UINT16: u.u16 = (uint16_t)(uint32_t)js_double_to_int32(d); break;
    case T_INT32: case T_UINT32: u.u32 = (uint32_t)js_double_to_int32(d); break;
    case T_FLOAT16: u.u16 = js_to_float16(d); break;
    case T_FLOAT32: u.f32 = (float)d; break;
    default: u.f64 = d; break;
    }
    uint8_t *p = js_as_array_buffer(dv->buffer)->data + dv->byte_offset + (size_t)index;
    copy_ordered(p, u.b, type_size[type], little);
    return JS_UNDEFINED;
}

#define VIEW_ACCESSORS(Name, type)                                                                             \
    BUILTIN(data_view_get_##Name) {                                                                            \
        (void)callee, (void)new_target;                                                                        \
        return get_view_value(ctx, this_val, ARG(0), ARG(1), type, "DataView.prototype.get" #Name);            \
    }                                                                                                          \
    BUILTIN(data_view_set_##Name) {                                                                            \
        (void)callee, (void)new_target;                                                                        \
        return set_view_value(ctx, this_val, ARG(0), ARG(1), ARG(2), type, "DataView.prototype.set" #Name);    \
    }
VIEW_ACCESSORS(Int8, T_INT8)
VIEW_ACCESSORS(Uint8, T_UINT8)
VIEW_ACCESSORS(Int16, T_INT16)
VIEW_ACCESSORS(Uint16, T_UINT16)
VIEW_ACCESSORS(Int32, T_INT32)
VIEW_ACCESSORS(Uint32, T_UINT32)
VIEW_ACCESSORS(Float16, T_FLOAT16)
VIEW_ACCESSORS(Float32, T_FLOAT32)
VIEW_ACCESSORS(Float64, T_FLOAT64)
VIEW_ACCESSORS(BigInt64, T_BIGINT64)
VIEW_ACCESSORS(BigUint64, T_BIGUINT64)

/* ---- Realm ----------------------------------------------------------------------------------- */

static const JSBuiltin array_buffer_statics[] = {
    JS_BUILTIN_FN("isView", array_buffer_is_view, 1),
    JS_BUILTIN_SYMBOL_GETTER(species, get_species),
};

static const JSBuiltin array_buffer_proto[] = {  /* V8's order, then the immutable proposal */
    JS_BUILTIN_GETTER("byteLength", array_buffer_byte_length),
    JS_BUILTIN_FN("slice", array_buffer_slice, 2),
    JS_BUILTIN_GETTER("maxByteLength", array_buffer_max_byte_length),
    JS_BUILTIN_GETTER("resizable", array_buffer_resizable),
    JS_BUILTIN_FN("resize", array_buffer_resize, 1),
    JS_BUILTIN_FN("transfer", array_buffer_transfer, 0),
    JS_BUILTIN_FN("transferToFixedLength", array_buffer_transfer_to_fixed_length, 0),
    JS_BUILTIN_GETTER("detached", array_buffer_detached),
    JS_BUILTIN_GETTER("immutable", array_buffer_immutable),
    JS_BUILTIN_FN("sliceToImmutable", array_buffer_slice_to_immutable, 2),
    JS_BUILTIN_FN("transferToImmutable", array_buffer_transfer_to_immutable, 0),
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "ArrayBuffer", JS_PROP_CONFIGURABLE),
};

static const JSBuiltin data_view_proto[] = {
    JS_BUILTIN_GETTER("buffer", data_view_buffer),
    JS_BUILTIN_GETTER("byteLength", data_view_byte_length),
    JS_BUILTIN_GETTER("byteOffset", data_view_byte_offset),
    JS_BUILTIN_FN("getInt8", data_view_get_Int8, 1),
    JS_BUILTIN_FN("setInt8", data_view_set_Int8, 2),
    JS_BUILTIN_FN("getUint8", data_view_get_Uint8, 1),
    JS_BUILTIN_FN("setUint8", data_view_set_Uint8, 2),
    JS_BUILTIN_FN("getInt16", data_view_get_Int16, 1),
    JS_BUILTIN_FN("setInt16", data_view_set_Int16, 2),
    JS_BUILTIN_FN("getUint16", data_view_get_Uint16, 1),
    JS_BUILTIN_FN("setUint16", data_view_set_Uint16, 2),
    JS_BUILTIN_FN("getInt32", data_view_get_Int32, 1),
    JS_BUILTIN_FN("setInt32", data_view_set_Int32, 2),
    JS_BUILTIN_FN("getUint32", data_view_get_Uint32, 1),
    JS_BUILTIN_FN("setUint32", data_view_set_Uint32, 2),
    JS_BUILTIN_FN("getFloat16", data_view_get_Float16, 1),
    JS_BUILTIN_FN("setFloat16", data_view_set_Float16, 2),
    JS_BUILTIN_FN("getFloat32", data_view_get_Float32, 1),
    JS_BUILTIN_FN("setFloat32", data_view_set_Float32, 2),
    JS_BUILTIN_FN("getFloat64", data_view_get_Float64, 1),
    JS_BUILTIN_FN("setFloat64", data_view_set_Float64, 2),
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "DataView", JS_PROP_CONFIGURABLE),
};

/* with BigInt: the bigint component is installed first when the program reaches it */
static const JSBuiltin data_view_bigint_proto[] = {
    JS_BUILTIN_FN("getBigInt64", data_view_get_BigInt64, 1),
    JS_BUILTIN_FN("setBigInt64", data_view_set_BigInt64, 2),
    JS_BUILTIN_FN("getBigUint64", data_view_get_BigUint64, 1),
    JS_BUILTIN_FN("setBigUint64", data_view_set_BigUint64, 2),
};

static JSValue define_class(JSContext *ctx, JSObject *global, const char *name, JSNativeFn ctor, uint32_t length, JSIntrinsic proto_slot,
                            const JSBuiltin *statics, size_t nstatics, const JSBuiltin *methods, size_t n) {
    JSValue proto = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 8);
    ctx->intrinsics[proto_slot] = proto;
    JSValue key = js_atom_from_cstr(ctx, name);
    JSValue c = js_new_native(ctx, ctor, key, length, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), proto, 0);
    js_define_builtins(ctx, js_as_object(c), statics, nstatics);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), c, JS_BUILTIN_METHOD_ATTRS);
    js_define_builtins(ctx, js_as_object(proto), methods, n);
    js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
    return c;
}

static void install_arraybuffer(JSContext *ctx, JSObject *global) {
    define_class(ctx, global, "ArrayBuffer", array_buffer_ctor, 1, JS_INTRINSIC_ARRAY_BUFFER_PROTOTYPE,
                 array_buffer_statics, JS_COUNTOF(array_buffer_statics), array_buffer_proto, JS_COUNTOF(array_buffer_proto));
    define_class(ctx, global, "DataView", data_view_ctor, 1, JS_INTRINSIC_DATA_VIEW_PROTOTYPE, NULL, 0, data_view_proto, JS_COUNTOF(data_view_proto));
    if (ctx->rt->bigint)
        js_define_builtins(ctx, js_as_object(ctx->intrinsics[JS_INTRINSIC_DATA_VIEW_PROTOTYPE]), data_view_bigint_proto, JS_COUNTOF(data_view_bigint_proto));
}

const JSComponent js_component_arraybuffer = { "arraybuffer", install_arraybuffer };
