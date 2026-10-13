/* Buffer, the buffer component: Node's global Buffer, in C. As in Node, a
 * Buffer is a Uint8Array whose prototype is Buffer.prototype (which inherits from
 * Uint8Array.prototype), so typed array methods work on it and make Buffers (Buffer is their
 * species constructor). Encodings: utf8 (WHATWG decoding, U+FFFD for each maximal invalid
 * subpart), utf16le/ucs2, latin1/binary, ascii, base64, base64url and hex, with Node's lenient
 * decoding (hex stops at the first invalid pair; base64 skips characters outside both alphabets
 * and stops at '='). The API is Node's, with its errors and its inspection (`<Buffer 68 69>`). */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_bigint.h"
#include "js_buffer.h"
#include "js_console.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

/* A failure's -1, after the call that threw (the throwers' results must be used). */
static int fail(JSValue thrown) {
    (void)thrown;
    return -1;
}

static JSValue throw_bounds(JSContext *ctx);

/* ---- Encodings ------------------------------------------------------------------------------ */

typedef enum { ENC_UTF8, ENC_UCS2, ENC_LATIN1, ENC_ASCII, ENC_BASE64, ENC_BASE64URL, ENC_HEX, ENC_INVALID } Encoding;

static const struct { const char *name; Encoding enc; } ENCODINGS[] = {
    { "utf8", ENC_UTF8 }, { "utf-8", ENC_UTF8 }, { "ucs2", ENC_UCS2 }, { "ucs-2", ENC_UCS2 },
    { "utf16le", ENC_UCS2 }, { "utf-16le", ENC_UCS2 }, { "latin1", ENC_LATIN1 }, { "binary", ENC_LATIN1 },
    { "ascii", ENC_ASCII }, { "base64", ENC_BASE64 }, { "base64url", ENC_BASE64URL }, { "hex", ENC_HEX },
};

/* An encoding name, ASCII case-insensitively; ENC_INVALID for a non-string or an unknown name. */
static Encoding encoding_of(JSContext *ctx, JSValue v) {
    if (!js_is_string(v)) return ENC_INVALID;
    JSStrView s = js_string_view(ctx, v);
    for (size_t i = 0; i < JS_COUNTOF(ENCODINGS); i++) {
        size_t n = strlen(ENCODINGS[i].name);
        if (s.length != n) continue;
        size_t k = 0;
        for (; k < n; k++) {
            uint32_t c = js_view_at(s, (uint32_t)k);
            if (c >= 'A' && c <= 'Z') c += 32;
            if (c != (uint8_t)ENCODINGS[i].name[k]) break;
        }
        if (k == n) return ENCODINGS[i].enc;
    }
    return ENC_INVALID;
}

static JSValue throw_unknown_encoding(JSContext *ctx, JSValue v) {
    char s[128] = "";
    JSValue str = js_is_symbol(v) ? JS_UNDEFINED : js_to_string(ctx, v);
    if (js_is_exception(str)) return str;
    if (js_is_string(str)) s[js_view_to_utf8(js_string_view(ctx, str), s, sizeof s - 1)] = '\0';
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_UNKNOWN_ENCODING", "Unknown encoding: %s", s);
}

/* An optional encoding argument: utf8 when undefined (or null). 0, or -1 with ERR_UNKNOWN_ENCODING. */
static int encoding_arg(JSContext *ctx, JSValue v, Encoding *out) {
    if (js_is_nullish(v)) {
        *out = ENC_UTF8;
        return 0;
    }
    *out = encoding_of(ctx, v);
    if (*out != ENC_INVALID) return 0;
    return fail(throw_unknown_encoding(ctx, v));
}

typedef struct {  /* bytes being built (malloc'd) */
    uint8_t *p;
    size_t   n, cap;
} Bytes;

static void bytes_reserve(Bytes *b, size_t more) {
    if (b->n + more <= b->cap) return;
    size_t cap = b->cap ? b->cap : 64;
    while (cap < b->n + more) cap *= 2;
    uint8_t *p = realloc(b->p, cap);
    if (!p) js_fatal("out of memory encoding a Buffer");
    b->p = p;
    b->cap = cap;
}

static void bytes_push(Bytes *b, uint8_t c) {
    bytes_reserve(b, 1);
    b->p[b->n++] = c;
}

static int hex_digit(uint32_t c) {
    if (c >= '0' && c <= '9') return (int)(c - '0');
    if ((c | 32) >= 'a' && (c | 32) <= 'f') return (int)((c | 32) - 'a' + 10);
    return -1;
}

static int base64_value(uint32_t c) {
    if (c >= 'A' && c <= 'Z') return (int)(c - 'A');
    if (c >= 'a' && c <= 'z') return (int)(c - 'a' + 26);
    if (c >= '0' && c <= '9') return (int)(c - '0' + 52);
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
}

/* A string's bytes in an encoding (Node's StringBytes::Write). */
static void encode_string(JSContext *ctx, JSValue s, Encoding enc, Bytes *out) {
    JSStrView v = js_string_view(ctx, s);
    switch (enc) {
    case ENC_UTF8: {
        size_t n = js_view_to_utf8(v, NULL, 0);
        bytes_reserve(out, n);
        out->n += js_view_to_utf8(v, (char *)out->p + out->n, n);
        break;
    }
    case ENC_UCS2:
        bytes_reserve(out, (size_t)v.length * 2);
        for (uint32_t i = 0; i < v.length; i++) {
            uint32_t c = js_view_at(v, i);
            out->p[out->n++] = (uint8_t)c;
            out->p[out->n++] = (uint8_t)(c >> 8);
        }
        break;
    case ENC_LATIN1:
    case ENC_ASCII:
        bytes_reserve(out, v.length);
        for (uint32_t i = 0; i < v.length; i++) out->p[out->n++] = (uint8_t)js_view_at(v, i);
        break;
    case ENC_HEX:
        bytes_reserve(out, v.length / 2);
        for (uint32_t i = 0; i + 1 < v.length; i += 2) {
            int hi = hex_digit(js_view_at(v, i)), lo = hex_digit(js_view_at(v, i + 1));
            if (hi < 0 || lo < 0) break;
            out->p[out->n++] = (uint8_t)(hi << 4 | lo);
        }
        break;
    case ENC_BASE64:
    case ENC_BASE64URL: {
        bytes_reserve(out, (size_t)v.length * 3 / 4 + 3);
        uint32_t acc = 0;
        int bits = 0;
        for (uint32_t i = 0; i < v.length; i++) {
            uint32_t c = js_view_at(v, i);
            if (c == '=') break;
            int d = base64_value(c);
            if (d < 0) continue;
            acc = acc << 6 | (uint32_t)d;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out->p[out->n++] = (uint8_t)(acc >> bits);
            }
        }
        break;
    }
    case ENC_INVALID:
        break;
    }
}

/* Buffer.byteLength's count, without encoding: base64's is Node's estimate from the length. */
static size_t encoded_length(JSContext *ctx, JSValue s, Encoding enc) {
    JSStrView v = js_string_view(ctx, s);
    switch (enc) {
    case ENC_UTF8: return js_view_to_utf8(v, NULL, 0);
    case ENC_UCS2: return (size_t)v.length * 2;
    case ENC_HEX: return v.length >> 1;
    case ENC_BASE64:
    case ENC_BASE64URL: {
        size_t n = v.length;
        if (n && js_view_at(v, (uint32_t)n - 1) == '=') n--;
        if (n && js_view_at(v, (uint32_t)n - 1) == '=') n--;
        return n * 3 >> 2;
    }
    default: return v.length;
    }
}

static const char HEX[] = "0123456789abcdef";
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static const char B64URL[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/* Bytes to a string in an encoding (Node's StringBytes::Encode). */
static JSValue decode_bytes(JSContext *ctx, const uint8_t *p, size_t n, Encoding enc) {
    if (n > (size_t)JS_STRING_MAX_LENGTH) return js_throw_node_error(ctx, JS_ERROR, "ERR_STRING_TOO_LONG", "Cannot create a string longer than 0x1fffffe8 characters");
    switch (enc) {
    case ENC_UTF8: return js_decode_utf8_bytes(ctx, p, n);
    case ENC_LATIN1: return js_new_string_latin1(ctx, p, (uint32_t)n);
    case ENC_ASCII: {
        uint8_t *s = malloc(n ? n : 1);
        if (!s) js_fatal("out of memory decoding a Buffer");
        for (size_t i = 0; i < n; i++) s[i] = p[i] & 0x7F;
        JSValue r = js_new_string_latin1(ctx, s, (uint32_t)n);
        free(s);
        return r;
    }
    case ENC_UCS2: {
        size_t units = n / 2;
        uint16_t *s = malloc((units ? units : 1) * sizeof *s);
        if (!s) js_fatal("out of memory decoding a Buffer");
        for (size_t i = 0; i < units; i++) s[i] = (uint16_t)(p[2 * i] | p[2 * i + 1] << 8);
        JSValue r = js_new_string_utf16(ctx, s, (uint32_t)units);
        free(s);
        return r;
    }
    case ENC_HEX: {
        uint8_t *s = malloc(n * 2 + 1);
        if (!s) js_fatal("out of memory decoding a Buffer");
        for (size_t i = 0; i < n; i++) s[2 * i] = (uint8_t)HEX[p[i] >> 4], s[2 * i + 1] = (uint8_t)HEX[p[i] & 15];
        JSValue r = js_new_string_latin1(ctx, s, (uint32_t)(n * 2));
        free(s);
        return r;
    }
    case ENC_BASE64:
    case ENC_BASE64URL: {
        const char *alphabet = enc == ENC_BASE64 ? B64 : B64URL;
        uint8_t *s = malloc((n + 2) / 3 * 4 + 1);
        if (!s) js_fatal("out of memory decoding a Buffer");
        size_t o = 0, i = 0;
        for (; i + 2 < n; i += 3) {
            uint32_t v = (uint32_t)p[i] << 16 | (uint32_t)p[i + 1] << 8 | p[i + 2];
            s[o++] = (uint8_t)alphabet[v >> 18], s[o++] = (uint8_t)alphabet[(v >> 12) & 63];
            s[o++] = (uint8_t)alphabet[(v >> 6) & 63], s[o++] = (uint8_t)alphabet[v & 63];
        }
        if (i < n) {
            uint32_t v = (uint32_t)p[i] << 16 | (i + 1 < n ? (uint32_t)p[i + 1] << 8 : 0);
            s[o++] = (uint8_t)alphabet[v >> 18], s[o++] = (uint8_t)alphabet[(v >> 12) & 63];
            if (i + 1 < n) s[o++] = (uint8_t)alphabet[(v >> 6) & 63];
            else if (enc == ENC_BASE64) s[o++] = '=';
            if (enc == ENC_BASE64) s[o++] = '=';
        }
        JSValue r = js_new_string_latin1(ctx, s, (uint32_t)o);
        free(s);
        return r;
    }
    case ENC_INVALID: break;
    }
    return js_empty_string();
}

/* ---- Buffers -------------------------------------------------------------------------------- */

static JSValue buffer_ctor_fn(JSContext *ctx) { return ctx->intrinsics[JS_INTRINSIC_BUFFER]; }
static JSValue uint8_array_ctor(JSContext *ctx) { return ctx->intrinsics[JS_INTRINSIC_TYPED_ARRAY_CTORS + JS_TA_UINT8]; }

/* A new zeroed Buffer of n bytes. */
static JSValue new_buffer(JSContext *ctx, size_t n) {
    JSValue arg = js_number((double)n);
    return js_construct(ctx, uint8_array_ctor(ctx), 1, &arg, buffer_ctor_fn(ctx), "Buffer");
}

/* A Buffer over an ArrayBuffer's bytes (shared). */
static JSValue new_view(JSContext *ctx, JSValue array_buffer, size_t offset, size_t length) {
    JSValue args[3] = { array_buffer, js_number((double)offset), js_number((double)length) };
    return js_construct(ctx, uint8_array_ctor(ctx), 3, args, buffer_ctor_fn(ctx), "Buffer");
}

/* A new Buffer holding a copy of the bytes. */
static JSValue buffer_of_bytes(JSContext *ctx, const uint8_t *p, size_t n) {
    JSValue b = new_buffer(ctx, n);
    if (js_is_exception(b)) return b;
    uint8_t *data;
    size_t len;
    js_buffer_source_bytes(b, &data, &len);
    if (n) memcpy(data, p, n);
    return b;
}

static bool is_typed_array(JSValue v) {
    return js_is_object(v) && strcmp(js_as_object(v)->shape->cls->name, "TypedArray") == 0;
}

/* A Uint8Array (a Buffer included): its bytes. */
static bool u8_bytes(JSValue v, uint8_t **p, size_t *n) {
    if (!js_is_uint8_array(v)) return false;
    js_buffer_source_bytes(v, p, n);
    return true;
}

static JSTypedArray *as_ta(JSValue v) { return (JSTypedArray *)js_as_object(v); }

static JSValue throw_not_u8(JSContext *ctx, const char *name, JSValue v) {
    return js_throw_invalid_arg_type(ctx, name, "an instance of Buffer or Uint8Array", v);
}

/* The receiver as a Uint8Array: Node's methods work on any. */
#define THIS_BYTES()                                                     \
    uint8_t *data;                                                       \
    size_t len;                                                          \
    if (!u8_bytes(this_val, &data, &len))                                \
        return js_throw_type_error(ctx, "argument must be a buffer")

static JSValue buffer_from_string(JSContext *ctx, JSValue s, JSValue encoding) {
    Encoding enc;
    if (encoding_arg(ctx, encoding, &enc) < 0) return JS_EXCEPTION;
    Bytes b = { 0 };
    encode_string(ctx, s, enc, &b);
    JSValue r = buffer_of_bytes(ctx, b.p, b.n);
    free(b.p);
    return r;
}

/* An array-like's elements, each ToNumber'd and taken modulo 256 (Uint8Array's conversion). */
static JSValue buffer_from_array_like(JSContext *ctx, JSValue o) {
    JSValue lv = js_get_value(ctx, o, JS_ATOM(length));
    if (js_is_exception(lv)) return lv;
    double n;
    if (js_to_number(ctx, &n, lv) < 0) return JS_EXCEPTION;
    n = isnan(n) || n < 0 ? 0 : floor(n);
    JSValue b = new_buffer(ctx, (size_t)n);
    if (js_is_exception(b)) return b;
    for (size_t i = 0; i < (size_t)n; i++) {
        JSValue v = js_get_elem(ctx, o, js_number((double)i));
        if (js_is_exception(v)) return v;
        double d;
        if (js_to_number(ctx, &d, v) < 0) return JS_EXCEPTION;
        uint8_t *data;
        size_t len;
        js_buffer_source_bytes(b, &data, &len);
        if (i < len) data[i] = (uint8_t)(isfinite(d) ? (int64_t)fmod(trunc(d), 256.0) : 0);
    }
    return b;
}

static JSValue from_value(JSContext *ctx, JSValue value, JSValue enc_or_offset, JSValue length);

static JSValue throw_from_type(JSContext *ctx, JSValue v) {
    char received[256];
    js_node_received(ctx, v, received, sizeof received);
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE",
        "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.%s", received);
}

/* Buffer.from(arrayBuffer, byteOffset, length): a view, as Node checks it. */
static JSValue from_array_buffer(JSContext *ctx, JSValue ab, JSValue offset_arg, JSValue length_arg) {
    size_t max = js_as_array_buffer(ab)->byte_length;
    double offset = 0;
    if (!js_is_undefined(offset_arg)) {
        if (js_to_number(ctx, &offset, offset_arg) < 0) return JS_EXCEPTION;
        offset = isnan(offset) ? 0 : trunc(offset);
        if (offset < 0 || offset > (double)max)
            return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_BUFFER_OUT_OF_BOUNDS", "\"offset\" is outside of buffer bounds");
    }
    double length = (double)max - offset;
    if (!js_is_undefined(length_arg)) {
        if (js_to_number(ctx, &length, length_arg) < 0) return JS_EXCEPTION;
        length = isnan(length) || length < 0 ? 0 : trunc(length);
        if (length > (double)max - offset)
            return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_BUFFER_OUT_OF_BOUNDS", "\"length\" is outside of buffer bounds");
    }
    return new_view(ctx, ab, (size_t)offset, (size_t)length);
}

static JSValue from_value(JSContext *ctx, JSValue value, JSValue enc_or_offset, JSValue length) {
    if (js_is_string(value)) return buffer_from_string(ctx, value, enc_or_offset);
    if (!js_is_object(value)) return throw_from_type(ctx, value);
    if (js_is_array_buffer(value) || strcmp(js_as_object(value)->shape->cls->name, "SharedArrayBuffer") == 0)
        return from_array_buffer(ctx, value, enc_or_offset, length);
    uint8_t *p;
    size_t n;
    if (u8_bytes(value, &p, &n)) return buffer_of_bytes(ctx, p, n);
    if (is_typed_array(value)) return buffer_from_array_like(ctx, value);
    /* an object whose valueOf gives something else: that (Node's `new String("x")`, say) */
    JSValue value_of = js_get_value(ctx, value, JS_ATOM(valueOf));
    if (js_is_exception(value_of)) return value_of;
    if (js_is_callable(value_of)) {
        JSValue prim = js_call(ctx, value_of, value, 0, NULL);
        if (js_is_exception(prim)) return prim;
        if (!js_is_nullish(prim) && !js_strict_equals(ctx, prim, value)) return from_value(ctx, prim, enc_or_offset, length);
    }
    JSValue lv = js_get_value(ctx, value, JS_ATOM(length));
    if (js_is_exception(lv)) return lv;
    if (!js_is_undefined(lv)) return buffer_from_array_like(ctx, value);
    /* { type: 'Buffer', data: [...] }, what toJSON makes */
    JSValue type = js_get_value(ctx, value, js_atom_from_cstr(ctx, "type"));
    if (js_is_exception(type)) return type;
    if (js_is_string(type) && js_string_equals(ctx, type, js_new_string_cstr(ctx, "Buffer"))) {
        JSValue data = js_get_value(ctx, value, js_atom_from_cstr(ctx, "data"));
        if (js_is_exception(data)) return data;
        if (js_is_array(data)) return buffer_from_array_like(ctx, data);
    }
    JSValue prim_key = JS_SYMBOL(toPrimitive);
    JSValue to_prim = js_get_value(ctx, value, prim_key);
    if (js_is_exception(to_prim)) return to_prim;
    if (js_is_callable(to_prim)) {
        JSValue hint = js_new_string_cstr(ctx, "string");
        JSValue prim = js_call(ctx, to_prim, value, 1, &hint);
        if (js_is_exception(prim)) return prim;
        if (js_is_string(prim)) return buffer_from_string(ctx, prim, enc_or_offset);
    }
    return throw_from_type(ctx, value);
}

/* ---- Statics -------------------------------------------------------------------------------- */

/* Buffer(arg, encodingOrOffset, length), with or without new (deprecated in Node, still works) */
BUILTIN(buffer_ctor) {
    (void)callee, (void)this_val, (void)new_target;
    if (js_is_number(ARG(0))) {
        double n = js_as_number(ARG(0));
        if (!(n >= 0 && n <= JS_MAX_SAFE_INTEGER)) {
            char received[64];
            js_describe_value(ctx, ARG(0), received, sizeof received);
            return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE",
                                       "The value of \"size\" is out of range. It must be >= 0 && <= 9007199254740991. Received %s", received);
        }
        return new_buffer(ctx, (size_t)n);
    }
    return from_value(ctx, ARG(0), ARG(1), ARG(2));
}

BUILTIN(buffer_from) {
    UNUSED_ARGS;
    return from_value(ctx, ARG(0), ARG(1), ARG(2));
}

/* Node's size check for alloc and allocUnsafe. 0, or -1. */
static int size_arg(JSContext *ctx, JSValue v, size_t *out) {
    if (!js_is_number(v)) return fail(js_throw_invalid_arg_type(ctx, "size", "of type number", v));
    double n = js_as_number(v);
    if (!(n >= 0 && n <= JS_MAX_SAFE_INTEGER)) {
        char received[64];
        js_describe_value(ctx, v, received, sizeof received);
        return fail(js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE",
                                        "The value of \"size\" is out of range. It must be >= 0 && <= 9007199254740991. Received %s", received));
    }
    *out = (size_t)n;
    return 0;
}

static int fill_bytes(JSContext *ctx, uint8_t *data, size_t start, size_t end, JSValue value, JSValue encoding);

BUILTIN(buffer_alloc) {
    UNUSED_ARGS;
    size_t n;
    if (size_arg(ctx, ARG(0), &n) < 0) return JS_EXCEPTION;
    JSValue b = new_buffer(ctx, n);
    if (js_is_exception(b) || js_is_undefined(ARG(1)) || (js_is_number(ARG(1)) && js_as_number(ARG(1)) == 0)) return b;
    uint8_t *data;
    size_t len;
    js_buffer_source_bytes(b, &data, &len);
    return fill_bytes(ctx, data, 0, len, ARG(1), ARG(2)) < 0 ? JS_EXCEPTION : b;
}

BUILTIN(buffer_alloc_unsafe) {
    UNUSED_ARGS;
    size_t n;
    if (size_arg(ctx, ARG(0), &n) < 0) return JS_EXCEPTION;
    return new_buffer(ctx, n);
}

BUILTIN(buffer_is_buffer) {
    UNUSED_ARGS;
    if (!js_is_object(ARG(0))) return JS_FALSE;
    JSValue r = js_instanceof(ctx, ARG(0), buffer_ctor_fn(ctx));
    return js_is_exception(r) ? r : r;
}

BUILTIN(buffer_is_encoding) {
    UNUSED_ARGS;
    return js_bool(encoding_of(ctx, ARG(0)) != ENC_INVALID);
}

BUILTIN(buffer_byte_length) {
    UNUSED_ARGS;
    JSValue s = ARG(0);
    if (!js_is_string(s)) {
        uint8_t *p;
        size_t n;
        if (js_buffer_source_bytes(s, &p, &n) || (js_is_object(s) && strcmp(js_as_object(s)->shape->cls->name, "SharedArrayBuffer") == 0))
            return js_number((double)n);
        return js_throw_invalid_arg_type(ctx, "string", "of type string or an instance of Buffer or ArrayBuffer", s);
    }
    Encoding enc = js_is_nullish(ARG(1)) ? ENC_UTF8 : encoding_of(ctx, ARG(1));
    if (enc == ENC_INVALID) enc = ENC_UTF8;  /* Node: an unknown encoding counts as utf8 */
    return js_number((double)encoded_length(ctx, s, enc));
}

static int compare_bytes(const uint8_t *a, size_t an, const uint8_t *b, size_t bn) {
    size_t n = an < bn ? an : bn;
    int c = n ? memcmp(a, b, n) : 0;
    if (c) return c < 0 ? -1 : 1;
    return an < bn ? -1 : an > bn ? 1 : 0;
}

BUILTIN(buffer_compare_static) {
    UNUSED_ARGS;
    uint8_t *a, *b;
    size_t an, bn;
    if (!u8_bytes(ARG(0), &a, &an)) return throw_not_u8(ctx, "buf1", ARG(0));
    if (!u8_bytes(ARG(1), &b, &bn)) return throw_not_u8(ctx, "buf2", ARG(1));
    return js_int32(compare_bytes(a, an, b, bn));
}

BUILTIN(buffer_concat) {
    UNUSED_ARGS;
    JSValue list = ARG(0);
    if (!js_is_array(list)) return js_throw_invalid_arg_type(ctx, "list", "an instance of Array", list);
    uint32_t count = js_array_length(js_as_object(list));
    double total = 0;
    for (uint32_t i = 0; i < count; i++) {
        JSValue item = js_get_elem(ctx, list, js_int32((int32_t)i));
        if (js_is_exception(item)) return item;
        uint8_t *p;
        size_t n;
        if (!u8_bytes(item, &p, &n)) {
            char name[32];
            snprintf(name, sizeof name, "list[%u]", i);
            return throw_not_u8(ctx, name, item);
        }
        total += (double)n;
    }
    if (!js_is_undefined(ARG(1))) {
        if (!js_is_number(ARG(1))) return js_throw_invalid_arg_type(ctx, "length", "of type number", ARG(1));
        double t = js_as_number(ARG(1));
        total = isnan(t) || t < 0 ? 0 : trunc(t);
    }
    JSValue result = new_buffer(ctx, (size_t)total);
    if (js_is_exception(result)) return result;
    uint8_t *out;
    size_t cap, at = 0;
    js_buffer_source_bytes(result, &out, &cap);
    for (uint32_t i = 0; i < count && at < cap; i++) {
        JSValue item = js_get_elem(ctx, list, js_int32((int32_t)i));
        if (js_is_exception(item)) return item;
        uint8_t *p;
        size_t n;
        if (!u8_bytes(item, &p, &n)) continue;
        if (n > cap - at) n = cap - at;
        if (n) memcpy(out + at, p, n);
        at += n;
    }
    return result;
}

BUILTIN(buffer_of) {
    UNUSED_ARGS;
    JSValue b = new_buffer(ctx, argc);
    if (js_is_exception(b)) return b;
    for (uint32_t i = 0; i < argc; i++) {
        double d;
        if (js_to_number(ctx, &d, argv[i]) < 0) return JS_EXCEPTION;
        uint8_t *data;
        size_t len;
        js_buffer_source_bytes(b, &data, &len);
        data[i] = (uint8_t)(isfinite(d) ? (int64_t)fmod(trunc(d), 256.0) : 0);
    }
    return b;
}

/* Buffer.copyBytesFrom(view, offset, length): a copy of a typed array's elements' bytes */
BUILTIN(buffer_copy_bytes_from) {
    UNUSED_ARGS;
    JSValue view = ARG(0);
    if (!is_typed_array(view)) return js_throw_invalid_arg_type(ctx, "view", "an instance of TypedArray", view);
    uint8_t *p;
    size_t n;
    js_buffer_source_bytes(view, &p, &n);
    size_t count = as_ta(view)->length, size = count ? n / count : 1;
    double offset = 0, length = (double)count;
    if (!js_is_undefined(ARG(1)) && js_to_number(ctx, &offset, ARG(1)) < 0) return JS_EXCEPTION;
    if (!js_is_undefined(ARG(2)) && js_to_number(ctx, &length, ARG(2)) < 0) return JS_EXCEPTION;
    offset = isnan(offset) || offset < 0 ? 0 : trunc(offset);
    if (offset >= (double)count) return new_buffer(ctx, 0);
    length = isnan(length) || length < 0 ? 0 : trunc(length);
    if (length > (double)count - offset) length = (double)count - offset;
    return buffer_of_bytes(ctx, p + (size_t)offset * size, (size_t)length * size);
}

/* ---- Prototype ------------------------------------------------------------------------------ */

/* A relative position like Node's slice start/end (negative counts from the end), clamped to [0, len]. */
static int position(JSContext *ctx, JSValue v, size_t len, size_t dflt, size_t *out) {
    if (js_is_undefined(v)) {
        *out = dflt;
        return 0;
    }
    double d;
    if (js_to_number(ctx, &d, v) < 0) return -1;
    d = isnan(d) ? 0 : trunc(d);
    if (d < 0) d += (double)len;
    *out = d < 0 ? 0 : d > (double)len ? len : (size_t)d;
    return 0;
}

/* toString(encoding = 'utf8', start = 0, end = length) */
BUILTIN(buffer_to_string) {
    UNUSED_ARGS;
    THIS_BYTES();
    if (argc == 0) return js_decode_utf8_bytes(ctx, data, len);
    double start = 0, end = (double)len;
    if (!js_is_undefined(ARG(1))) {
        if (js_to_number(ctx, &start, ARG(1)) < 0) return JS_EXCEPTION;
        start = isnan(start) || start <= 0 ? 0 : trunc(start);
        if (start >= (double)len) return js_empty_string();
    }
    if (!js_is_undefined(ARG(2))) {
        if (js_to_number(ctx, &end, ARG(2)) < 0) return JS_EXCEPTION;
        end = isnan(end) ? 0 : end > (double)len ? (double)len : trunc(end);
    }
    if (end <= start) return js_empty_string();
    Encoding enc = ENC_UTF8;
    if (!js_is_undefined(ARG(0))) {
        enc = encoding_of(ctx, ARG(0));
        if (enc == ENC_INVALID) return throw_unknown_encoding(ctx, ARG(0));
    }
    u8_bytes(this_val, &data, &len);  /* ToNumber ran user code */
    if ((size_t)end > len) end = (double)len;
    if ((size_t)start >= (size_t)end) return js_empty_string();
    return decode_bytes(ctx, data + (size_t)start, (size_t)end - (size_t)start, enc);
}

/* the encoding-specific slices: buf.utf8Slice(start, end), … */
static JSValue slice_as(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, Encoding enc) {
    THIS_BYTES();
    size_t start, end;
    if (position(ctx, ARG(0), len, 0, &start) < 0 || position(ctx, ARG(1), len, len, &end) < 0) return JS_EXCEPTION;
    u8_bytes(this_val, &data, &len);
    if (end > len) end = len;
    return start >= end ? js_empty_string() : decode_bytes(ctx, data + start, end - start, enc);
}

#define SLICE(fn, enc)                                          \
    BUILTIN(fn) {                                               \
        (void)callee, (void)new_target;                         \
        return slice_as(ctx, this_val, argc, argv, enc);        \
    }
SLICE(buffer_utf8_slice, ENC_UTF8)
SLICE(buffer_ucs2_slice, ENC_UCS2)
SLICE(buffer_latin1_slice, ENC_LATIN1)
SLICE(buffer_ascii_slice, ENC_ASCII)
SLICE(buffer_base64_slice, ENC_BASE64)
SLICE(buffer_base64url_slice, ENC_BASE64URL)
SLICE(buffer_hex_slice, ENC_HEX)

BUILTIN(buffer_equals) {
    UNUSED_ARGS;
    THIS_BYTES();
    uint8_t *p;
    size_t n;
    if (!u8_bytes(ARG(0), &p, &n)) return throw_not_u8(ctx, "otherBuffer", ARG(0));
    return js_bool(n == len && (n == 0 || memcmp(p, data, n) == 0));
}

/* An offset argument of compare and copy: an integer in [0, max], else ERR_OUT_OF_RANGE. */
static int range_arg(JSContext *ctx, JSValue v, const char *name, size_t dflt, size_t max, size_t *out) {
    if (js_is_undefined(v)) {
        *out = dflt;
        return 0;
    }
    if (!js_is_number(v)) return fail(js_throw_invalid_arg_type(ctx, name, "of type number", v));
    double d = js_as_number(v);
    if (!(d >= 0 && d <= (double)max) || d != trunc(d)) {
        char received[64];
        js_describe_value(ctx, v, received, sizeof received);
        JSValue e = d != trunc(d) && isfinite(d)
            ? js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE", "The value of \"%s\" is out of range. It must be an integer. Received %s", name, received)
            : js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE", "The value of \"%s\" is out of range. It must be >= 0 and <= %zu. Received %s", name, max, received);
        return fail(e);
    }
    *out = (size_t)d;
    return 0;
}

/* compare(target, targetStart, targetEnd, sourceStart, sourceEnd) */
BUILTIN(buffer_compare) {
    UNUSED_ARGS;
    THIS_BYTES();
    uint8_t *p;
    size_t n;
    if (!u8_bytes(ARG(0), &p, &n)) return throw_not_u8(ctx, "target", ARG(0));
    size_t ts, te, ss, se;
    if (range_arg(ctx, ARG(1), "targetStart", 0, n, &ts) < 0 || range_arg(ctx, ARG(2), "targetEnd", n, n, &te) < 0 ||
        range_arg(ctx, ARG(3), "sourceStart", 0, len, &ss) < 0 || range_arg(ctx, ARG(4), "sourceEnd", len, len, &se) < 0)
        return JS_EXCEPTION;
    if (ss >= se) return js_int32(ts >= te ? 0 : -1);
    if (ts >= te) return js_int32(1);
    return js_int32(compare_bytes(data + ss, se - ss, p + ts, te - ts));
}

/* copy(target, targetStart = 0, sourceStart = 0, sourceEnd = length): the bytes copied */
BUILTIN(buffer_copy) {
    UNUSED_ARGS;
    THIS_BYTES();
    uint8_t *p;
    size_t n;
    if (!u8_bytes(ARG(0), &p, &n) && !is_typed_array(ARG(0)))
        return js_throw_invalid_arg_type(ctx, "target", "an instance of Buffer or Uint8Array", ARG(0));
    if (!js_is_uint8_array(ARG(0))) js_buffer_source_bytes(ARG(0), &p, &n);
    double ts = 0, ss = 0, se = (double)len;
    if (!js_is_undefined(ARG(1)) && js_to_number(ctx, &ts, ARG(1)) < 0) return JS_EXCEPTION;
    if (!js_is_undefined(ARG(2)) && js_to_number(ctx, &ss, ARG(2)) < 0) return JS_EXCEPTION;
    if (!js_is_undefined(ARG(3)) && js_to_number(ctx, &se, ARG(3)) < 0) return JS_EXCEPTION;
    ts = isnan(ts) ? 0 : trunc(ts), ss = isnan(ss) ? 0 : trunc(ss), se = isnan(se) ? 0 : trunc(se);
    if (ts < 0) return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE", "The value of \"targetStart\" is out of range. It must be >= 0. Received %g", ts);
    if (ss < 0 || ss > (double)len)
        return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE", "The value of \"sourceStart\" is out of range. It must be >= 0 && <= %zu. Received %g", len, ss);
    if (se < 0) return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE", "The value of \"sourceEnd\" is out of range. It must be >= 0. Received %g", se);
    if (se > (double)len) se = (double)len;
    if (ts >= (double)n || ss >= se) return js_int32(0);
    size_t count = (size_t)(se - ss);
    if (count > n - (size_t)ts) count = n - (size_t)ts;
    memmove(p + (size_t)ts, data + (size_t)ss, count);
    return js_number((double)count);
}

/* How many bytes of a UTF-8 encoding fit in `room` without splitting a character. */
static size_t utf8_fit(const uint8_t *p, size_t n, size_t room) {
    if (n <= room) return n;
    size_t k = room;
    while (k > 0 && (p[k] & 0xC0) == 0x80) k--;
    return k;
}

/* Writes a string's bytes at offset; at most `max` of them, whole UTF-8/UCS-2 characters only. */
static size_t write_string(JSContext *ctx, uint8_t *data, size_t room, JSValue s, Encoding enc) {
    Bytes b = { 0 };
    encode_string(ctx, s, enc, &b);
    size_t n = b.n;
    if (enc == ENC_UTF8) n = utf8_fit(b.p, b.n, room);
    else if (n > room) n = enc == ENC_UCS2 ? room & ~(size_t)1 : room;
    if (n) memcpy(data, b.p, n);
    free(b.p);
    return n;
}

/* write(string, offset = 0, length = buffer.length - offset, encoding = 'utf8'), with Node's
 * overloads: write(string, encoding), write(string, offset, encoding) */
BUILTIN(buffer_write) {
    UNUSED_ARGS;
    THIS_BYTES();
    if (!js_is_string(ARG(0))) return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "argument must be a string");
    JSValue offset_arg = ARG(1), length_arg = ARG(2), enc_arg = ARG(3);
    if (js_is_string(offset_arg)) enc_arg = offset_arg, offset_arg = JS_UNDEFINED, length_arg = JS_UNDEFINED;
    else if (js_is_string(length_arg)) enc_arg = length_arg, length_arg = JS_UNDEFINED;
    size_t offset, length;
    if (range_arg(ctx, offset_arg, "offset", 0, len, &offset) < 0) return JS_EXCEPTION;
    if (range_arg(ctx, length_arg, "length", len - offset, len, &length) < 0) return JS_EXCEPTION;
    if (length > len - offset) length = len - offset;
    Encoding enc;
    if (encoding_arg(ctx, enc_arg, &enc) < 0) return JS_EXCEPTION;
    return js_number((double)write_string(ctx, data + offset, length, ARG(0), enc));
}

static JSValue write_as(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, Encoding enc) {
    THIS_BYTES();
    if (!js_is_string(ARG(0))) return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "argument must be a string");
    size_t offset, length;
    if (range_arg(ctx, ARG(1), "offset", 0, len, &offset) < 0) return JS_EXCEPTION;
    if (range_arg(ctx, ARG(2), "length", len - offset, len, &length) < 0) return JS_EXCEPTION;
    if (length > len - offset) length = len - offset;
    return js_number((double)write_string(ctx, data + offset, length, ARG(0), enc));
}

#define WRITE(fn, enc)                                         \
    BUILTIN(fn) {                                              \
        (void)callee, (void)new_target;                        \
        return write_as(ctx, this_val, argc, argv, enc);       \
    }
WRITE(buffer_utf8_write, ENC_UTF8)
WRITE(buffer_ucs2_write, ENC_UCS2)
WRITE(buffer_latin1_write, ENC_LATIN1)
WRITE(buffer_ascii_write, ENC_ASCII)
WRITE(buffer_base64_write, ENC_BASE64)
WRITE(buffer_base64url_write, ENC_BASE64URL)
WRITE(buffer_hex_write, ENC_HEX)

/* Fills data[start, end) with a value repeated: a string (encoded), a number (& 255), bytes. */
static int fill_bytes(JSContext *ctx, uint8_t *data, size_t start, size_t end, JSValue value, JSValue encoding) {
    if (start >= end) return 0;
    if (js_is_string(value)) {
        Encoding enc;
        if (encoding_arg(ctx, encoding, &enc) < 0) return -1;
        Bytes b = { 0 };
        encode_string(ctx, value, enc, &b);
        if (b.n == 0) {
            free(b.p);
            if (js_string_length(value) == 0) {
                memset(data + start, 0, end - start);
                return 0;
            }
            return fail(js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_VALUE",
                                             "The argument 'value' is invalid. Received '%s'", "…"));
        }
        for (size_t i = start; i < end; i++) data[i] = b.p[(i - start) % b.n];
        free(b.p);
        return 0;
    }
    uint8_t *p;
    size_t n;
    if (u8_bytes(value, &p, &n)) {
        if (n == 0) return fail(js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_VALUE", "The argument 'value' is invalid. Received Uint8Array(0) []"));
        uint8_t *copy = malloc(n);
        if (!copy) js_fatal("out of memory filling a Buffer");
        memcpy(copy, p, n);
        for (size_t i = start; i < end; i++) data[i] = copy[(i - start) % n];
        free(copy);
        return 0;
    }
    double d = 0;
    if (js_is_bool(value)) d = js_truthy(value);
    else if (js_to_number(ctx, &d, value) < 0) return -1;
    memset(data + start, isfinite(d) ? (int)((int64_t)trunc(d) & 255) : 0, end - start);
    return 0;
}

/* fill(value, offset = 0, end = length, encoding), with fill(value, encoding) */
BUILTIN(buffer_fill) {
    UNUSED_ARGS;
    THIS_BYTES();
    JSValue offset_arg = ARG(1), end_arg = ARG(2), enc_arg = ARG(3);
    if (js_is_string(offset_arg)) enc_arg = offset_arg, offset_arg = JS_UNDEFINED, end_arg = JS_UNDEFINED;
    else if (js_is_string(end_arg)) enc_arg = end_arg, end_arg = JS_UNDEFINED;
    size_t start, end;
    if (range_arg(ctx, offset_arg, "offset", 0, len, &start) < 0 || range_arg(ctx, end_arg, "end", len, len, &end) < 0)
        return JS_EXCEPTION;
    return fill_bytes(ctx, data, start, end, ARG(0), enc_arg) < 0 ? JS_EXCEPTION : this_val;
}

/* indexOf / lastIndexOf / includes: a string (encoded), a number (a byte) or bytes */
static JSValue search(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, int kind) {
    THIS_BYTES();
    JSValue value = ARG(0), offset_arg = ARG(1), enc_arg = ARG(2);
    if (js_is_string(offset_arg)) enc_arg = offset_arg, offset_arg = JS_UNDEFINED;
    bool last = kind == 1;
    double offset = last ? (double)len : 0;
    if (!js_is_undefined(offset_arg)) {
        if (js_to_number(ctx, &offset, offset_arg) < 0) return JS_EXCEPTION;
        if (isnan(offset)) offset = last ? (double)len : 0;  /* Node: NaN searches the whole buffer */
        offset = trunc(offset);
    }
    if (offset < 0) offset += (double)len;
    Bytes needle = { 0 };
    if (js_is_string(value)) {
        Encoding enc;
        if (encoding_arg(ctx, enc_arg, &enc) < 0) return JS_EXCEPTION;
        encode_string(ctx, value, enc, &needle);
    } else if (js_is_number(value)) {
        double d = js_as_number(value);
        bytes_push(&needle, (uint8_t)(isfinite(d) ? (int64_t)trunc(d) & 255 : 0));
    } else {
        uint8_t *p;
        size_t n;
        if (!u8_bytes(value, &p, &n))
            return js_throw_invalid_arg_type(ctx, "value", "one of type number or string or an instance of Buffer or Uint8Array", value);
        bytes_reserve(&needle, n);
        if (n) memcpy(needle.p, p, n);
        needle.n = n;
    }
    u8_bytes(this_val, &data, &len);
    double found = -1;
    if (!last) {
        if (offset < 0) offset = 0;
        if (needle.n == 0) found = offset < (double)len ? offset : (double)len;
        else
            for (size_t i = (size_t)offset; offset < (double)len && i + needle.n <= len; i++)
                if (memcmp(data + i, needle.p, needle.n) == 0) {
                    found = (double)i;
                    break;
                }
    } else if (offset >= 0) {
        if (needle.n == 0) found = offset < (double)len ? offset : (double)len;
        else if (needle.n <= len) {
            size_t i = offset > (double)(len - needle.n) ? len - needle.n : (size_t)offset;
            for (;; i--) {
                if (memcmp(data + i, needle.p, needle.n) == 0) {
                    found = (double)i;
                    break;
                }
                if (i == 0) break;
            }
        }
    }
    free(needle.p);
    return kind == 2 ? js_bool(found >= 0) : js_number(found);
}

BUILTIN(buffer_index_of) {
    (void)callee, (void)new_target;
    return search(ctx, this_val, argc, argv, 0);
}
BUILTIN(buffer_last_index_of) {
    (void)callee, (void)new_target;
    return search(ctx, this_val, argc, argv, 1);
}
BUILTIN(buffer_includes) {
    (void)callee, (void)new_target;
    return search(ctx, this_val, argc, argv, 2);
}

BUILTIN(buffer_to_json) {
    UNUSED_ARGS;
    THIS_BYTES();
    JSValue arr = js_new_array(ctx, (uint32_t)len);
    for (size_t i = 0; i < len; i++)
        if (js_array_push(ctx, js_as_object(arr), js_int32(data[i])) < 0) return JS_EXCEPTION;
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "type"), js_new_string_cstr(ctx, "Buffer"), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_atom_from_cstr(ctx, "data"), arr, JS_PROP_DEFAULT);
    return o;
}

/* subarray(start, end) and slice(start, end): Buffers sharing the memory */
BUILTIN(buffer_subarray) {
    UNUSED_ARGS;
    THIS_BYTES();
    size_t start, end;
    if (position(ctx, ARG(0), len, 0, &start) < 0 || position(ctx, ARG(1), len, len, &end) < 0) return JS_EXCEPTION;
    if (end < start) end = start;
    JSTypedArray *ta = as_ta(this_val);
    return new_view(ctx, ta->buffer, ta->byte_offset + start, end - start);
}

static JSValue swap(JSContext *ctx, JSValue this_val, size_t width) {
    THIS_BYTES();
    if (len % width) return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_INVALID_BUFFER_SIZE", "Buffer size must be a multiple of %zu-bits", width * 8);
    for (size_t i = 0; i < len; i += width)
        for (size_t a = 0, b = width - 1; a < b; a++, b--) {
            uint8_t t = data[i + a];
            data[i + a] = data[i + b];
            data[i + b] = t;
        }
    return this_val;
}

BUILTIN(buffer_swap16) {
    UNUSED_ARGS;
    return swap(ctx, this_val, 2);
}
BUILTIN(buffer_swap32) {
    UNUSED_ARGS;
    return swap(ctx, this_val, 4);
}
BUILTIN(buffer_swap64) {
    UNUSED_ARGS;
    return swap(ctx, this_val, 8);
}

BUILTIN(buffer_parent) {
    UNUSED_ARGS;
    return is_typed_array(this_val) ? as_ta(this_val)->buffer : JS_UNDEFINED;
}

BUILTIN(buffer_offset) {
    UNUSED_ARGS;
    return is_typed_array(this_val) ? js_number((double)as_ta(this_val)->byte_offset) : JS_UNDEFINED;
}

/* ---- Numbers: the reads and writes ------------------------------------------------------------------ */

static JSValue throw_bounds(JSContext *ctx) {
    return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_BUFFER_OUT_OF_BOUNDS", "Attempt to access memory outside buffer bounds");
}

/* The offset of a read or write of `size` bytes (Node's validateNumber/boundsError). 0, or -1. */
static int access_offset(JSContext *ctx, JSValue v, size_t len, size_t size, size_t *out) {
    if (js_is_undefined(v)) v = js_int32(0);
    if (!js_is_number(v)) return fail(js_throw_invalid_arg_type(ctx, "offset", "of type number", v));
    double d = js_as_number(v);
    if (d != trunc(d) || isnan(d)) {
        char received[64];
        js_describe_value(ctx, v, received, sizeof received);
        return fail(js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE",
                                         "The value of \"offset\" is out of range. It must be an integer. Received %s", received));
    }
    if (len < size) return fail(throw_bounds(ctx));
    if (d < 0 || d > (double)(len - size)) {
        char received[64];
        js_describe_value(ctx, v, received, sizeof received);
        return fail(js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE",
                                         "The value of \"offset\" is out of range. It must be >= 0 and <= %zu. Received %s", len - size, received));
    }
    *out = (size_t)d;
    return 0;
}

enum { INT_LE = 0, INT_BE = 1 };

static uint64_t load_uint(const uint8_t *p, size_t size, int order) {
    uint64_t v = 0;
    for (size_t i = 0; i < size; i++) v |= (uint64_t)p[order == INT_LE ? i : size - 1 - i] << (8 * i);
    return v;
}

static void store_uint(uint8_t *p, size_t size, int order, uint64_t v) {
    for (size_t i = 0; i < size; i++) p[order == INT_LE ? i : size - 1 - i] = (uint8_t)(v >> (8 * i));
}

/* the read: size bytes (1-6), order, signedness; `variable`: the size is argument 1 (readUIntLE) */
static JSValue read_int(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, size_t size, int order, bool is_signed, bool variable) {
    THIS_BYTES();
    if (variable) {
        if (!js_is_number(ARG(1))) return js_throw_invalid_arg_type(ctx, "byteLength", "of type number", ARG(1));
        double b = js_as_number(ARG(1));
        if (!(b >= 1 && b <= 6) || b != trunc(b)) {
            char received[64];
            js_describe_value(ctx, ARG(1), received, sizeof received);
            return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE",
                                       "The value of \"byteLength\" is out of range. It must be >= 1 and <= 6. Received %s", received);
        }
        size = (size_t)b;
    }
    size_t offset;
    if (access_offset(ctx, ARG(0), len, size, &offset) < 0) return JS_EXCEPTION;
    uint64_t v = load_uint(data + offset, size, order);
    if (is_signed && size < 8 && (v >> (8 * size - 1)) & 1) return js_number((double)(int64_t)(v | ~((UINT64_C(1) << (8 * size)) - 1)));
    return js_number((double)v);
}

/* the write: value checked against the type's range, as Node checks it */
static JSValue write_int(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, size_t size, int order, bool is_signed, bool variable) {
    THIS_BYTES();
    if (variable) {
        if (!js_is_number(ARG(2))) return js_throw_invalid_arg_type(ctx, "byteLength", "of type number", ARG(2));
        double b = js_as_number(ARG(2));
        if (!(b >= 1 && b <= 6) || b != trunc(b)) {
            char received[64];
            js_describe_value(ctx, ARG(2), received, sizeof received);
            return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE",
                                       "The value of \"byteLength\" is out of range. It must be >= 1 and <= 6. Received %s", received);
        }
        size = (size_t)b;
    }
    double v;
    if (js_to_number(ctx, &v, ARG(0)) < 0) return JS_EXCEPTION;
    double min = is_signed ? -ldexp(1, (int)(8 * size - 1)) : 0;
    double max = is_signed ? ldexp(1, (int)(8 * size - 1)) - 1 : ldexp(1, (int)(8 * size)) - 1;
    size_t offset;
    if (access_offset(ctx, ARG(1), len, size, &offset) < 0) return JS_EXCEPTION;
    if (!(v >= min && v <= max)) {
        char range[160], received[64];
        if (size > 4) {
            if (is_signed) snprintf(range, sizeof range, ">= -(2 ** %zu) and < 2 ** %zu", 8 * size - 1, 8 * size - 1);
            else snprintf(range, sizeof range, ">= 0 and < 2 ** %zu", 8 * size);
        } else {
            snprintf(range, sizeof range, ">= %.0f and <= %.0f", min, max);
        }
        js_describe_value(ctx, js_number(v), received, sizeof received);
        return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE", "The value of \"value\" is out of range. It must be %s. Received %s", range, received);
    }
    u8_bytes(this_val, &data, &len);
    store_uint(data + offset, size, order, (uint64_t)(int64_t)trunc(v));
    return js_number((double)(offset + size));
}

#define READ(fn, size, order, sign, variable)                                       \
    BUILTIN(fn) {                                                                   \
        (void)callee, (void)new_target;                                             \
        return read_int(ctx, this_val, argc, argv, size, order, sign, variable);   \
    }
#define WRITE_INT(fn, size, order, sign, variable)                                  \
    BUILTIN(fn) {                                                                   \
        (void)callee, (void)new_target;                                             \
        return write_int(ctx, this_val, argc, argv, size, order, sign, variable);  \
    }
READ(read_uint8, 1, INT_LE, false, false)
READ(read_uint16le, 2, INT_LE, false, false)
READ(read_uint16be, 2, INT_BE, false, false)
READ(read_uint32le, 4, INT_LE, false, false)
READ(read_uint32be, 4, INT_BE, false, false)
READ(read_uintle, 0, INT_LE, false, true)
READ(read_uintbe, 0, INT_BE, false, true)
READ(read_int8, 1, INT_LE, true, false)
READ(read_int16le, 2, INT_LE, true, false)
READ(read_int16be, 2, INT_BE, true, false)
READ(read_int32le, 4, INT_LE, true, false)
READ(read_int32be, 4, INT_BE, true, false)
READ(read_intle, 0, INT_LE, true, true)
READ(read_intbe, 0, INT_BE, true, true)
WRITE_INT(write_uint8, 1, INT_LE, false, false)
WRITE_INT(write_uint16le, 2, INT_LE, false, false)
WRITE_INT(write_uint16be, 2, INT_BE, false, false)
WRITE_INT(write_uint32le, 4, INT_LE, false, false)
WRITE_INT(write_uint32be, 4, INT_BE, false, false)
WRITE_INT(write_uintle, 0, INT_LE, false, true)
WRITE_INT(write_uintbe, 0, INT_BE, false, true)
WRITE_INT(write_int8, 1, INT_LE, true, false)
WRITE_INT(write_int16le, 2, INT_LE, true, false)
WRITE_INT(write_int16be, 2, INT_BE, true, false)
WRITE_INT(write_int32le, 4, INT_LE, true, false)
WRITE_INT(write_int32be, 4, INT_BE, true, false)
WRITE_INT(write_intle, 0, INT_LE, true, true)
WRITE_INT(write_intbe, 0, INT_BE, true, true)

/* floats and doubles */
static JSValue read_float(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, size_t size, int order) {
    THIS_BYTES();
    size_t offset;
    if (access_offset(ctx, ARG(0), len, size, &offset) < 0) return JS_EXCEPTION;
    uint64_t bits = load_uint(data + offset, size, order);
    if (size == 4) {
        uint32_t b32 = (uint32_t)bits;
        float f;
        memcpy(&f, &b32, 4);
        return js_number((double)f);
    }
    double d;
    memcpy(&d, &bits, 8);
    return js_number(d);
}

static JSValue write_float(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, size_t size, int order) {
    THIS_BYTES();
    double v;
    if (js_to_number(ctx, &v, ARG(0)) < 0) return JS_EXCEPTION;
    size_t offset;
    if (access_offset(ctx, ARG(1), len, size, &offset) < 0) return JS_EXCEPTION;
    uint64_t bits;
    if (size == 4) {
        float f = (float)v;
        uint32_t b32;
        memcpy(&b32, &f, 4);
        bits = b32;
    } else {
        memcpy(&bits, &v, 8);
    }
    u8_bytes(this_val, &data, &len);
    store_uint(data + offset, size, order, bits);
    return js_number((double)(offset + size));
}

#define FLOAT(fn, wfn, size, order)                                                    \
    BUILTIN(fn) {                                                                      \
        (void)callee, (void)new_target;                                                \
        return read_float(ctx, this_val, argc, argv, size, order);                    \
    }                                                                                  \
    BUILTIN(wfn) {                                                                     \
        (void)callee, (void)new_target;                                                \
        return write_float(ctx, this_val, argc, argv, size, order);                   \
    }
FLOAT(read_floatle, write_floatle, 4, INT_LE)
FLOAT(read_floatbe, write_floatbe, 4, INT_BE)
FLOAT(read_doublele, write_doublele, 8, INT_LE)
FLOAT(read_doublebe, write_doublebe, 8, INT_BE)

/* the BigInt reads and writes: the bigint component is installed when a program names them */
static JSValue read_big(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, int order, bool is_signed) {
    THIS_BYTES();
    if (!ctx->rt->bigint) return js_throw_type_error(ctx, "BigInt is not available");
    size_t offset;
    if (access_offset(ctx, ARG(0), len, 8, &offset) < 0) return JS_EXCEPTION;
    uint64_t v = load_uint(data + offset, 8, order);
    return is_signed ? ctx->rt->bigint->from_int64(ctx, (int64_t)v) : ctx->rt->bigint->from_uint64(ctx, v);
}

static JSValue write_big(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, int order, bool is_signed) {
    THIS_BYTES();
    if (!ctx->rt->bigint) return js_throw_type_error(ctx, "BigInt is not available");
    JSValue v = ARG(0);
    if (!js_is_bigint(v)) return js_throw_invalid_arg_type(ctx, "value", "of type bigint", v);
    JSValue lo = is_signed ? ctx->rt->bigint->from_int64(ctx, INT64_MIN) : ctx->rt->bigint->from_uint64(ctx, 0);
    JSValue hi = is_signed ? ctx->rt->bigint->from_int64(ctx, INT64_MAX) : ctx->rt->bigint->from_uint64(ctx, UINT64_MAX);
    if (ctx->rt->bigint->compare(ctx, v, lo) < 0 || ctx->rt->bigint->compare(ctx, v, hi) > 0) {
        JSValue s = ctx->rt->bigint->to_string(ctx, v, 10);
        char received[96] = "";
        if (js_is_string(s)) received[js_view_to_utf8(js_string_view(ctx, s), received, sizeof received - 1)] = '\0';
        return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_OUT_OF_RANGE", "The value of \"value\" is out of range. It must be %s. Received %sn",
                                   is_signed ? ">= -(2n ** 63n) and < 2n ** 63n" : ">= 0n and < 2n ** 64n", received);
    }
    size_t offset;
    if (access_offset(ctx, ARG(1), len, 8, &offset) < 0) return JS_EXCEPTION;
    store_uint(data + offset, 8, order, ctx->rt->bigint->to_uint64(v));
    return js_number((double)(offset + 8));
}

#define BIG(fn, wfn, order, sign)                                                      \
    BUILTIN(fn) {                                                                      \
        (void)callee, (void)new_target;                                                \
        return read_big(ctx, this_val, argc, argv, order, sign);                      \
    }                                                                                  \
    BUILTIN(wfn) {                                                                     \
        (void)callee, (void)new_target;                                                \
        return write_big(ctx, this_val, argc, argv, order, sign);                     \
    }
BIG(read_big_uint64le, write_big_uint64le, INT_LE, false)
BIG(read_big_uint64be, write_big_uint64be, INT_BE, false)
BIG(read_big_int64le, write_big_int64le, INT_LE, true)
BIG(read_big_int64be, write_big_int64be, INT_BE, true)

/* ---- Inspection ----------------------------------------------------------------------------- */

/* `<Buffer 68 69>`: at most 50 bytes, then ` ... n more bytes`, then the own enumerable
 * non-index properties (`<Buffer 61, foo: 1>`) */
BUILTIN(buffer_inspect) {
    UNUSED_ARGS;
    THIS_BYTES();
    char name[128] = "Buffer";
    JSValue c = js_get_value(ctx, this_val, JS_ATOM(constructor));
    if (js_is_exception(c)) return c;
    if (js_is_object(c)) {
        JSValue n = js_get_value(ctx, c, JS_ATOM(name));
        if (js_is_exception(n)) return n;
        if (js_is_string(n)) name[js_view_to_utf8(js_string_view(ctx, n), name, sizeof name - 1)] = '\0';
    }
    size_t shown = len < 50 ? len : 50;
    char *s = malloc(strlen(name) + shown * 3 + 64);
    if (!s) js_fatal("out of memory inspecting a Buffer");
    size_t o = (size_t)sprintf(s, "<%s ", name);
    for (size_t i = 0; i < shown; i++) {
        if (i) s[o++] = ' ';
        s[o++] = HEX[data[i] >> 4];
        s[o++] = HEX[data[i] & 15];
    }
    if (len > 50) o += (size_t)sprintf(s + o, " ... %zu more byte%s", len - 50, len - 50 > 1 ? "s" : "");
    s[o] = '\0';
    JSValue r = js_new_string_cstr(ctx, s);
    free(s);
    if (js_is_exception(r)) return r;
    /* the extras: inspected as a null-prototype object, without its braces */
    JSValue keys = js_get_own_enumerable_string_keys(ctx, this_val);
    if (js_is_exception(keys)) return keys;
    JSValue extras = js_new_object_proto(ctx, JS_NULL, 4);
    bool any = false;
    for (uint32_t i = 0; i < js_array_length(js_as_object(keys)); i++) {
        JSValue k = js_get_elem(ctx, keys, js_int32((int32_t)i));
        if (js_is_exception(k)) return k;
        JSStrView kv = js_string_view(ctx, k);
        bool index = kv.length > 0;
        for (uint32_t j = 0; j < kv.length && index; j++) index = js_view_at(kv, j) >= '0' && js_view_at(kv, j) <= '9';
        if (index) continue;
        JSValue v = js_get_value(ctx, this_val, js_to_property_key(ctx, k));
        if (js_is_exception(v)) return v;
        js_define_data(ctx, js_as_object(extras), js_to_property_key(ctx, k), v, JS_PROP_DEFAULT);
        any = true;
    }
    if (any) {
        JSInspectOptions opts = js_inspect_defaults;
        if (js_is_object(ARG(1)) && js_inspect_options_from(ctx, ARG(1), &opts) < 0) return JS_EXCEPTION;
        opts.break_length = INFINITY;
        opts.compact = -1;
        JSValue e = js_inspect_with(ctx, extras, &opts);
        if (js_is_exception(e)) return e;
        uint32_t el = js_string_length(e);
        if (el > 29) {
            JSValue sep = js_new_string_cstr(ctx, len ? ", " : "");
            r = js_concat(ctx, js_concat(ctx, r, sep), js_substring(ctx, e, 27, el - 2));
            if (js_is_exception(r)) return r;
        }
    }
    return js_concat(ctx, r, js_new_string_cstr(ctx, ">"));
}

/* ---- C callers ------------------------------------------------------------------------------ */

JSValue js_new_buffer_from_bytes(JSContext *ctx, const uint8_t *p, size_t n) { return buffer_of_bytes(ctx, p, n); }

/* ---- Realm ---------------------------------------------------------------------------------- */

/* Node assigns them, so they're enumerable: safer-buffer copies the statics with for-in, and
 * mysql2's MockBuffer stubs out the prototype's methods with for-in */
#define STATIC(name, fn, length) \
    { (name), NULL, JS_BUILTIN_KIND_FN, JS_BUILTIN_METHOD_ATTRS | JS_PROP_ENUMERABLE, (length), (fn), NULL, 0, NULL }
#define FN(name, fn, length) STATIC(name, fn, length)
#define ALIAS(name, earlier) \
    { (name), NULL, JS_BUILTIN_KIND_ALIAS, JS_BUILTIN_METHOD_ATTRS | JS_PROP_ENUMERABLE, 0, NULL, NULL, 0, (earlier) }
#define GETTER(name, get) \
    { (name), NULL, JS_BUILTIN_KIND_ACCESSOR, JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE, 0, (get), NULL, 0, NULL }

static const JSBuiltin buffer_statics[] = {
    JS_BUILTIN_NUMBER("poolSize", 8192, JS_PROP_DEFAULT),
    STATIC("from", buffer_from, 3),
    STATIC("copyBytesFrom", buffer_copy_bytes_from, 3),
    STATIC("of", buffer_of, 0),
    STATIC("alloc", buffer_alloc, 3),
    STATIC("allocUnsafe", buffer_alloc_unsafe, 1),
    STATIC("allocUnsafeSlow", buffer_alloc_unsafe, 1),
    STATIC("isBuffer", buffer_is_buffer, 1),
    STATIC("compare", buffer_compare_static, 2),
    STATIC("isEncoding", buffer_is_encoding, 1),
    STATIC("concat", buffer_concat, 2),
    STATIC("byteLength", buffer_byte_length, 2),
};

static const JSBuiltin buffer_proto[] = {
    FN("readBigUInt64LE", read_big_uint64le, 0), FN("readBigUInt64BE", read_big_uint64be, 0),
    ALIAS("readBigUint64LE", "readBigUInt64LE"), ALIAS("readBigUint64BE", "readBigUInt64BE"),
    FN("readBigInt64LE", read_big_int64le, 0), FN("readBigInt64BE", read_big_int64be, 0),
    FN("writeBigUInt64LE", write_big_uint64le, 0), FN("writeBigUInt64BE", write_big_uint64be, 0),
    ALIAS("writeBigUint64LE", "writeBigUInt64LE"), ALIAS("writeBigUint64BE", "writeBigUInt64BE"),
    FN("writeBigInt64LE", write_big_int64le, 0), FN("writeBigInt64BE", write_big_int64be, 0),
    FN("readUIntLE", read_uintle, 2), FN("readUInt32LE", read_uint32le, 0), FN("readUInt16LE", read_uint16le, 0),
    FN("readUInt8", read_uint8, 0), FN("readUIntBE", read_uintbe, 2), FN("readUInt32BE", read_uint32be, 0),
    FN("readUInt16BE", read_uint16be, 0),
    ALIAS("readUintLE", "readUIntLE"), ALIAS("readUint32LE", "readUInt32LE"),
    ALIAS("readUint16LE", "readUInt16LE"), ALIAS("readUint8", "readUInt8"),
    ALIAS("readUintBE", "readUIntBE"), ALIAS("readUint32BE", "readUInt32BE"),
    ALIAS("readUint16BE", "readUInt16BE"),
    FN("readIntLE", read_intle, 2), FN("readInt32LE", read_int32le, 0), FN("readInt16LE", read_int16le, 0),
    FN("readInt8", read_int8, 0), FN("readIntBE", read_intbe, 2), FN("readInt32BE", read_int32be, 0),
    FN("readInt16BE", read_int16be, 0),
    FN("writeUIntLE", write_uintle, 3), FN("writeUInt32LE", write_uint32le, 0), FN("writeUInt16LE", write_uint16le, 0),
    FN("writeUInt8", write_uint8, 0), FN("writeUIntBE", write_uintbe, 3), FN("writeUInt32BE", write_uint32be, 0),
    FN("writeUInt16BE", write_uint16be, 0),
    ALIAS("writeUintLE", "writeUIntLE"), ALIAS("writeUint32LE", "writeUInt32LE"),
    ALIAS("writeUint16LE", "writeUInt16LE"), ALIAS("writeUint8", "writeUInt8"),
    ALIAS("writeUintBE", "writeUIntBE"), ALIAS("writeUint32BE", "writeUInt32BE"),
    ALIAS("writeUint16BE", "writeUInt16BE"),
    FN("writeIntLE", write_intle, 3), FN("writeInt32LE", write_int32le, 0), FN("writeInt16LE", write_int16le, 0),
    FN("writeInt8", write_int8, 0), FN("writeIntBE", write_intbe, 3), FN("writeInt32BE", write_int32be, 0),
    FN("writeInt16BE", write_int16be, 0),
    FN("readFloatLE", read_floatle, 0), FN("readFloatBE", read_floatbe, 0),
    FN("readDoubleLE", read_doublele, 0), FN("readDoubleBE", read_doublebe, 0),
    FN("writeFloatLE", write_floatle, 0), FN("writeFloatBE", write_floatbe, 0),
    FN("writeDoubleLE", write_doublele, 0), FN("writeDoubleBE", write_doublebe, 0),
    FN("asciiSlice", buffer_ascii_slice, 2), FN("base64Slice", buffer_base64_slice, 2),
    FN("base64urlSlice", buffer_base64url_slice, 2), FN("latin1Slice", buffer_latin1_slice, 2),
    FN("hexSlice", buffer_hex_slice, 2), FN("ucs2Slice", buffer_ucs2_slice, 2), FN("utf8Slice", buffer_utf8_slice, 2),
    FN("asciiWrite", buffer_ascii_write, 3), FN("base64Write", buffer_base64_write, 3),
    FN("base64urlWrite", buffer_base64url_write, 3), FN("latin1Write", buffer_latin1_write, 3),
    FN("hexWrite", buffer_hex_write, 3), FN("ucs2Write", buffer_ucs2_write, 3), FN("utf8Write", buffer_utf8_write, 3),
    GETTER("parent", buffer_parent),
    GETTER("offset", buffer_offset),
    FN("copy", buffer_copy, 4),
    FN("toString", buffer_to_string, 3),
    FN("equals", buffer_equals, 1),
    FN("inspect", buffer_inspect, 2),
    FN("compare", buffer_compare, 5),
    FN("indexOf", buffer_index_of, 3),
    FN("lastIndexOf", buffer_last_index_of, 3),
    FN("includes", buffer_includes, 3),
    FN("fill", buffer_fill, 4),
    FN("write", buffer_write, 4),
    FN("toJSON", buffer_to_json, 0),
    FN("subarray", buffer_subarray, 2),
    FN("slice", buffer_subarray, 2),
    FN("swap16", buffer_swap16, 0),
    FN("swap32", buffer_swap32, 0),
    FN("swap64", buffer_swap64, 0),
    ALIAS("toLocaleString", "toString"),
};

static void install_buffer(JSContext *ctx, JSObject *global) {
    JSValue u8 = uint8_array_ctor(ctx);
    JSValue u8_proto = ctx->intrinsics[JS_INTRINSIC_TYPED_ARRAY_PROTOS + JS_TA_UINT8];
    JSValue proto = js_new_object_proto(ctx, u8_proto, 128);
    ctx->intrinsics[JS_INTRINSIC_BUFFER_PROTOTYPE] = proto;
    JSValue key = js_atom_from_cstr(ctx, "Buffer");
    JSValue c = js_new_native(ctx, buffer_ctor, key, 3, JS_FN_CONSTRUCTOR);
    ctx->intrinsics[JS_INTRINSIC_BUFFER] = c;
    if (js_set_prototype_of(ctx, js_as_object(c), u8) < 0) js_discard(js_take_exception(ctx));
    js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), proto, 0);
    js_define_builtins(ctx, js_as_object(c), buffer_statics, JS_COUNTOF(buffer_statics));
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), c, JS_BUILTIN_METHOD_ATTRS);
    js_define_builtins(ctx, js_as_object(proto), buffer_proto, JS_COUNTOF(buffer_proto));
    JSValue custom = js_symbol_for(ctx, js_new_string_cstr(ctx, "nodejs.util.inspect.custom"));
    JSValue inspect = js_get_value(ctx, proto, js_atom_from_cstr(ctx, "inspect"));
    js_define_data(ctx, js_as_object(proto), custom, inspect, JS_BUILTIN_METHOD_ATTRS);
    js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
}

const JSComponent js_component_buffer = { "buffer", install_buffer };
