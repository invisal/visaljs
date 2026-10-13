/* Headers (Fetch §5.2), the headers component, as Node's (undici's): a list of
 * (name, value) in the order added, names compared case-insensitively. Iteration is sorted by
 * lowercase name with the values of a name combined (", "), except Set-Cookie's, each its own
 * entry; inspection shows each name as first given (`Headers { 'Content-Type': 'text/plain' }`).
 * A guard makes a Response's headers immutable, or drops forbidden names; the fetch component
 * sets it through js_headers_set_guard. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtins_util.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_exception.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "js_web.h"
#include "jscontext.h"
#include "jsstring.h"

/* A failure's -1, after the call that threw (the throwers' results must be used). */
static int fail(JSValue thrown) {
    (void)thrown;
    return -1;
}

typedef struct HeadersObject {
    JSObject obj;
    JSValue *list;    /* lowercase name, name as given, value; … (strings), in the order added */
    uint32_t n, cap;  /* JSValues in use (3 per header) */
    uint8_t  guard;   /* JSHeadersGuard */
    JSValue  sorted;  /* the iteration's [name, value] pairs, cached; undefined when stale */
} HeadersObject;

typedef struct HeadersIterator {
    JSObject obj;
    JSValue  headers;
    uint32_t index;
    uint8_t  kind;  /* 0 keys, 1 values, 2 entries */
} HeadersIterator;

static void headers_visit(JSCell *c, JSTracer *trc) {
    HeadersObject *h = (HeadersObject *)c;
    for (uint32_t i = 0; i < h->n; i++) js_trace_value(trc, h->list[i]);
    js_trace_value(trc, h->sorted);
}
static void headers_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    free(((HeadersObject *)c)->list);
}
static void iterator_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((HeadersIterator *)c)->headers); }

static const JSClass headers_class = { "Headers", sizeof(HeadersObject), NULL, NULL, NULL, NULL, headers_visit, headers_finalize, NULL };
static const JSClass iterator_class = { "Headers Iterator", sizeof(HeadersIterator), NULL, NULL, NULL, NULL, iterator_visit, NULL, NULL };

static HeadersObject *as_headers(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &headers_class ? (HeadersObject *)js_as_object(v) : NULL;
}

#define THIS_HEADERS()                       \
    HeadersObject *h = as_headers(this_val); \
    if (!h) return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_THIS", "Illegal invocation")

/* ---- Names and values ----------------------------------------------------------------------- */

static bool is_token_char(uint32_t c) {
    if (c >= 'a' && c <= 'z') return true;
    if (c >= 'A' && c <= 'Z') return true;
    if (c >= '0' && c <= '9') return true;
    return c < 0x80 && strchr("!#$%&'*+-.^_`|~", (int)c) && c != 0;
}

static bool valid_name(JSContext *ctx, JSValue name) {
    JSStrView v = js_string_view(ctx, name);
    if (v.length == 0) return false;
    for (uint32_t i = 0; i < v.length; i++)
        if (!is_token_char(js_view_at(v, i))) return false;
    return true;
}

static bool http_whitespace(uint32_t c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; }

/* A value normalized (leading and trailing HTTP whitespace removed); EMPTY when it has NUL, CR or LF. */
static JSValue normalize_value(JSContext *ctx, JSValue value) {
    JSStrView v = js_string_view(ctx, value);
    uint32_t start = 0, end = v.length;
    while (start < end && http_whitespace(js_view_at(v, start))) start++;
    while (end > start && http_whitespace(js_view_at(v, end - 1))) end--;
    for (uint32_t i = start; i < end; i++) {
        uint32_t c = js_view_at(v, i);
        if (c == 0 || c == '\r' || c == '\n') return JS_EMPTY;
    }
    return start == 0 && end == v.length ? value : js_substring(ctx, value, start, end);
}

/* ByteString conversion (WebIDL §3.2.10): a string of code units below 256, else a TypeError. */
static JSValue byte_string(JSContext *ctx, JSValue v, const char *context) {
    (void)context;
    JSValue s = js_to_string(ctx, v);
    if (js_is_exception(s)) return s;
    JSStrView view = js_string_view(ctx, s);
    for (uint32_t i = 0; i < view.length; i++)
        if (js_view_at(view, i) > 255)
            return js_throw_type_error(ctx, "Cannot convert argument to a ByteString because the character at index %u has a value of %u which is greater than 255.",
                                       i, js_view_at(view, i));
    return s;
}

static JSValue lowercase(JSContext *ctx, JSValue s) {
    JSStrView v = js_string_view(ctx, s);
    bool upper = false;
    for (uint32_t i = 0; i < v.length && !upper; i++) upper = js_view_at(v, i) >= 'A' && js_view_at(v, i) <= 'Z';
    if (!upper) return s;
    uint8_t small[128];
    uint8_t *b = v.length <= sizeof small ? small : malloc(v.length);
    if (!b) js_fatal("out of memory");
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        b[i] = (uint8_t)(c >= 'A' && c <= 'Z' ? c + 32 : c);
    }
    JSValue r = js_new_string_latin1(ctx, b, v.length);
    if (b != small) free(b);
    return r;
}

static void to_cstr(JSContext *ctx, JSValue s, char *buf, size_t cap) {
    buf[js_view_to_utf8(js_string_view(ctx, s), buf, cap - 1)] = '\0';
}

static bool is_name(JSContext *ctx, JSValue lower, const char *name) {
    JSStrView v = js_string_view(ctx, lower);
    size_t n = strlen(name);
    if (v.length != n) return false;
    for (uint32_t i = 0; i < v.length; i++)
        if (js_view_at(v, i) != (uint8_t)name[i]) return false;
    return true;
}

/* Forbidden request header names (Fetch §2.2.2), for the request-no-cors guard; Node's undici
 * doesn't forbid any for "request", so neither do we. */

/* ---- The list ------------------------------------------------------------------------------- */

static void invalidate(JSContext *ctx, HeadersObject *h) { js_store(ctx, &h->obj.cell, &h->sorted, JS_UNDEFINED); }

static void list_push(JSContext *ctx, HeadersObject *h, JSValue lower, JSValue name, JSValue value) {
    if (h->n + 3 > h->cap) {
        uint32_t cap = h->cap ? h->cap * 2 : 24;
        JSValue *list = realloc(h->list, cap * sizeof *list);
        if (!list) js_fatal("out of memory adding a header");
        h->list = list;
        h->cap = cap;
    }
    js_store(ctx, &h->obj.cell, &h->list[h->n++], lower);
    js_store(ctx, &h->obj.cell, &h->list[h->n++], name);
    js_store(ctx, &h->obj.cell, &h->list[h->n++], value);
}

static int64_t find(JSContext *ctx, HeadersObject *h, JSValue lower, uint32_t from) {
    for (uint32_t i = from; i < h->n; i += 3)
        if (js_string_equals(ctx, h->list[i], lower)) return i;
    return -1;
}

static void remove_all(JSContext *ctx, HeadersObject *h, JSValue lower) {
    uint32_t o = 0;
    for (uint32_t i = 0; i < h->n; i += 3) {
        if (js_string_equals(ctx, h->list[i], lower)) continue;
        if (o != i) memmove(h->list + o, h->list + i, 3 * sizeof *h->list);
        o += 3;
    }
    h->n = o;
}

static JSValue throw_immutable(JSContext *ctx) { return js_throw_type_error(ctx, "immutable"); }

/* Validates and converts a name/value pair for `method` ("Headers.append"). 0, or -1. */
static int checked_pair(JSContext *ctx, const char *method, JSValue name_arg, JSValue value_arg, JSValue *name, JSValue *value) {
    *name = byte_string(ctx, name_arg, method);
    if (js_is_exception(*name)) return -1;
    *value = byte_string(ctx, value_arg, method);
    if (js_is_exception(*value)) return -1;
    char s[256];
    if (!valid_name(ctx, *name)) {
        to_cstr(ctx, *name, s, sizeof s);
        return fail(js_throw_type_error(ctx, "%s: \"%s\" is an invalid header name.", method, s));
    }
    JSValue v = normalize_value(ctx, *value);
    if (js_is_empty(v)) {
        to_cstr(ctx, *value, s, sizeof s);
        return fail(js_throw_type_error(ctx, "%s: \"%s\" is an invalid header value.", method, s));
    }
    *value = v;
    return 0;
}

/* Append (Fetch §5.2): a name's values combine with ", " (Set-Cookie's stay apart). 0, or -1. */
static int append(JSContext *ctx, HeadersObject *h, const char *method, JSValue name_arg, JSValue value_arg) {
    JSValue name, value;
    if (checked_pair(ctx, method, name_arg, value_arg, &name, &value) < 0) return -1;
    if (h->guard == JS_HEADERS_IMMUTABLE) return fail(throw_immutable(ctx));
    JSValue lower = lowercase(ctx, name);
    if (js_is_exception(lower)) return -1;
    invalidate(ctx, h);
    int64_t i = is_name(ctx, lower, "set-cookie") ? -1 : find(ctx, h, lower, 0);
    if (i >= 0) {
        JSValue combined = js_concat(ctx, js_concat(ctx, h->list[i + 2], js_new_string_cstr(ctx, ", ")), value);
        if (js_is_exception(combined)) return -1;
        js_store(ctx, &h->obj.cell, &h->list[i + 2], combined);
        return 0;
    }
    list_push(ctx, h, lower, name, value);
    return 0;
}

/* Fills a new Headers from an init: a Headers, a sequence of pairs, or a record. 0, or -1. */
static int fill(JSContext *ctx, HeadersObject *h, JSValue init) {
    HeadersObject *src = as_headers(init);
    if (src) {
        for (uint32_t i = 0; i < src->n; i += 3) list_push(ctx, h, src->list[i], src->list[i + 1], src->list[i + 2]);
        return 0;
    }
    if (!js_is_object(init))
        return fail(js_throw_type_error(ctx, "Headers constructor: Argument 1 could not be converted to one of: sequence<sequence<ByteString>>, record<ByteString, ByteString>."));
    JSValue method = js_get_value(ctx, init, JS_SYMBOL(iterator));
    if (js_is_exception(method)) return -1;
    if (!js_is_nullish(method)) {
        if (!js_is_callable(method)) return fail(js_throw_type_error(ctx, "Headers constructor: Symbol.iterator is not a function."));
        JSValue rec = js_iter_start(ctx, init);
        if (js_is_exception(rec)) return -1;
        for (;;) {
            JSValue pair = js_iter_next(ctx, rec);
            if (js_is_exception(pair)) return -1;
            if (js_is_empty(pair)) break;
            if (!js_is_object(pair))
                return fail(js_throw_type_error(ctx, "Headers constructor: expected name/value pair to be length 2, found %s.", "0"));
            JSValueArray *items = js_list_from_array_like(ctx, pair);
            if (!items) return -1;
            if (items->cell.aux != 2)
                return fail(js_throw_type_error(ctx, "Headers constructor: expected name/value pair to be length 2, found %u.", items->cell.aux));
            if (append(ctx, h, "Headers.append", items->values[0], items->values[1]) < 0) return -1;
        }
        return 0;
    }
    JSValue keys = js_own_keys(ctx, js_as_object(init));
    if (js_is_exception(keys)) return -1;
    JSValueArray *k = (JSValueArray *)js_as_cell(keys);
    for (uint32_t i = 0; i < k->cell.aux; i++) {
        JSValue key = k->values[i];
        if (js_is_symbol(key)) continue;
        JSPropertyDescriptor d;
        int has = js_get_own_property(ctx, js_as_object(init), key, &d);
        if (has < 0) return -1;
        if (!has || !(d.attrs & JS_PROP_ENUMERABLE)) continue;
        JSValue v = js_get_value(ctx, init, key);
        if (js_is_exception(v)) return -1;
        if (append(ctx, h, "Headers.append", key, v) < 0) return -1;
    }
    return 0;
}

static JSValue new_headers(JSContext *ctx, JSValue proto) {
    HeadersObject *h = (HeadersObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &headers_class, proto, 2));
    h->list = NULL;
    h->n = h->cap = 0;
    h->guard = JS_HEADERS_NONE;
    js_init_slot(&h->sorted, JS_UNDEFINED);
    return js_object_value(&h->obj);
}

/* The iteration's list (Fetch "sort and combine"): [name, value] pairs, sorted by name. */
static JSValue sorted_pairs(JSContext *ctx, HeadersObject *h) {
    if (!js_is_undefined(h->sorted)) return h->sorted;
    uint32_t count = h->n / 3;
    uint32_t *order = malloc((count ? count : 1) * sizeof *order);
    if (!order) js_fatal("out of memory");
    for (uint32_t i = 0; i < count; i++) order[i] = i;
    for (uint32_t i = 1; i < count; i++) {  /* insertion sort: stable, and header lists are short */
        uint32_t x = order[i], j = i;
        while (j > 0 && js_string_compare(ctx, h->list[order[j - 1] * 3], h->list[x * 3]) > 0) {
            order[j] = order[j - 1];
            j--;
        }
        order[j] = x;
    }
    JSValue result = js_new_array(ctx, count);
    for (uint32_t i = 0; i < count; i++) {
        JSValue pair[2] = { h->list[order[i] * 3], h->list[order[i] * 3 + 2] };
        if (js_array_push(ctx, js_as_object(result), js_new_array_from(ctx, pair, 2)) < 0) {
            free(order);
            return JS_EXCEPTION;
        }
    }
    free(order);
    js_store(ctx, &h->obj.cell, &h->sorted, result);
    return result;
}

/* ---- Methods -------------------------------------------------------------------------------- */

BUILTIN(headers_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "_Headers");
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_HEADERS_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    JSValue hv = new_headers(ctx, proto);
    if (!js_is_undefined(ARG(0)) && fill(ctx, as_headers(hv), ARG(0)) < 0) return JS_EXCEPTION;
    return hv;
}

static JSValue missing(JSContext *ctx, const char *method, uint32_t need, uint32_t got) {
    return got ? js_throw_type_error(ctx, "%s: %u argument%s required, but only %u found.", method, need, need > 1 ? "s" : "", got)
               : js_throw_type_error(ctx, "%s: %u argument%s required, but 0 found.", method, need, need > 1 ? "s" : "");
}

BUILTIN(headers_append) {
    UNUSED_ARGS;
    THIS_HEADERS();
    if (argc < 2) return missing(ctx, "Headers.append", 2, argc);
    return append(ctx, h, "Headers.append", argv[0], argv[1]) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
}

/* The lowercase name of a name argument, validated. */
static JSValue name_arg(JSContext *ctx, JSValue v, const char *method) {
    JSValue name = byte_string(ctx, v, method);
    if (js_is_exception(name)) return name;
    if (!valid_name(ctx, name)) {
        char s[256];
        to_cstr(ctx, name, s, sizeof s);
        return js_throw_type_error(ctx, "%s: \"%s\" is an invalid header name.", method, s);
    }
    return lowercase(ctx, name);
}

BUILTIN(headers_delete) {
    UNUSED_ARGS;
    THIS_HEADERS();
    if (argc < 1) return missing(ctx, "Headers.delete", 1, argc);
    JSValue lower = name_arg(ctx, argv[0], "Headers.delete");
    if (js_is_exception(lower)) return lower;
    if (h->guard == JS_HEADERS_IMMUTABLE) return throw_immutable(ctx);
    invalidate(ctx, h);
    remove_all(ctx, h, lower);
    return JS_UNDEFINED;
}

/* Get (Fetch §2.2.2): the values combined, or null */
static JSValue get_combined(JSContext *ctx, HeadersObject *h, JSValue lower) {
    JSValue result = JS_NULL;
    for (int64_t i = find(ctx, h, lower, 0); i >= 0; i = find(ctx, h, lower, (uint32_t)i + 3)) {
        result = js_is_null(result) ? h->list[i + 2] : js_concat(ctx, js_concat(ctx, result, js_new_string_cstr(ctx, ", ")), h->list[i + 2]);
        if (js_is_exception(result)) return result;
    }
    return result;
}

BUILTIN(headers_get) {
    UNUSED_ARGS;
    THIS_HEADERS();
    if (argc < 1) return missing(ctx, "Headers.get", 1, argc);
    JSValue lower = name_arg(ctx, argv[0], "Headers.get");
    if (js_is_exception(lower)) return lower;
    return get_combined(ctx, h, lower);
}

BUILTIN(headers_has) {
    UNUSED_ARGS;
    THIS_HEADERS();
    if (argc < 1) return missing(ctx, "Headers.has", 1, argc);
    JSValue lower = name_arg(ctx, argv[0], "Headers.has");
    if (js_is_exception(lower)) return lower;
    return js_bool(find(ctx, h, lower, 0) >= 0);
}

/* Set: replaces the first occurrence's value, removes the rest */
BUILTIN(headers_set) {
    UNUSED_ARGS;
    THIS_HEADERS();
    if (argc < 2) return missing(ctx, "Headers.set", 2, argc);
    JSValue name, value;
    if (checked_pair(ctx, "Headers.set", argv[0], argv[1], &name, &value) < 0) return JS_EXCEPTION;
    if (h->guard == JS_HEADERS_IMMUTABLE) return throw_immutable(ctx);
    JSValue lower = lowercase(ctx, name);
    if (js_is_exception(lower)) return lower;
    invalidate(ctx, h);
    int64_t i = find(ctx, h, lower, 0);
    if (i < 0) {
        list_push(ctx, h, lower, name, value);
        return JS_UNDEFINED;
    }
    js_store(ctx, &h->obj.cell, &h->list[i + 2], value);
    uint32_t o = (uint32_t)i + 3;
    for (uint32_t k = (uint32_t)i + 3; k < h->n; k += 3) {
        if (js_string_equals(ctx, h->list[k], lower)) continue;
        if (o != k) memmove(h->list + o, h->list + k, 3 * sizeof *h->list);
        o += 3;
    }
    h->n = o;
    return JS_UNDEFINED;
}

BUILTIN(headers_get_set_cookie) {
    UNUSED_ARGS;
    THIS_HEADERS();
    JSValue result = js_new_array(ctx, 0);
    for (uint32_t i = 0; i < h->n; i += 3)
        if (is_name(ctx, h->list[i], "set-cookie") && js_array_push(ctx, js_as_object(result), h->list[i + 2]) < 0) return JS_EXCEPTION;
    return result;
}

BUILTIN(headers_for_each) {
    UNUSED_ARGS;
    THIS_HEADERS();
    if (!js_is_callable(ARG(0)))
        return js_throw_type_error(ctx, "Headers.forEach: Argument 1 could not be converted to: Function.");
    for (uint32_t i = 0;; i++) {  /* the list is live */
        JSValue pairs = sorted_pairs(ctx, h);
        if (js_is_exception(pairs)) return pairs;
        if (i >= js_array_length(js_as_object(pairs))) break;
        JSValue pair = js_get_elem(ctx, pairs, js_int32((int32_t)i));
        if (js_is_exception(pair)) return pair;
        JSValue args[3] = { js_get_elem(ctx, pair, js_int32(1)), js_get_elem(ctx, pair, js_int32(0)), this_val };
        JSValue r = js_call(ctx, ARG(0), ARG(1), 3, args);
        if (js_is_exception(r)) return r;
    }
    return JS_UNDEFINED;
}

static JSValue new_iterator(JSContext *ctx, JSValue headers, uint8_t kind) {
    HeadersIterator *it = (HeadersIterator *)js_alloc_object(ctx, JS_CELL_OBJECT,
        js_shape_root(ctx, &iterator_class, ctx->intrinsics[JS_INTRINSIC_HEADERS_ITERATOR_PROTOTYPE], 0));
    js_init_slot(&it->headers, headers);
    it->index = 0;
    it->kind = kind;
    return js_object_value(&it->obj);
}

BUILTIN(headers_keys) {
    UNUSED_ARGS;
    THIS_HEADERS();
    return new_iterator(ctx, this_val, 0);
}
BUILTIN(headers_values) {
    UNUSED_ARGS;
    THIS_HEADERS();
    return new_iterator(ctx, this_val, 1);
}
BUILTIN(headers_entries) {
    UNUSED_ARGS;
    THIS_HEADERS();
    return new_iterator(ctx, this_val, 2);
}

BUILTIN(iterator_next) {
    UNUSED_ARGS;
    HeadersIterator *it = js_is_object(this_val) && js_as_object(this_val)->shape->cls == &iterator_class ? (HeadersIterator *)js_as_object(this_val) : NULL;
    if (!it) return js_throw_type_error(ctx, "'next' called on an object that does not implement interface Headers Iterator.");
    JSValue pairs = sorted_pairs(ctx, as_headers(it->headers));
    if (js_is_exception(pairs)) return pairs;
    if (it->index >= js_array_length(js_as_object(pairs))) return js_iter_result(ctx, JS_UNDEFINED, true);
    JSValue pair = js_get_elem(ctx, pairs, js_int32((int32_t)it->index++));
    if (js_is_exception(pair)) return pair;
    if (it->kind == 2) {
        JSValue copy[2] = { js_get_elem(ctx, pair, js_int32(0)), js_get_elem(ctx, pair, js_int32(1)) };
        return js_iter_result(ctx, js_new_array_from(ctx, copy, 2), false);
    }
    return js_iter_result(ctx, js_get_elem(ctx, pair, js_int32(it->kind)), false);
}

/* `Headers { 'Content-Type': 'text/plain' }`: each name as first given, the values combined */
BUILTIN(headers_inspect) {
    UNUSED_ARGS;
    THIS_HEADERS();
    JSValue o = js_new_object(ctx);
    for (uint32_t i = 0; i < h->n; i += 3) {
        bool seen = false;
        for (uint32_t k = 0; k < i && !seen; k += 3) seen = js_string_equals(ctx, h->list[k], h->list[i]);
        if (seen) continue;
        JSValue v = get_combined(ctx, h, h->list[i]);
        if (js_is_exception(v)) return v;
        JSValue key = js_to_property_key(ctx, h->list[i + 1]);
        if (js_is_exception(key)) return key;
        js_define_data(ctx, js_as_object(o), key, v, JS_PROP_DEFAULT);
    }
    return js_inspect_named(ctx, "Headers", o, ARG(0), ARG(1));
}

/* ---- C callers (the fetch component) -------------------------------------------------------- */

bool js_is_headers(JSValue v) { return as_headers(v) != NULL; }

JSValue js_new_headers_from(JSContext *ctx, JSValue init) {
    JSValue hv = new_headers(ctx, ctx->intrinsics[JS_INTRINSIC_HEADERS_PROTOTYPE]);
    if (!js_is_undefined(init) && fill(ctx, as_headers(hv), init) < 0) return JS_EXCEPTION;
    return hv;
}

void js_headers_set_guard(JSValue headers, JSHeadersGuard guard) { as_headers(headers)->guard = (uint8_t)guard; }

int js_headers_append(JSContext *ctx, JSValue headers, JSValue name, JSValue value) {
    HeadersObject *h = as_headers(headers);
    uint8_t guard = h->guard;
    h->guard = JS_HEADERS_NONE;
    int r = append(ctx, h, "Headers.append", name, value);
    h->guard = guard;
    return r;
}

JSValue js_headers_get(JSContext *ctx, JSValue headers, const char *lower) {
    JSValue name = js_new_string_cstr(ctx, lower);
    return js_is_exception(name) ? name : get_combined(ctx, as_headers(headers), name);
}

uint32_t js_headers_count(JSValue headers) { return as_headers(headers)->n / 3; }

void js_headers_at(JSValue headers, uint32_t i, JSValue *lower, JSValue *name, JSValue *value) {
    HeadersObject *h = as_headers(headers);
    *lower = h->list[3 * i];
    *name = h->list[3 * i + 1];
    *value = h->list[3 * i + 2];
}

/* ---- Realm ---------------------------------------------------------------------------------- */

static const JSBuiltin headers_proto[] = {
    WEBIDL_OPERATION("append", headers_append, 2),
    WEBIDL_OPERATION("delete", headers_delete, 1),
    WEBIDL_OPERATION("get", headers_get, 1),
    WEBIDL_OPERATION("has", headers_has, 1),
    WEBIDL_OPERATION("set", headers_set, 2),
    WEBIDL_OPERATION("getSetCookie", headers_get_set_cookie, 0),
    WEBIDL_OPERATION("keys", headers_keys, 0),
    WEBIDL_OPERATION("values", headers_values, 0),
    WEBIDL_OPERATION("entries", headers_entries, 0),
    WEBIDL_OPERATION("forEach", headers_for_each, 1),
};

static const JSBuiltin iterator_proto[] = {
    WEBIDL_OPERATION("next", iterator_next, 0),
};

static void install_headers(JSContext *ctx, JSObject *global) {
    js_define_web_class(ctx, global, "Headers", headers_ctor, 0, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], JS_INTRINSIC_HEADERS_PROTOTYPE);
    JSValue hp = ctx->intrinsics[JS_INTRINSIC_HEADERS_PROTOTYPE];
    js_define_builtins(ctx, js_as_object(hp), headers_proto, JS_COUNTOF(headers_proto));
    js_define_inspect(ctx, hp, headers_inspect, "Headers");
    JSValue entries = js_get_value(ctx, hp, js_atom_from_cstr(ctx, "entries"));
    js_define_data(ctx, js_as_object(hp), JS_SYMBOL(iterator), entries, JS_BUILTIN_METHOD_ATTRS);

    JSValue ip = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_ITERATOR_PROTOTYPE], 4);
    ctx->intrinsics[JS_INTRINSIC_HEADERS_ITERATOR_PROTOTYPE] = ip;
    js_define_builtins(ctx, js_as_object(ip), iterator_proto, JS_COUNTOF(iterator_proto));
    js_define_data(ctx, js_as_object(ip), JS_SYMBOL(toStringTag), js_new_string_cstr(ctx, "Headers Iterator"), JS_PROP_CONFIGURABLE);
}

const JSComponent js_component_headers = { "headers", install_headers };
