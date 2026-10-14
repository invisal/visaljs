/* Node's error shapes for the web-standard host layer, written in C for the
 * components that throw them (the prelude has the same in JS, node/prelude/internal/errors.js). */
#include "js_web.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "internal.h"
#include "js_bigint.h"
#include "js_console.h"
#include "js_host.h"
#include "js_symbol.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_object.h"
#include "jscontext.h"
#include "jsstring.h"

JSValue js_throw_node_error(JSContext *ctx, JSErrorKind kind, const char *code, const char *fmt, ...) {
    char msg[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    JSValue s = js_new_string_cstr(ctx, msg);
    if (js_is_exception(s)) return s;
    JSValue e = js_new_error(ctx, kind, s);
    js_define_data(ctx, js_as_object(e), js_atom_from_cstr(ctx, "code"), js_new_string_cstr(ctx, code),
                   JS_PROP_WRITABLE | JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE);
    return js_throw(ctx, e);
}

JSValue js_throw_invalid_this(JSContext *ctx, const char *type) {
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_THIS", "Value of \"this\" must be of type %s", type);
}

JSValue js_throw_class_without_new(JSContext *ctx, const char *name) {
    return js_throw_type_error(ctx, "Class constructor %s cannot be invoked without 'new'", name);
}

static void to_utf8(JSContext *ctx, JSValue s, char *buf, size_t cap) {
    buf[js_view_to_utf8(js_string_view(ctx, s), buf, cap - 1)] = '\0';
}

/* The constructor name Node shows: value.constructor.name, when it is a non-empty string. */
static bool constructor_name(JSContext *ctx, JSValue v, char *buf, size_t cap) {
    JSValue c = js_get_value(ctx, v, JS_ATOM(constructor));
    if (js_is_exception(c)) {
        js_discard(js_take_exception(ctx));
        return false;
    }
    if (!js_is_object(c)) return false;
    JSValue n = js_get_value(ctx, c, JS_ATOM(name));
    if (js_is_exception(n)) {
        js_discard(js_take_exception(ctx));
        return false;
    }
    if (!js_is_string(n) || js_string_length(n) == 0) return false;
    to_utf8(ctx, n, buf, cap);
    return true;
}

void js_node_received(JSContext *ctx, JSValue v, char *buf, size_t cap) {
    char s[160];
    if (js_is_nullish(v)) {
        snprintf(buf, cap, " Received %s", js_is_null(v) ? "null" : "undefined");
    } else if (js_is_function(v)) {
        JSValue n = js_get_value(ctx, v, JS_ATOM(name));
        if (js_is_exception(n)) js_discard(js_take_exception(ctx));
        if (js_is_string(n)) to_utf8(ctx, n, s, sizeof s);
        else s[0] = '\0';  /* determineSpecificType: `function ${value.name}`, empty when anonymous */
        snprintf(buf, cap, " Received function %s", s);
    } else if (js_is_object(v)) {
        if (constructor_name(ctx, v, s, sizeof s)) snprintf(buf, cap, " Received an instance of %s", s);
        else snprintf(buf, cap, " Received [Object: null prototype] {}");
    } else {
        const char *type = js_is_string(v) ? "string" : js_is_symbol(v) ? "symbol" : js_is_bool(v) ? "boolean"
                         : js_is_bigint(v) ? "bigint" : "number";
        char shown[160];
        if (js_is_symbol(v)) {
            js_describe_value(ctx, v, shown, sizeof shown);
        } else {
            JSValue str = js_to_string(ctx, v);
            if (js_is_exception(str)) {
                js_discard(js_take_exception(ctx));
                str = js_empty_string();
            }
            to_utf8(ctx, str, s, sizeof s);
            snprintf(shown, sizeof shown, js_is_string(v) ? "'%s'" : js_is_bigint(v) ? "%sn" : "%s", s);
        }
        if (strlen(shown) > 28) strcpy(shown + 25, "...");  /* Node counts UTF-16 units; close enough for ASCII */
        snprintf(buf, cap, " Received type %s (%s)", type, shown);
    }
}

JSValue js_throw_invalid_arg_type(JSContext *ctx, const char *name, const char *expected, JSValue value) {
    char received[256];
    js_node_received(ctx, value, received, sizeof received);
    return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_ARG_TYPE", "The \"%s\" argument must be %s.%s", name, expected, received);
}

/* ---- What the web classes share ---------------------------------------------------------- */

JSValue js_new_closure_native(JSContext *ctx, JSNativeFn fn, uint32_t length, JSValue data) {
    JSValue f = js_new_native(ctx, fn, js_empty_string(), length, JS_FN_STRICT);
    js_store(ctx, &js_as_function(f)->obj.cell, &js_as_function(f)->home_object, data);
    return f;
}

JSValue js_closure_data(JSValue callee) { return js_as_function(callee)->home_object; }

JSValue js_inspect_as(JSContext *ctx, JSValue self, const char *fallback, JSValue object, JSValue depth, JSValue options) {
    char name[128];
    if (!constructor_name(ctx, self, name, sizeof name)) snprintf(name, sizeof name, "%s", fallback);
    return js_inspect_named(ctx, name, object, depth, options);
}

JSValue js_inspect_named(JSContext *ctx, const char *name, JSValue object, JSValue depth, JSValue options) {
    if (js_is_number(depth) && js_as_number(depth) < 0) return js_new_string_cstr(ctx, name);
    JSInspectOptions o = js_inspect_defaults;
    if (js_is_object(options) && js_inspect_options_from(ctx, options, &o) < 0) return JS_EXCEPTION;
    o.depth -= 1;  /* Node's: options.depth - 1 (the option, not the depth left) */
    JSValue s = js_inspect_with(ctx, object, &o);
    if (js_is_exception(s)) return s;
    char prefix[132];
    snprintf(prefix, sizeof prefix, "%s ", name);
    JSValue p = js_new_string_cstr(ctx, prefix);
    return js_is_exception(p) ? p : js_concat(ctx, p, s);
}

void js_define_inspect(JSContext *ctx, JSValue proto, JSNativeFn fn, const char *tag) {
    JSValue key = js_symbol_for(ctx, js_new_string_cstr(ctx, "nodejs.util.inspect.custom"));
    JSValue f = js_new_native(ctx, fn, js_new_string_cstr(ctx, "[nodejs.util.inspect.custom]"), 2, JS_FN_STRICT);
    js_define_data(ctx, js_as_object(proto), key, f, JS_BUILTIN_METHOD_ATTRS);
    js_define_data(ctx, js_as_object(proto), JS_SYMBOL(toStringTag), js_new_string_cstr(ctx, tag), JS_PROP_CONFIGURABLE);
}

JSValue js_define_web_class(JSContext *ctx, JSObject *global, const char *name, JSNativeFn ctor, uint32_t length,
                            JSValue parent, JSIntrinsic slot) {
    JSValue proto = js_new_object_proto(ctx, parent, 16);
    ctx->intrinsics[slot] = proto;
    JSValue key = js_atom_from_cstr(ctx, name);
    JSValue c = js_new_native(ctx, ctor, key, length, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), proto, 0);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), c, JS_BUILTIN_METHOD_ATTRS);
    js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
    return c;
}

/* ---- UTF-8 ------------------------------------------------------------------------------- */

/* UTF-8 bytes to a string, as WHATWG decodes them (U+FFFD for each maximal invalid subpart). */
JSValue js_decode_utf8_bytes(JSContext *ctx, const uint8_t *p, size_t n) {
    size_t i = 0;
    while (i < n && p[i] < 0x80) i++;
    if (i == n) return js_new_string_latin1(ctx, p, (uint32_t)n);
    uint16_t *out = malloc((n + 1) * sizeof *out);
    if (!out) js_fatal("out of memory decoding UTF-8");
    size_t u = 0;
    for (size_t k = 0; k < i; k++) out[u++] = p[k];
    while (i < n) {
        uint8_t b = p[i];
        if (b < 0x80) {
            out[u++] = b;
            i++;
            continue;
        }
        size_t need;
        uint32_t cp;
        uint8_t lower = 0x80, upper = 0xBF;
        if (b >= 0xC2 && b <= 0xDF) need = 1, cp = b & 0x1F;
        else if (b >= 0xE0 && b <= 0xEF) {
            need = 2, cp = b & 0x0F;
            if (b == 0xE0) lower = 0xA0;
            if (b == 0xED) upper = 0x9F;
        } else if (b >= 0xF0 && b <= 0xF4) {
            need = 3, cp = b & 0x07;
            if (b == 0xF0) lower = 0x90;
            if (b == 0xF4) upper = 0x8F;
        } else {
            out[u++] = 0xFFFD;
            i++;
            continue;
        }
        size_t k = 1;
        for (; k <= need; k++) {
            if (i + k >= n) break;
            uint8_t c = p[i + k];
            if (c < lower || c > upper) break;
            lower = 0x80, upper = 0xBF;
            cp = cp << 6 | (c & 0x3F);
        }
        if (k <= need) {  /* a maximal invalid subpart: one U+FFFD for the bytes so far */
            out[u++] = 0xFFFD;
            i += k;
            continue;
        }
        i += need + 1;
        if (cp > 0xFFFF) {
            cp -= 0x10000;
            out[u++] = (uint16_t)(0xD800 + (cp >> 10));
            out[u++] = (uint16_t)(0xDC00 + (cp & 0x3FF));
        } else {
            out[u++] = (uint16_t)cp;
        }
    }
    JSValue s = js_new_string_utf16(ctx, out, (uint32_t)u);
    free(out);
    return s;
}


/* cloneClass(value): an object's internal class, as structuredClone (node/prelude/internal/
 * structured_clone.js) sorts values: "Object" (an ordinary object, a class instance's too),
 * "Array", "Date", "Map", "TypedArray", "Proxy", "Arguments", "Function", a primitive wrapper's
 * type ("Number", "String", …), a web class's name ("URL", "Blob", …); undefined for a primitive. */
JSValue js_host_clone_class(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    JSValue v = ARG(0);
    if (!js_is_object(v)) return JS_UNDEFINED;
    if (js_is_function(v)) return js_new_string_cstr(ctx, "Function");
    if (js_is_wrapper(v)) {
        JSValue p = js_wrapped_value(v);
        return js_new_string_cstr(ctx, js_is_string(p) ? "String" : js_is_number(p) ? "Number" : js_is_bool(p) ? "Boolean"
                                       : js_is_bigint(p) ? "BigInt" : "Symbol");
    }
    return js_new_string_cstr(ctx, js_as_object(v)->shape->cls->name);
}
