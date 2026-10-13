/* TextEncoder and TextDecoder (WHATWG Encoding), the encoding component,
 * which needs the typedarray component. As in Node: TextEncoder writes UTF-8 (lone surrogates
 * become U+FFFD); TextDecoder reads UTF-8, UTF-16LE, UTF-16BE and windows-1252 (the labels
 * latin1, ascii, …), streaming, with `fatal` and `ignoreBOM`, and Node's errors and inspection.
 * Node with ICU knows the legacy encodings too (Shift_JIS, GBK, …); they're RangeErrors here. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_buffer.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

enum { ENC_UTF8, ENC_UTF16LE, ENC_UTF16BE, ENC_WINDOWS1252 };
static const char *const ENCODING_NAMES[] = { "utf-8", "utf-16le", "utf-16be", "windows-1252" };

/* The labels of each encoding (Encoding §4.2), ASCII lowercase. */
static const struct { const char *label; uint8_t encoding; } LABELS[] = {
    { "unicode-1-1-utf-8", ENC_UTF8 }, { "unicode11utf8", ENC_UTF8 }, { "unicode20utf8", ENC_UTF8 },
    { "utf-8", ENC_UTF8 }, { "utf8", ENC_UTF8 }, { "x-unicode20utf8", ENC_UTF8 },
    { "unicodefffe", ENC_UTF16BE }, { "utf-16be", ENC_UTF16BE },
    { "csunicode", ENC_UTF16LE }, { "iso-10646-ucs-2", ENC_UTF16LE }, { "ucs-2", ENC_UTF16LE },
    { "unicode", ENC_UTF16LE }, { "unicodefeff", ENC_UTF16LE }, { "utf-16", ENC_UTF16LE }, { "utf-16le", ENC_UTF16LE },
    { "ansi_x3.4-1968", ENC_WINDOWS1252 }, { "ascii", ENC_WINDOWS1252 }, { "cp1252", ENC_WINDOWS1252 },
    { "cp819", ENC_WINDOWS1252 }, { "csisolatin1", ENC_WINDOWS1252 }, { "ibm819", ENC_WINDOWS1252 },
    { "iso-8859-1", ENC_WINDOWS1252 }, { "iso-ir-100", ENC_WINDOWS1252 }, { "iso8859-1", ENC_WINDOWS1252 },
    { "iso88591", ENC_WINDOWS1252 }, { "iso_8859-1", ENC_WINDOWS1252 }, { "iso_8859-1:1987", ENC_WINDOWS1252 },
    { "l1", ENC_WINDOWS1252 }, { "latin1", ENC_WINDOWS1252 }, { "us-ascii", ENC_WINDOWS1252 },
    { "windows-1252", ENC_WINDOWS1252 }, { "x-cp1252", ENC_WINDOWS1252 },
};

/* windows-1252's 0x80…0x9F; the other bytes are their own code points. */
static const uint16_t WINDOWS1252_HIGH[32] = {
    0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
    0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
};

typedef struct TextDecoderObject {
    JSObject obj;
    uint8_t  encoding;
    bool     fatal, ignore_bom;
    bool     bom_seen, do_not_flush;
    /* the UTF-8 decoder (Encoding §8.1.2) */
    uint8_t  needed, seen, lower, upper;
    uint32_t code_point;
    /* the shared UTF-16 decoder (§14.2.1): -1 / 0 when none */
    int16_t  lead_byte;
    uint16_t lead_surrogate;
} TextDecoderObject;

static const JSClass text_decoder_class = { "TextDecoder", sizeof(TextDecoderObject), NULL, NULL, NULL, NULL, NULL, NULL, NULL };
static const JSClass text_encoder_class = { "TextEncoder", sizeof(JSObject), NULL, NULL, NULL, NULL, NULL, NULL, NULL };

static TextDecoderObject *as_decoder(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &text_decoder_class ? (TextDecoderObject *)js_as_object(v) : NULL;
}
static bool is_encoder(JSValue v) { return js_is_object(v) && js_as_object(v)->shape->cls == &text_encoder_class; }

#define THIS_DECODER()                          \
    TextDecoderObject *d = as_decoder(this_val); \
    if (!d) return js_throw_invalid_this(ctx, "TextDecoder")
#define THIS_ENCODER() \
    if (!is_encoder(this_val)) return js_throw_invalid_this(ctx, "TextEncoder")

static JSValue inspect_custom_key(JSContext *ctx) {
    return js_symbol_for(ctx, js_new_string_cstr(ctx, "nodejs.util.inspect.custom"));
}

/* ---- Decoding ------------------------------------------------------------------------------ */

/* The decoder's output: UTF-16 code units. */
typedef struct {
    uint16_t *units;
    size_t    n, cap;
} Out;

static void put_unit(Out *o, uint32_t u) {
    if (o->n == o->cap) {
        o->cap = o->cap ? o->cap * 2 : 64;
        uint16_t *p = realloc(o->units, o->cap * sizeof *p);
        if (!p) js_fatal("out of memory in TextDecoder");
        o->units = p;
    }
    o->units[o->n++] = (uint16_t)u;
}

/* A decoded code point, after the BOM check (Encoding §6, "serialize I/O queue"). */
static void put_code_point(TextDecoderObject *d, Out *o, uint32_t cp) {
    if (!d->ignore_bom && !d->bom_seen && d->encoding != ENC_WINDOWS1252) {
        d->bom_seen = true;
        if (cp == 0xFEFF) return;
    }
    if (cp > 0xFFFF) {
        cp -= 0x10000;
        put_unit(o, 0xD800 + (cp >> 10));
        put_unit(o, 0xDC00 + (cp & 0x3FF));
    } else {
        put_unit(o, cp);
    }
}

/* A decoding error: U+FFFD, or false when the decoder is fatal (the caller throws). */
static bool error(TextDecoderObject *d, Out *o) {
    if (d->fatal) return false;
    put_code_point(d, o, 0xFFFD);
    return true;
}

static void reset_utf8(TextDecoderObject *d) {
    d->needed = d->seen = 0;
    d->code_point = 0;
    d->lower = 0x80;
    d->upper = 0xBF;
}

/* The UTF-8 decoder's handler (Encoding §8.1.2), over bytes then (`flush`) the end of the queue. */
static bool decode_utf8(TextDecoderObject *d, Out *o, const uint8_t *p, size_t n, bool flush) {
    for (size_t i = 0; i < n;) {
        uint8_t b = p[i];
        if (d->needed == 0) {
            i++;
            if (b <= 0x7F) {
                put_code_point(d, o, b);
            } else if (b >= 0xC2 && b <= 0xDF) {
                d->needed = 1;
                d->code_point = b & 0x1F;
            } else if (b >= 0xE0 && b <= 0xEF) {
                if (b == 0xE0) d->lower = 0xA0;
                if (b == 0xED) d->upper = 0x9F;
                d->needed = 2;
                d->code_point = b & 0xF;
            } else if (b >= 0xF0 && b <= 0xF4) {
                if (b == 0xF0) d->lower = 0x90;
                if (b == 0xF4) d->upper = 0x8F;
                d->needed = 3;
                d->code_point = b & 0x7;
            } else if (!error(d, o)) {
                return false;
            }
            continue;
        }
        if (b < d->lower || b > d->upper) {  /* the byte is processed again, as a lead */
            reset_utf8(d);
            if (!error(d, o)) return false;
            continue;
        }
        i++;
        d->lower = 0x80;
        d->upper = 0xBF;
        d->code_point = (d->code_point << 6) | (b & 0x3F);
        if (++d->seen == d->needed) {
            put_code_point(d, o, d->code_point);
            reset_utf8(d);
        }
    }
    if (flush && d->needed != 0) {
        reset_utf8(d);
        return error(d, o);
    }
    return true;
}

/* The shared UTF-16 decoder's handler (Encoding §14.2.1). */
static bool decode_utf16(TextDecoderObject *d, Out *o, const uint8_t *p, size_t n, bool flush) {
    bool be = d->encoding == ENC_UTF16BE;
    for (size_t i = 0; i < n; i++) {
        if (d->lead_byte < 0) {
            d->lead_byte = p[i];
            continue;
        }
        uint32_t cu = be ? ((uint32_t)d->lead_byte << 8) | p[i] : ((uint32_t)p[i] << 8) | (uint32_t)d->lead_byte;
        d->lead_byte = -1;
        if (d->lead_surrogate) {
            uint32_t lead = d->lead_surrogate;
            d->lead_surrogate = 0;
            if (cu >= 0xDC00 && cu <= 0xDFFF) {
                put_code_point(d, o, 0x10000 + ((lead - 0xD800) << 10) + (cu - 0xDC00));
                continue;
            }
            /* the unit's bytes are processed again: the same unit, with no lead surrogate */
            if (!error(d, o)) return false;
        }
        if (cu >= 0xD800 && cu <= 0xDBFF) {
            d->lead_surrogate = (uint16_t)cu;
        } else if (cu >= 0xDC00 && cu <= 0xDFFF) {
            if (!error(d, o)) return false;
        } else {
            put_code_point(d, o, cu);
        }
    }
    if (flush && (d->lead_byte >= 0 || d->lead_surrogate)) {
        d->lead_byte = -1;
        d->lead_surrogate = 0;
        return error(d, o);
    }
    return true;
}

static void reset_decoder(TextDecoderObject *d) {
    reset_utf8(d);
    d->lead_byte = -1;
    d->lead_surrogate = 0;
    d->bom_seen = false;
}

/* decode(input, options) (Encoding §7.2) */
BUILTIN(text_decoder_decode) {
    UNUSED_ARGS;
    THIS_DECODER();
    bool stream = false;
    if (js_is_object(ARG(1))) {
        JSValue s = js_get_value(ctx, ARG(1), js_atom_from_cstr(ctx, "stream"));
        if (js_is_exception(s)) return s;
        stream = js_truthy(s);
    }
    uint8_t *bytes = NULL;
    size_t n = 0;
    if (!js_is_undefined(ARG(0)) && !js_buffer_source_bytes(ARG(0), &bytes, &n))
        return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE",
                                   "The \"list\" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.");
    if (!d->do_not_flush) reset_decoder(d);
    d->do_not_flush = stream;

    /* ASCII from a fresh decoder, all of it: the bytes are the string */
    if (d->encoding != ENC_UTF16LE && d->encoding != ENC_UTF16BE && d->needed == 0) {
        size_t k = 0;
        while (k < n && bytes[k] < 0x80) k++;
        if (k == n) {
            if (n > 0) d->bom_seen = true;
            return js_new_string_latin1(ctx, bytes, (uint32_t)n);
        }
    }
    Out o = { 0 };
    bool ok;
    if (d->encoding == ENC_UTF8) {
        ok = decode_utf8(d, &o, bytes, n, !stream);
    } else if (d->encoding == ENC_WINDOWS1252) {
        for (size_t i = 0; i < n; i++) put_unit(&o, bytes[i] >= 0x80 && bytes[i] <= 0x9F ? WINDOWS1252_HIGH[bytes[i] - 0x80] : bytes[i]);
        ok = true;
    } else {
        ok = decode_utf16(d, &o, bytes, n, !stream);
    }
    if (!ok) {
        free(o.units);
        return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_ENCODING_INVALID_ENCODED_DATA",
                                   "The encoded data was not valid for encoding %s", ENCODING_NAMES[d->encoding]);
    }
    if (o.n > JS_STRING_MAX_LENGTH) {
        free(o.units);
        return js_throw_range_error(ctx, "Invalid string length");
    }
    JSValue r = js_new_string_utf16(ctx, o.units, (uint32_t)o.n);
    free(o.units);
    return r;
}

/* The encoding name for a label (Encoding §4.2, "get an encoding"): -1 when there is none. */
static int encoding_of_label(JSContext *ctx, JSValue label) {
    JSStrView v = js_string_view(ctx, label);
    uint32_t start = 0, end = v.length;
    #define IS_WS(c) ((c) == 0x09 || (c) == 0x0A || (c) == 0x0C || (c) == 0x0D || (c) == 0x20)
    while (start < end && IS_WS(js_view_at(v, start))) start++;
    while (end > start && IS_WS(js_view_at(v, end - 1))) end--;
    #undef IS_WS
    char buf[24];
    if (end - start >= sizeof buf) return -1;
    for (uint32_t i = start; i < end; i++) {
        uint32_t c = js_view_at(v, i);
        if (c >= 0x80) return -1;
        buf[i - start] = (char)(c >= 'A' && c <= 'Z' ? c + 32 : c);
    }
    buf[end - start] = '\0';
    for (size_t i = 0; i < JS_COUNTOF(LABELS); i++)
        if (strcmp(LABELS[i].label, buf) == 0) return LABELS[i].encoding;
    return -1;
}

/* new TextDecoder(label = "utf-8", options = {}) */
BUILTIN(text_decoder_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "TextDecoder");
    JSValue label = js_is_undefined(ARG(0)) ? js_new_string_cstr(ctx, "utf-8") : js_to_string(ctx, ARG(0));
    if (js_is_exception(label)) return label;
    JSValue options = ARG(1);
    if (!js_is_undefined(options) && !js_is_null(options) && !js_is_object(options))
        return js_throw_invalid_arg_type(ctx, "options", "of type object", options);
    int encoding = encoding_of_label(ctx, label);
    if (encoding < 0) {
        char s[200];
        s[js_view_to_utf8(js_string_view(ctx, label), s, sizeof s - 1)] = '\0';
        return js_throw_node_error(ctx, JS_RANGE_ERROR, "ERR_ENCODING_NOT_SUPPORTED", "The \"%s\" encoding is not supported", s);
    }
    bool fatal = false, ignore_bom = false;
    if (js_is_object(options)) {
        JSValue f = js_get_value(ctx, options, js_atom_from_cstr(ctx, "fatal"));
        if (js_is_exception(f)) return f;
        fatal = js_truthy(f);
        JSValue b = js_get_value(ctx, options, js_atom_from_cstr(ctx, "ignoreBOM"));
        if (js_is_exception(b)) return b;
        ignore_bom = js_truthy(b);
    }
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_TEXT_DECODER_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    TextDecoderObject *d = (TextDecoderObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &text_decoder_class, proto, 0));
    d->encoding = (uint8_t)encoding;
    d->fatal = fatal;
    d->ignore_bom = ignore_bom;
    d->do_not_flush = false;
    reset_decoder(d);
    return js_object_value(&d->obj);
}

BUILTIN(text_decoder_encoding) {
    UNUSED_ARGS;
    THIS_DECODER();
    return js_new_string_cstr(ctx, ENCODING_NAMES[d->encoding]);
}

BUILTIN(text_decoder_fatal) {
    UNUSED_ARGS;
    THIS_DECODER();
    return js_bool(d->fatal);
}

BUILTIN(text_decoder_ignore_bom) {
    UNUSED_ARGS;
    THIS_DECODER();
    return js_bool(d->ignore_bom);
}

/* Node's inspection: `TextDecoder { encoding: 'utf-8', fatal: false, ignoreBOM: false }`, named
 * after the instance's constructor (a subclass shows its name). */
BUILTIN(text_decoder_inspect) {
    UNUSED_ARGS;
    THIS_DECODER();
    if (js_is_number(ARG(0)) && js_as_number(ARG(0)) < 0) return this_val;
    char name[96] = "TextDecoder";
    JSValue c = js_get_value(ctx, this_val, JS_ATOM(constructor));
    if (js_is_exception(c)) return c;
    if (js_is_object(c)) {
        JSValue n = js_get_value(ctx, c, JS_ATOM(name));
        if (js_is_exception(n)) return n;
        if (js_is_string(n) && js_string_length(n) != 0) name[js_view_to_utf8(js_string_view(ctx, n), name, sizeof name - 1)] = '\0';
    }
    char s[256];
    snprintf(s, sizeof s, "%s { encoding: '%s', fatal: %s, ignoreBOM: %s }", name, ENCODING_NAMES[d->encoding],
             d->fatal ? "true" : "false", d->ignore_bom ? "true" : "false");
    return js_new_string_cstr(ctx, s);
}

/* ---- Encoding ------------------------------------------------------------------------------ */

/* new TextEncoder() */
BUILTIN(text_encoder_ctor) {
    (void)callee, (void)this_val, (void)argc, (void)argv;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "TextEncoder");
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_TEXT_ENCODER_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    return js_object_value(js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &text_encoder_class, proto, 0)));
}

BUILTIN(text_encoder_encoding) {
    UNUSED_ARGS;
    THIS_ENCODER();
    return js_new_string_cstr(ctx, "utf-8");
}

/* encode(input = "") */
BUILTIN(text_encoder_encode) {
    UNUSED_ARGS;
    THIS_ENCODER();
    JSValue s = js_is_undefined(ARG(0)) ? js_empty_string() : js_to_string(ctx, ARG(0));
    if (js_is_exception(s)) return s;
    size_t n = js_view_to_utf8(js_string_view(ctx, s), NULL, 0);
    JSValue a = js_new_uint8_array(ctx, n);
    if (js_is_exception(a)) return a;
    uint8_t *bytes;
    size_t len;
    js_buffer_source_bytes(a, &bytes, &len);
    js_view_to_utf8(js_string_view(ctx, s), (char *)bytes, len);
    return a;
}

/* encodeInto(src, dest): { read, written }, without splitting a code point */
BUILTIN(text_encoder_encode_into) {
    UNUSED_ARGS;
    THIS_ENCODER();
    if (!js_is_string(ARG(0))) return js_throw_invalid_arg_type(ctx, "src", "of type string", ARG(0));
    if (!js_is_uint8_array(ARG(1))) return js_throw_invalid_arg_type(ctx, "dest", "an instance of Uint8Array", ARG(1));
    uint8_t *out;
    size_t cap;
    js_buffer_source_bytes(ARG(1), &out, &cap);
    JSStrView v = js_string_view(ctx, ARG(0));
    size_t read = 0, written = 0;
    while (read < v.length) {
        uint32_t c = js_view_at(v, (uint32_t)read), units = 1;
        if (c >= 0xD800 && c <= 0xDBFF && read + 1 < v.length) {
            uint32_t t = js_view_at(v, (uint32_t)read + 1);
            if (t >= 0xDC00 && t <= 0xDFFF) {
                c = 0x10000 + ((c - 0xD800) << 10) + (t - 0xDC00);
                units = 2;
            }
        }
        if (c >= 0xD800 && c <= 0xDFFF) c = 0xFFFD;
        size_t k = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
        if (written + k > cap) break;
        if (k == 1) {
            out[written] = (uint8_t)c;
        } else if (k == 2) {
            out[written] = (uint8_t)(0xC0 | (c >> 6));
            out[written + 1] = (uint8_t)(0x80 | (c & 0x3F));
        } else if (k == 3) {
            out[written] = (uint8_t)(0xE0 | (c >> 12));
            out[written + 1] = (uint8_t)(0x80 | ((c >> 6) & 0x3F));
            out[written + 2] = (uint8_t)(0x80 | (c & 0x3F));
        } else {
            out[written] = (uint8_t)(0xF0 | (c >> 18));
            out[written + 1] = (uint8_t)(0x80 | ((c >> 12) & 0x3F));
            out[written + 2] = (uint8_t)(0x80 | ((c >> 6) & 0x3F));
            out[written + 3] = (uint8_t)(0x80 | (c & 0x3F));
        }
        written += k;
        read += units;
    }
    JSValue r = js_new_object(ctx);
    js_define_data(ctx, js_as_object(r), js_atom_from_cstr(ctx, "read"), js_number((double)read), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(r), js_atom_from_cstr(ctx, "written"), js_number((double)written), JS_PROP_DEFAULT);
    return r;
}

/* Node's inspection: `{ encoding: 'utf-8' }`. */
BUILTIN(text_encoder_inspect) {
    UNUSED_ARGS;
    THIS_ENCODER();
    if (js_is_number(ARG(0)) && js_as_number(ARG(0)) < 0) return this_val;
    return js_new_string_cstr(ctx, "{ encoding: 'utf-8' }");
}

/* ---- Realm --------------------------------------------------------------------------------- */


static const JSBuiltin text_decoder_proto[] = {
    WEBIDL_OPERATION("decode", text_decoder_decode, 0),
    WEBIDL_ATTRIBUTE("encoding", text_decoder_encoding, NULL),
    WEBIDL_ATTRIBUTE("fatal", text_decoder_fatal, NULL),
    WEBIDL_ATTRIBUTE("ignoreBOM", text_decoder_ignore_bom, NULL),
};

static const JSBuiltin text_encoder_proto[] = {
    WEBIDL_ATTRIBUTE("encoding", text_encoder_encoding, NULL),
    WEBIDL_OPERATION("encode", text_encoder_encode, 0),
    WEBIDL_OPERATION("encodeInto", text_encoder_encode_into, 2),
};

static void define_class(JSContext *ctx, JSObject *global, const char *name, JSNativeFn ctor, JSIntrinsic slot,
                         const JSBuiltin *methods, size_t n, JSNativeFn inspect, const char *tag) {
    JSValue proto = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 8);
    ctx->intrinsics[slot] = proto;
    JSValue key = js_atom_from_cstr(ctx, name);
    JSValue c = js_new_native(ctx, ctor, key, 0, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), proto, 0);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), c, JS_BUILTIN_METHOD_ATTRS);
    js_define_builtins(ctx, js_as_object(proto), methods, n);
    JSValue f = js_new_native(ctx, inspect, js_new_string_cstr(ctx, "[nodejs.util.inspect.custom]"), 2, JS_FN_STRICT);
    js_define_data(ctx, js_as_object(proto), inspect_custom_key(ctx), f, JS_BUILTIN_METHOD_ATTRS);
    js_define_data(ctx, js_as_object(proto), JS_SYMBOL(toStringTag), js_new_string_cstr(ctx, tag), JS_PROP_CONFIGURABLE);
    js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
}

static void install_encoding(JSContext *ctx, JSObject *global) {
    define_class(ctx, global, "TextEncoder", text_encoder_ctor, JS_INTRINSIC_TEXT_ENCODER_PROTOTYPE, text_encoder_proto,
                 JS_COUNTOF(text_encoder_proto), text_encoder_inspect, "TextEncoder");
    define_class(ctx, global, "TextDecoder", text_decoder_ctor, JS_INTRINSIC_TEXT_DECODER_PROTOTYPE, text_decoder_proto,
                 JS_COUNTOF(text_decoder_proto), text_decoder_inspect, "TextDecoder");
}

const JSComponent js_component_encoding = { "encoding", install_encoding };
