/* String and String.prototype (§22.1): core built-ins. Case conversion and
 * normalization use QuickJS's libunicode (vendored with libregexp); the regex-based methods
 * dispatch to @@match/@@replace/@@search/@@split on their argument as the spec makes them, and
 * create a RegExp (the RegExp component) only where the spec does. */
#include "builtins_util.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_exception.h"
#include "js_ops.h"
#include "jsstring.h"
#include "cutils.h"      /* QuickJS's helpers, which libunicode.h expects */
#include "libunicode.h"

/* ---- A growable UTF-16 buffer ------------------------------------------------------------- */

typedef struct {
    uint16_t *units;
    size_t length, cap;
} Builder;

static void reserve(Builder *b, size_t more) {
    if (b->length + more <= b->cap) return;
    size_t cap = b->cap ? b->cap * 2 : 64;
    while (cap < b->length + more) cap *= 2;
    uint16_t *u = realloc(b->units, cap * sizeof *u);
    if (!u) js_fatal("out of memory building a string");
    b->units = u;
    b->cap = cap;
}

static void put_unit(Builder *b, uint32_t u) {
    reserve(b, 1);
    b->units[b->length++] = (uint16_t)u;
}

static void put_code_point(Builder *b, uint32_t c) {
    if (c < 0x10000) {
        put_unit(b, c);
    } else {
        put_unit(b, 0xD800 + ((c - 0x10000) >> 10));
        put_unit(b, 0xDC00 + ((c - 0x10000) & 0x3FF));
    }
}

static void put_view(Builder *b, JSStrView v, uint32_t start, uint32_t end) {
    reserve(b, end - start);
    for (uint32_t i = start; i < end; i++) b->units[b->length++] = (uint16_t)js_view_at(v, i);
}

static void put_ascii(Builder *b, const char *s) {
    while (*s) put_unit(b, (uint8_t)*s++);
}

static JSValue finish(JSContext *ctx, Builder *b) {
    if (b->length > JS_STRING_MAX_LENGTH) {
        free(b->units);
        return js_throw_range_error(ctx, "Invalid string length");
    }
    JSValue s = js_new_string_utf16(ctx, b->units, (uint32_t)b->length);
    free(b->units);
    return s;
}

/* The code point at i (a lone surrogate is itself); *next is where the next one starts. */
static uint32_t code_point_at(JSStrView v, uint32_t i, uint32_t *next) {
    uint32_t c = js_view_at(v, i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < v.length) {
        uint32_t d = js_view_at(v, i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) {
            *next = i + 2;
            return 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
        }
    }
    *next = i + 1;
    return c;
}

/* ---- Helpers ---------------------------------------------------------------------------- */

/* RequireObjectCoercible(this), then ToString. */
static JSValue this_string(JSContext *ctx, JSValue v, const char *method) {
    if (!js_require_this(ctx, v, method)) return JS_EXCEPTION;
    return js_to_string(ctx, v);
}

/* StringIndexOf (§6.1.4.1): the first match at or after `from`, or -1. */
static int64_t index_of(JSStrView h, JSStrView n, uint32_t from) {
    if (n.length > h.length) return -1;
    for (uint32_t i = from; i + n.length <= h.length; i++) {
        uint32_t j = 0;
        while (j < n.length && js_view_at(h, i + j) == js_view_at(n, j)) j++;
        if (j == n.length) return i;
    }
    return -1;
}

static bool is_white_space(uint32_t c) {
    switch (c) {
    case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0: case 0x1680:
    case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
        return true;
    default:
        return c >= 0x2000 && c <= 0x200A;
    }
}

/* IsRegExp (§7.2.8): an object whose @@match is truthy (or, with none, a RegExp). */
static int is_regexp(JSContext *ctx, JSValue v) {
    if (!js_is_object(v)) return 0;
    JSValue matcher = js_get_value(ctx, v, JS_SYMBOL(match));
    if (js_is_exception(matcher)) return -1;
    if (!js_is_undefined(matcher)) return js_truthy(matcher);
    return strcmp(js_as_object(v)->shape->cls->name, "RegExp") == 0;
}

/* GetMethod (§7.3.10): undefined for null or undefined, a TypeError if not callable. */
static JSValue get_method(JSContext *ctx, JSValue v, JSValue key) {
    JSValue f = js_get_value(ctx, v, key);
    if (js_is_exception(f) || js_is_nullish(f)) return js_is_exception(f) ? f : JS_UNDEFINED;
    if (!js_is_callable(f)) return js_throw_type_error(ctx, "%s is not a function", "Symbol method");
    return f;
}

/* RegExpCreate (§22.2.3.1), through the RegExp component. */
static JSValue regexp_create(JSContext *ctx, JSValue pattern, const char *flags, const char *method) {
    JSValue ctor = ctx->intrinsics[JS_INTRINSIC_REGEXP];
    if (!js_is_function(ctor)) return js_throw_type_error(ctx, "%s needs RegExp (not supported yet)", method);
    JSValue args[2] = { js_is_undefined(pattern) ? js_empty_string() : pattern, flags ? js_new_string_cstr(ctx, flags) : JS_UNDEFINED };
    return js_construct(ctx, ctor, 2, args, ctor, NULL);
}

/* ---- String (§22.1.1, §22.1.2) ---------------------------------------------------------- */

static JSValue string_ctor(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    JSValue s;
    if (!argc) s = js_empty_string();
    else if (js_is_undefined(new_target) && js_is_symbol(argv[0])) return js_symbol_descriptive_string(ctx, argv[0]);  /* String(sym) */
    else s = js_to_string(ctx, argv[0]);
    if (js_is_exception(s) || js_is_undefined(new_target)) return s;
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_STRING_PROTOTYPE);
    return js_is_exception(proto) ? proto : js_new_wrapper(ctx, s, proto);
}

CORE(string_from_char_code) {
    UNUSED_ARGS;
    Builder b = { 0 };
    for (uint32_t i = 0; i < argc; i++) {
        double d;
        if (js_to_number(ctx, &d, argv[i]) < 0) {
            free(b.units);
            return JS_EXCEPTION;
        }
        put_unit(&b, (uint16_t)js_double_to_int32(d));
    }
    return finish(ctx, &b);
}

CORE(string_from_code_point) {
    UNUSED_ARGS;
    Builder b = { 0 };
    for (uint32_t i = 0; i < argc; i++) {
        double d;
        if (js_to_number(ctx, &d, argv[i]) < 0) {
            free(b.units);
            return JS_EXCEPTION;
        }
        if (d != floor(d) || d < 0 || d > 0x10FFFF) {
            free(b.units);
            JSValue shown = js_to_string(ctx, argv[i]);
            if (js_is_exception(shown)) return shown;
            JSValue prefix = js_new_string_cstr(ctx, "Invalid code point ");
            JSValue m = js_concat(ctx, prefix, shown);
            return js_is_exception(m) ? m : js_throw(ctx, js_new_error(ctx, JS_RANGE_ERROR, m));
        }
        put_code_point(&b, (uint32_t)d);
    }
    return finish(ctx, &b);
}

/* String.raw(template, ...substitutions) (§22.1.2.4) */
CORE(string_raw) {
    UNUSED_ARGS;
    if (js_is_nullish(ARG(0))) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    JSValue raw = js_get_value(ctx, ARG(0), js_atom_from_cstr(ctx, "raw"));
    if (js_is_exception(raw)) return raw;
    if (js_is_nullish(raw)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    double len;
    if (js_length_of_array_like(ctx, raw, &len) < 0) return JS_EXCEPTION;
    JSValue r = js_empty_string();
    for (double i = 0; i < len; i++) {
        JSValue seg = js_get_value(ctx, raw, js_index_key_of(ctx, i));
        if (!js_is_exception(seg)) seg = js_to_string(ctx, seg);
        if (js_is_exception(seg) || js_is_exception(r = js_concat(ctx, r, seg))) return JS_EXCEPTION;
        if (i + 1 < len && i + 1 < argc) {
            JSValue sub = js_to_string(ctx, argv[(uint32_t)i + 1]);
            if (js_is_exception(sub) || js_is_exception(r = js_concat(ctx, r, sub))) return JS_EXCEPTION;
        }
    }
    return r;
}

/* ---- String.prototype (§22.1.3) ------------------------------------------------------------ */

CORE(string_proto_at) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.at");
    double rel;
    if (js_is_exception(s) || js_to_integer_or_infinity(ctx, &rel, ARG(0)) < 0) return JS_EXCEPTION;
    double len = js_string_length(s), k = rel >= 0 ? rel : len + rel;
    if (k < 0 || k >= len) return JS_UNDEFINED;
    return js_substring(ctx, s, (uint32_t)k, (uint32_t)k + 1);
}

CORE(string_proto_char_at) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.charAt");
    double pos;
    if (js_is_exception(s) || js_to_integer_or_infinity(ctx, &pos, ARG(0)) < 0) return JS_EXCEPTION;
    if (pos < 0 || pos >= js_string_length(s)) return js_empty_string();
    return js_substring(ctx, s, (uint32_t)pos, (uint32_t)pos + 1);
}

CORE(string_proto_char_code_at) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.charCodeAt");
    double pos;
    if (js_is_exception(s) || js_to_integer_or_infinity(ctx, &pos, ARG(0)) < 0) return JS_EXCEPTION;
    JSStrView v = js_string_view(ctx, s);
    if (pos < 0 || pos >= v.length) return js_double(NAN);
    return js_int32((int32_t)js_view_at(v, (uint32_t)pos));
}

CORE(string_proto_code_point_at) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.codePointAt");
    double pos;
    if (js_is_exception(s) || js_to_integer_or_infinity(ctx, &pos, ARG(0)) < 0) return JS_EXCEPTION;
    JSStrView v = js_string_view(ctx, s);
    if (pos < 0 || pos >= v.length) return JS_UNDEFINED;
    uint32_t next;
    return js_int32((int32_t)code_point_at(v, (uint32_t)pos, &next));
}

CORE(string_proto_concat) {
    UNUSED_ARGS;
    JSValue r = this_string(ctx, this_val, "String.prototype.concat");
    for (uint32_t i = 0; i < argc && !js_is_exception(r); i++) {
        JSValue s = js_to_string(ctx, argv[i]);
        r = js_is_exception(s) ? s : js_concat(ctx, r, s);
    }
    return r;
}

/* startsWith / endsWith / includes: the search string may not be a RegExp. */
static JSValue search_string(JSContext *ctx, JSValue v, const char *method) {
    int re = is_regexp(ctx, v);
    if (re < 0) return JS_EXCEPTION;
    if (re) return js_throw_type_error(ctx, "First argument to %s must not be a regular expression", method);
    return js_to_string(ctx, v);
}

CORE(string_proto_ends_with) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.endsWith");
    JSValue search = js_is_exception(s) ? s : search_string(ctx, ARG(0), "String.prototype.endsWith");
    if (js_is_exception(search)) return search;
    double len = js_string_length(s), end = len;
    if (!js_is_undefined(ARG(1))) {
        if (js_to_integer_or_infinity(ctx, &end, ARG(1)) < 0) return JS_EXCEPTION;
        end = fmin(fmax(end, 0), len);
    }
    double n = js_string_length(search), start = end - n;
    if (start < 0) return JS_FALSE;
    JSStrView h = js_string_view(ctx, s), sv = js_string_view(ctx, search);
    for (uint32_t i = 0; i < n; i++)
        if (js_view_at(h, (uint32_t)start + i) != js_view_at(sv, i)) return JS_FALSE;
    return JS_TRUE;
}

CORE(string_proto_starts_with) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.startsWith");
    JSValue search = js_is_exception(s) ? s : search_string(ctx, ARG(0), "String.prototype.startsWith");
    if (js_is_exception(search)) return search;
    double len = js_string_length(s), start;
    if (js_to_integer_or_infinity(ctx, &start, ARG(1)) < 0) return JS_EXCEPTION;
    start = fmin(fmax(start, 0), len);
    double n = js_string_length(search);
    if (start + n > len) return JS_FALSE;
    JSStrView h = js_string_view(ctx, s), sv = js_string_view(ctx, search);
    for (uint32_t i = 0; i < n; i++)
        if (js_view_at(h, (uint32_t)start + i) != js_view_at(sv, i)) return JS_FALSE;
    return JS_TRUE;
}

CORE(string_proto_includes) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.includes");
    JSValue search = js_is_exception(s) ? s : search_string(ctx, ARG(0), "String.prototype.includes");
    if (js_is_exception(search)) return search;
    double pos;
    if (js_to_integer_or_infinity(ctx, &pos, ARG(1)) < 0) return JS_EXCEPTION;
    double len = js_string_length(s);
    pos = fmin(fmax(pos, 0), len);
    return js_bool(index_of(js_string_view(ctx, s), js_string_view(ctx, search), (uint32_t)pos) >= 0);
}

CORE(string_proto_index_of) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.indexOf");
    JSValue search = js_is_exception(s) ? s : js_to_string(ctx, ARG(0));
    double pos;
    if (js_is_exception(search) || js_to_integer_or_infinity(ctx, &pos, ARG(1)) < 0) return JS_EXCEPTION;
    double len = js_string_length(s);
    pos = fmin(fmax(pos, 0), len);
    return js_number((double)index_of(js_string_view(ctx, s), js_string_view(ctx, search), (uint32_t)pos));
}

CORE(string_proto_last_index_of) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.lastIndexOf");
    JSValue search = js_is_exception(s) ? s : js_to_string(ctx, ARG(0));
    double num;
    if (js_is_exception(search) || js_to_number(ctx, &num, ARG(1)) < 0) return JS_EXCEPTION;
    double len = js_string_length(s), n = js_string_length(search);
    double pos = num != num ? INFINITY : num == INFINITY || num == -INFINITY ? num : trunc(num);
    double start = fmin(fmax(pos, 0), len);
    if (n > len) return js_int32(-1);
    JSStrView h = js_string_view(ctx, s), sv = js_string_view(ctx, search);
    for (double i = fmin(start, len - n); i >= 0; i--) {
        uint32_t j = 0;
        while (j < n && js_view_at(h, (uint32_t)i + j) == js_view_at(sv, j)) j++;
        if (j == n) return js_number(i);
    }
    return js_int32(-1);
}

CORE(string_proto_is_well_formed) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.isWellFormed");
    if (js_is_exception(s)) return s;
    JSStrView v = js_string_view(ctx, s);
    for (uint32_t i = 0, next; i < v.length; i = next) {
        uint32_t c = code_point_at(v, i, &next);
        if (c >= 0xD800 && c <= 0xDFFF) return JS_FALSE;
    }
    return JS_TRUE;
}

CORE(string_proto_to_well_formed) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.toWellFormed");
    if (js_is_exception(s)) return s;
    JSStrView v = js_string_view(ctx, s);
    Builder b = { 0 };
    for (uint32_t i = 0, next; i < v.length; i = next) {
        uint32_t c = code_point_at(v, i, &next);
        put_code_point(&b, c >= 0xD800 && c <= 0xDFFF ? 0xFFFD : c);
    }
    return finish(ctx, &b);
}

/* localeCompare without Intl: by code units. Node compares by ICU collation,
 * which differs for mixed case and accents. */
CORE(string_proto_locale_compare) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.localeCompare");
    JSValue that = js_is_exception(s) ? s : js_to_string(ctx, ARG(0));
    if (js_is_exception(that)) return that;
    int c = js_string_compare(ctx, s, that);
    return js_int32(c < 0 ? -1 : c > 0 ? 1 : 0);
}

CORE(string_proto_normalize) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.normalize");
    if (js_is_exception(s)) return s;
    UnicodeNormalizationEnum form = UNICODE_NFC;
    if (!js_is_undefined(ARG(0))) {
        JSValue f = js_to_string(ctx, ARG(0));
        if (js_is_exception(f)) return f;
        char name[8] = { 0 };
        JSStrView fv = js_string_view(ctx, f);
        for (uint32_t i = 0; i < fv.length && i < 7; i++) name[i] = (char)js_view_at(fv, i);
        if (fv.length > 4 || !strcmp(name, "")) form = (UnicodeNormalizationEnum)-1;
        else if (!strcmp(name, "NFC")) form = UNICODE_NFC;
        else if (!strcmp(name, "NFD")) form = UNICODE_NFD;
        else if (!strcmp(name, "NFKC")) form = UNICODE_NFKC;
        else if (!strcmp(name, "NFKD")) form = UNICODE_NFKD;
        else form = (UnicodeNormalizationEnum)-1;
        if ((int)form < 0) return js_throw_range_error(ctx, "The normalization form should be one of NFC, NFD, NFKC, NFKD.");
    }
    JSStrView v = js_string_view(ctx, s);
    uint32_t *cps = malloc((v.length ? v.length : 1) * sizeof *cps);
    if (!cps) js_fatal("out of memory");
    int n = 0;
    for (uint32_t i = 0, next; i < v.length; i = next) cps[n++] = code_point_at(v, i, &next);
    uint32_t *out = NULL;
    int len = unicode_normalize(&out, cps, n, form, NULL, NULL);
    free(cps);
    if (len < 0) js_fatal("out of memory normalizing");
    Builder b = { 0 };
    for (int i = 0; i < len; i++) put_code_point(&b, out[i]);
    free(out);
    return finish(ctx, &b);
}

/* padStart / padEnd (§22.1.3.17.1 StringPaddingBuiltinsImpl) */
static JSValue pad(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, bool start, const char *method) {
    JSValue s = this_string(ctx, this_val, method);
    double max_len;
    if (js_is_exception(s) || js_to_integer_or_infinity(ctx, &max_len, ARG(0)) < 0) return JS_EXCEPTION;
    double len = js_string_length(s);
    if (max_len <= len) return s;
    JSValue fill = js_is_undefined(ARG(1)) ? js_char_string(' ') : js_to_string(ctx, ARG(1));
    if (js_is_exception(fill)) return fill;
    if (js_string_length(fill) == 0) return s;
    if (max_len > JS_STRING_MAX_LENGTH) return js_throw_range_error(ctx, "Invalid string length");
    JSStrView f = js_string_view(ctx, fill), sv = js_string_view(ctx, s);
    Builder b = { 0 };
    if (!start) put_view(&b, sv, 0, sv.length);
    for (double i = 0; i < max_len - len; i++) put_unit(&b, js_view_at(f, (uint32_t)fmod(i, f.length)));
    if (start) put_view(&b, sv, 0, sv.length);
    return finish(ctx, &b);
}

CORE(string_proto_pad_end) {
    UNUSED_ARGS;
    return pad(ctx, this_val, argc, argv, false, "String.prototype.padEnd");
}

CORE(string_proto_pad_start) {
    UNUSED_ARGS;
    return pad(ctx, this_val, argc, argv, true, "String.prototype.padStart");
}

CORE(string_proto_repeat) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.repeat");
    double n;
    if (js_is_exception(s) || js_to_integer_or_infinity(ctx, &n, ARG(0)) < 0) return JS_EXCEPTION;
    if (n < 0 || n == INFINITY) {
        JSValue shown = js_to_string(ctx, js_number(n));
        JSValue m = js_is_exception(shown) ? shown : js_concat(ctx, js_new_string_cstr(ctx, "Invalid count value: "), shown);
        return js_is_exception(m) ? m : js_throw(ctx, js_new_error(ctx, JS_RANGE_ERROR, m));
    }
    double len = js_string_length(s);
    if (n == 0 || len == 0) return js_empty_string();
    if (len * n > JS_STRING_MAX_LENGTH) return js_throw_range_error(ctx, "Invalid string length");
    JSStrView v = js_string_view(ctx, s);
    Builder b = { 0 };
    for (double i = 0; i < n; i++) put_view(&b, v, 0, v.length);
    return finish(ctx, &b);
}

/* GetSubstitution (§22.1.3.19.1) for a string search: $$, $&, $`, $' (no captures). */
static void put_substitution(Builder *b, JSStrView str, uint32_t position, uint32_t matched_len, JSStrView replacement) {
    for (uint32_t i = 0; i < replacement.length; i++) {
        uint32_t c = js_view_at(replacement, i);
        if (c == '$' && i + 1 < replacement.length) {
            uint32_t d = js_view_at(replacement, i + 1);
            if (d == '$') { put_unit(b, '$'); i++; continue; }
            if (d == '&') { put_view(b, str, position, position + matched_len); i++; continue; }
            if (d == '`') { put_view(b, str, 0, position); i++; continue; }
            if (d == '\'') { put_view(b, str, position + matched_len < str.length ? position + matched_len : str.length, str.length); i++; continue; }
        }
        put_unit(b, c);
    }
}

/* replace / replaceAll with a string pattern (§22.1.3.19, §22.1.3.20) */
static JSValue replace(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, bool all, const char *method) {
    if (!js_require_this(ctx, this_val, method)) return JS_EXCEPTION;
    JSValue search_value = ARG(0), replace_value = ARG(1);
    if (js_is_object(search_value)) {  /* primitives' Symbol methods aren't consulted */
        if (all) {
            int re = is_regexp(ctx, search_value);
            if (re < 0) return JS_EXCEPTION;
            if (re) {
                JSValue flags = js_get_value(ctx, search_value, js_atom_from_cstr(ctx, "flags"));
                if (js_is_exception(flags)) return flags;
                if (js_is_nullish(flags)) return js_throw_type_error(ctx, "String.prototype.replaceAll called with a non-global RegExp argument");
                JSValue fs = js_to_string(ctx, flags);
                if (js_is_exception(fs)) return fs;
                if (index_of(js_string_view(ctx, fs), js_view_latin1("g", 1), 0) < 0)
                    return js_throw_type_error(ctx, "String.prototype.replaceAll called with a non-global RegExp argument");
            }
        }
        JSValue replacer = get_method(ctx, search_value, JS_SYMBOL(replace));
        if (js_is_exception(replacer)) return replacer;
        if (!js_is_undefined(replacer)) {
            JSValue args[2] = { this_val, replace_value };
            return js_call(ctx, replacer, search_value, 2, args);
        }
    }
    JSValue s = js_to_string(ctx, this_val);
    JSValue search = js_is_exception(s) ? s : js_to_string(ctx, search_value);
    if (js_is_exception(search)) return search;
    bool functional = js_is_callable(replace_value);
    if (!functional) {
        replace_value = js_to_string(ctx, replace_value);
        if (js_is_exception(replace_value)) return replace_value;
    }
    JSStrView str = js_string_view(ctx, s), sv = js_string_view(ctx, search);
    uint32_t advance = sv.length ? sv.length : 1;
    Builder b = { 0 };
    uint32_t end_of_last = 0;
    bool found = false;
    for (int64_t pos = index_of(str, sv, 0); pos >= 0; pos = all && (uint32_t)pos + advance <= str.length ? index_of(str, sv, (uint32_t)pos + advance) : -1) {
        found = true;
        put_view(&b, str, end_of_last, (uint32_t)pos);
        if (functional) {
            JSValue args[3] = { search, js_number((double)pos), s };
            JSValue r = js_call(ctx, replace_value, JS_UNDEFINED, 3, args);
            JSValue rs = js_is_exception(r) ? r : js_to_string(ctx, r);
            if (js_is_exception(rs)) {
                free(b.units);
                return rs;
            }
            JSStrView rv = js_string_view(ctx, rs);
            put_view(&b, rv, 0, rv.length);
            str = js_string_view(ctx, s);  /* user code ran: views may have moved (flattening) */
            sv = js_string_view(ctx, search);
        } else {
            put_substitution(&b, str, (uint32_t)pos, sv.length, js_string_view(ctx, replace_value));
        }
        end_of_last = (uint32_t)pos + sv.length;
        if (!all) break;
    }
    if (!found) {
        free(b.units);
        return s;
    }
    put_view(&b, str, end_of_last < str.length ? end_of_last : str.length, str.length);
    return finish(ctx, &b);
}

CORE(string_proto_replace) {
    UNUSED_ARGS;
    return replace(ctx, this_val, argc, argv, false, "String.prototype.replace");
}

CORE(string_proto_replace_all) {
    UNUSED_ARGS;
    return replace(ctx, this_val, argc, argv, true, "String.prototype.replaceAll");
}

/* match / matchAll / search (§22.1.3.13, .14, .23): the argument's @@match/@@matchAll/@@search,
 * or a new RegExp's. */
static JSValue regexp_method(JSContext *ctx, JSValue this_val, JSValue regexp, JSValue symbol, const char *flags, bool all, const char *method) {
    if (!js_require_this(ctx, this_val, method)) return JS_EXCEPTION;
    if (js_is_object(regexp)) {  /* primitives' Symbol methods aren't consulted */
        if (all) {
            int re = is_regexp(ctx, regexp);
            if (re < 0) return JS_EXCEPTION;
            if (re) {
                JSValue f = js_get_value(ctx, regexp, js_atom_from_cstr(ctx, "flags"));
                if (js_is_exception(f)) return f;
                if (js_is_nullish(f)) return js_throw_type_error(ctx, "String.prototype.matchAll called with a non-global RegExp argument");
                JSValue fs = js_to_string(ctx, f);
                if (js_is_exception(fs)) return fs;
                if (index_of(js_string_view(ctx, fs), js_view_latin1("g", 1), 0) < 0)
                    return js_throw_type_error(ctx, "String.prototype.matchAll called with a non-global RegExp argument");
            }
        }
        JSValue m = get_method(ctx, regexp, symbol);
        if (js_is_exception(m)) return m;
        if (!js_is_undefined(m)) return js_call(ctx, m, regexp, 1, &this_val);
    }
    JSValue s = js_to_string(ctx, this_val);
    if (js_is_exception(s)) return s;
    JSValue rx = regexp_create(ctx, regexp, flags, method);
    if (js_is_exception(rx)) return rx;
    JSValue m = js_get_value(ctx, rx, symbol);
    if (js_is_exception(m)) return m;
    return js_call(ctx, m, rx, 1, &s);
}

CORE(string_proto_match) {
    UNUSED_ARGS;
    return regexp_method(ctx, this_val, ARG(0), JS_SYMBOL(match), NULL, false, "String.prototype.match");
}

CORE(string_proto_match_all) {
    UNUSED_ARGS;
    return regexp_method(ctx, this_val, ARG(0), JS_SYMBOL(matchAll), "g", true, "String.prototype.matchAll");
}

CORE(string_proto_search) {
    UNUSED_ARGS;
    return regexp_method(ctx, this_val, ARG(0), JS_SYMBOL(search), NULL, false, "String.prototype.search");
}

/* split (§22.1.3.23) */
CORE(string_proto_split) {
    UNUSED_ARGS;
    if (!js_require_this(ctx, this_val, "String.prototype.split")) return JS_EXCEPTION;
    JSValue separator = ARG(0), limit = ARG(1);
    if (js_is_object(separator)) {  /* primitives' Symbol methods aren't consulted */
        JSValue splitter = get_method(ctx, separator, JS_SYMBOL(split));
        if (js_is_exception(splitter)) return splitter;
        if (!js_is_undefined(splitter)) {
            JSValue args[2] = { this_val, limit };
            return js_call(ctx, splitter, separator, 2, args);
        }
    }
    JSValue s = js_to_string(ctx, this_val);
    if (js_is_exception(s)) return s;
    double lim = 4294967295.0;
    if (!js_is_undefined(limit)) {
        double d;
        if (js_to_number(ctx, &d, limit) < 0) return JS_EXCEPTION;
        lim = (uint32_t)js_double_to_int32(d);
    }
    JSValue r = js_to_string(ctx, separator);
    if (js_is_exception(r)) return r;
    JSValue a = js_new_array(ctx, 0);
    if (js_is_exception(a) || lim == 0) return a;
    if (js_is_undefined(separator)) return js_array_push(ctx, js_as_object(a), s) < 0 ? JS_EXCEPTION : a;
    JSStrView str = js_string_view(ctx, s), sep = js_string_view(ctx, r);
    if (str.length == 0) {
        if (sep.length != 0 && js_array_push(ctx, js_as_object(a), s) < 0) return JS_EXCEPTION;
        return a;
    }
    if (sep.length == 0) {
        for (uint32_t i = 0; i < str.length && i < lim; i++)
            if (js_array_push(ctx, js_as_object(a), js_substring(ctx, s, i, i + 1)) < 0) return JS_EXCEPTION;
        return a;
    }
    uint32_t p = 0;
    for (int64_t q = index_of(str, sep, 0); q >= 0; q = index_of(js_string_view(ctx, s), js_string_view(ctx, r), p)) {
        if (js_array_push(ctx, js_as_object(a), js_substring(ctx, s, p, (uint32_t)q)) < 0) return JS_EXCEPTION;
        if (js_array_length(js_as_object(a)) >= lim) return a;
        p = (uint32_t)q + sep.length;
    }
    if (js_array_push(ctx, js_as_object(a), js_substring(ctx, s, p, js_string_length(s))) < 0) return JS_EXCEPTION;
    return a;
}

CORE(string_proto_slice) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.slice");
    if (js_is_exception(s)) return s;
    double len = js_string_length(s), start, end;
    if (js_relative_index(ctx, ARG(0), len, 0, &start) < 0 || js_relative_index(ctx, ARG(1), len, len, &end) < 0) return JS_EXCEPTION;
    if (start >= end) return js_empty_string();
    return js_substring(ctx, s, (uint32_t)start, (uint32_t)end);
}

CORE(string_proto_substring) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.substring");
    if (js_is_exception(s)) return s;
    double len = js_string_length(s), a, b = len;
    if (js_to_integer_or_infinity(ctx, &a, ARG(0)) < 0) return JS_EXCEPTION;
    if (!js_is_undefined(ARG(1)) && js_to_integer_or_infinity(ctx, &b, ARG(1)) < 0) return JS_EXCEPTION;
    a = fmin(fmax(a, 0), len);
    b = fmin(fmax(b, 0), len);
    return js_substring(ctx, s, (uint32_t)fmin(a, b), (uint32_t)fmax(a, b));
}

/* substr (Annex B §B.2.2.1) */
CORE(string_proto_substr) {
    UNUSED_ARGS;
    JSValue s = this_string(ctx, this_val, "String.prototype.substr");
    if (js_is_exception(s)) return s;
    double size = js_string_length(s), start, length = size;
    if (js_to_integer_or_infinity(ctx, &start, ARG(0)) < 0) return JS_EXCEPTION;
    if (start == -INFINITY) start = 0;
    else if (start < 0) start = fmax(size + start, 0);
    else start = fmin(start, size);
    if (!js_is_undefined(ARG(1)) && js_to_integer_or_infinity(ctx, &length, ARG(1)) < 0) return JS_EXCEPTION;
    double end = fmin(start + length, size);
    if (start >= end) return js_empty_string();
    return js_substring(ctx, s, (uint32_t)start, (uint32_t)end);
}

static JSValue case_convert(JSContext *ctx, JSValue this_val, bool lower, const char *method) {
    JSValue s = this_string(ctx, this_val, method);
    if (js_is_exception(s)) return s;
    JSStrView v = js_string_view(ctx, s);
    Builder b = { 0 };
    for (uint32_t i = 0, next; i < v.length; i = next) {
        uint32_t c = code_point_at(v, i, &next);
        uint32_t res[LRE_CC_RES_LEN_MAX];
        int n;
        if (c == 0x3A3 && lower) {  /* capital sigma: final (ς) or not (σ), §22.1.3.28 */
            bool final = false;
            uint32_t k = i, c1 = 0;
            while (k > 0) {  /* before: a cased letter, past case-ignorable ones */
                c1 = js_view_at(v, --k);
                if (!lre_is_case_ignorable(c1)) break;
            }
            if (i > 0 && lre_is_cased(c1)) {
                final = true;
                for (uint32_t j = next, after; j < v.length; j = after) {  /* after: no cased letter */
                    uint32_t c2 = code_point_at(v, j, &after);
                    if (lre_is_case_ignorable(c2)) continue;
                    final = !lre_is_cased(c2);
                    break;
                }
            }
            res[0] = final ? 0x3C2 : 0x3C3;
            n = 1;
        } else {
            n = lre_case_conv(res, c, lower ? 1 : 0);
        }
        for (int j = 0; j < n; j++) put_code_point(&b, res[j]);
    }
    return finish(ctx, &b);
}

CORE(string_proto_to_lower_case) {
    UNUSED_ARGS;
    return case_convert(ctx, this_val, true, "String.prototype.toLowerCase");
}

CORE(string_proto_to_upper_case) {
    UNUSED_ARGS;
    return case_convert(ctx, this_val, false, "String.prototype.toUpperCase");
}

/* The locale variants without Intl: the root locale's mapping. */
CORE(string_proto_to_locale_lower_case) {
    UNUSED_ARGS;
    return case_convert(ctx, this_val, true, "String.prototype.toLocaleLowerCase");
}

CORE(string_proto_to_locale_upper_case) {
    UNUSED_ARGS;
    return case_convert(ctx, this_val, false, "String.prototype.toLocaleUpperCase");
}

static JSValue trim(JSContext *ctx, JSValue this_val, bool start, bool end, const char *method) {
    JSValue s = this_string(ctx, this_val, method);
    if (js_is_exception(s)) return s;
    JSStrView v = js_string_view(ctx, s);
    uint32_t a = 0, b = v.length;
    if (start) while (a < b && is_white_space(js_view_at(v, a))) a++;
    if (end) while (b > a && is_white_space(js_view_at(v, b - 1))) b--;
    return a == 0 && b == v.length ? s : js_substring(ctx, s, a, b);
}

CORE(string_proto_trim) {
    UNUSED_ARGS;
    return trim(ctx, this_val, true, true, "String.prototype.trim");
}

CORE(string_proto_trim_start) {
    UNUSED_ARGS;
    return trim(ctx, this_val, true, false, "String.prototype.trimStart");
}

CORE(string_proto_trim_end) {
    UNUSED_ARGS;
    return trim(ctx, this_val, false, true, "String.prototype.trimEnd");
}

CORE(string_proto_to_string) {
    UNUSED_ARGS;
    JSValue s = js_this_primitive(this_val, js_is_string);
    if (js_is_empty(s)) return js_throw_type_error(ctx, "String.prototype.toString requires that 'this' be a String");
    return s;
}

CORE(string_proto_value_of) {
    UNUSED_ARGS;
    JSValue s = js_this_primitive(this_val, js_is_string);
    if (js_is_empty(s)) return js_throw_type_error(ctx, "String.prototype.valueOf requires that 'this' be a String");
    return s;
}

/* The HTML methods (Annex B §B.2.2.2 CreateHTML): `<tag attr="value">string</tag>`, quotes
 * in the value as &quot;. */
static JSValue create_html(JSContext *ctx, JSValue this_val, const char *tag, const char *attr, JSValue value, const char *method) {
    JSValue s = this_string(ctx, this_val, method);
    if (js_is_exception(s)) return s;
    JSValue v = attr ? js_to_string(ctx, value) : JS_UNDEFINED;
    if (js_is_exception(v)) return v;
    Builder b = { 0 };
    put_unit(&b, '<');
    put_ascii(&b, tag);
    if (attr) {
        put_unit(&b, ' ');
        put_ascii(&b, attr);
        put_ascii(&b, "=\"");
        JSStrView vv = js_string_view(ctx, v);
        for (uint32_t i = 0; i < vv.length; i++) {
            uint32_t c = js_view_at(vv, i);
            if (c == '"') put_ascii(&b, "&quot;");
            else put_unit(&b, c);
        }
        put_unit(&b, '"');
    }
    put_unit(&b, '>');
    JSStrView sv = js_string_view(ctx, s);
    put_view(&b, sv, 0, sv.length);
    put_ascii(&b, "</");
    put_ascii(&b, tag);
    put_unit(&b, '>');
    return finish(ctx, &b);
}

#define HTML_METHOD(fn, tag, attr)                                                   \
    CORE(string_html_##fn) {                                                         \
        UNUSED_ARGS;                                                                 \
        return create_html(ctx, this_val, tag, attr, ARG(0), "String.prototype." #fn); \
    }

HTML_METHOD(anchor, "a", "name")
HTML_METHOD(big, "big", NULL)
HTML_METHOD(blink, "blink", NULL)
HTML_METHOD(bold, "b", NULL)
HTML_METHOD(fixed, "tt", NULL)
HTML_METHOD(fontcolor, "font", "color")
HTML_METHOD(fontsize, "font", "size")
HTML_METHOD(italics, "i", NULL)
HTML_METHOD(link, "a", "href")
HTML_METHOD(small, "small", NULL)
HTML_METHOD(strike, "strike", NULL)
HTML_METHOD(sub, "sub", NULL)
HTML_METHOD(sup, "sup", NULL)

/* ---- The objects ----------------------------------------------------------------------------- */

JSValue js_string_realm_init(JSContext *ctx, JSObject *global,
                             JSValue (*define_constructor)(JSContext *, JSObject *, const char *, JSNativeFn, uint32_t, JSValue)) {
    return define_constructor(ctx, global, "String", string_ctor, 1, ctx->intrinsics[JS_INTRINSIC_STRING_PROTOTYPE]);
}
