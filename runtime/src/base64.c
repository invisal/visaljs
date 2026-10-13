/* atob and btoa (HTML §8.3, forgiving-base64 in Infra §4.7), the base64 component,
 * which needs domexception: Node's checks, in Node's order, and its DOMExceptions. */
#include <stdlib.h>

#include "builtins_util.h"
#include "internal.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

static const char ALPHABET[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int sextet(uint32_t c) {
    if (c >= 'A' && c <= 'Z') return (int)(c - 'A');
    if (c >= 'a' && c <= 'z') return (int)(c - 'a' + 26);
    if (c >= '0' && c <= '9') return (int)(c - '0' + 52);
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static bool ascii_whitespace(uint32_t c) { return c == 0x09 || c == 0x0A || c == 0x0C || c == 0x0D || c == 0x20; }

static JSValue string_arg(JSContext *ctx, uint32_t argc, const JSValue *argv) {
    if (argc == 0) return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_MISSING_ARGS", "The \"input\" argument must be specified");
    return js_to_string(ctx, argv[0]);
}

/* btoa(data): the Latin-1 string's bytes, in base64 */
BUILTIN(btoa) {
    (void)callee, (void)this_val, (void)new_target;
    JSValue s = string_arg(ctx, argc, argv);
    if (js_is_exception(s)) return s;
    JSStrView v = js_string_view(ctx, s);
    for (uint32_t i = 0; i < v.length; i++)
        if (js_view_at(v, i) > 0xFF) return js_throw_dom_exception(ctx, "InvalidCharacterError", "Invalid character");
    size_t n = ((size_t)v.length + 2) / 3 * 4;
    if (n > JS_STRING_MAX_LENGTH) return js_throw_range_error(ctx, "Invalid string length");
    uint8_t *out = malloc(n ? n : 1);
    if (!out) js_fatal("out of memory in btoa");
    size_t k = 0;
    for (uint32_t i = 0; i < v.length; i += 3) {
        uint32_t rest = v.length - i;
        uint32_t b = js_view_at(v, i) << 16 | (rest > 1 ? js_view_at(v, i + 1) << 8 : 0) | (rest > 2 ? js_view_at(v, i + 2) : 0);
        out[k++] = (uint8_t)ALPHABET[b >> 18];
        out[k++] = (uint8_t)ALPHABET[(b >> 12) & 63];
        out[k++] = rest > 1 ? (uint8_t)ALPHABET[(b >> 6) & 63] : '=';
        out[k++] = rest > 2 ? (uint8_t)ALPHABET[b & 63] : '=';
    }
    JSValue r = js_new_string_latin1(ctx, out, (uint32_t)n);
    free(out);
    return r;
}

/* atob(data): forgiving-base64 decode, as a Latin-1 string */
BUILTIN(atob) {
    (void)callee, (void)this_val, (void)new_target;
    JSValue s = string_arg(ctx, argc, argv);
    if (js_is_exception(s)) return s;
    JSStrView v = js_string_view(ctx, s);
    /* Node's validation: whitespace anywhere, `=` only at the end (at most two) */
    size_t significant = 0, equals = 0;
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        if (ascii_whitespace(c)) continue;
        if (c != '=' && sextet(c) < 0) return js_throw_dom_exception(ctx, "InvalidCharacterError", "Invalid character");
        significant++;
        if (c == '=') equals++;
        else if (equals) return js_throw_dom_exception(ctx, "InvalidCharacterError", "Invalid character");
        if (equals > 2) return js_throw_dom_exception(ctx, "InvalidCharacterError", "Invalid character");
    }
    size_t remainder = significant % 4;
    if (!remainder) remainder = (significant - equals) % 4;
    else if (equals) return js_throw_dom_exception(ctx, "InvalidCharacterError", "Invalid character");
    if (remainder == 1)
        return js_throw_dom_exception(ctx, "InvalidCharacterError", "The string to be decoded is not correctly encoded.");
    uint8_t *out = malloc(significant ? significant : 1);  /* 3 bytes per 4 characters */
    if (!out) js_fatal("out of memory in atob");
    size_t k = 0, bits = 0;
    uint32_t acc = 0;
    for (uint32_t i = 0; i < v.length; i++) {
        int x = sextet(js_view_at(v, i));
        if (x < 0) continue;
        acc = acc << 6 | (uint32_t)x;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[k++] = (uint8_t)(acc >> bits);
        }
    }
    JSValue r = js_new_string_latin1(ctx, out, (uint32_t)k);
    free(out);
    return r;
}

static const JSBuiltin base64_globals[] = {  /* Node defines them enumerable */
    { "atob", NULL, JS_BUILTIN_KIND_FN, JS_PROP_DEFAULT, 1, atob, NULL, 0, NULL },
    { "btoa", NULL, JS_BUILTIN_KIND_FN, JS_PROP_DEFAULT, 1, btoa, NULL, 0, NULL },
};

static void install_base64(JSContext *ctx, JSObject *global) {
    js_define_builtins(ctx, global, base64_globals, JS_COUNTOF(base64_globals));
}

const JSComponent js_component_base64 = { "base64", install_base64 };
