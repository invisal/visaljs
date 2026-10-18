/* Typed arrays (ECMAScript §23.2, §10.4.5), the typedarray component, which needs the
 * arraybuffer component: %TypedArray%, its prototype's methods, and one constructor per element
 * type. BigInt64Array and BigUint64Array exist when the bigint component does, which
 * is installed before this one; their elements are 64-bit integers read and written as BigInts.
 *
 * A typed array is an integer-indexed exotic object. Its class hooks and internal methods
 * (JSClass.methods) take over keys that are canonical numeric strings, reading and writing the
 * buffer's bytes in the platform's byte order; every other key is ordinary. A view checks its
 * buffer on each access: a detached or shrunk buffer leaves it out of bounds, with length 0. */
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
#include "js_symbol.h"
#include "jscontext.h"
#include "jsnum.h"
#include "jsstring.h"

#define MAX_INDEX 9007199254740991.0  /* 2^53 - 1 */

static const uint8_t elem_size[JS_TYPED_ARRAY_TYPES] = { 1, 1, 1, 2, 2, 4, 4, 8, 8, 2, 4, 8 };
static const char *const type_names[JS_TYPED_ARRAY_TYPES] = {
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
    "BigInt64Array", "BigUint64Array", "Float16Array", "Float32Array", "Float64Array",
};

static bool is_bigint_type(int t) { return t == JS_TA_BIGINT64 || t == JS_TA_BIGUINT64; }

/* ---- Typed array objects --------------------------------------------------------------------- */

static int ta_get_own(JSContext *ctx, JSObject *o, JSValue key, JSPropertyDescriptor *out);
static int ta_define(JSContext *ctx, JSObject *o, JSValue key, const JSPropertyDescriptor *desc, bool throw_on_fail);
static int ta_delete(JSContext *ctx, JSObject *o, JSValue key, bool throw_on_fail);
static int ta_has(JSContext *ctx, JSObject *o, JSValue key);
static JSValue ta_get(JSContext *ctx, JSObject *o, JSValue key, JSValue receiver);
static int ta_set(JSContext *ctx, JSObject *o, JSValue key, JSValue v, JSValue receiver, bool throw_on_fail);
static JSValue ta_own_keys(JSContext *ctx, JSObject *o);
static int ta_prevent_extensions(JSContext *ctx, JSObject *o);

static void ta_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((JSTypedArray *)c)->buffer); }

static const JSObjectMethods ta_methods = {
    NULL, NULL, NULL, ta_prevent_extensions, ta_has, ta_get, ta_set, ta_own_keys, NULL,
};

static const JSClass ta_class = { "TypedArray", sizeof(JSTypedArray), ta_get_own, ta_define, ta_delete, NULL, ta_visit, NULL, &ta_methods };

static bool is_ta(JSValue v) { return js_is_object(v) && js_as_object(v)->shape->cls == &ta_class; }
static JSTypedArray *as_ta(JSValue v) { return (JSTypedArray *)js_as_object(v); }
static JSArrayBuffer *buffer_of(const JSTypedArray *ta) { return js_as_array_buffer(ta->buffer); }

/* IsTypedArrayOutOfBounds (§10.4.5.12): a detached buffer, or one shrunk below the view. */
static bool out_of_bounds(const JSTypedArray *ta) {
    const JSArrayBuffer *b = buffer_of(ta);
    if (js_buffer_is_detached(b) || ta->byte_offset > b->byte_length) return true;
    return !ta->length_tracking && ta->byte_offset + ta->length * elem_size[ta->type] > b->byte_length;
}

/* TypedArrayLength (§10.4.5.14), 0 when out of bounds. */
static size_t ta_length(const JSTypedArray *ta) {
    if (out_of_bounds(ta)) return 0;
    if (!ta->length_tracking) return ta->length;
    return (buffer_of(ta)->byte_length - ta->byte_offset) / elem_size[ta->type];
}

static uint8_t *element_ptr(const JSTypedArray *ta, size_t i) {
    return buffer_of(ta)->data + ta->byte_offset + i * elem_size[ta->type];
}

/* The element at a valid index, as a number. */
static double load_number(const JSTypedArray *ta, size_t i) {
    const uint8_t *p = element_ptr(ta, i);
    union { int8_t i8; uint8_t u8; int16_t i16; uint16_t u16; int32_t i32; uint32_t u32; float f32; double f64; } u;
    memcpy(&u, p, elem_size[ta->type]);
    switch (ta->type) {
    case JS_TA_INT8: return u.i8;
    case JS_TA_UINT8: case JS_TA_UINT8C: return u.u8;
    case JS_TA_INT16: return u.i16;
    case JS_TA_UINT16: return u.u16;
    case JS_TA_INT32: return u.i32;
    case JS_TA_UINT32: return u.u32;
    case JS_TA_FLOAT16: return js_from_float16(u.u16);
    case JS_TA_FLOAT32: return u.f32;
    default: return u.f64;
    }
}

/* An element: a Number, or for BigInt64Array and BigUint64Array its 64 bits. */
typedef union {
    double   num;
    uint64_t raw;
} Elem;

static Elem load_elem(const JSTypedArray *ta, size_t i) {
    Elem e;
    if (is_bigint_type(ta->type)) memcpy(&e.raw, element_ptr(ta, i), 8);
    else e.num = load_number(ta, i);
    return e;
}

/* An element as a JS value: a Number, or a BigInt (signed for BigInt64Array). */
static JSValue elem_value(JSContext *ctx, int type, Elem e) {
    if (type == JS_TA_BIGINT64) return ctx->rt->bigint->from_int64(ctx, (int64_t)e.raw);
    if (type == JS_TA_BIGUINT64) return ctx->rt->bigint->from_uint64(ctx, e.raw);
    return js_number(e.num);
}

static JSValue load(JSContext *ctx, const JSTypedArray *ta, size_t i) { return elem_value(ctx, ta->type, load_elem(ta, i)); }

/* ToUint8Clamp (§7.1.12): round to nearest, ties to even, within 0..255. */
static uint8_t clamp_u8(double d) {
    if (!(d > 0)) return 0;
    if (d >= 255) return 255;
    double f = floor(d), diff = d - f;
    if (diff > 0.5 || (diff == 0.5 && fmod(f, 2) != 0)) f += 1;
    return (uint8_t)f;
}

/* NumericToRawBytes (§25.1.3.17) at a valid index. */
static void store(const JSTypedArray *ta, size_t i, double d) {
    union { uint8_t u8; uint16_t u16; uint32_t u32; float f32; double f64; } u;
    switch (ta->type) {
    case JS_TA_INT8: case JS_TA_UINT8: u.u8 = (uint8_t)js_double_to_int32(d); break;
    case JS_TA_UINT8C: u.u8 = clamp_u8(d); break;
    case JS_TA_INT16: case JS_TA_UINT16: u.u16 = (uint16_t)js_double_to_int32(d); break;
    case JS_TA_INT32: case JS_TA_UINT32: u.u32 = (uint32_t)js_double_to_int32(d); break;
    case JS_TA_FLOAT16: u.u16 = js_to_float16(d); break;
    case JS_TA_FLOAT32: u.f32 = (float)d; break;
    default: u.f64 = d; break;
    }
    memcpy(element_ptr(ta, i), &u, elem_size[ta->type]);
}

static void store_elem(const JSTypedArray *ta, size_t i, Elem e) {
    if (is_bigint_type(ta->type)) memcpy(element_ptr(ta, i), &e.raw, 8);
    else store(ta, i, e.num);
}

/* ToBigInt for the BigInt types (its value modulo 2^64), else ToNumber: 0, or -1. */
static int to_elem(JSContext *ctx, int type, JSValue v, Elem *out) {
    if (is_bigint_type(type)) {
        JSValue b = ctx->rt->bigint->to_bigint(ctx, v);
        if (js_is_exception(b)) return -1;
        out->raw = ctx->rt->bigint->to_uint64(b);
        return 0;
    }
    return js_to_number(ctx, &out->num, v);
}

static bool immutable(const JSTypedArray *ta) { return (buffer_of(ta)->flags & JS_BUFFER_IMMUTABLE) != 0; }

/* IsValidIntegerIndex (§10.4.5.13) */
static bool valid_index(const JSTypedArray *ta, double index) {
    if (js_buffer_is_detached(buffer_of(ta))) return false;
    if (index != trunc(index) || (index == 0 && signbit(index))) return false;
    return index >= 0 && index < (double)ta_length(ta);
}

/* TypedArraySetElement (§10.4.5.16): ToNumber or ToBigInt first (it may detach), then the store
 * if the index is still valid. */
static int set_element(JSContext *ctx, JSTypedArray *ta, double index, JSValue v) {
    Elem e;
    if (to_elem(ctx, ta->type, v, &e) < 0) return -1;
    if (valid_index(ta, index)) store_elem(ta, (size_t)index, e);
    return 0;
}

/* TypedArrayGetElement (§10.4.5.15) */
static JSValue get_element(JSContext *ctx, const JSTypedArray *ta, double index) {
    return valid_index(ta, index) ? load(ctx, ta, (size_t)index) : JS_UNDEFINED;
}

/* CanonicalNumericIndexString (§7.1.21) of a property key: 1 with *out, 0 if not numeric, -1. */
static int numeric_key(JSContext *ctx, JSValue key, double *out) {
    if (js_is_number(key)) {  /* an array index key */
        *out = js_as_number(key);
        return 1;
    }
    if (!js_is_string(key)) return 0;
    JSStrView v = js_string_view(ctx, key);
    if (v.length == 0) return 0;
    uint32_t c = js_view_at(v, 0);
    if (!(c == '-' || (c >= '0' && c <= '9') || c == 'I' || c == 'N')) return 0;
    if (v.length == 2 && c == '-' && js_view_at(v, 1) == '0') {
        *out = -0.0;
        return 1;
    }
    double n = js_str_to_num(v);
    JSValue s = js_to_string(ctx, js_number(n));
    if (js_is_exception(s)) return -1;
    if (!js_string_equals(ctx, s, key)) return 0;
    *out = n;
    return 1;
}

static int reject(JSContext *ctx, bool throw_on_fail, const char *fmt, JSValue key) {
    if (!throw_on_fail) return 0;
    char k[64];
    js_describe_value(ctx, key, k, sizeof k);
    js_discard(js_throw_type_error(ctx, fmt, k));
    return -1;
}

static int ta_get_own(JSContext *ctx, JSObject *o, JSValue key, JSPropertyDescriptor *out) {
    double i;
    int n = numeric_key(ctx, key, &i);
    if (n <= 0) return n < 0 ? -1 : JS_ORDINARY;
    JSTypedArray *ta = (JSTypedArray *)o;
    if (!valid_index(ta, i)) return 0;
    /* an immutable buffer's elements are read-only and fixed */
    *out = js_data_descriptor(load(ctx, ta, (size_t)i), immutable(ta) ? JS_PROP_ENUMERABLE : JS_PROP_DEFAULT);
    return 1;
}

static int ta_define(JSContext *ctx, JSObject *o, JSValue key, const JSPropertyDescriptor *desc, bool throw_on_fail) {
    double i;
    int n = numeric_key(ctx, key, &i);
    if (n <= 0) return n < 0 ? -1 : JS_ORDINARY;
    JSTypedArray *ta = (JSTypedArray *)o;
    if (!valid_index(ta, i)) return reject(ctx, throw_on_fail, "Invalid typed array index%.0s", key);
    if (immutable(ta)) {  /* only a definition that changes nothing succeeds */
        bool same = !((desc->has & JS_DESC_CONFIGURABLE) && (desc->attrs & JS_PROP_CONFIGURABLE)) &&
                    !((desc->has & JS_DESC_ENUMERABLE) && !(desc->attrs & JS_PROP_ENUMERABLE)) && !(desc->has & (JS_DESC_GET | JS_DESC_SET)) &&
                    !((desc->has & JS_DESC_WRITABLE) && (desc->attrs & JS_PROP_WRITABLE)) &&
                    !((desc->has & JS_DESC_VALUE) && !js_same_value(ctx, desc->value, load(ctx, ta, (size_t)i)));
        return same ? 1 : reject(ctx, throw_on_fail, "Cannot redefine property: %s", key);
    }
    if (((desc->has & JS_DESC_CONFIGURABLE) && !(desc->attrs & JS_PROP_CONFIGURABLE)) ||
        ((desc->has & JS_DESC_ENUMERABLE) && !(desc->attrs & JS_PROP_ENUMERABLE)) || (desc->has & (JS_DESC_GET | JS_DESC_SET)) ||
        ((desc->has & JS_DESC_WRITABLE) && !(desc->attrs & JS_PROP_WRITABLE)))
        return reject(ctx, throw_on_fail, "Cannot redefine property: %s", key);
    if ((desc->has & JS_DESC_VALUE) && set_element(ctx, ta, i, desc->value) < 0) return -1;
    return 1;
}

static int ta_delete(JSContext *ctx, JSObject *o, JSValue key, bool throw_on_fail) {
    double i;
    int n = numeric_key(ctx, key, &i);
    if (n <= 0) return n < 0 ? -1 : JS_ORDINARY;
    JSTypedArray *ta = (JSTypedArray *)o;
    if (!valid_index(ta, i)) return 1;
    if (!throw_on_fail) return 0;
    char k[64];
    js_describe_value(ctx, key, k, sizeof k);
    js_discard(js_throw_type_error(ctx, "Cannot delete property '%s' of [object %s]", k, type_names[ta->type]));
    return -1;
}

static int ta_has(JSContext *ctx, JSObject *o, JSValue key) {
    double i;
    int n = numeric_key(ctx, key, &i);
    if (n < 0) return -1;
    return n ? valid_index((JSTypedArray *)o, i) : js_ordinary_has_property(ctx, o, key);
}

static JSValue ta_get(JSContext *ctx, JSObject *o, JSValue key, JSValue receiver) {
    double i;
    int n = numeric_key(ctx, key, &i);
    if (n < 0) return JS_EXCEPTION;
    return n ? get_element(ctx, (JSTypedArray *)o, i) : js_ordinary_get(ctx, o, key, receiver);
}

static int ta_set(JSContext *ctx, JSObject *o, JSValue key, JSValue v, JSValue receiver, bool throw_on_fail) {
    double i;
    int n = numeric_key(ctx, key, &i);
    if (n < 0) return -1;
    if (n) {
        JSTypedArray *ta = (JSTypedArray *)o;
        if (js_is_object(receiver) && js_as_object(receiver) == o) {
            if (immutable(ta)) return reject(ctx, throw_on_fail, "Cannot assign to read only property '%s' of object", key);
            return set_element(ctx, ta, i, v) < 0 ? -1 : 1;
        }
        if (!valid_index(ta, i)) return 1;
    }
    return js_ordinary_set(ctx, o, key, v, receiver, throw_on_fail);
}

/* The indices, then the ordinary keys (§10.4.5.7). */
static JSValue ta_own_keys(JSContext *ctx, JSObject *o) {
    JSTypedArray *ta = (JSTypedArray *)o;
    size_t len = ta_length(ta);
    JSValue rest = js_ordinary_own_keys(ctx, o);
    if (js_is_exception(rest)) return rest;
    JSValueArray *r = (JSValueArray *)js_as_cell(rest);
    JSValueArray *keys = js_alloc_value_array(ctx, (uint32_t)(len + r->cell.aux));
    for (size_t i = 0; i < len; i++) js_store(ctx, &keys->cell, &keys->values[i], js_index_key_of(ctx, (double)i));
    for (uint32_t i = 0; i < r->cell.aux; i++) js_store(ctx, &keys->cell, &keys->values[len + i], r->values[i]);
    js_keep_alive(rest);
    return js_cell(&keys->cell);
}

/* A view of a resizable buffer, or one that tracks its length, can't be made non-extensible. */
static int ta_prevent_extensions(JSContext *ctx, JSObject *o) {
    JSTypedArray *ta = (JSTypedArray *)o;
    if (ta->length_tracking || (buffer_of(ta)->flags & JS_BUFFER_RESIZABLE)) return 0;
    return js_ordinary_prevent_extensions(ctx, o);
}

/* ---- Creating typed arrays --------------------------------------------------------------------- */

static JSTypedArray *alloc_ta(JSContext *ctx, JSValue proto, int type) {
    JSTypedArray *ta = (JSTypedArray *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &ta_class, proto, 0));
    ta->buffer = JS_UNDEFINED;
    ta->type = (uint8_t)type;
    return ta;
}

/* AllocateTypedArrayBuffer (§23.2.5.1.6): a new zeroed buffer of `length` elements. */
static int allocate_buffer(JSContext *ctx, JSTypedArray *ta, double length) {
    double bytes = length * elem_size[ta->type];
    JSValue buffer = bytes > MAX_INDEX ? js_throw_range_error(ctx, "Array buffer allocation failed") : js_new_array_buffer(ctx, (size_t)bytes);
    if (js_is_exception(buffer)) return -1;
    js_store(ctx, &ta->obj.cell, &ta->buffer, buffer);
    ta->byte_offset = 0;
    ta->length = (size_t)length;
    ta->length_tracking = false;
    return 0;
}

/* ToIndex with V8's message for the value. */
static int to_index(JSContext *ctx, JSValue v, double *out, const char *fmt) {
    if (js_is_undefined(v)) {
        *out = 0;
        return 0;
    }
    double d;
    if (js_to_integer_or_infinity(ctx, &d, v) < 0) return -1;
    if (d < 0 || d > MAX_INDEX) {
        js_discard(js_throw_range_error(ctx, fmt, d));
        return -1;
    }
    *out = d;
    return 0;
}

static JSValue throw_detached(JSContext *ctx, const char *method) {
    return js_throw_type_error(ctx, "Cannot perform %s on a detached ArrayBuffer", method);
}

/* InitializeTypedArrayFromArrayBuffer (§23.2.5.1.3) */
static int init_from_buffer(JSContext *ctx, JSTypedArray *ta, JSValue buffer, JSValue byte_offset, JSValue length) {
    const char *name = type_names[ta->type];
    unsigned size = elem_size[ta->type];
    double offset, new_length = 0;
    if (to_index(ctx, byte_offset, &offset, "Start offset %.17g is outside the bounds of the buffer") < 0) return -1;
    if (fmod(offset, size) != 0) {
        js_discard(js_throw_range_error(ctx, "start offset of %s should be a multiple of %u", name, size));
        return -1;
    }
    if (!js_is_undefined(length) && to_index(ctx, length, &new_length, "Invalid typed array length: %.17g") < 0) return -1;
    JSArrayBuffer *b = js_as_array_buffer(buffer);
    if (js_buffer_is_detached(b)) {
        js_discard(throw_detached(ctx, "Construct"));
        return -1;
    }
    double buffer_len = (double)b->byte_length;
    bool tracking = js_is_undefined(length) && (b->flags & JS_BUFFER_RESIZABLE);
    if (tracking) {
        if (offset > buffer_len) {
            js_discard(js_throw_range_error(ctx, "Start offset %.17g is outside the bounds of the buffer", offset));
            return -1;
        }
    } else if (js_is_undefined(length)) {
        if (fmod(buffer_len, size) != 0) {
            js_discard(js_throw_range_error(ctx, "byte length of %s should be a multiple of %u", name, size));
            return -1;
        }
        if (buffer_len - offset < 0) {
            js_discard(js_throw_range_error(ctx, "Start offset %.17g is outside the bounds of the buffer", offset));
            return -1;
        }
        new_length = (buffer_len - offset) / size;
    } else if (offset + new_length * size > buffer_len) {
        js_discard(js_throw_range_error(ctx, "Invalid typed array length: %.17g", new_length));
        return -1;
    }
    js_store(ctx, &ta->obj.cell, &ta->buffer, buffer);
    ta->byte_offset = (size_t)offset;
    ta->length = tracking ? 0 : (size_t)new_length;
    ta->length_tracking = tracking;
    return 0;
}

/* InitializeTypedArrayFromTypedArray (§23.2.5.1.2) */
static int init_from_typed_array(JSContext *ctx, JSTypedArray *ta, JSTypedArray *src) {
    if (out_of_bounds(src)) {
        js_discard(throw_detached(ctx, "Construct"));
        return -1;
    }
    if (is_bigint_type(src->type) != is_bigint_type(ta->type)) {
        js_discard(js_throw_type_error(ctx, "Cannot mix BigInt and other types, use explicit conversions"));
        return -1;
    }
    size_t len = ta_length(src);
    if (allocate_buffer(ctx, ta, (double)len) < 0) return -1;
    if (src->type == ta->type) {
        if (len) memcpy(element_ptr(ta, 0), element_ptr(src, 0), len * elem_size[ta->type]);
    } else {
        for (size_t i = 0; i < len; i++) store_elem(ta, i, load_elem(src, i));  /* same content type */
    }
    return 0;
}

/* A list of values from an iterator method (IteratorToList(GetIteratorFromMethod(v, method))),
 * as a JS array. Arrays iterated by the built-in iterator are read directly. */
static JSValue list_from_iterable(JSContext *ctx, JSValue v, JSValue method) {
    JSValue list = js_new_array(ctx, 0);
    JSValue it = js_call(ctx, method, v, 0, NULL);
    if (js_is_exception(it)) return it;
    if (!js_is_object(it)) return js_throw_type_error(ctx, "Result of the Symbol.iterator method is not an object");
    JSValue next = js_get_value(ctx, it, JS_ATOM(next));
    if (js_is_exception(next)) return next;
    for (;;) {
        JSValue r = js_call(ctx, next, it, 0, NULL);
        if (js_is_exception(r)) return r;
        if (!js_is_object(r)) {
            char what[64];
            js_describe_value(ctx, r, what, sizeof what);
            return js_throw_type_error(ctx, "Iterator result %s is not an object", what);
        }
        JSValue done = js_get_value(ctx, r, JS_ATOM(done));
        if (js_is_exception(done)) return done;
        if (js_truthy(done)) return list;
        JSValue value = js_get_value(ctx, r, JS_ATOM(value));
        if (js_is_exception(value) || js_array_push(ctx, js_as_object(list), value) < 0) return JS_EXCEPTION;
    }
}

/* GetMethod(v, @@iterator): a function, undefined, or EXCEPTION. */
static JSValue iterator_method(JSContext *ctx, JSValue v) {
    JSValue m = js_get_value(ctx, v, JS_SYMBOL(iterator));
    if (js_is_exception(m) || js_is_nullish(m)) return js_is_exception(m) ? m : JS_UNDEFINED;
    if (!js_is_callable(m)) {
        char what[64];
        js_describe_value(ctx, m, what, sizeof what);
        return js_throw_type_error(ctx, "%s is not a function", what);
    }
    return m;
}

/* new XArray(…) (§23.2.5.1) */
static JSValue construct(JSContext *ctx, JSValue new_target, uint32_t argc, const JSValue *argv, int type) {
    if (js_is_undefined(new_target)) return js_throw_type_error(ctx, "Constructor %s requires 'new'", type_names[type]);
    JSValue first = ARG(0);
    JSIntrinsic proto_slot = (JSIntrinsic)(JS_INTRINSIC_TYPED_ARRAY_PROTOS + type);
    if (!js_is_object(first)) {
        double len;
        if (to_index(ctx, first, &len, "Invalid typed array length: %.17g") < 0) return JS_EXCEPTION;
        JSValue proto = js_get_prototype_from_constructor(ctx, new_target, proto_slot);
        if (js_is_exception(proto)) return proto;
        JSTypedArray *ta = alloc_ta(ctx, proto, type);
        return allocate_buffer(ctx, ta, len) < 0 ? JS_EXCEPTION : js_object_value(&ta->obj);
    }
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, proto_slot);
    if (js_is_exception(proto)) return proto;
    JSTypedArray *ta = alloc_ta(ctx, proto, type);
    JSValue result = js_object_value(&ta->obj);
    if (is_ta(first)) return init_from_typed_array(ctx, ta, as_ta(first)) < 0 ? JS_EXCEPTION : result;
    if (js_is_array_buffer(first)) return init_from_buffer(ctx, ta, first, ARG(1), ARG(2)) < 0 ? JS_EXCEPTION : result;
    JSValue method = iterator_method(ctx, first);
    if (js_is_exception(method)) return method;
    JSValue source = first;
    double len;
    if (!js_is_undefined(method)) {
        source = list_from_iterable(ctx, first, method);
        if (js_is_exception(source)) return source;
        len = js_array_length(js_as_object(source));
    } else if (js_length_of_array_like(ctx, first, &len) < 0) {
        return JS_EXCEPTION;
    }
    if (allocate_buffer(ctx, ta, len) < 0) return JS_EXCEPTION;
    for (double k = 0; k < len; k++) {
        JSValue v = js_get_value(ctx, source, js_index_key_of(ctx, k));
        if (js_is_exception(v) || set_element(ctx, ta, k, v) < 0) return JS_EXCEPTION;
    }
    return result;
}

#define TA_CONSTRUCTOR(fn, type)                                                                     \
    BUILTIN(fn) {                                                                                    \
        (void)callee, (void)this_val;                                                                \
        return construct(ctx, new_target, argc, argv, type);                                         \
    }
TA_CONSTRUCTOR(int8_array_ctor, JS_TA_INT8)
TA_CONSTRUCTOR(uint8_array_ctor, JS_TA_UINT8)
TA_CONSTRUCTOR(uint8_clamped_array_ctor, JS_TA_UINT8C)
TA_CONSTRUCTOR(int16_array_ctor, JS_TA_INT16)
TA_CONSTRUCTOR(uint16_array_ctor, JS_TA_UINT16)
TA_CONSTRUCTOR(int32_array_ctor, JS_TA_INT32)
TA_CONSTRUCTOR(uint32_array_ctor, JS_TA_UINT32)
TA_CONSTRUCTOR(float16_array_ctor, JS_TA_FLOAT16)
TA_CONSTRUCTOR(float32_array_ctor, JS_TA_FLOAT32)
TA_CONSTRUCTOR(float64_array_ctor, JS_TA_FLOAT64)
TA_CONSTRUCTOR(bigint64_array_ctor, JS_TA_BIGINT64)
TA_CONSTRUCTOR(biguint64_array_ctor, JS_TA_BIGUINT64)

/* %TypedArray% (§23.2.1.1) */
BUILTIN(typed_array_ctor) {
    UNUSED_ARGS;
    return js_throw_type_error(ctx, "Abstract class TypedArray not directly constructable");
}

/* ---- Validation and species -------------------------------------------------------------------- */

/* ValidateTypedArray (§23.2.4.4): a typed array in bounds (and, to be written, with a mutable
 * buffer), or NULL with a TypeError. */
static JSTypedArray *validate_access(JSContext *ctx, JSValue v, const char *method, bool write) {
    if (!is_ta(v)) {
        js_discard(js_throw_type_error(ctx, "this is not a typed array."));
        return NULL;
    }
    if (write && immutable(as_ta(v))) {
        js_discard(js_throw_type_error(ctx, "Cannot perform %s on an immutable ArrayBuffer", method));
        return NULL;
    }
    if (out_of_bounds(as_ta(v))) {
        js_discard(js_throw_type_error(ctx, "Cannot perform %s on a detached ArrayBuffer", method));
        return NULL;
    }
    return as_ta(v);
}

static JSTypedArray *validate(JSContext *ctx, JSValue v, const char *method) { return validate_access(ctx, v, method, false); }

#define VALIDATE_ACCESS(name, write)                                                      \
    static const char method[] = "%TypedArray%.prototype." name;                          \
    JSTypedArray *ta = validate_access(ctx, this_val, method, write);                     \
    if (!ta) return JS_EXCEPTION;                                                         \
    double len = (double)ta_length(ta)
#define VALIDATE(name) VALIDATE_ACCESS(name, false)
#define VALIDATE_WRITE(name) VALIDATE_ACCESS(name, true)

/* TypedArrayCreateFromConstructor (§23.2.4.2): `min_length` >= 0 when args is one length. */
static JSValue create_from_constructor(JSContext *ctx, JSValue c, uint32_t argc, const JSValue *argv, double min_length, const char *method) {
    JSValue r = js_construct(ctx, c, argc, argv, JS_UNDEFINED, NULL);
    if (js_is_exception(r)) return r;
    if (!is_ta(r)) {
        char what[64];
        js_describe_value(ctx, r, what, sizeof what);
        return js_throw_type_error(ctx, "Method %s called on incompatible receiver %s", method, what);
    }
    if (out_of_bounds(as_ta(r))) return throw_detached(ctx, method);
    if (min_length >= 0 && immutable(as_ta(r)))  /* a result that will be written */
        return js_throw_type_error(ctx, "Cannot perform %s on an immutable ArrayBuffer", method);
    if (min_length >= 0 && (double)ta_length(as_ta(r)) < min_length)
        return js_throw_type_error(ctx, "Derived TypedArray constructor created an array which was too small");
    return r;
}

/* TypedArraySpeciesCreate (§23.2.4.1) */
static JSValue species_create(JSContext *ctx, JSTypedArray *exemplar, uint32_t argc, const JSValue *argv, double min_length, const char *method) {
    JSValue dflt = ctx->intrinsics[JS_INTRINSIC_TYPED_ARRAY_CTORS + exemplar->type];
    JSValue c = js_get_value(ctx, js_object_value(&exemplar->obj), JS_ATOM(constructor));
    if (js_is_exception(c)) return c;
    if (js_is_undefined(c)) {
        c = dflt;
    } else {
        if (!js_is_object(c)) return js_throw_type_error(ctx, "object.constructor is not an object");
        JSValue s = js_get_value(ctx, c, JS_SYMBOL(species));
        if (js_is_exception(s)) return s;
        if (js_is_nullish(s)) c = dflt;
        else if (!js_is_constructor(s)) return js_throw_type_error(ctx, "object.constructor[Symbol.species] is not a constructor");
        else c = s;
    }
    JSValue r = create_from_constructor(ctx, c, argc, argv, min_length, method);
    if (!js_is_exception(r) && is_bigint_type(as_ta(r)->type) != is_bigint_type(exemplar->type))
        return js_throw_type_error(ctx, "Cannot mix BigInt and other types, use explicit conversions");
    return r;
}

/* TypedArrayCreateSameType (§23.2.4.3) */
static JSValue create_same_type(JSContext *ctx, JSTypedArray *exemplar, double length, const char *method) {
    JSValue arg = js_number(length);
    return create_from_constructor(ctx, ctx->intrinsics[JS_INTRINSIC_TYPED_ARRAY_CTORS + exemplar->type], 1, &arg, length, method);
}

static bool callable_or_throw(JSContext *ctx, JSValue f) {
    if (js_is_callable(f)) return true;
    char what[64];
    js_describe_value(ctx, f, what, sizeof what);
    js_discard(js_throw_type_error(ctx, "%s is not a function", what));
    return false;
}

/* A relative index argument clamped to 0..len (`dflt` when undefined). */
static int relative(JSContext *ctx, JSValue v, double len, double dflt, double *out) {
    double d = dflt;
    if (!js_is_undefined(v) && js_to_integer_or_infinity(ctx, &d, v) < 0) return -1;
    *out = d < 0 ? fmax(len + d, 0) : fmin(d, len);
    return 0;
}


/* ---- %TypedArray% statics ------------------------------------------------------------------------- */

/* %TypedArray%.from(source, mapfn, thisArg) (§23.2.2.1) */
BUILTIN(typed_array_from) {
    (void)callee, (void)new_target;
    JSValue c = this_val, mapfn = ARG(1), this_arg = ARG(2);
    if (!js_is_constructor(c)) {
        char what[64];
        js_describe_value(ctx, c, what, sizeof what);
        return js_throw_type_error(ctx, "%s is not a constructor", what);
    }
    bool mapping = !js_is_undefined(mapfn);
    if (mapping && !callable_or_throw(ctx, mapfn)) return JS_EXCEPTION;
    JSValue method = iterator_method(ctx, ARG(0));
    if (js_is_exception(method)) return method;
    JSValue source;
    double len;
    if (!js_is_undefined(method)) {
        source = list_from_iterable(ctx, ARG(0), method);
        if (js_is_exception(source)) return source;
        len = js_array_length(js_as_object(source));
    } else {
        source = js_to_object(ctx, ARG(0));
        if (js_is_exception(source) || js_length_of_array_like(ctx, source, &len) < 0) return JS_EXCEPTION;
    }
    JSValue arg = js_number(len);
    JSValue target = create_from_constructor(ctx, c, 1, &arg, len, "%TypedArray%.from");
    if (js_is_exception(target)) return target;
    for (double k = 0; k < len; k++) {
        JSValue key = js_index_key_of(ctx, k);
        JSValue v = js_get_value(ctx, source, key);
        if (js_is_exception(v)) return v;
        if (mapping) {
            JSValue args[2] = { v, js_number(k) };
            v = js_call(ctx, mapfn, this_arg, 2, args);
            if (js_is_exception(v)) return v;
        }
        if (js_set_value(ctx, target, key, v, true) < 0) return JS_EXCEPTION;
    }
    return target;
}

/* %TypedArray%.of(...items) (§23.2.2.2) */
BUILTIN(typed_array_of) {
    (void)callee, (void)new_target;
    if (!js_is_constructor(this_val)) {
        char what[64];
        js_describe_value(ctx, this_val, what, sizeof what);
        return js_throw_type_error(ctx, "%s is not a constructor", what);
    }
    JSValue arg = js_number(argc);
    JSValue target = create_from_constructor(ctx, this_val, 1, &arg, argc, "%TypedArray%.of");
    if (js_is_exception(target)) return target;
    for (uint32_t k = 0; k < argc; k++)
        if (js_set_value(ctx, target, js_index_key(k), argv[k], true) < 0) return JS_EXCEPTION;
    return target;
}

BUILTIN(get_species) {
    UNUSED_ARGS;
    return this_val;
}

/* ---- %TypedArray%.prototype accessors ---------------------------------------------------------- */

static JSTypedArray *this_ta(JSContext *ctx, JSValue v, const char *method) {
    if (is_ta(v)) return as_ta(v);
    char what[64];
    js_describe_value(ctx, v, what, sizeof what);
    js_discard(js_throw_type_error(ctx, "Method %s called on incompatible receiver %s", method, what));
    return NULL;
}

BUILTIN(ta_proto_buffer) {
    UNUSED_ARGS;
    JSTypedArray *ta = this_ta(ctx, this_val, "get TypedArray.prototype.buffer");
    return ta ? ta->buffer : JS_EXCEPTION;
}

BUILTIN(ta_proto_byte_length) {
    UNUSED_ARGS;
    JSTypedArray *ta = this_ta(ctx, this_val, "get TypedArray.prototype.byteLength");
    return ta ? js_number((double)(ta_length(ta) * elem_size[ta->type])) : JS_EXCEPTION;
}

BUILTIN(ta_proto_byte_offset) {
    UNUSED_ARGS;
    JSTypedArray *ta = this_ta(ctx, this_val, "get TypedArray.prototype.byteOffset");
    if (!ta) return JS_EXCEPTION;
    return js_number(out_of_bounds(ta) ? 0 : (double)ta->byte_offset);
}

BUILTIN(ta_proto_length) {
    UNUSED_ARGS;
    JSTypedArray *ta = this_ta(ctx, this_val, "get TypedArray.prototype.length");
    return ta ? js_number((double)ta_length(ta)) : JS_EXCEPTION;
}

BUILTIN(ta_proto_to_string_tag) {
    UNUSED_ARGS;
    return is_ta(this_val) ? js_atom_from_cstr(ctx, type_names[as_ta(this_val)->type]) : JS_UNDEFINED;
}

/* ---- %TypedArray%.prototype methods ------------------------------------------------------------- */

BUILTIN(ta_proto_at) {
    UNUSED_ARGS;
    VALIDATE("at");
    double k;
    if (js_to_integer_or_infinity(ctx, &k, ARG(0)) < 0) return JS_EXCEPTION;
    if (k < 0) k += len;
    if (k < 0 || k >= len) return JS_UNDEFINED;
    return get_element(ctx, ta, k);
}

BUILTIN(ta_proto_copy_within) {
    UNUSED_ARGS;
    VALIDATE_WRITE("copyWithin");
    double to, from, final;
    if (relative(ctx, ARG(0), len, 0, &to) < 0 || relative(ctx, ARG(1), len, 0, &from) < 0 ||
        relative(ctx, ARG(2), len, len, &final) < 0)
        return JS_EXCEPTION;
    double count = fmin(final - from, len - to);
    if (count > 0) {
        if (out_of_bounds(ta)) return throw_detached(ctx, method);
        size_t size = elem_size[ta->type];
        double limit = (double)ta_length(ta) * size;  /* it may have shrunk */
        double to_byte = to * size, from_byte = from * size, count_bytes = count * size;
        count_bytes = fmin(count_bytes, fmin(limit - from_byte, limit - to_byte));
        if (count_bytes > 0) {
            uint8_t *base = buffer_of(ta)->data + ta->byte_offset;
            memmove(base + (size_t)to_byte, base + (size_t)from_byte, (size_t)count_bytes);
        }
    }
    return this_val;
}

static JSValue iterator_of(JSContext *ctx, JSValue this_val, JSNativeFn make, const char *name) {
    JSTypedArray *ta = validate(ctx, this_val, name);
    if (!ta) return JS_EXCEPTION;
    return make(ctx, JS_UNDEFINED, this_val, 0, NULL, JS_UNDEFINED);
}

BUILTIN(ta_proto_entries) {
    UNUSED_ARGS;
    return iterator_of(ctx, this_val, js_core_array_proto_entries, "%TypedArray%.prototype.entries");
}
BUILTIN(ta_proto_keys) {
    UNUSED_ARGS;
    return iterator_of(ctx, this_val, js_core_array_proto_keys, "%TypedArray%.prototype.keys");
}
BUILTIN(ta_proto_values) {
    UNUSED_ARGS;
    return iterator_of(ctx, this_val, js_core_array_proto_values, "%TypedArray%.prototype.values");
}

enum { EVERY, SOME, FOR_EACH, FIND, FIND_INDEX, FIND_LAST, FIND_LAST_INDEX };

/* every, some, forEach, find, findIndex, findLast, findLastIndex: callback(value, index, ta). */
static JSValue visit(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, int kind, const char *method) {
    JSTypedArray *ta = validate(ctx, this_val, method);
    if (!ta) return JS_EXCEPTION;
    double len = (double)ta_length(ta);
    if (!callable_or_throw(ctx, ARG(0))) return JS_EXCEPTION;
    bool backwards = kind == FIND_LAST || kind == FIND_LAST_INDEX;
    for (double i = 0; i < len; i++) {
        double k = backwards ? len - 1 - i : i;
        JSValue v = get_element(ctx, ta, k);
        JSValue args[3] = { v, js_number(k), this_val };
        JSValue r = js_call(ctx, ARG(0), ARG(1), 3, args);
        if (js_is_exception(r)) return r;
        bool t = js_truthy(r);
        switch (kind) {
        case EVERY: if (!t) return JS_FALSE; break;
        case SOME: if (t) return JS_TRUE; break;
        case FIND: case FIND_LAST: if (t) return v; break;
        case FIND_INDEX: case FIND_LAST_INDEX: if (t) return js_number(k); break;
        default: break;
        }
    }
    switch (kind) {
    case EVERY: return JS_TRUE;
    case SOME: return JS_FALSE;
    case FIND_INDEX: case FIND_LAST_INDEX: return js_int32(-1);
    default: return JS_UNDEFINED;
    }
}

#define VISITOR(fn, kind, name)                                                              \
    BUILTIN(fn) {                                                                            \
        (void)callee, (void)new_target;                                                      \
        return visit(ctx, this_val, argc, argv, kind, "%TypedArray%.prototype." name);       \
    }
VISITOR(ta_proto_every, EVERY, "every")
VISITOR(ta_proto_some, SOME, "some")
VISITOR(ta_proto_for_each, FOR_EACH, "forEach")
VISITOR(ta_proto_find, FIND, "find")
VISITOR(ta_proto_find_index, FIND_INDEX, "findIndex")
VISITOR(ta_proto_find_last, FIND_LAST, "findLast")
VISITOR(ta_proto_find_last_index, FIND_LAST_INDEX, "findLastIndex")

BUILTIN(ta_proto_fill) {
    UNUSED_ARGS;
    VALIDATE_WRITE("fill");
    double k, final;
    Elem value;
    if (to_elem(ctx, ta->type, ARG(0), &value) < 0) return JS_EXCEPTION;
    if (relative(ctx, ARG(1), len, 0, &k) < 0 || relative(ctx, ARG(2), len, len, &final) < 0) return JS_EXCEPTION;
    if (out_of_bounds(ta)) return throw_detached(ctx, method);
    final = fmin(final, (double)ta_length(ta));
    for (; k < final; k++) store_elem(ta, (size_t)k, value);
    return this_val;
}

BUILTIN(ta_proto_filter) {
    UNUSED_ARGS;
    VALIDATE("filter");
    if (!callable_or_throw(ctx, ARG(0))) return JS_EXCEPTION;
    JSValue kept = js_new_array(ctx, 0);
    for (double k = 0; k < len; k++) {
        JSValue v = get_element(ctx, ta, k);
        JSValue args[3] = { v, js_number(k), this_val };
        JSValue r = js_call(ctx, ARG(0), ARG(1), 3, args);
        if (js_is_exception(r)) return r;
        if (js_truthy(r) && js_array_push(ctx, js_as_object(kept), v) < 0) return JS_EXCEPTION;
    }
    uint32_t n = js_array_length(js_as_object(kept));
    JSValue arg = js_number(n);
    JSValue a = species_create(ctx, ta, 1, &arg, n, method);
    if (js_is_exception(a)) return a;
    for (uint32_t i = 0; i < n; i++) {
        JSValue v = js_get_value(ctx, kept, js_index_key(i));
        if (js_is_exception(v) || js_set_value(ctx, a, js_index_key(i), v, true) < 0) return JS_EXCEPTION;
    }
    return a;
}

enum { INCLUDES, INDEX_OF, LAST_INDEX_OF };

static JSValue search(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, int kind, const char *method) {
    JSTypedArray *ta = validate(ctx, this_val, method);
    if (!ta) return JS_EXCEPTION;
    double len = (double)ta_length(ta);
    JSValue not_found = kind == INCLUDES ? JS_FALSE : js_int32(-1);
    if (len == 0) return not_found;
    double n = kind == LAST_INDEX_OF ? len - 1 : 0;
    if (argc > 1 && js_to_integer_or_infinity(ctx, &n, argv[1]) < 0) return JS_EXCEPTION;
    JSValue target = ARG(0);
    if (kind == LAST_INDEX_OF) {
        if (n == -INFINITY) return not_found;
        double k = n >= 0 ? fmin(n, len - 1) : len + n;
        for (; k >= 0; k--) {
            if (!valid_index(ta, k)) continue;  /* a missing element is never strictly equal */
            if (js_strict_equals(ctx, load(ctx, ta, (size_t)k), target)) return js_number(k);
        }
        return not_found;
    }
    if (n == INFINITY) return not_found;
    double k = n >= 0 ? n : fmax(len + n, 0);
    for (; k < len; k++) {
        JSValue e = get_element(ctx, ta, k);
        if (kind == INCLUDES) {
            if (js_same_bits(e, target) || js_strict_equals(ctx, e, target) ||
                (js_is_number(e) && js_is_number(target) && isnan(js_as_number(e)) && isnan(js_as_number(target))))
                return JS_TRUE;
        } else if (valid_index(ta, k) && js_strict_equals(ctx, e, target)) {
            return js_number(k);
        }
    }
    return not_found;
}

BUILTIN(ta_proto_includes) {
    (void)callee, (void)new_target;
    return search(ctx, this_val, argc, argv, INCLUDES, "%TypedArray%.prototype.includes");
}
BUILTIN(ta_proto_index_of) {
    (void)callee, (void)new_target;
    return search(ctx, this_val, argc, argv, INDEX_OF, "%TypedArray%.prototype.indexOf");
}
BUILTIN(ta_proto_last_index_of) {
    (void)callee, (void)new_target;
    return search(ctx, this_val, argc, argv, LAST_INDEX_OF, "%TypedArray%.prototype.lastIndexOf");
}

/* join and toLocaleString: elements as strings (missing ones as ""), with a separator. */
static JSValue join(JSContext *ctx, JSValue this_val, JSValue sep_arg, bool locale, const char *method) {
    JSTypedArray *ta = validate(ctx, this_val, method);
    if (!ta) return JS_EXCEPTION;
    double len = (double)ta_length(ta);
    JSValue sep = js_atom_from_cstr(ctx, ",");
    if (!locale && !js_is_undefined(sep_arg)) {
        sep = js_to_string(ctx, sep_arg);
        if (js_is_exception(sep)) return sep;
    }
    JSValue r = js_empty_string();
    for (double k = 0; k < len; k++) {
        if (k > 0) r = js_concat(ctx, r, sep);
        JSValue e = get_element(ctx, ta, k);
        if (js_is_undefined(e)) continue;
        JSValue s;
        if (locale) {
            JSValue f = js_get_value(ctx, e, js_atom_from_cstr(ctx, "toLocaleString"));
            if (js_is_exception(f)) return f;
            s = js_call(ctx, f, e, 0, NULL);
            if (!js_is_exception(s)) s = js_to_string(ctx, s);
        } else {
            s = js_to_string(ctx, e);
        }
        if (js_is_exception(s)) return s;
        r = js_concat(ctx, r, s);
        if (js_is_exception(r)) return r;
    }
    return r;
}

BUILTIN(ta_proto_join) {
    UNUSED_ARGS;
    return join(ctx, this_val, ARG(0), false, "%TypedArray%.prototype.join");
}

BUILTIN(ta_proto_to_locale_string) {
    UNUSED_ARGS;
    return join(ctx, this_val, JS_UNDEFINED, true, "%TypedArray%.prototype.toLocaleString");
}

BUILTIN(ta_proto_map) {
    UNUSED_ARGS;
    VALIDATE("map");
    if (!callable_or_throw(ctx, ARG(0))) return JS_EXCEPTION;
    JSValue arg = js_number(len);
    JSValue a = species_create(ctx, ta, 1, &arg, len, method);
    if (js_is_exception(a)) return a;
    for (double k = 0; k < len; k++) {
        JSValue args[3] = { get_element(ctx, ta, k), js_number(k), this_val };
        JSValue v = js_call(ctx, ARG(0), ARG(1), 3, args);
        if (js_is_exception(v) || js_set_value(ctx, a, js_index_key_of(ctx, k), v, true) < 0) return JS_EXCEPTION;
    }
    return a;
}

static JSValue reduce(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, bool right, const char *method) {
    JSTypedArray *ta = validate(ctx, this_val, method);
    if (!ta) return JS_EXCEPTION;
    double len = (double)ta_length(ta);
    if (!callable_or_throw(ctx, ARG(0))) return JS_EXCEPTION;
    if (len == 0 && argc < 2) return js_throw_type_error(ctx, "Reduce of empty array with no initial value");
    double i = 0;
    JSValue acc;
    if (argc >= 2) {
        acc = argv[1];
    } else {
        acc = get_element(ctx, ta, right ? len - 1 : 0);
        i = 1;
    }
    for (; i < len; i++) {
        double k = right ? len - 1 - i : i;
        JSValue args[4] = { acc, get_element(ctx, ta, k), js_number(k), this_val };
        acc = js_call(ctx, ARG(0), JS_UNDEFINED, 4, args);
        if (js_is_exception(acc)) return acc;
    }
    return acc;
}

BUILTIN(ta_proto_reduce) {
    (void)callee, (void)new_target;
    return reduce(ctx, this_val, argc, argv, false, "%TypedArray%.prototype.reduce");
}
BUILTIN(ta_proto_reduce_right) {
    (void)callee, (void)new_target;
    return reduce(ctx, this_val, argc, argv, true, "%TypedArray%.prototype.reduceRight");
}

BUILTIN(ta_proto_reverse) {
    UNUSED_ARGS;
    VALIDATE_WRITE("reverse");
    for (size_t lower = 0, upper = (size_t)len; lower + 1 < upper; lower++) {
        upper--;
        Elem a = load_elem(ta, lower), b = load_elem(ta, upper);
        store_elem(ta, lower, b);
        store_elem(ta, upper, a);
    }
    return this_val;
}

/* set(source, offset) (§23.2.3.26) */
BUILTIN(ta_proto_set) {
    UNUSED_ARGS;
    static const char method[] = "%TypedArray%.prototype.set";
    if (!is_ta(this_val)) return js_throw_type_error(ctx, "this is not a typed array.");
    JSTypedArray *target = as_ta(this_val);
    if (immutable(target)) return js_throw_type_error(ctx, "Cannot perform %s on an immutable ArrayBuffer", method);
    double offset;
    if (js_to_integer_or_infinity(ctx, &offset, ARG(1)) < 0) return JS_EXCEPTION;
    if (offset < 0) return js_throw_range_error(ctx, "offset is out of bounds");
    if (is_ta(ARG(0))) {  /* SetTypedArrayFromTypedArray */
        JSTypedArray *src = as_ta(ARG(0));
        if (out_of_bounds(target) || out_of_bounds(src)) return throw_detached(ctx, method);
        double target_len = (double)ta_length(target), src_len = (double)ta_length(src);
        if (is_bigint_type(src->type) != is_bigint_type(target->type))
            return js_throw_type_error(ctx, "Cannot mix BigInt and other types, use explicit conversions");
        if (offset == INFINITY || src_len + offset > target_len) return js_throw_range_error(ctx, "offset is out of bounds");
        size_t n = (size_t)src_len;
        if (n == 0) return JS_UNDEFINED;
        if (src->type == target->type) {
            memmove(element_ptr(target, (size_t)offset), element_ptr(src, 0), n * elem_size[src->type]);
        } else {  /* read every source element first: the two may share a buffer */
            Elem *values = malloc(n * sizeof *values);
            if (!values) js_fatal("out of memory in %%TypedArray%%.prototype.set");
            for (size_t i = 0; i < n; i++) values[i] = load_elem(src, i);
            for (size_t i = 0; i < n; i++) store_elem(target, (size_t)offset + i, values[i]);
            free(values);
        }
        return JS_UNDEFINED;
    }
    /* SetTypedArrayFromArrayLike */
    if (out_of_bounds(target)) return throw_detached(ctx, method);
    double target_len = (double)ta_length(target);
    JSValue src = js_to_object(ctx, ARG(0));
    if (js_is_exception(src)) return src;
    double src_len;
    if (js_length_of_array_like(ctx, src, &src_len) < 0) return JS_EXCEPTION;
    if (offset == INFINITY || src_len + offset > target_len) return js_throw_range_error(ctx, "offset is out of bounds");
    for (double k = 0; k < src_len; k++) {
        JSValue v = js_get_value(ctx, src, js_index_key_of(ctx, k));
        if (js_is_exception(v) || set_element(ctx, target, offset + k, v) < 0) return JS_EXCEPTION;
    }
    return JS_UNDEFINED;
}

BUILTIN(ta_proto_slice) {
    UNUSED_ARGS;
    VALIDATE("slice");
    double k, final;
    if (relative(ctx, ARG(0), len, 0, &k) < 0 || relative(ctx, ARG(1), len, len, &final) < 0) return JS_EXCEPTION;
    double count = fmax(final - k, 0);
    JSValue arg = js_number(count);
    JSValue a = species_create(ctx, ta, 1, &arg, count, method);
    if (js_is_exception(a)) return a;
    if (count == 0) return a;
    if (out_of_bounds(ta)) return throw_detached(ctx, method);
    final = fmin(final, (double)ta_length(ta));
    count = fmax(final - k, 0);
    JSTypedArray *target = as_ta(a);
    if (target->type == ta->type) {
        size_t size = elem_size[ta->type];
        double bytes = fmin(count * size, (double)(ta_length(target) * size));
        /* byte by byte, forwards: the target may share the buffer (§23.2.3.27 step 14.g) */
        uint8_t *dst = element_ptr(target, 0);
        const uint8_t *src = element_ptr(ta, (size_t)k);
        for (size_t b = 0; b < (size_t)fmax(bytes, 0); b++) dst[b] = src[b];
    } else {
        for (double n = 0; k < final; k++, n++) {
            JSValue v = get_element(ctx, ta, k);
            if (js_set_value(ctx, a, js_index_key_of(ctx, n), v, true) < 0) return JS_EXCEPTION;
        }
    }
    return a;
}

/* SortCompare for typed arrays (§23.2.4.7): numbers ascending, -0 before +0, NaN last (BigInts
 * by value); or the comparator's answer. -2 with an exception. */
static int compare(JSContext *ctx, JSValue comparefn, int type, Elem ex, Elem ey) {
    if (!js_is_undefined(comparefn)) {
        JSValue args[2] = { elem_value(ctx, type, ex), elem_value(ctx, type, ey) };
        JSValue r = js_call(ctx, comparefn, JS_UNDEFINED, 2, args);
        double v;
        if (js_is_exception(r) || js_to_number(ctx, &v, r) < 0) return -2;
        return isnan(v) ? 0 : v < 0 ? -1 : v > 0 ? 1 : 0;
    }
    if (type == JS_TA_BIGINT64) return (int64_t)ex.raw < (int64_t)ey.raw ? -1 : (int64_t)ex.raw > (int64_t)ey.raw;
    if (type == JS_TA_BIGUINT64) return ex.raw < ey.raw ? -1 : ex.raw > ey.raw;
    double x = ex.num, y = ey.num;
    if (isnan(x)) return isnan(y) ? 0 : 1;
    if (isnan(y)) return -1;
    if (x < y) return -1;
    if (x > y) return 1;
    if (x == 0 && y == 0) return signbit(x) && !signbit(y) ? -1 : !signbit(x) && signbit(y) ? 1 : 0;
    return 0;
}

/* A stable merge sort of n elements; false after an exception. */
static bool merge_sort(JSContext *ctx, JSValue comparefn, int type, Elem *items, Elem *tmp, size_t n) {
    if (n < 2) return true;
    size_t mid = n / 2;
    if (!merge_sort(ctx, comparefn, type, items, tmp, mid) || !merge_sort(ctx, comparefn, type, items + mid, tmp, n - mid)) return false;
    size_t i = 0, j = mid, k = 0;
    while (i < mid && j < n) {
        int c = compare(ctx, comparefn, type, items[j], items[i]);
        if (c == -2) return false;
        tmp[k++] = c < 0 ? items[j++] : items[i++];
    }
    while (i < mid) tmp[k++] = items[i++];
    while (j < n) tmp[k++] = items[j++];
    memcpy(items, tmp, n * sizeof *items);
    return true;
}

static bool comparefn_ok(JSContext *ctx, JSValue f) {
    if (js_is_undefined(f) || js_is_callable(f)) return true;
    char what[64];
    js_describe_value(ctx, f, what, sizeof what);
    js_discard(js_throw_type_error(ctx, "The comparison function must be either a function or undefined: %s", what));
    return false;
}

/* The elements, sorted, in malloc'd memory (NULL with an exception). */
static Elem *sorted_values(JSContext *ctx, JSTypedArray *ta, size_t len, JSValue comparefn) {
    Elem *items = malloc((2 * len + 1) * sizeof *items);
    if (!items) js_fatal("out of memory sorting");
    for (size_t i = 0; i < len; i++) items[i] = load_elem(ta, i);
    if (!merge_sort(ctx, comparefn, ta->type, items, items + len, len)) {
        free(items);
        return NULL;
    }
    return items;
}

BUILTIN(ta_proto_sort) {
    UNUSED_ARGS;
    if (!comparefn_ok(ctx, ARG(0))) return JS_EXCEPTION;
    VALIDATE_WRITE("sort");
    Elem *items = sorted_values(ctx, ta, (size_t)len, ARG(0));
    if (!items) return JS_EXCEPTION;
    for (size_t j = 0; j < (size_t)len; j++)  /* the comparator may have shrunk or detached the buffer */
        if (valid_index(ta, (double)j)) store_elem(ta, j, items[j]);
    free(items);
    return this_val;
}

BUILTIN(ta_proto_subarray) {
    UNUSED_ARGS;
    if (!is_ta(this_val)) return js_throw_type_error(ctx, "this is not a typed array.");
    JSTypedArray *ta = as_ta(this_val);
    double len = (double)ta_length(ta), begin, end;
    if (relative(ctx, ARG(0), len, 0, &begin) < 0) return JS_EXCEPTION;
    if (relative(ctx, ARG(1), len, len, &end) < 0) return JS_EXCEPTION;
    double begin_byte = (double)ta->byte_offset + begin * elem_size[ta->type];
    JSValue args[3] = { ta->buffer, js_number(begin_byte), js_number(fmax(end - begin, 0)) };
    uint32_t n = ta->length_tracking && js_is_undefined(ARG(1)) ? 2 : 3;
    return species_create(ctx, ta, n, args, -1, "%TypedArray%.prototype.subarray");
}

BUILTIN(ta_proto_to_reversed) {
    UNUSED_ARGS;
    VALIDATE("toReversed");
    JSValue a = create_same_type(ctx, ta, len, method);
    if (js_is_exception(a)) return a;
    for (size_t k = 0; k < (size_t)len; k++) store_elem(as_ta(a), k, load_elem(ta, (size_t)len - 1 - k));
    return a;
}

BUILTIN(ta_proto_to_sorted) {
    UNUSED_ARGS;
    if (!comparefn_ok(ctx, ARG(0))) return JS_EXCEPTION;
    VALIDATE("toSorted");
    JSValue a = create_same_type(ctx, ta, len, method);
    if (js_is_exception(a)) return a;
    Elem *items = sorted_values(ctx, ta, (size_t)len, ARG(0));
    if (!items) return JS_EXCEPTION;
    for (size_t j = 0; j < (size_t)len; j++) store_elem(as_ta(a), j, items[j]);
    free(items);
    return a;
}

BUILTIN(ta_proto_with) {
    UNUSED_ARGS;
    VALIDATE("with");
    double rel;
    Elem value;
    if (js_to_integer_or_infinity(ctx, &rel, ARG(0)) < 0) return JS_EXCEPTION;
    double actual = rel >= 0 ? rel : len + rel;
    if (to_elem(ctx, ta->type, ARG(1), &value) < 0) return JS_EXCEPTION;
    if (!valid_index(ta, actual)) return js_throw_range_error(ctx, "Invalid typed array index");
    JSValue a = create_same_type(ctx, ta, len, method);
    if (js_is_exception(a)) return a;
    for (double k = 0; k < len; k++) {
        JSValue v = k == actual ? elem_value(ctx, ta->type, value) : get_element(ctx, ta, k);
        if (js_set_value(ctx, a, js_index_key_of(ctx, k), v, true) < 0) return JS_EXCEPTION;
    }
    return a;
}

/* ---- For other components (js_buffer.h) ------------------------------------------------------ */

bool js_buffer_source_bytes(JSValue v, uint8_t **data, size_t *length) {
    *data = NULL;
    *length = 0;
    if (js_is_array_buffer(v)) {
        JSArrayBuffer *b = js_as_array_buffer(v);
        *data = b->data;
        *length = b->byte_length;
        return true;
    }
    if (is_ta(v)) {
        JSTypedArray *ta = as_ta(v);
        if (!out_of_bounds(ta)) {
            *data = buffer_of(ta)->data + ta->byte_offset;
            *length = ta_length(ta) * elem_size[ta->type];
        }
        return true;
    }
    if (js_is_object(v) && strcmp(js_as_object(v)->shape->cls->name, "DataView") == 0) {
        JSDataView *dv = (JSDataView *)js_as_object(v);
        JSArrayBuffer *b = js_as_array_buffer(dv->buffer);
        if (js_buffer_is_detached(b) || dv->byte_offset > b->byte_length) return true;
        size_t n = dv->length_tracking ? b->byte_length - dv->byte_offset : dv->byte_length;
        if (dv->byte_offset + n > b->byte_length) return true;
        *data = b->data + dv->byte_offset;
        *length = n;
        return true;
    }
    return false;
}

bool js_is_uint8_array(JSValue v) { return is_ta(v) && as_ta(v)->type == JS_TA_UINT8; }

int js_typed_array_type(JSValue v) { return is_ta(v) ? as_ta(v)->type : -1; }

JSValue js_new_uint8_array(JSContext *ctx, size_t length) {
    JSValue c = ctx->intrinsics[JS_INTRINSIC_TYPED_ARRAY_CTORS + JS_TA_UINT8];
    JSValue arg = js_number((double)length);
    return js_construct(ctx, c, 1, &arg, c, "Uint8Array");
}

/* ---- Hooks for the core ---------------------------------------------------------------------- */

static bool hook_is_typed_array(JSValue v) { return is_ta(v); }

static double hook_typed_array_length(JSValue v) {
    if (!is_ta(v)) return -2;
    return out_of_bounds(as_ta(v)) ? -1 : (double)ta_length(as_ta(v));
}

/* An element the core may read or write inline: of a typed array, a valid index (§10.4.5.15
 * IsValidIntegerIndex), a Number element. Its own data property: no prototype, no code runs. */
static bool inline_elem(JSValue v, int32_t i) {
    if (!is_ta(v) || i < 0) return false;
    const JSTypedArray *ta = as_ta(v);
    return !is_bigint_type(ta->type) && (size_t)i < ta_length(ta);
}

static bool hook_typed_array_get(JSValue v, int32_t i, JSValue *out) {
    if (!inline_elem(v, i)) return false;
    *out = js_number(load_number(as_ta(v), (size_t)i));
    return true;
}

static bool hook_typed_array_set(JSValue v, int32_t i, double d) {
    if (!inline_elem(v, i) || immutable(as_ta(v))) return false;
    store(as_ta(v), (size_t)i, d);
    return true;
}

static bool hook_view_bytes(JSValue v, uint8_t **data, size_t *length) {
    return !js_is_array_buffer(v) && js_buffer_source_bytes(v, data, length);
}

/* ---- Realm ----------------------------------------------------------------------------------- */

static const JSBuiltin typed_array_statics[] = {
    JS_BUILTIN_FN("of", typed_array_of, 0),
    JS_BUILTIN_FN("from", typed_array_from, 1),
    JS_BUILTIN_SYMBOL_GETTER(species, get_species),
};

static const JSBuiltin typed_array_proto[] = {  /* V8's order */
    JS_BUILTIN_GETTER("buffer", ta_proto_buffer),
    JS_BUILTIN_GETTER("byteLength", ta_proto_byte_length),
    JS_BUILTIN_GETTER("byteOffset", ta_proto_byte_offset),
    JS_BUILTIN_GETTER("length", ta_proto_length),
    JS_BUILTIN_FN("entries", ta_proto_entries, 0),
    JS_BUILTIN_FN("keys", ta_proto_keys, 0),
    JS_BUILTIN_FN("values", ta_proto_values, 0),
    JS_BUILTIN_FN("at", ta_proto_at, 1),
    JS_BUILTIN_FN("copyWithin", ta_proto_copy_within, 2),
    JS_BUILTIN_FN("every", ta_proto_every, 1),
    JS_BUILTIN_FN("fill", ta_proto_fill, 1),
    JS_BUILTIN_FN("filter", ta_proto_filter, 1),
    JS_BUILTIN_FN("find", ta_proto_find, 1),
    JS_BUILTIN_FN("findIndex", ta_proto_find_index, 1),
    JS_BUILTIN_FN("findLast", ta_proto_find_last, 1),
    JS_BUILTIN_FN("findLastIndex", ta_proto_find_last_index, 1),
    JS_BUILTIN_FN("forEach", ta_proto_for_each, 1),
    JS_BUILTIN_FN("includes", ta_proto_includes, 1),
    JS_BUILTIN_FN("indexOf", ta_proto_index_of, 1),
    JS_BUILTIN_FN("join", ta_proto_join, 1),
    JS_BUILTIN_FN("lastIndexOf", ta_proto_last_index_of, 1),
    JS_BUILTIN_FN("map", ta_proto_map, 1),
    JS_BUILTIN_FN("reverse", ta_proto_reverse, 0),
    JS_BUILTIN_FN("reduce", ta_proto_reduce, 1),
    JS_BUILTIN_FN("reduceRight", ta_proto_reduce_right, 1),
    JS_BUILTIN_FN("set", ta_proto_set, 1),
    JS_BUILTIN_FN("slice", ta_proto_slice, 2),
    JS_BUILTIN_FN("some", ta_proto_some, 1),
    JS_BUILTIN_FN("sort", ta_proto_sort, 1),
    JS_BUILTIN_FN("subarray", ta_proto_subarray, 2),
    JS_BUILTIN_FN("toReversed", ta_proto_to_reversed, 0),
    JS_BUILTIN_FN("toSorted", ta_proto_to_sorted, 1),
    JS_BUILTIN_FN("with", ta_proto_with, 2),
    JS_BUILTIN_FN("toLocaleString", ta_proto_to_locale_string, 0),
    /* toString: Array.prototype.toString itself, defined below */
};

static const JSNativeFn constructors[JS_TYPED_ARRAY_TYPES] = {
    int8_array_ctor, uint8_array_ctor, uint8_clamped_array_ctor, int16_array_ctor, uint16_array_ctor,
    int32_array_ctor, uint32_array_ctor, bigint64_array_ctor, biguint64_array_ctor, float16_array_ctor, float32_array_ctor,
    float64_array_ctor,
};

static void install_typedarray(JSContext *ctx, JSObject *global) {
    JSValue *in = ctx->intrinsics;
    /* %TypedArray% and its prototype */
    JSValue proto = js_new_object_proto(ctx, in[JS_INTRINSIC_OBJECT_PROTOTYPE], 8);
    in[JS_INTRINSIC_TYPED_ARRAY_PROTOTYPE] = proto;
    JSValue abstract = js_new_native(ctx, typed_array_ctor, js_atom_from_cstr(ctx, "TypedArray"), 0, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    in[JS_INTRINSIC_TYPED_ARRAY] = abstract;
    js_define_data(ctx, js_as_object(abstract), JS_ATOM(prototype), proto, 0);
    js_define_builtins(ctx, js_as_object(abstract), typed_array_statics, JS_COUNTOF(typed_array_statics));
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), abstract, JS_BUILTIN_METHOD_ATTRS);
    js_define_builtins(ctx, js_as_object(proto), typed_array_proto, JS_COUNTOF(typed_array_proto));
    JSValue to_string = js_get_value(ctx, in[JS_INTRINSIC_ARRAY_PROTOTYPE], JS_ATOM(toString));
    if (!js_is_function(to_string))
        to_string = js_new_native(ctx, js_core_array_proto_to_string, JS_ATOM(toString), 0, JS_FN_STRICT);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(toString), to_string, JS_BUILTIN_METHOD_ATTRS);
    static const JSBuiltin tag[] = { { NULL, &js_symbol_toStringTag, JS_BUILTIN_KIND_ACCESSOR, JS_PROP_CONFIGURABLE, 0, ta_proto_to_string_tag, NULL, 0, NULL } };
    js_define_builtins(ctx, js_as_object(proto), tag, 1);
    JSValue values = js_get_value(ctx, proto, js_atom_from_cstr(ctx, "values"));
    js_define_data(ctx, js_as_object(proto), JS_SYMBOL(iterator), values, JS_BUILTIN_METHOD_ATTRS);

    /* one constructor per element type */
    for (int t = 0; t < JS_TYPED_ARRAY_TYPES; t++) {
        if (is_bigint_type(t) && !ctx->rt->bigint) continue;  /* they come with the bigint component, installed first */
        JSValue p = js_new_object_proto(ctx, proto, 2);
        in[JS_INTRINSIC_TYPED_ARRAY_PROTOS + t] = p;
        JSValue key = js_atom_from_cstr(ctx, type_names[t]);
        JSValue c = js_new_native(ctx, constructors[t], key, 3, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
        int r = js_set_prototype_of(ctx, js_as_object(c), abstract);
        (void)r;
        in[JS_INTRINSIC_TYPED_ARRAY_CTORS + t] = c;
        JSValue bytes = js_int32(elem_size[t]);
        js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), p, 0);
        js_define_data(ctx, js_as_object(c), js_atom_from_cstr(ctx, "BYTES_PER_ELEMENT"), bytes, 0);
        js_define_data(ctx, js_as_object(p), JS_ATOM(constructor), c, JS_BUILTIN_METHOD_ATTRS);
        js_define_data(ctx, js_as_object(p), js_atom_from_cstr(ctx, "BYTES_PER_ELEMENT"), bytes, 0);
        js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
    }
    ctx->rt->is_typed_array = hook_is_typed_array;
    ctx->rt->typed_array_length = hook_typed_array_length;
    ctx->rt->view_bytes = hook_view_bytes;
    ctx->rt->typed_array_get = hook_typed_array_get;
    ctx->rt->typed_array_class = &ta_class;
    ctx->rt->typed_array_set = hook_typed_array_set;
}

const JSComponent js_component_typedarray = { "typedarray", install_typedarray };
