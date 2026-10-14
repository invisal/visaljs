/* util.inspect and util.format, natively: Node's algorithms
 * (lib/internal/util/inspect.js), so console output matches Node's byte for byte.
 *
 * Every string built here, and every object reached, is also pushed on `keep`, a JS array
 * the conservative stack scan sees: user code (getters, toString, custom
 * inspectors) can run and collect, and the C lists below are not roots themselves.
 *
 * Ported from Node.js (Copyright Node.js contributors, MIT): runtime/third_party/nodejs/LICENSE. */
#include "js_console.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "js_buffer.h"
#include "js_builtins.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_promise.h"
#include "js_symbol.h"
#include "jsnum.h"
#include "jsstring.h"

/* ---- A growable UTF-16 buffer --------------------------------------------- */

typedef struct {
    uint16_t *units;
    size_t length, cap;
} Builder;

static void reserve(Builder *b, size_t more) {
    if (b->length + more <= b->cap) return;
    size_t cap = b->cap ? b->cap * 2 : 128;
    while (cap < b->length + more) cap *= 2;
    uint16_t *u = realloc(b->units, cap * sizeof *u);
    if (!u) js_fatal("out of memory formatting output");
    b->units = u;
    b->cap = cap;
}

static void put_unit(Builder *b, uint32_t unit) {
    reserve(b, 1);
    b->units[b->length++] = (uint16_t)unit;
}

static void put_ascii(Builder *b, const char *s) {
    size_t n = strlen(s);
    reserve(b, n);
    for (size_t i = 0; i < n; i++) b->units[b->length++] = (uint8_t)s[i];
}

static void put_view(Builder *b, JSStrView v, uint32_t start, uint32_t end) {
    reserve(b, end - start);
    for (uint32_t i = start; i < end; i++) b->units[b->length++] = (uint16_t)js_view_at(v, i);
}

static void put_repeat(Builder *b, uint32_t unit, size_t n) {
    reserve(b, n);
    for (size_t i = 0; i < n; i++) b->units[b->length++] = (uint16_t)unit;
}

/* The code units [start, end) of v. */
static JSStrView view_slice(JSStrView v, uint32_t start, uint32_t end) {
    JSStrView r = v;
    r.chars = v.latin1 ? (const void *)((const uint8_t *)v.chars + start) : (const void *)((const uint16_t *)v.chars + start);
    r.length = end - start;
    return r;
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

/* ---- The inspection's state ---------------------------------------------- */

typedef struct {
    JSValue *v;
    size_t n, cap;
} List;

static void list_push(List *l, JSValue v) {
    if (l->n == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 16;
        JSValue *grown = realloc(l->v, l->cap * sizeof *grown);
        if (!grown) js_fatal("out of memory formatting output");
        l->v = grown;
    }
    l->v[l->n++] = v;
}

static void list_remove(List *l, size_t i) {
    memmove(l->v + i, l->v + i + 1, (l->n - i - 1) * sizeof *l->v);
    l->n--;
}

static void list_free(List *l) {
    free(l->v);
    *l = (List){ 0 };
}

#define COMPACT_TRUE (-1)  /* JSInspectOptions.compact */

typedef struct {
    JSContext *ctx;
    JSValue keep;        /* a JS array: keeps everything below alive */
    List seen;           /* the objects being formatted, outermost first */
    List circular;       /* objects found inside themselves: their index + 1 is the *n */
    double indentation;
    double current_depth;
    JSInspectOptions o;
} Insp;

const JSInspectOptions js_inspect_defaults = { false, 2, true, 100, 10000, 80, 3, false, JS_INSPECT_GETTERS_OFF };

static void insp_init(Insp *ip, JSContext *ctx, const JSInspectOptions *o) {
    *ip = (Insp){ ctx, JS_UNDEFINED, { 0 }, { 0 }, 0, 0, *o };
    ip->keep = js_new_array(ctx, 0);
}

static void insp_free(Insp *ip) {
    list_free(&ip->seen);
    list_free(&ip->circular);
}

/* Keeps v alive for the rest of the inspection; returns it (or the exception). */
static JSValue keep(Insp *ip, JSValue v) {
    if (js_is_exception(v) || !js_is_cell(v) || js_is_exception(ip->keep)) return v;
    if (js_array_push(ip->ctx, js_as_object(ip->keep), v) < 0) return JS_EXCEPTION;
    return v;
}

static JSValue cstr(Insp *ip, const char *s) {
    return keep(ip, js_new_string_cstr(ip->ctx, s));
}

static JSValue done(Insp *ip, Builder *b) {
    return keep(ip, finish(ip->ctx, b));
}

static void put_str(Builder *b, JSContext *ctx, JSValue s) {
    JSStrView v = js_string_view(ctx, s);
    put_view(b, v, 0, v.length);
}

static bool str_contains_unit(JSContext *ctx, JSValue s, uint32_t unit) {
    JSStrView v = js_string_view(ctx, s);
    for (uint32_t i = 0; i < v.length; i++)
        if (js_view_at(v, i) == unit) return true;
    return false;
}

/* The index of `sub` in `s` from `from`, or -1. */
static int64_t str_index_of(JSContext *ctx, JSValue s, JSValue sub, uint32_t from) {
    JSStrView a = js_string_view(ctx, s), b = js_string_view(ctx, sub);
    if (b.length > a.length) return -1;
    for (uint32_t i = from; i + b.length <= a.length; i++) {
        uint32_t j = 0;
        while (j < b.length && js_view_at(a, i + j) == js_view_at(b, j)) j++;
        if (j == b.length) return i;
    }
    return -1;
}

static bool str_eq_cstr(JSContext *ctx, JSValue s, const char *c) {
    JSStrView v = js_string_view(ctx, s);
    size_t n = strlen(c);
    if (v.length != n) return false;
    for (uint32_t i = 0; i < n; i++)
        if (js_view_at(v, i) != (uint8_t)c[i]) return false;
    return true;
}

/* ---- Primitives -------------------------------------------------------------- */

/* formatNumber: -0 prints as "-0". */
static void put_number(Builder *b, double d) {
    char buf[JS_NUM_BUF_SIZE];
    if (d == 0 && signbit(d)) put_ascii(b, "-0");
    else {
        js_num_to_cstr(buf, d);
        put_ascii(b, buf);
    }
}

static bool view_contains(JSStrView v, uint32_t unit) {
    for (uint32_t i = 0; i < v.length; i++)
        if (js_view_at(v, i) == unit) return true;
    return false;
}

static bool view_contains_dollar_brace(JSStrView v) {
    for (uint32_t i = 0; i + 1 < v.length; i++)
        if (js_view_at(v, i) == '$' && js_view_at(v, i + 1) == '{') return true;
    return false;
}

/* Node's `meta` escapes: code units below 0x20 and 0x7F…0x9F. */
static void put_meta(Builder *b, uint32_t c) {
    char esc[8];
    switch (c) {
    case '\b': put_ascii(b, "\\b"); return;
    case '\t': put_ascii(b, "\\t"); return;
    case '\n': put_ascii(b, "\\n"); return;
    case '\f': put_ascii(b, "\\f"); return;
    case '\r': put_ascii(b, "\\r"); return;
    default:
        snprintf(esc, sizeof esc, "\\x%02X", c);
        put_ascii(b, esc);
    }
}

/* strEscape: quoted with ', else " if it contains ' but no ", else ` if it has neither ` nor ${. */
static void put_quoted(Builder *b, JSStrView v) {
    uint32_t quote = '\'';
    if (view_contains(v, '\'')) {
        if (!view_contains(v, '"')) quote = '"';
        else if (!view_contains(v, '`') && !view_contains_dollar_brace(v)) quote = '`';
    }
    put_unit(b, quote);
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        if (c == quote && quote == '\'') {
            put_ascii(b, "\\'");
        } else if (c == '\\') {
            put_ascii(b, "\\\\");
        } else if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) {
            put_meta(b, c);
        } else if (c >= 0xD800 && c <= 0xDFFF) {
            uint32_t d = i + 1 < v.length ? js_view_at(v, i + 1) : 0;
            if (c <= 0xDBFF && d >= 0xDC00 && d <= 0xDFFF) {  /* a pair: printed as is */
                put_unit(b, c);
                put_unit(b, d);
                i++;
            } else {
                char esc[8];
                snprintf(esc, sizeof esc, "\\u%x", c);  /* lone surrogate, lowercase like Node */
                put_ascii(b, esc);
            }
        } else {
            put_unit(b, c);
        }
    }
    put_unit(b, quote);
}

/* Escapes without quotes: a symbol's description, a non-enumerable key (Node's escapeFn). */
static void put_escaped(Builder *b, JSStrView v) {
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        if (c == '\'') put_ascii(b, "\\'");
        else if (c == '\\') put_ascii(b, "\\\\");
        else if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) put_meta(b, c);
        else put_unit(b, c);
    }
}

static JSValue format_primitive(Insp *ip, JSValue v) {
    JSContext *ctx = ip->ctx;
    Builder b = { 0 };
    if (js_is_string(v)) {
        JSStrView s = js_string_view(ctx, v);
        uint32_t len = s.length;
        double trailer = 0;
        if (len > ip->o.max_string_length) {
            trailer = len - ip->o.max_string_length;
            len = (uint32_t)ip->o.max_string_length;
        }
        if (ip->o.compact != COMPACT_TRUE && len > 16 && len > ip->o.break_length - ip->indentation - 4) {
            /* long strings: one quoted piece per line, each keeping its \n */
            uint32_t start = 0;
            bool first = true;
            for (uint32_t i = 0; i < len; i++) {
                if (js_view_at(s, i) != '\n') continue;
                if (!first) {
                    put_ascii(&b, " +\n");
                    put_repeat(&b, ' ', (size_t)ip->indentation + 2);
                }
                put_quoted(&b, view_slice(s, start, i + 1));
                first = false;
                start = i + 1;
            }
            if (start < len || first) {
                if (!first) {
                    put_ascii(&b, " +\n");
                    put_repeat(&b, ' ', (size_t)ip->indentation + 2);
                }
                put_quoted(&b, view_slice(s, start, len));
            }
        } else {
            put_quoted(&b, view_slice(s, 0, len));
        }
        if (trailer > 0) {
            char t[64];
            snprintf(t, sizeof t, "... %.0f more character%s", trailer, trailer > 1 ? "s" : "");
            put_ascii(&b, t);
        }
    } else if (js_is_number(v)) {
        put_number(&b, js_as_number(v));
    } else if (js_is_bool(v)) {
        put_ascii(&b, js_as_bool(v) ? "true" : "false");
    } else if (js_is_undefined(v)) {
        put_ascii(&b, "undefined");
    } else if (js_is_null(v)) {
        put_ascii(&b, "null");
    } else if (js_is_bigint(v)) {  /* 12n */
        JSValue s = js_to_string(ctx, v);
        if (js_is_exception(s)) {
            free(b.units);
            return s;
        }
        put_str(&b, ctx, s);
        put_ascii(&b, "n");
    } else if (js_is_symbol(v)) {
        JSValue s = js_symbol_descriptive_string(ctx, v);
        if (js_is_exception(s)) {
            free(b.units);
            return s;
        }
        put_str(&b, ctx, s);
    }
    return done(ip, &b);
}

/* ---- Objects ---------------------------------------------------------------------- */

enum { OBJECT_TYPE, ARRAY_TYPE, ARRAY_EXTRAS_TYPE };

static JSValue format_value(Insp *ip, JSValue value, double recurse);
static JSValue inspect_value(JSContext *ctx, JSValue v, const JSInspectOptions *o);

static bool is_object_like(JSValue v) {
    return js_is_object(v);  /* functions are objects too */
}

/* (own property, found) → 1, absent → 0, an exception → -1 */
static int own(JSContext *ctx, JSValue o, JSValue key, JSPropertyDescriptor *d) {
    return js_get_own_property(ctx, js_as_object(o), key, d);
}

static bool own_enumerable(JSContext *ctx, JSValue o, JSValue key) {
    JSPropertyDescriptor d;
    int has = own(ctx, o, key, &d);
    if (has < 0) {
        js_discard(js_take_exception(ctx));
        return false;
    }
    return has && (d.attrs & JS_PROP_ENUMERABLE);
}

static bool has_own(JSContext *ctx, JSValue o, JSValue key) {
    JSPropertyDescriptor d;
    int has = own(ctx, o, key, &d);
    if (has < 0) {
        js_discard(js_take_exception(ctx));
        return false;
    }
    return has;
}

static JSValue get(Insp *ip, JSValue o, JSValue key) {
    return keep(ip, js_get_value(ip->ctx, o, key));
}

/* A property key as the string Node's key lists hold (indices are numbers here). */
static JSValue key_string(Insp *ip, JSValue key) {
    if (js_is_number(key)) return keep(ip, js_number_to_string(ip->ctx, key));
    return key;
}

static JSValue concat3(Insp *ip, const char *a, JSValue s, const char *c) {
    Builder b = { 0 };
    put_ascii(&b, a);
    put_str(&b, ip->ctx, s);
    put_ascii(&b, c);
    return done(ip, &b);
}

/* The name of the nearest constructor on the prototype chain whose `prototype` the value
 * inherits from; null for a null-prototype chain. */
static JSValue get_constructor_name(Insp *ip, JSValue obj, double recurse) {
    JSContext *ctx = ip->ctx;
    JSValue tmp = obj, first_proto = JS_UNDEFINED;
    bool have_first = false;
    while (js_is_object(obj)) {
        JSPropertyDescriptor d;
        int has = own(ctx, obj, JS_ATOM(constructor), &d);
        if (has < 0) return JS_EXCEPTION;
        if (has && (d.has & JS_DESC_VALUE) && js_is_function(d.value)) {
            JSValue name = get(ip, d.value, JS_ATOM(name));
            if (js_is_exception(name)) return name;
            if (!(js_is_string(name) && js_string_length(name) == 0)) {
                JSValue r = js_instanceof(ctx, tmp, d.value);
                if (js_is_exception(r)) js_discard(js_take_exception(ctx));
                else if (js_truthy(r)) return keep(ip, js_to_string(ctx, name));
            }
        }
        obj = js_get_prototype_of(js_as_object(obj));
        if (!have_first) {
            first_proto = obj;
            have_first = true;
        }
    }
    if (js_is_null(first_proto)) return JS_NULL;
    JSValue res = cstr(ip, js_as_object(tmp)->shape->cls->name);
    if (js_is_exception(res)) return res;
    if (recurse > ip->o.depth) return concat3(ip, "", res, " <Complex prototype>");
    JSValue proto_constr = get_constructor_name(ip, first_proto, recurse + 1);
    if (js_is_exception(proto_constr)) return proto_constr;
    Builder b = { 0 };
    put_str(&b, ctx, res);
    put_ascii(&b, " <");
    if (js_is_null(proto_constr)) {
        JSInspectOptions o = ip->o;
        o.depth = -1;
        o.custom_inspect = false;
        JSValue s = keep(ip, inspect_value(ctx, first_proto, &o));
        if (js_is_exception(s)) {
            free(b.units);
            return s;
        }
        put_str(&b, ctx, s);
    } else {
        put_str(&b, ctx, proto_constr);
    }
    put_ascii(&b, ">");
    return done(ip, &b);
}

/* getPrefix: "Foo ", "Foo [Tag] ", "[Object: null prototype] " */
static void put_prefix(Builder *b, JSContext *ctx, JSValue constructor, JSValue tag, const char *fallback, const char *size) {
    bool has_tag = js_string_length(tag) != 0;
    if (js_is_null(constructor)) {
        put_ascii(b, "[");
        put_ascii(b, fallback);
        put_ascii(b, size);
        put_ascii(b, ": null prototype] ");
        if (has_tag && !str_eq_cstr(ctx, tag, fallback)) {
            b->length--;
            put_ascii(b, " [");
            put_str(b, ctx, tag);
            put_ascii(b, "] ");
        }
        return;
    }
    put_str(b, ctx, constructor);
    put_ascii(b, size);
    if (has_tag && !js_string_equals(ctx, constructor, tag)) {
        put_ascii(b, " [");
        put_str(b, ctx, tag);
        put_ascii(b, "]");
    }
    put_ascii(b, " ");
}

static JSValue prefix_string(Insp *ip, JSValue constructor, JSValue tag, const char *fallback, const char *size, const char *suffix) {
    Builder b = { 0 };
    put_prefix(&b, ip->ctx, constructor, tag, fallback, size);
    put_ascii(&b, suffix);
    return done(ip, &b);
}

/* The keys to show: own enumerable ones (all with showHidden), strings then symbols; for
 * arrays without the indices. */
static int get_keys(Insp *ip, JSValue value, bool non_index, List *keys) {
    JSContext *ctx = ip->ctx;
    JSValue all = keep(ip, js_own_keys(ctx, js_as_object(value)));
    if (js_is_exception(all)) return -1;
    JSValueArray *list = (JSValueArray *)js_as_cell(all);
    for (uint32_t i = 0; i < list->cell.aux; i++) {
        JSValue key = list->values[i];
        if (non_index && js_is_number(key)) continue;
        if (ip->o.show_hidden || own_enumerable(ctx, value, key)) list_push(keys, key);
    }
    return 0;
}

static bool is_identifier_key(JSContext *ctx, JSValue key) {
    JSStrView v = js_string_view(ctx, key);
    if (v.length == 0) return false;
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        bool letter = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
        if (!letter && !(i > 0 && c >= '0' && c <= '9')) return false;
    }
    return true;
}

static JSValue format_property(Insp *ip, JSValue value, double recurse, JSValue key, int type) {
    JSContext *ctx = ip->ctx;
    JSPropertyDescriptor d;
    int has = own(ctx, value, key, &d);
    if (has < 0) return JS_EXCEPTION;
    bool enumerable = true;
    if (!has) {
        d.has = JS_DESC_VALUE;
        d.value = get(ip, value, key);
        if (js_is_exception(d.value)) return d.value;
    } else {
        enumerable = (d.attrs & JS_PROP_ENUMERABLE) != 0;
        keep(ip, d.value);
    }
    Builder b = { 0 };
    JSValue str;
    if ((d.has & JS_DESC_VALUE) && !js_is_undefined(d.value)) {
        int diff = ip->o.compact != COMPACT_TRUE || type != OBJECT_TYPE ? 2 : 3;
        ip->indentation += diff;
        str = format_value(ip, d.value, recurse);
        ip->indentation -= diff;
        if (js_is_exception(str)) return str;
    } else if ((d.has & JS_DESC_GET) && !js_is_undefined(d.get)) {
        bool setter = (d.has & JS_DESC_SET) && !js_is_undefined(d.set);
        const char *label = setter ? "Getter/Setter" : "Getter";
        int g = ip->o.getters;
        if (g == JS_INSPECT_GETTERS_ALL || (g == JS_INSPECT_GETTERS_GET && !setter) || (g == JS_INSPECT_GETTERS_SET && setter)) {
            /* the getter's value, as Node shows it: [Getter: 5], [Getter: null], [Getter] { a: 1 } */
            keep(ip, d.get);
            JSValue got = js_call(ctx, d.get, value, 0, NULL);
            Builder g2 = { 0 };
            if (js_is_exception(got)) {
                /* what it threw, inspected: <Inspection threw ([Error: nope])> */
                JSValue err = keep(ip, js_take_exception(ctx));
                ip->indentation += 2;
                JSValue shown = format_value(ip, err, recurse);
                ip->indentation -= 2;
                if (js_is_exception(shown)) { free(g2.units); return shown; }
                put_ascii(&g2, "["), put_ascii(&g2, label), put_ascii(&g2, ": <Inspection threw (");
                put_str(&g2, ctx, shown);
                put_ascii(&g2, ")>]");
            } else {
                keep(ip, got);
                ip->indentation += 2;
                JSValue shown = js_is_null(got) ? cstr(ip, "null") : is_object_like(got) ? format_value(ip, got, recurse) : format_primitive(ip, got);
                ip->indentation -= 2;
                if (js_is_exception(shown)) { free(g2.units); return shown; }
                put_ascii(&g2, "["), put_ascii(&g2, label);
                put_ascii(&g2, is_object_like(got) ? "] " : ": ");
                put_str(&g2, ctx, shown);
                if (!is_object_like(got)) put_ascii(&g2, "]");
            }
            str = done(ip, &g2);
        } else {
            str = cstr(ip, setter ? "[Getter/Setter]" : "[Getter]");
        }
    } else if ((d.has & JS_DESC_SET) && !js_is_undefined(d.set)) {
        str = cstr(ip, "[Setter]");
    } else {
        str = cstr(ip, "undefined");
    }
    if (js_is_exception(str)) return str;
    if (type == ARRAY_TYPE) return str;
    /* the key: Symbol(s), an identifier as it is, any other quoted; in brackets when it isn't
       enumerable */
    if (!enumerable) put_ascii(&b, "[");
    if (js_is_symbol(key)) {
        JSValue s = js_symbol_descriptive_string(ctx, key);
        if (js_is_exception(s)) { free(b.units); return s; }
        put_escaped(&b, js_string_view(ctx, s));
    } else {
        JSValue k = key_string(ip, key);
        if (js_is_exception(k)) { free(b.units); return k; }
        if (str_eq_cstr(ctx, k, "__proto__")) put_ascii(&b, "['__proto__']");
        else if (is_identifier_key(ctx, k)) put_str(&b, ctx, k);
        else put_quoted(&b, js_string_view(ctx, k));
    }
    if (!enumerable) put_ascii(&b, "]");
    put_ascii(&b, ": ");
    put_str(&b, ctx, str);
    return done(ip, &b);
}

static JSValue remaining_text(Insp *ip, double remaining) {
    char t[64];
    snprintf(t, sizeof t, "... %.0f more item%s", remaining, remaining > 1 ? "s" : "");
    return cstr(ip, t);
}

static JSValue empty_items(Insp *ip, double n) {
    char t[64];
    snprintf(t, sizeof t, "<%.0f empty item%s>", n, n > 1 ? "s" : "");
    return cstr(ip, t);
}

static int push_result(List *out, JSValue s) {
    if (js_is_exception(s)) return -1;
    list_push(out, s);
    return 0;
}

/* An array with holes: runs of them become "<n empty items>" (formatSpecialArray). */
static int format_special_array(Insp *ip, JSValue value, double recurse, double max_length, List *out, uint32_t i) {
    JSContext *ctx = ip->ctx;
    List keys = { 0 };
    bool saved = ip->o.show_hidden;
    ip->o.show_hidden = false;
    int rc = get_keys(ip, value, false, &keys);  /* Object.keys */
    ip->o.show_hidden = saved;
    if (rc < 0) {
        list_free(&keys);
        return -1;
    }
    double index = i;
    for (; i < keys.n && out->n < max_length; i++) {
        JSValue key = keys.v[i];
        if (!js_is_number(key)) break;  /* only index keys */
        double tmp = js_as_number(key);
        if (tmp != index) {
            if (push_result(out, empty_items(ip, tmp - index)) < 0) goto fail;
            index = tmp;
            if (out->n == max_length) break;
        }
        if (push_result(out, format_property(ip, value, recurse, key, ARRAY_TYPE)) < 0) goto fail;
        index++;
    }
    list_free(&keys);
    {
        double remaining = js_array_length(js_as_object(value)) - index;
        if (out->n != max_length) {
            if (remaining > 0 && push_result(out, empty_items(ip, remaining)) < 0) return -1;
        } else if (remaining > 0) {
            if (push_result(out, remaining_text(ip, remaining)) < 0) return -1;
        }
    }
    (void)ctx;
    return 0;
fail:
    list_free(&keys);
    return -1;
}

static int format_array(Insp *ip, JSValue value, double recurse, List *out) {
    double length = js_array_length(js_as_object(value));
    double len = ip->o.max_array_length < 0 ? 0 : ip->o.max_array_length;
    if (len > length) len = length;
    double remaining = length - len;
    for (uint32_t i = 0; i < len; i++) {
        if (!has_own(ip->ctx, value, js_index_key(i))) return format_special_array(ip, value, recurse, len, out, i);
        if (push_result(out, format_property(ip, value, recurse, js_index_key(i), ARRAY_TYPE)) < 0) return -1;
    }
    if (remaining > 0 && push_result(out, remaining_text(ip, remaining)) < 0) return -1;
    return 0;
}

/* ---- Functions, errors, promises -------------------------------------------------------- */

/* getBoxedBase: "[Number: 5]", "[String (Foo): 'ab']"; a String wrapper's index keys are left out. */
static JSValue boxed_base(Insp *ip, JSValue value, JSValue constructor, JSValue tag, List *keys) {
    JSContext *ctx = ip->ctx;
    JSValue prim = js_wrapped_value(value);
    const char *type = js_is_number(prim) ? "Number" : js_is_string(prim) ? "String" : js_is_bool(prim) ? "Boolean"
                     : js_is_bigint(prim) ? "BigInt" : "Symbol";
    if (js_is_string(prim)) {
        size_t n = js_string_length(prim);
        if (n > keys->n) n = keys->n;
        memmove(keys->v, keys->v + n, (keys->n - n) * sizeof *keys->v);
        keys->n -= n;
    }
    JSValue text = format_primitive(ip, prim);
    if (js_is_exception(text)) return text;
    Builder b = { 0 };
    put_ascii(&b, "[");
    put_ascii(&b, type);
    if (js_is_null(constructor)) {
        put_ascii(&b, " (null prototype)");
    } else if (!str_eq_cstr(ctx, constructor, type)) {
        put_ascii(&b, " (");
        put_str(&b, ctx, constructor);
        put_ascii(&b, ")");
    }
    put_ascii(&b, ": ");
    put_str(&b, ctx, text);
    put_ascii(&b, "]");
    if (js_string_length(tag) != 0 && (js_is_null(constructor) || !js_string_equals(ctx, constructor, tag))) {
        put_ascii(&b, " [");
        put_str(&b, ctx, tag);
        put_ascii(&b, "]");
    }
    return done(ip, &b);
}

static JSValue function_base(Insp *ip, JSValue value, JSValue constructor, JSValue tag) {
    JSContext *ctx = ip->ctx;
    uint32_t flags = js_as_function(value)->flags;
    Builder b = { 0 };
    bool has_tag = js_string_length(tag) != 0;
    if (flags & JS_FN_CLASS_CTOR) {
        JSValue name = JS_UNDEFINED;
        if (has_own(ctx, value, JS_ATOM(name))) {
            name = get(ip, value, JS_ATOM(name));
            if (js_is_exception(name)) return name;
        }
        put_ascii(&b, "[class ");
        if (js_truthy(name)) {
            JSValue s = keep(ip, js_to_string(ctx, name));
            if (js_is_exception(s)) goto fail;
            put_str(&b, ctx, s);
        } else {
            put_ascii(&b, "(anonymous)");
        }
        if (!js_is_null(constructor) && !str_eq_cstr(ctx, constructor, "Function")) {
            put_ascii(&b, " [");
            put_str(&b, ctx, constructor);
            put_ascii(&b, "]");
        }
        if (has_tag && (js_is_null(constructor) || !js_string_equals(ctx, constructor, tag))) {
            put_ascii(&b, " [");
            put_str(&b, ctx, tag);
            put_ascii(&b, "]");
        }
        if (!js_is_null(constructor)) {
            JSValue proto = js_get_prototype_of(js_as_object(value));
            if (js_is_object(proto)) {
                JSValue super_name = get(ip, proto, JS_ATOM(name));
                if (js_is_exception(super_name)) goto fail;
                if (js_truthy(super_name)) {
                    JSValue s = keep(ip, js_to_string(ctx, super_name));
                    if (js_is_exception(s)) goto fail;
                    put_ascii(&b, " extends ");
                    put_str(&b, ctx, s);
                }
            }
        } else {
            put_ascii(&b, " extends [null prototype]");
        }
        put_ascii(&b, "]");
        return done(ip, &b);
    }
    const char *type = (flags & JS_FN_ASYNC) && (flags & JS_FN_GENERATOR) ? "AsyncGeneratorFunction"
                     : flags & JS_FN_ASYNC ? "AsyncFunction"
                     : flags & JS_FN_GENERATOR ? "GeneratorFunction" : "Function";
    /* visaljs has no %AsyncFunction% or %GeneratorFunction% constructors yet: such functions
     * find Function, which Node would never print after their own type */
    if (!js_is_null(constructor) && strcmp(type, "Function") != 0 && str_eq_cstr(ctx, constructor, "Function")) {
        constructor = cstr(ip, type);
        if (js_is_exception(constructor)) goto fail;
    }
    bool constructor_is_type = !js_is_null(constructor) && str_eq_cstr(ctx, constructor, type);
    put_ascii(&b, "[");
    put_ascii(&b, type);
    if (js_is_null(constructor)) put_ascii(&b, " (null prototype)");
    JSValue name = get(ip, value, JS_ATOM(name));
    if (js_is_exception(name)) goto fail;
    if (js_is_string(name) && js_string_length(name) == 0) {
        put_ascii(&b, " (anonymous)");
    } else {
        JSValue s = keep(ip, js_to_string(ctx, name));
        if (js_is_exception(s)) goto fail;
        put_ascii(&b, ": ");
        put_str(&b, ctx, s);
    }
    put_ascii(&b, "]");
    if (!constructor_is_type && !js_is_null(constructor)) {
        put_ascii(&b, " ");
        put_str(&b, ctx, constructor);
    }
    if (has_tag && (js_is_null(constructor) || !js_string_equals(ctx, constructor, tag))) {
        put_ascii(&b, " [");
        put_str(&b, ctx, tag);
        put_ascii(&b, "]");
    }
    return done(ip, &b);
fail:
    free(b.units);
    return JS_EXCEPTION;
}

static bool starts_with_value(JSContext *ctx, JSValue s, JSValue prefix) {
    return js_string_length(prefix) <= js_string_length(s) && str_index_of(ctx, s, prefix, 0) == 0;
}

static bool ends_with_cstr(JSContext *ctx, JSValue s, const char *suffix) {
    JSStrView v = js_string_view(ctx, s);
    size_t n = strlen(suffix);
    if (n > v.length) return false;
    for (size_t i = 0; i < n; i++)
        if (js_view_at(v, (uint32_t)(v.length - n + i)) != (uint8_t)suffix[i]) return false;
    return true;
}

/* improveStack: "MyErr [Error]: m" when the constructor isn't the name. */
static JSValue improve_stack(Insp *ip, JSValue stack, JSValue constructor, JSValue name, JSValue tag) {
    JSContext *ctx = ip->ctx;
    uint32_t len = js_string_length(name);
    JSStrView sv = js_string_view(ctx, stack);
    if (js_is_null(constructor) ||
        (ends_with_cstr(ctx, name, "Error") && starts_with_value(ctx, stack, name) &&
         (sv.length == len || js_view_at(sv, len) == ':' || js_view_at(sv, len) == '\n'))) {
        Builder pb = { 0 };
        put_prefix(&pb, ctx, constructor, tag, "Error", "");
        pb.length--;  /* without the trailing space */
        JSValue prefix = done(ip, &pb);
        if (js_is_exception(prefix)) return prefix;
        if (!js_string_equals(ctx, name, prefix)) {
            Builder b = { 0 };
            if (str_index_of(ctx, prefix, name, 0) != -1) {
                put_str(&b, ctx, prefix);
                if (len == 0) {
                    put_ascii(&b, ": ");
                    put_str(&b, ctx, stack);
                } else {
                    put_view(&b, sv, len, sv.length);
                }
            } else {
                put_str(&b, ctx, prefix);
                put_ascii(&b, " [");
                put_str(&b, ctx, name);
                put_ascii(&b, "]");
                put_view(&b, sv, len, sv.length);
            }
            return done(ip, &b);
        }
    }
    return stack;
}

static JSValue replace_newlines(Insp *ip, JSValue s, double indentation) {
    if (!str_contains_unit(ip->ctx, s, '\n')) return s;
    JSStrView v = js_string_view(ip->ctx, s);
    Builder b = { 0 };
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        put_unit(&b, c);
        if (c == '\n') put_repeat(&b, ' ', (size_t)indentation);
    }
    return done(ip, &b);
}

static int64_t list_index_of_key(List *keys, JSValue key) {
    for (size_t i = 0; i < keys->n; i++)
        if (js_same_bits(keys->v[i], key)) return (int64_t)i;
    return -1;
}

/* Node's isError also takes `value instanceof Error` (a DOMException, Object.create(Error.prototype)):
 * %Error.prototype% on the prototype chain, read without running proxy traps. */
static bool inherits_error(JSContext *ctx, JSValue value) {
    JSValue error_proto = ctx->intrinsics[JS_INTRINSIC_ERROR_PROTOTYPE];
    for (JSValue p = js_as_object(value)->shape->proto; js_is_object(p); p = js_as_object(p)->shape->proto)
        if (js_same_bits(p, error_proto)) return true;
    return false;
}

static JSValue format_error(Insp *ip, JSValue err, JSValue constructor, JSValue tag, List *keys) {
    JSContext *ctx = ip->ctx;
    JSValue name_v = get(ip, err, JS_ATOM(name));
    if (js_is_exception(name_v)) return name_v;
    JSValue name = js_is_nullish(name_v) ? cstr(ip, "Error") : keep(ip, js_to_string(ctx, name_v));
    if (js_is_exception(name)) return name;
    JSValue stack_v = get(ip, err, JS_ATOM(stack));
    if (js_is_exception(stack_v)) return stack_v;
    JSValue stack = keep(ip, js_truthy(stack_v) ? js_to_string(ctx, stack_v) : js_error_to_string(ctx, err));
    if (js_is_exception(stack)) return stack;
    if (!ip->o.show_hidden && keys->n) {
        const JSValue names[] = { JS_ATOM(name), JS_ATOM(message), JS_ATOM(stack) };
        for (size_t k = 0; k < 3; k++) {
            int64_t index = list_index_of_key(keys, names[k]);
            if (index == -1) continue;
            JSValue v = get(ip, err, names[k]);
            if (js_is_exception(v)) return v;
            /* only hidden when the stack already shows it */
            if (!js_is_string(v) || str_index_of(ctx, stack, v, 0) != -1) list_remove(keys, (size_t)index);
        }
    }
    int has_cause = js_has_property(ctx, js_as_object(err), JS_ATOM(cause));
    if (has_cause < 0) return JS_EXCEPTION;
    if (has_cause && list_index_of_key(keys, JS_ATOM(cause)) == -1) list_push(keys, JS_ATOM(cause));
    JSValue errors_key = keep(ip, js_atom_from_cstr(ctx, "errors"));
    JSValue errors = get(ip, err, errors_key);
    if (js_is_exception(errors)) return errors;
    if (js_is_array(errors) && list_index_of_key(keys, errors_key) == -1) list_push(keys, errors_key);
    stack = improve_stack(ip, stack, constructor, name, tag);
    if (js_is_exception(stack)) return stack;

    JSValue message = get(ip, err, JS_ATOM(message));
    if (js_is_exception(message)) return message;
    int64_t pos = -1;
    if (js_truthy(message)) {
        JSValue m = keep(ip, js_to_string(ctx, message));
        if (js_is_exception(m)) return m;
        pos = str_index_of(ctx, stack, m, 0);
        if (pos == 0) pos = -1;  /* Node: `(err.message && stack.indexOf(err.message)) || -1` */
        if (pos != -1) pos += js_string_length(m);
    }
    /* no stack trace (visaljs records none): the error in brackets */
    JSValue at = cstr(ip, "\n    at");
    if (js_is_exception(at)) return at;
    if (str_index_of(ctx, stack, at, pos < 0 ? 0 : (uint32_t)pos) == -1) stack = concat3(ip, "[", stack, "]");
    if (js_is_exception(stack)) return stack;
    if (ip->indentation != 0) stack = replace_newlines(ip, stack, ip->indentation);
    return stack;
}

/* ---- Laying out ------------------------------------------------------------------------- */

static bool is_below_break_length(Insp *ip, List *output, double start, JSValue base) {
    /* an infinite breakLength: one line, unless an entry has a line break of its own */
    if (isinf(ip->o.break_length)) {
        if (js_string_length(base) != 0 && str_contains_unit(ip->ctx, base, '\n')) return false;
        for (size_t i = 0; i < output->n; i++)
            if (str_contains_unit(ip->ctx, output->v[i], '\n')) return false;
        return true;
    }
    double total = output->n + start;
    if (total + output->n > ip->o.break_length) return false;
    for (size_t i = 0; i < output->n; i++) {
        total += js_string_length(output->v[i]);
        if (total > ip->o.break_length) return false;
    }
    return js_string_length(base) == 0 || !str_contains_unit(ip->ctx, base, '\n');
}

static void put_joined(Builder *b, JSContext *ctx, List *output, const char *sep, double indentation) {
    for (size_t i = 0; i < output->n; i++) {
        if (i) {
            put_ascii(b, sep);
            if (indentation >= 0) put_repeat(b, ' ', (size_t)indentation + 2);
        }
        put_str(b, ctx, output->v[i]);
    }
}

/* Arrays of more than six short entries are laid out in columns (groupArrayElements). */
static int group_array_elements(Insp *ip, List *output, JSValue value) {
    JSContext *ctx = ip->ctx;
    double total_length = 0, max_length = 0;
    size_t output_length = output->n;
    if (ip->o.max_array_length < output->n) output_length--;  /* "... n more items" isn't laid out */
    const double separator_space = 2;
    double *data_len = malloc((output_length ? output_length : 1) * sizeof *data_len);
    if (!data_len) js_fatal("out of memory formatting output");
    for (size_t i = 0; i < output_length; i++) {
        double len = js_string_length(output->v[i]);
        data_len[i] = len;
        total_length += len + separator_space;
        if (max_length < len) max_length = len;
    }
    double actual_max = max_length + separator_space;
    if (actual_max * 3 + ip->indentation < ip->o.break_length &&
        (total_length / actual_max > 5 || max_length <= 6)) {
        const double approx_char_heights = 2.5;
        double average_bias = sqrt(actual_max - total_length / output->n);
        double biased_max = fmax(actual_max - 3 - average_bias, 1);
        double columns = fmin(fmin(floor(sqrt(approx_char_heights * biased_max * output_length) / biased_max + 0.5),
                                   floor((ip->o.break_length - ip->indentation) / actual_max)),
                              fmin(ip->o.compact * 4.0, 15));
        if (columns <= 1) {
            free(data_len);
            return 0;
        }
        size_t cols = (size_t)columns;
        double *max_line_length = malloc(cols * sizeof *max_line_length);
        if (!max_line_length) js_fatal("out of memory formatting output");
        for (size_t c = 0; c < cols; c++) {
            double line_length = 0;
            for (size_t j = c; j < output_length; j += cols)
                if (data_len[j] > line_length) line_length = data_len[j];
            max_line_length[c] = line_length + separator_space;
        }
        bool pad_start = true;
        if (!js_is_undefined(value)) {
            for (size_t k = 0; k < output->n; k++) {
                JSValue e = get(ip, value, js_index_key((uint32_t)k));
                if (js_is_exception(e)) {
                    free(data_len);
                    free(max_line_length);
                    return -1;
                }
                if (!js_is_number(e)) {
                    pad_start = false;
                    break;
                }
            }
        }
        List grouped = { 0 };
        for (size_t k = 0; k < output_length; k += cols) {
            size_t last = k + cols < output_length ? k + cols : output_length;
            Builder b = { 0 };
            size_t j = k;
            for (; j < last - 1; j++) {
                double width = max_line_length[j - k], len = data_len[j] + 2;
                if (pad_start) put_repeat(&b, ' ', width > len ? (size_t)(width - len) : 0);
                put_str(&b, ctx, output->v[j]);
                put_ascii(&b, ", ");
                if (!pad_start) put_repeat(&b, ' ', width > len ? (size_t)(width - len) : 0);
            }
            if (pad_start) {
                double width = max_line_length[j - k] - separator_space;
                put_repeat(&b, ' ', width > data_len[j] ? (size_t)(width - data_len[j]) : 0);
            }
            put_str(&b, ctx, output->v[j]);
            JSValue line = done(ip, &b);
            if (js_is_exception(line)) {
                list_free(&grouped);
                free(data_len);
                free(max_line_length);
                return -1;
            }
            list_push(&grouped, line);
        }
        if (ip->o.max_array_length < output->n) list_push(&grouped, output->v[output_length]);
        list_free(output);
        *output = grouped;
        free(max_line_length);
    }
    free(data_len);
    return 0;
}

static JSValue reduce_to_single_string(Insp *ip, List *output, JSValue base, JSValue brace0, const char *brace1,
                                       int extras_type, double recurse, JSValue value) {
    JSContext *ctx = ip->ctx;
    Builder b = { 0 };
    bool has_base = js_string_length(base) != 0;
    if (ip->o.compact != COMPACT_TRUE) {
        if (ip->o.compact >= 1) {
            size_t entries = output->n;
            if (extras_type == ARRAY_EXTRAS_TYPE && entries > 6 && group_array_elements(ip, output, value) < 0) return JS_EXCEPTION;
            if (ip->current_depth - recurse < ip->o.compact && entries == output->n) {
                double start = output->n + ip->indentation + js_string_length(brace0) + js_string_length(base) + 10;
                if (is_below_break_length(ip, output, start, base)) {
                    Builder j = { 0 };
                    put_joined(&j, ctx, output, ", ", -1);
                    bool newline = false;
                    for (size_t i = 0; i < j.length && !newline; i++) newline = j.units[i] == '\n';
                    if (!newline) {
                        if (has_base) {
                            put_str(&b, ctx, base);
                            put_ascii(&b, " ");
                        }
                        put_str(&b, ctx, brace0);
                        put_ascii(&b, " ");
                        reserve(&b, j.length);
                        if (j.length) memcpy(b.units + b.length, j.units, j.length * sizeof *j.units);
                        b.length += j.length;
                        free(j.units);
                        put_ascii(&b, " ");
                        put_ascii(&b, brace1);
                        return done(ip, &b);
                    }
                    free(j.units);
                }
            }
        }
        if (has_base) {
            put_str(&b, ctx, base);
            put_ascii(&b, " ");
        }
        put_str(&b, ctx, brace0);
        put_ascii(&b, "\n");
        put_repeat(&b, ' ', (size_t)ip->indentation + 2);
        put_joined(&b, ctx, output, ",\n", ip->indentation);
        put_ascii(&b, "\n");
        put_repeat(&b, ' ', (size_t)ip->indentation);
        put_ascii(&b, brace1);
        return done(ip, &b);
    }
    /* compact: true */
    if (is_below_break_length(ip, output, 0, base)) {
        put_str(&b, ctx, brace0);
        if (has_base) {
            put_ascii(&b, " ");
            put_str(&b, ctx, base);
        }
        put_ascii(&b, " ");
        put_joined(&b, ctx, output, ", ", -1);
        put_ascii(&b, " ");
        put_ascii(&b, brace1);
        return done(ip, &b);
    }
    put_str(&b, ctx, brace0);
    if (!has_base && js_string_length(brace0) == 1) {
        put_ascii(&b, " ");
    } else {
        if (has_base) {
            put_ascii(&b, " ");
            put_str(&b, ctx, base);
        }
        put_ascii(&b, "\n");
        put_repeat(&b, ' ', (size_t)ip->indentation + 2);
    }
    put_joined(&b, ctx, output, ",\n", ip->indentation);
    put_ascii(&b, " ");
    put_ascii(&b, brace1);
    return done(ip, &b);
}

/* ---- formatRaw ------------------------------------------------------------------------- */

/* getIteratorBraces: "[Map Iterator] {", "[Foo] [Set Iterator] {"; "Entries" for entries(). */
static JSValue iterator_braces(Insp *ip, JSValue tag, JSCollectionPreview what) {
    bool map = what == JS_PREVIEW_MAP_ITERATOR || what == JS_PREVIEW_MAP_ENTRIES;
    bool entries = what == JS_PREVIEW_MAP_ENTRIES || what == JS_PREVIEW_SET_ENTRIES;
    const char *type = map ? "Map Iterator" : "Set Iterator";
    Builder b = { 0 };
    put_ascii(&b, "[");
    if (!str_eq_cstr(ip->ctx, tag, type) && js_string_length(tag) != 0) {
        put_str(&b, ip->ctx, tag);
        put_ascii(&b, "] [");
    }
    put_ascii(&b, map ? "Map" : "Set");
    put_ascii(&b, entries ? " Entries] {" : " Iterator] {");
    return done(ip, &b);
}

/* formatMap, formatSet, formatIterator: "k => v", values, or "[ k, v ]" pairs. */
static int format_collection(Insp *ip, JSValue items, JSCollectionPreview what, double recurse, List *out) {
    JSContext *ctx = ip->ctx;
    bool pairs = what == JS_PREVIEW_MAP || what == JS_PREVIEW_MAP_ENTRIES || what == JS_PREVIEW_SET_ENTRIES;
    double length = js_array_length(js_as_object(items)) / (pairs ? 2 : 1);
    double max = ip->o.max_array_length < 0 ? 0 : ip->o.max_array_length;
    if (max > length) max = length;
    ip->indentation += 2;
    for (uint32_t i = 0; i < max; i++) {
        if (!pairs) {
            if (push_result(out, format_value(ip, js_get_value(ctx, items, js_int32((int32_t)i)), recurse)) < 0) return -1;
            continue;
        }
        List pair = { 0 };
        JSValue k = format_value(ip, js_get_value(ctx, items, js_int32((int32_t)(2 * i))), recurse);
        JSValue v = js_is_exception(k) ? k : format_value(ip, js_get_value(ctx, items, js_int32((int32_t)(2 * i + 1))), recurse);
        if (js_is_exception(v)) return -1;
        JSValue s;
        if (what == JS_PREVIEW_MAP) {
            s = concat3(ip, "", k, " => ");
            if (!js_is_exception(s)) s = keep(ip, js_concat(ctx, s, v));
        } else {
            list_push(&pair, k);
            list_push(&pair, v);
            s = reduce_to_single_string(ip, &pair, js_empty_string(), cstr(ip, "["), "]", ARRAY_EXTRAS_TYPE, recurse, JS_UNDEFINED);
            list_free(&pair);
        }
        if (push_result(out, s) < 0) return -1;
    }
    ip->indentation -= 2;
    if (length > max && push_result(out, remaining_text(ip, length - max)) < 0) return -1;
    return 0;
}

/* Whether the builder holds exactly the ASCII text s: 0 if so. */
static int memcmp_units(const Builder *b, const char *s) {
    for (size_t i = 0; i < b->length; i++)
        if (b->units[i] != (unsigned char)s[i]) return 1;
    return 0;
}

/* "[name]: value", for the internal values Node lists before the keys. */
static JSValue hidden_entry(Insp *ip, const char *name, JSValue v, double recurse) {
    ip->indentation += 2;
    JSValue s = format_value(ip, v, recurse);
    ip->indentation -= 2;
    if (js_is_exception(s)) return s;
    Builder b = { 0 };
    put_ascii(&b, "[");
    put_ascii(&b, name);
    put_ascii(&b, "]: ");
    put_str(&b, ip->ctx, s);
    return done(ip, &b);
}

/* formatArrayBuffer: "[Uint8Contents]: <00 ff …>" (or "(detached)"), then "[byteLength]: n". */
static int format_array_buffer(Insp *ip, JSValue value, List *out) {
    const JSArrayBuffer *ab = js_as_array_buffer(value);
    if (js_buffer_is_detached(ab)) {
        if (push_result(out, cstr(ip, "(detached)")) < 0) return -1;
    } else {
        double max = ip->o.max_array_length < 0 ? 0 : ip->o.max_array_length;
        size_t n = (double)ab->byte_length < max ? ab->byte_length : (size_t)max;
        Builder b = { 0 };
        put_ascii(&b, "[Uint8Contents]: <");
        for (size_t i = 0; i < n; i++) {
            char hex[4];
            snprintf(hex, sizeof hex, i ? " %02x" : "%02x", ab->data[i]);
            put_ascii(&b, hex);
        }
        if (ab->byte_length > n) {
            char more[64];
            size_t remaining = ab->byte_length - n;
            snprintf(more, sizeof more, " ... %zu more byte%s", remaining, remaining > 1 ? "s" : "");
            put_ascii(&b, more);
        }
        put_ascii(&b, ">");
        if (push_result(out, done(ip, &b)) < 0) return -1;
    }
    return push_result(out, hidden_entry(ip, "byteLength", js_number((double)ab->byte_length), 0));
}

static JSValue format_raw(Insp *ip, JSValue value, double recurse) {
    JSContext *ctx = ip->ctx;
    JSValue result = JS_EXCEPTION;
    List keys = { 0 }, output = { 0 };
    JSValue constructor = get_constructor_name(ip, value, recurse);
    if (js_is_exception(constructor)) return constructor;
    JSValue tag = get(ip, value, JS_SYMBOL(toStringTag));
    if (js_is_exception(tag)) {  /* a getter that throws: no tag */
        js_discard(js_take_exception(ctx));
        tag = js_empty_string();
    }
    /* only listed when not an own enumerable property (it would be printed twice) */
    if (!js_is_string(tag) ||
        (js_string_length(tag) != 0 && (ip->o.show_hidden ? has_own(ctx, value, JS_SYMBOL(toStringTag))
                                                          : own_enumerable(ctx, value, JS_SYMBOL(toStringTag)))))
        tag = js_empty_string();
    const char *cls = js_as_object(value)->shape->cls->name;
    JSValue base = js_empty_string();
    JSValue brace0;
    const char *brace1 = "}";
    int extras_type = OBJECT_TYPE;
    enum { PLAIN, ARRAY, PROMISE, WEAK, COLLECTION, BUFFER, DATA_VIEW, TYPED } formatter = PLAIN;
    double typed_length = ctx->rt->typed_array_length ? ctx->rt->typed_array_length(value) : -2;
    /* a Map, a Set or their iterators: the entries to show (the collections component) */
    JSCollectionPreview what = JS_PREVIEW_MAP;
    JSValue items = JS_EMPTY;
    if (ctx->rt->collection_preview) {
        items = keep(ip, ctx->rt->collection_preview(ctx, value, &what));
        if (js_is_exception(items)) return items;
    }

    if (js_is_array(value)) {
        /* only non-ordinary arrays name their constructor: "Foo(2) [ … ]" */
        bool named = js_is_null(constructor) || !str_eq_cstr(ctx, constructor, "Array") || js_string_length(tag) != 0;
        if (get_keys(ip, value, true, &keys) < 0) goto out;
        Builder b = { 0 };
        if (named) {
            char size[32];
            snprintf(size, sizeof size, "(%u)", js_array_length(js_as_object(value)));
            put_prefix(&b, ctx, constructor, tag, "Array", size);
        }
        put_ascii(&b, "[");
        brace0 = done(ip, &b);
        brace1 = "]";
        if (js_is_exception(brace0)) goto out;
        if (js_array_length(js_as_object(value)) == 0 && keys.n == 0) {
            result = concat3(ip, "", brace0, "]");
            goto out;
        }
        extras_type = ARRAY_EXTRAS_TYPE;
        formatter = ARRAY;
    } else if (typed_length != -2) {  /* a typed array: "Uint8Array(3) [ 1, 2, 3 ]" */
        if (typed_length < 0) typed_length = 0;
        if (get_keys(ip, value, true, &keys) < 0) goto out;
        char size[32];
        snprintf(size, sizeof size, "(%.0f)", typed_length);
        JSValue fallback = js_is_null(constructor) ? get(ip, value, JS_SYMBOL(toStringTag)) : JS_UNDEFINED;
        char fb[32] = "";
        if (js_is_string(fallback)) fb[js_view_to_utf8(js_string_view(ctx, fallback), fb, sizeof fb - 1)] = '\0';
        Builder b = { 0 };
        put_prefix(&b, ctx, constructor, tag, fb, size);
        put_ascii(&b, "[");
        brace0 = done(ip, &b);
        brace1 = "]";
        if (js_is_exception(brace0)) goto out;
        if (typed_length == 0 && keys.n == 0) {
            result = concat3(ip, "", brace0, "]");
            goto out;
        }
        extras_type = ARRAY_EXTRAS_TYPE;
        formatter = TYPED;
    } else {
        if (get_keys(ip, value, false, &keys) < 0) goto out;
        brace0 = cstr(ip, "{");
        /* a Date's ISO string or a RegExp's /source/flags: the base, after a subclass's prefix */
        const char *special = "Date";
        JSValue date = ctx->rt->date_inspect ? keep(ip, ctx->rt->date_inspect(ctx, value)) : JS_EMPTY;
        if (js_is_empty(date) && ctx->rt->regexp_inspect) {
            date = keep(ip, ctx->rt->regexp_inspect(ctx, value));
            special = "RegExp";
        }
        if (js_is_exception(date)) goto out;
        bool object = !js_is_null(constructor) && str_eq_cstr(ctx, constructor, "Object");
        if (!js_is_empty(items) && (what == JS_PREVIEW_MAP || what == JS_PREVIEW_SET)) {
            bool map = what == JS_PREVIEW_MAP;
            uint32_t size = js_array_length(js_as_object(items)) / (map ? 2 : 1);
            char sz[32];
            snprintf(sz, sizeof sz, "(%u)", size);
            if (size == 0 && keys.n == 0) {
                result = prefix_string(ip, constructor, tag, map ? "Map" : "Set", sz, "{}");
                goto out;
            }
            brace0 = prefix_string(ip, constructor, tag, map ? "Map" : "Set", sz, "{");
            formatter = COLLECTION;
        } else if (!js_is_empty(items)) {
            brace0 = iterator_braces(ip, tag, what);
            formatter = COLLECTION;
        } else if (!js_is_empty(date)) {
            /* "MyDate 1970-…", "MyRegExp /a/g" */
            base = date;
            Builder b = { 0 };
            char plain[16];
            snprintf(plain, sizeof plain, "%s ", special);
            put_prefix(&b, ctx, constructor, tag, special, "");
            if (b.length != strlen(plain) || memcmp_units(&b, plain)) {
                put_str(&b, ctx, base);
                base = done(ip, &b);
                if (js_is_exception(base)) goto out;
            } else {
                free(b.units);
            }
            if (keys.n == 0) {
                result = base;
                goto out;
            }
            brace0 = cstr(ip, "{");
        } else if (js_is_array_buffer(value)) {
            brace0 = prefix_string(ip, constructor, tag, "ArrayBuffer", "", "{");
            formatter = BUFFER;
        } else if (strcmp(cls, "DataView") == 0) {
            brace0 = prefix_string(ip, constructor, tag, "DataView", "", "{");
            formatter = DATA_VIEW;
        } else if (js_is_function(value)) {
            base = function_base(ip, value, constructor, tag);
            if (js_is_exception(base) || keys.n == 0) {
                result = base;
                goto out;
            }
        } else if (object && strcmp(cls, "Arguments") == 0) {
            brace0 = cstr(ip, "[Arguments] {");
            if (keys.n == 0) {
                result = cstr(ip, "[Arguments] {}");
                goto out;
            }
        } else if (object) {
            if (js_string_length(tag) != 0) brace0 = prefix_string(ip, constructor, tag, "Object", "", "{");
            if (keys.n == 0) {
                result = concat3(ip, "", brace0, "}");
                goto out;
            }
        } else if (strcmp(cls, "Error") == 0 || js_is_error(value) || inherits_error(ctx, value)) {
            base = format_error(ip, value, constructor, tag, &keys);
            if (js_is_exception(base) || keys.n == 0) {
                result = base;
                goto out;
            }
        } else if (js_is_wrapper(value)) {
            base = boxed_base(ip, value, constructor, tag, &keys);
            if (js_is_exception(base) || keys.n == 0) {
                result = base;
                goto out;
            }
        } else if (js_is_promise(value)) {
            brace0 = prefix_string(ip, constructor, tag, "Promise", "", "{");
            formatter = PROMISE;
        } else if (strcmp(cls, "WeakSet") == 0) {
            brace0 = prefix_string(ip, constructor, tag, "WeakSet", "", "{");
            formatter = WEAK;
        } else if (strcmp(cls, "WeakMap") == 0) {
            brace0 = prefix_string(ip, constructor, tag, "WeakMap", "", "{");
            formatter = WEAK;
        } else {
            if (keys.n == 0) {
                result = prefix_string(ip, constructor, tag, "Object", "", "{}");
                goto out;
            }
            brace0 = prefix_string(ip, constructor, tag, "Object", "", "{");
        }
        if (js_is_exception(brace0)) goto out;
    }

    if (recurse > ip->o.depth) {
        Builder b = { 0 };
        if (!js_is_null(constructor)) put_ascii(&b, "[");
        put_prefix(&b, ctx, constructor, tag, "Object", "");
        b.length--;
        if (!js_is_null(constructor)) put_ascii(&b, "]");
        result = done(ip, &b);
        goto out;
    }
    recurse += 1;
    list_push(&ip->seen, value);
    ip->current_depth = recurse;
    switch (formatter) {
    case ARRAY:
        if (format_array(ip, value, recurse, &output) < 0) goto out;
        break;
    case PROMISE: {
        JSPromise *p = js_as_promise(value);
        if (p->state == JS_PROMISE_PENDING) {
            if (push_result(&output, cstr(ip, "<pending>")) < 0) goto out;
        } else {
            ip->indentation += 2;
            JSValue str = format_value(ip, p->result, recurse);
            ip->indentation -= 2;
            if (js_is_exception(str)) goto out;
            if (p->state == JS_PROMISE_REJECTED) str = concat3(ip, "<rejected> ", str, "");
            if (push_result(&output, str) < 0) goto out;
        }
        break;
    }
    case WEAK:
        if (push_result(&output, cstr(ip, "<items unknown>")) < 0) goto out;
        break;
    case COLLECTION:
        if (format_collection(ip, items, what, recurse, &output) < 0) goto out;
        break;
    case BUFFER:
        if (format_array_buffer(ip, value, &output) < 0) goto out;
        break;
    case TYPED: {  /* formatTypedArray */
        double max = ip->o.max_array_length < 0 ? 0 : ip->o.max_array_length;
        if (max > typed_length) max = typed_length;
        for (uint32_t i = 0; i < max; i++) {
            JSValue e = get(ip, value, js_index_key(i));
            if (js_is_exception(e) || push_result(&output, format_primitive(ip, e)) < 0) goto out;
        }
        if (typed_length > max && push_result(&output, remaining_text(ip, typed_length - max)) < 0) goto out;
        break;
    }
    case DATA_VIEW: {
        static const char *const names[] = { "byteLength", "byteOffset", "buffer" };
        for (int i = 0; i < 3; i++) {
            JSValue v = get(ip, value, js_atom_from_cstr(ctx, names[i]));
            if (js_is_exception(v) || push_result(&output, hidden_entry(ip, names[i], v, recurse)) < 0) goto out;
        }
        break;
    }
    case PLAIN:
        break;
    }
    for (size_t i = 0; i < keys.n; i++)
        if (push_result(&output, format_property(ip, value, recurse, keys.v[i], extras_type)) < 0) goto out;

    for (size_t i = 0; i < ip->circular.n; i++) {
        if (!js_same_bits(ip->circular.v[i], value)) continue;
        char ref[32];
        snprintf(ref, sizeof ref, "<ref *%zu>", i + 1);
        Builder b = { 0 };
        put_ascii(&b, ref);
        if (js_string_length(base) != 0) {
            put_ascii(&b, " ");
            put_str(&b, ctx, base);
        }
        if (ip->o.compact != COMPACT_TRUE) {
            base = done(ip, &b);
            if (js_is_exception(base)) goto out;
        } else {
            free(b.units);
            Builder c = { 0 };
            put_ascii(&c, ref);
            put_ascii(&c, " ");
            put_str(&c, ctx, brace0);
            brace0 = done(ip, &c);
            if (js_is_exception(brace0)) goto out;
        }
        break;
    }
    ip->seen.n--;
    if (ip->o.sorted) {
        /* Node sorts the formatted entries: all of an object's (a Map's, a Set's), only the named
         * properties after an array's elements */
        size_t from = extras_type == OBJECT_TYPE ? 0 : keys.n > 1 ? output.n - keys.n : output.n;
        for (size_t i = from + 1; i < output.n; i++) {
            JSValue s = output.v[i];
            size_t j = i;
            for (; j > from && js_string_compare(ctx, output.v[j - 1], s) > 0; j--) output.v[j] = output.v[j - 1];
            output.v[j] = s;
        }
    }
    result = reduce_to_single_string(ip, &output, base, brace0, brace1, extras_type, recurse, value);
out:
    list_free(&keys);
    list_free(&output);
    return result;
}

/* ---- formatValue ------------------------------------------------------------------------ */

static JSValue identity_stylize(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                                const JSValue *argv, JSValue new_target) {
    (void)ctx, (void)callee, (void)this_val, (void)new_target;
    return argc ? argv[0] : JS_UNDEFINED;
}

/* The options a custom inspector receives (getUserOptions): `depth` is the option, not the depth left. */
static JSValue user_options(Insp *ip) {
    JSContext *ctx = ip->ctx;
    JSValue o = keep(ip, js_new_object(ctx));
    if (js_is_exception(o)) return o;
    JSObject *obj = js_as_object(o);
    const JSInspectOptions *p = &ip->o;
#define FIELD(name, v) js_define_data(ctx, obj, js_atom_from_cstr(ctx, name), (v), JS_PROP_DEFAULT)
    FIELD("showHidden", js_bool(p->show_hidden));
    FIELD("depth", isinf(p->depth) ? JS_NULL : js_number(p->depth));
    FIELD("colors", JS_FALSE);
    FIELD("customInspect", js_bool(p->custom_inspect));
    FIELD("showProxy", JS_FALSE);
    FIELD("maxArrayLength", js_number(p->max_array_length));
    FIELD("maxStringLength", js_number(p->max_string_length));
    FIELD("breakLength", js_number(p->break_length));
    FIELD("compact", p->compact == COMPACT_TRUE ? JS_TRUE : p->compact == 0 ? JS_FALSE : js_int32(p->compact));
    FIELD("sorted", js_bool(p->sorted));
    FIELD("getters", p->getters == JS_INSPECT_GETTERS_ALL ? JS_TRUE
                     : p->getters == JS_INSPECT_GETTERS_GET ? js_new_string_cstr(ctx, "get")
                     : p->getters == JS_INSPECT_GETTERS_SET ? js_new_string_cstr(ctx, "set") : JS_FALSE);
    FIELD("numericSeparator", JS_FALSE);
    JSValue stylize = js_new_native(ctx, identity_stylize, js_atom_from_cstr(ctx, "stylize"), 2, JS_FN_STRICT);
    if (js_is_exception(stylize)) return stylize;
    FIELD("stylize", stylize);
#undef FIELD
    return o;
}

static JSValue format_value(Insp *ip, JSValue value, double recurse) {
    JSContext *ctx = ip->ctx;
    if (!is_object_like(value)) return format_primitive(ip, value);
    keep(ip, value);
    /* a proxy shows its target, and never runs its traps (getProxyDetails) */
    for (JSValue target; !js_is_empty(target = js_proxy_target(value));) {
        if (js_is_null(target)) return cstr(ip, "<Revoked Proxy>");
        value = target;
    }

    if (ip->o.custom_inspect) {
        JSValue key = keep(ip, js_symbol_for(ctx, js_new_string_cstr(ctx, "nodejs.util.inspect.custom")));
        if (js_is_exception(key)) return key;
        JSValue custom = get(ip, value, key);
        if (js_is_exception(custom)) return custom;
        JSValue inspect_fn = js_util_inspect_function(ctx);
        if (js_is_callable(custom) && !js_same_bits(custom, inspect_fn)) {
            /* not a class's prototype inspecting itself */
            bool own_prototype = false;
            JSValue ctor = get(ip, value, JS_ATOM(constructor));
            if (js_is_exception(ctor)) return ctor;
            if (js_is_object(ctor)) {
                JSValue proto = get(ip, ctor, JS_ATOM(prototype));
                if (js_is_exception(proto)) return proto;
                own_prototype = js_same_bits(proto, value);
            }
            if (!own_prototype) {
                JSValue depth = isinf(ip->o.depth) ? JS_NULL : js_number(ip->o.depth - recurse);
                JSValue options = user_options(ip);
                if (js_is_exception(options)) return options;
                JSValue args[3] = { depth, options, inspect_fn };
                JSValue ret = keep(ip, js_call(ctx, custom, value, 3, args));
                if (js_is_exception(ret)) return ret;
                if (!js_same_bits(ret, value)) {
                    if (!js_is_string(ret)) return format_value(ip, ret, recurse);
                    return replace_newlines(ip, ret, ip->indentation);
                }
            }
        }
    }

    for (size_t i = 0; i < ip->seen.n; i++) {
        if (!js_same_bits(ip->seen.v[i], value)) continue;
        size_t index = 0;
        for (size_t c = 0; c < ip->circular.n; c++)
            if (js_same_bits(ip->circular.v[c], value)) index = c + 1;
        if (!index) {
            list_push(&ip->circular, value);
            index = ip->circular.n;
        }
        char ref[40];
        snprintf(ref, sizeof ref, "[Circular *%zu]", index);
        return cstr(ip, ref);
    }
    return format_raw(ip, value, recurse);
}

static JSValue inspect_value(JSContext *ctx, JSValue v, const JSInspectOptions *o) {
    Insp ip;
    insp_init(&ip, ctx, o);
    if (js_is_exception(ip.keep)) return ip.keep;
    JSValue r = format_value(&ip, v, 0);
    insp_free(&ip);
    return r;
}

JSValue js_inspect_with(JSContext *ctx, JSValue v, const JSInspectOptions *o) {
    return inspect_value(ctx, v, o);
}

JSValue js_inspect(JSContext *ctx, JSValue v) {
    return inspect_value(ctx, v, &js_inspect_defaults);
}

/* ---- %j ---------------------------------------------------------------------------------- */

/* tryStringify: JSON.stringify, "[Circular]" for a cycle; undefined → "undefined". */
static int put_stringified(Insp *ip, Builder *b, JSValue v) {
    bool circular;
    JSValue s = js_json_stringify(ip->ctx, v, JS_UNDEFINED, JS_UNDEFINED, &circular);
    if (js_is_exception(s)) {
        if (!circular) return -1;
        js_discard(js_take_exception(ip->ctx));
        put_ascii(b, "[Circular]");
    } else if (js_is_undefined(s)) {
        put_ascii(b, "undefined");
    } else {
        put_str(b, ip->ctx, s);
    }
    return 0;
}

/* ---- util.format ------------------------------------------------------------------------ */

/* Whether `value`'s toString is a built-in one: %s then inspects it rather than calling it. */
static int has_built_in_to_string(Insp *ip, JSValue value) {
    JSContext *ctx = ip->ctx;
    JSValue to_string = get(ip, value, JS_ATOM(toString));
    if (js_is_exception(to_string)) return -1;
    if (!js_is_callable(to_string)) return 1;
    if (has_own(ctx, value, JS_ATOM(toString))) return 0;
    JSValue pointer = value;
    do {
        pointer = js_get_prototype_of(js_as_object(pointer));
    } while (js_is_object(pointer) && !has_own(ctx, pointer, JS_ATOM(toString)));
    if (!js_is_object(pointer)) return 1;
    JSPropertyDescriptor d;
    int has = own(ctx, pointer, JS_ATOM(constructor), &d);
    if (has < 0) return -1;
    if (!has || !(d.has & JS_DESC_VALUE) || !js_is_function(d.value)) return 0;
    /* Node's builtInObjects: the global functions whose names start with a capital letter */
    JSValue name = get(ip, d.value, JS_ATOM(name));
    if (js_is_exception(name)) return -1;
    if (!js_is_string(name) || js_string_length(name) == 0) return 0;
    uint32_t c = js_view_at(js_string_view(ctx, name), 0);
    if (c < 'A' || c > 'Z') return 0;
    JSValue key = keep(ip, js_to_property_key(ctx, name));
    if (js_is_exception(key)) return -1;
    JSValue global = ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT];
    if (own(ctx, global, key, &d) <= 0) return 0;
    return (d.has & JS_DESC_VALUE) && js_is_function(d.value);
}

static int put_inspected(Insp *ip, Builder *b, JSValue v, const JSInspectOptions *o) {
    JSValue s = keep(ip, inspect_value(ip->ctx, v, o));
    if (js_is_exception(s)) return -1;
    put_str(b, ip->ctx, s);
    return 0;
}

/* %d and %i of a BigInt: "5n" */
static int put_bigint(Insp *ip, Builder *b, JSValue v) {
    JSValue s = keep(ip, js_to_string(ip->ctx, v));
    if (js_is_exception(s)) return -1;
    put_str(b, ip->ctx, s);
    put_ascii(b, "n");
    return 0;
}

static int put_to_number(Insp *ip, Builder *b, JSValue v) {
    if (js_is_bigint(v)) return put_bigint(ip, b, v);
    if (js_is_symbol(v)) {
        put_ascii(b, "NaN");
        return 0;
    }
    double d;
    if (js_to_number(ip->ctx, &d, v)) return -1;
    put_number(b, d);
    return 0;
}

static int put_parsed(Insp *ip, Builder *b, JSValue v, bool integer) {
    if (integer && js_is_bigint(v)) return put_bigint(ip, b, v);
    if (js_is_symbol(v)) {
        put_ascii(b, "NaN");
        return 0;
    }
    JSValue s = keep(ip, js_to_string(ip->ctx, v));
    if (js_is_exception(s)) return -1;
    JSStrView sv = js_string_view(ip->ctx, s);
    put_number(b, integer ? js_parse_int(sv, 0) : js_parse_float(sv));
    return 0;
}

JSValue js_format_with(JSContext *ctx, const JSInspectOptions *o, uint32_t argc, const JSValue *argv) {
    if (argc == 0) return js_empty_string();
    if (argc == 1 && js_is_string(argv[0])) return argv[0];
    Insp ip;
    insp_init(&ip, ctx, o);
    if (js_is_exception(ip.keep)) return ip.keep;
    Builder b = { 0 };
    uint32_t a = 0;
    const char *join = "";
    int rc = 0;

    if (js_is_string(argv[0])) {
        JSStrView f = js_string_view(ctx, argv[0]);
        uint32_t last = 0;
        for (uint32_t i = 0; f.length && i < f.length - 1 && rc == 0; i++) {
            if (js_view_at(f, i) != '%') continue;
            uint32_t next = js_view_at(f, ++i);
            if (a + 1 == argc) {  /* no argument left: only %% is replaced */
                if (next == '%') {
                    put_view(&b, f, last, i);
                    last = i + 1;
                }
                continue;
            }
            Builder piece = { 0 };
            JSValue arg = JS_UNDEFINED;
            switch (next) {
            case 's': {
                arg = argv[++a];
                if (js_is_number(arg)) {
                    put_number(&piece, js_as_number(arg));
                    break;
                }
                if (js_is_bigint(arg)) {  /* 7n */
                    rc = put_bigint(&ip, &piece, arg);
                    break;
                }
                int builtin = js_is_object(arg) ? has_built_in_to_string(&ip, arg) : 0;
                if (builtin < 0) {
                    rc = -1;
                } else if (!js_is_object(arg) || !builtin) {
                    /* String(arg): a symbol is its description, not a TypeError */
                    JSValue s = keep(&ip, js_is_symbol(arg) ? js_symbol_descriptive_string(ctx, arg) : js_to_string(ctx, arg));
                    if (js_is_exception(s)) rc = -1;
                    else put_str(&piece, ctx, s);
                } else {
                    JSInspectOptions so = *o;
                    so.depth = 0;
                    so.compact = 3;
                    rc = put_inspected(&ip, &piece, arg, &so);
                }
                break;
            }
            case 'j': rc = put_stringified(&ip, &piece, argv[++a]); break;
            case 'd': rc = put_to_number(&ip, &piece, argv[++a]); break;
            case 'i': rc = put_parsed(&ip, &piece, argv[++a], true); break;
            case 'f': rc = put_parsed(&ip, &piece, argv[++a], false); break;
            case 'O': rc = put_inspected(&ip, &piece, argv[++a], o); break;
            case 'o': {
                JSInspectOptions oo = *o;
                oo.show_hidden = true;
                oo.depth = 4;
                rc = put_inspected(&ip, &piece, argv[++a], &oo);
                break;
            }
            case 'c': a++; break;
            case '%':
                put_view(&b, f, last, i);
                last = i + 1;
                free(piece.units);
                continue;
            default:
                free(piece.units);
                continue;
            }
            if (rc == 0) {
                if (last != i - 1) put_view(&b, f, last, i - 1);
                reserve(&b, piece.length);
                if (piece.length) memcpy(b.units + b.length, piece.units, piece.length * sizeof *piece.units);
                b.length += piece.length;
                last = i + 1;
            }
            free(piece.units);
        }
        if (rc == 0 && last != 0) {
            a++;
            join = " ";
            if (last < f.length) put_view(&b, f, last, f.length);
        }
    }
    for (; a < argc && rc == 0; a++) {
        put_ascii(&b, join);
        if (js_is_string(argv[a])) put_str(&b, ctx, argv[a]);
        else rc = put_inspected(&ip, &b, argv[a], o);
        join = " ";
    }
    insp_free(&ip);
    if (rc) {
        free(b.units);
        return JS_EXCEPTION;
    }
    return finish(ctx, &b);
}

JSValue js_format(JSContext *ctx, uint32_t argc, const JSValue *argv) {
    return js_format_with(ctx, &js_inspect_defaults, argc, argv);
}

/* ---- Options from JavaScript, and node:util's functions ------------------------------------ */

/* util.inspect's options object: the keys Node knows (others are ignored). */
int js_inspect_options_from(JSContext *ctx, JSValue opts, JSInspectOptions *o) {
    if (!js_is_object(opts)) return 0;
    JSValue all = js_own_keys(ctx, js_as_object(opts));
    if (js_is_exception(all)) return -1;
    JSValueArray *list = (JSValueArray *)js_as_cell(all);
    for (uint32_t i = 0; i < list->cell.aux; i++) {
        JSValue key = list->values[i];
        if (!js_is_string(key) || !own_enumerable(ctx, opts, key)) continue;
        JSValue v = js_get_value(ctx, opts, key);
        if (js_is_exception(v)) return -1;
        double d = js_is_number(v) ? js_as_number(v) : NAN;
        if (str_eq_cstr(ctx, key, "showHidden")) o->show_hidden = js_truthy(v);
        else if (str_eq_cstr(ctx, key, "depth")) o->depth = js_is_null(v) ? INFINITY : js_is_number(v) ? d : o->depth;
        else if (str_eq_cstr(ctx, key, "customInspect")) o->custom_inspect = js_truthy(v);
        else if (str_eq_cstr(ctx, key, "maxArrayLength")) o->max_array_length = js_is_null(v) ? INFINITY : js_is_number(v) ? d : o->max_array_length;
        else if (str_eq_cstr(ctx, key, "maxStringLength")) o->max_string_length = js_is_null(v) ? INFINITY : js_is_number(v) ? d : o->max_string_length;
        else if (str_eq_cstr(ctx, key, "breakLength")) o->break_length = js_is_number(v) ? d : o->break_length;
        else if (str_eq_cstr(ctx, key, "compact")) o->compact = js_is_bool(v) ? (js_as_bool(v) ? COMPACT_TRUE : 0) : js_is_number(v) ? (int)d : o->compact;
        else if (str_eq_cstr(ctx, key, "sorted")) o->sorted = js_truthy(v);
        else if (str_eq_cstr(ctx, key, "getters"))
            o->getters = js_is_bool(v) ? (js_as_bool(v) ? JS_INSPECT_GETTERS_ALL : JS_INSPECT_GETTERS_OFF)
                       : js_is_string(v) && str_eq_cstr(ctx, v, "get") ? JS_INSPECT_GETTERS_GET
                       : js_is_string(v) && str_eq_cstr(ctx, v, "set") ? JS_INSPECT_GETTERS_SET : JS_INSPECT_GETTERS_OFF;
    }
    return 0;
}

/* util.inspect(value, options) — also inspect(value, showHidden, depth) */
JSValue js_util_inspect(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                        const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    JSInspectOptions o = js_inspect_defaults;
    if (argc > 1) {
        if (js_is_bool(argv[1])) o.show_hidden = js_as_bool(argv[1]);
        else if (js_inspect_options_from(ctx, argv[1], &o) < 0) return JS_EXCEPTION;
        if (argc > 2 && !js_is_undefined(argv[2])) o.depth = js_is_null(argv[2]) ? INFINITY : js_is_number(argv[2]) ? js_as_number(argv[2]) : o.depth;
    }
    return inspect_value(ctx, argc ? argv[0] : JS_UNDEFINED, &o);
}

/* util.format(...args) */
JSValue js_util_format(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                       const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    return js_format(ctx, argc, argv);
}

/* util.formatWithOptions(options, ...args) */
JSValue js_util_format_with_options(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                                    const JSValue *argv, JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    JSInspectOptions o = js_inspect_defaults;
    if (argc && js_inspect_options_from(ctx, argv[0], &o) < 0) return JS_EXCEPTION;
    return js_format_with(ctx, &o, argc ? argc - 1 : 0, argv + (argc ? 1 : 0));
}

/* The util.inspect function object custom inspectors receive: one per realm. */
JSValue js_util_inspect_function(JSContext *ctx) {
    JSValue *slot = &ctx->intrinsics[JS_INTRINSIC_UTIL_INSPECT];
    if (!js_is_function(*slot)) {
        JSValue f = js_new_native(ctx, js_util_inspect, js_atom_from_cstr(ctx, "inspect"), 2, JS_FN_STRICT);
        if (js_is_exception(f)) return f;
        *slot = f;
    }
    return *slot;
}
