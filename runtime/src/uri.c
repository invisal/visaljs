/* The URI handling functions (§19.2.6): encodeURI, encodeURIComponent, decodeURI and
 * decodeURIComponent. Core built-ins: their entries are in js_core.def. */
#include "builtins_util.h"

#include <stdlib.h>
#include <string.h>

#include "js_convert.h"
#include "js_exception.h"
#include "jsstring.h"

/* ---- A growable UTF-16 buffer ------------------------------------------------------------- */

typedef struct {
    uint16_t *units;
    size_t length, cap;
} Units;

static void put(Units *b, uint32_t u) {
    if (b->length == b->cap) {
        b->cap = b->cap ? b->cap * 2 : 64;
        b->units = realloc(b->units, b->cap * sizeof *b->units);
        if (!b->units) js_fatal("out of memory building a string");
    }
    b->units[b->length++] = (uint16_t)u;
}

static JSValue finish(JSContext *ctx, Units *b) {
    if (b->length > JS_STRING_MAX_LENGTH) {
        free(b->units);
        return js_throw_range_error(ctx, "Invalid string length");
    }
    JSValue s = js_new_string_utf16(ctx, b->units, (uint32_t)b->length);
    free(b->units);
    return s;
}

static JSValue malformed(JSContext *ctx, Units *b) {
    free(b->units);
    return js_throw_uri_error(ctx, "URI malformed");
}

/* ---- Encode (§19.2.6.5) ------------------------------------------------------------------- */

/* uriReserved and "#": what encodeURI leaves as it is, on top of the unreserved marks */
static const char URI_RESERVED[] = ";/?:@&=+$,#";

static bool unescaped(uint32_t c, bool component) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return true;
    if (c && c < 0x80 && strchr("-_.!~*'()", (int)c)) return true;
    return !component && c && c < 0x80 && strchr(URI_RESERVED, (int)c);
}

static JSValue encode(JSContext *ctx, JSValue arg, bool component) {
    static const char HEX[] = "0123456789ABCDEF";
    JSValue s = js_to_string(ctx, arg);
    if (js_is_exception(s)) return JS_EXCEPTION;
    JSStrView v = js_string_view(ctx, s);
    Units b = {0};
    for (uint32_t k = 0; k < v.length; k++) {
        uint32_t c = js_view_at(v, k);
        if (unescaped(c, component)) {
            put(&b, c);
            continue;
        }
        /* CodePointAt: an unpaired surrogate can't be encoded */
        if (c >= 0xDC00 && c <= 0xDFFF) return malformed(ctx, &b);
        if (c >= 0xD800 && c <= 0xDBFF) {
            uint32_t d = k + 1 < v.length ? js_view_at(v, k + 1) : 0;
            if (d < 0xDC00 || d > 0xDFFF) return malformed(ctx, &b);
            c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
            k++;
        }
        uint8_t bytes[4];
        int n;
        if (c < 0x80) bytes[0] = (uint8_t)c, n = 1;
        else if (c < 0x800) bytes[0] = (uint8_t)(0xC0 | c >> 6), bytes[1] = (uint8_t)(0x80 | (c & 0x3F)), n = 2;
        else if (c < 0x10000) bytes[0] = (uint8_t)(0xE0 | c >> 12), bytes[1] = (uint8_t)(0x80 | (c >> 6 & 0x3F)), bytes[2] = (uint8_t)(0x80 | (c & 0x3F)), n = 3;
        else bytes[0] = (uint8_t)(0xF0 | c >> 18), bytes[1] = (uint8_t)(0x80 | (c >> 12 & 0x3F)), bytes[2] = (uint8_t)(0x80 | (c >> 6 & 0x3F)), bytes[3] = (uint8_t)(0x80 | (c & 0x3F)), n = 4;
        for (int i = 0; i < n; i++) {
            put(&b, '%');
            put(&b, (uint8_t)HEX[bytes[i] >> 4]);
            put(&b, (uint8_t)HEX[bytes[i] & 0xF]);
        }
    }
    return finish(ctx, &b);
}

/* ---- Decode (§19.2.6.6) ------------------------------------------------------------------- */

static int hex_digit(uint32_t c) {
    if (c >= '0' && c <= '9') return (int)(c - '0');
    if (c >= 'a' && c <= 'f') return (int)(c - 'a' + 10);
    if (c >= 'A' && c <= 'F') return (int)(c - 'A' + 10);
    return -1;
}

/* The byte of "%XX" at k, or -1 */
static int escaped_byte(JSStrView v, uint32_t k) {
    if (k + 2 >= v.length || js_view_at(v, k) != '%') return -1;
    int hi = hex_digit(js_view_at(v, k + 1)), lo = hex_digit(js_view_at(v, k + 2));
    return hi < 0 || lo < 0 ? -1 : hi << 4 | lo;
}

static JSValue decode(JSContext *ctx, JSValue arg, bool component) {
    JSValue s = js_to_string(ctx, arg);
    if (js_is_exception(s)) return JS_EXCEPTION;
    JSStrView v = js_string_view(ctx, s);
    Units b = {0};
    for (uint32_t k = 0; k < v.length; k++) {
        uint32_t c = js_view_at(v, k);
        if (c != '%') {
            put(&b, c);
            continue;
        }
        int byte = escaped_byte(v, k);
        if (byte < 0) return malformed(ctx, &b);
        if (byte < 0x80) {
            /* decodeURI keeps an escaped reserved character escaped */
            if (!component && byte && strchr(URI_RESERVED, byte)) {
                for (uint32_t i = k; i < k + 3; i++) put(&b, js_view_at(v, i));
            } else {
                put(&b, (uint32_t)byte);
            }
            k += 2;
            continue;
        }
        /* a UTF-8 sequence of 2 to 4 bytes, each escaped; overlong forms, surrogates and code
         * points past U+10FFFF are malformed */
        int n = byte >= 0xF0 && byte <= 0xF4 ? 4 : byte >= 0xE0 ? 3 : byte >= 0xC2 && byte < 0xE0 ? 2 : 0;
        if (!n || byte > 0xF4) return malformed(ctx, &b);
        uint32_t cp = (uint32_t)byte & (0x7F >> n);
        for (int i = 1; i < n; i++) {
            int cont = escaped_byte(v, k + 3 * (uint32_t)i);
            if (cont < 0 || (cont & 0xC0) != 0x80) return malformed(ctx, &b);
            cp = cp << 6 | ((uint32_t)cont & 0x3F);
        }
        static const uint32_t MIN[] = {0, 0, 0x80, 0x800, 0x10000};
        if (cp < MIN[n] || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return malformed(ctx, &b);
        if (cp < 0x10000) {
            put(&b, cp);
        } else {
            put(&b, 0xD800 + ((cp - 0x10000) >> 10));
            put(&b, 0xDC00 + ((cp - 0x10000) & 0x3FF));
        }
        k += 3 * (uint32_t)n - 1;
    }
    return finish(ctx, &b);
}

CORE(global_encode_uri) {
    UNUSED_ARGS;
    return encode(ctx, ARG(0), false);
}

CORE(global_encode_uri_component) {
    UNUSED_ARGS;
    return encode(ctx, ARG(0), true);
}

CORE(global_decode_uri) {
    UNUSED_ARGS;
    return decode(ctx, ARG(0), false);
}

CORE(global_decode_uri_component) {
    UNUSED_ARGS;
    return decode(ctx, ARG(0), true);
}
