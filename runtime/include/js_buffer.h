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

#include "js_object.h"

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

#endif /* JS_BUFFER_H */
