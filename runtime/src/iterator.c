/* Iterators (ECMAScript §7.4, §27.1): the protocol for for…of and spread, %IteratorPrototype%,
 * and the Array and String iterators (§23.1.5, §22.1.5). */
#include <stdio.h>

#include "internal.h"
#include "builtins_util.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_function.h"
#include "js_object.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "jscontext.h"

/* CreateIterResultObject (§7.4.14) */
JSValue js_iter_result(JSContext *ctx, JSValue value, bool done) {
    JSValue keys[2] = { JS_ATOM(value), JS_ATOM(done) };
    JSShape *shape = js_cached_shape(ctx, JS_INTRINSIC_ITER_RESULT_SHAPE, &js_class_object, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE],
                                     JS_DEFAULT_INLINE_SLOTS, 2, keys, JS_PROP_DEFAULT);
    JSObject *o = js_alloc_object(ctx, JS_CELL_OBJECT, shape);
    js_init_slot(js_object_slot(o, 0), value);
    js_init_slot(js_object_slot(o, 1), js_bool(done));
    return js_object_value(o);
}

/* ---- Array iterators (§23.1.5) ------------------------------------------------------ */

enum { KIND_KEYS, KIND_VALUES, KIND_ENTRIES };

typedef struct ArrayIterator {
    JSObject obj;
    JSValue  iterated;  /* undefined once exhausted */
    double   index;
    int      kind;
} ArrayIterator;

static void array_iterator_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((ArrayIterator *)c)->iterated); }

static const JSClass array_iterator_class = { "Array Iterator", sizeof(ArrayIterator), NULL, NULL, NULL, NULL, array_iterator_visit, NULL, NULL };

/* CreateArrayIterator (§23.1.5.1) */
static JSValue new_array_iterator(JSContext *ctx, JSValue array, int kind) {
    JSShape *shape = js_shape_root(ctx, &array_iterator_class, ctx->intrinsics[JS_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE], 0);
    ArrayIterator *it = (ArrayIterator *)js_alloc_object(ctx, JS_CELL_OBJECT, shape);
    js_store(ctx, &it->obj.cell, &it->iterated, array);
    it->index = 0;
    it->kind = kind;
    return js_object_value(&it->obj);
}

/* The next [key, value] of an array-like at `index`: the value (keys: the index), or EMPTY at the end. */
static JSValue array_step(JSContext *ctx, JSValue a, double index, int kind) {
    double len;
    double ta = ctx->rt->typed_array_length ? ctx->rt->typed_array_length(a) : -2;
    if (js_is_array(a)) len = js_array_length(js_as_object(a));
    else if (ta == -1) return js_throw_type_error(ctx, "Cannot perform %%ArrayIteratorPrototype%%.next on a detached ArrayBuffer");
    else if (ta >= 0) len = ta;  /* a typed array: its length now (§23.1.5.2.1) */
    else if (js_length_of_array_like(ctx, a, &len) < 0) return JS_EXCEPTION;
    if (index >= len) return JS_EMPTY;
    JSValue key = js_number(index);
    if (kind == KIND_KEYS) return key;
    JSValue value = js_get_value(ctx, a, js_to_property_key(ctx, key));
    if (js_is_exception(value) || kind == KIND_VALUES) return value;
    JSValue pair[2] = { key, value };
    return js_new_array_from(ctx, pair, 2);
}

/* %ArrayIteratorPrototype%.next (§23.1.5.2.1) */
static JSValue array_iterator_next(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    if (!js_is_object(this_val) || js_as_object(this_val)->shape->cls != &array_iterator_class)
        return js_throw_type_error(ctx, "next method called on incompatible receiver (not an Array Iterator)");
    ArrayIterator *it = (ArrayIterator *)js_as_object(this_val);
    if (js_is_undefined(it->iterated)) return js_iter_result(ctx, JS_UNDEFINED, true);
    JSValue r = array_step(ctx, it->iterated, it->index, it->kind);
    if (js_is_exception(r)) return JS_EXCEPTION;
    if (js_is_empty(r)) {
        js_store(ctx, &it->obj.cell, &it->iterated, JS_UNDEFINED);
        return js_iter_result(ctx, JS_UNDEFINED, true);
    }
    it->index++;
    return js_iter_result(ctx, r, false);
}

#define ARRAY_ITERATOR_METHOD(fn, kind)                                                                     \
    JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, \
                      JSValue new_target) {                                                                 \
        (void)callee, (void)argc, (void)argv, (void)new_target;                                             \
        if (js_is_nullish(this_val)) return js_throw_type_error(ctx, "Array.prototype method called on null or undefined"); \
        JSValue o = js_to_object(ctx, this_val);                                                            \
        return js_is_exception(o) ? o : new_array_iterator(ctx, o, kind);                                   \
    }
ARRAY_ITERATOR_METHOD(js_core_array_proto_keys, KIND_KEYS)  /* array.c defines them on Array.prototype */
ARRAY_ITERATOR_METHOD(js_core_array_proto_values, KIND_VALUES)
ARRAY_ITERATOR_METHOD(js_core_array_proto_entries, KIND_ENTRIES)

/* ---- String iterators (§22.1.5) ----------------------------------------------------- */

typedef struct StringIterator {
    JSObject obj;
    JSValue  string;  /* undefined once exhausted */
    uint32_t index;
} StringIterator;

static void string_iterator_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((StringIterator *)c)->string); }

static const JSClass string_iterator_class = { "String Iterator", sizeof(StringIterator), NULL, NULL, NULL, NULL, string_iterator_visit, NULL, NULL };

/* The code point of s at *index (a surrogate pair together), advancing it; EMPTY at the end. */
static JSValue code_point_at(JSContext *ctx, JSValue s, uint32_t *index) {
    JSStrView v = js_string_view(ctx, s);
    uint32_t i = *index;
    if (i >= v.length) return JS_EMPTY;
    uint32_t n = 1, c = js_view_at(v, i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < v.length) {
        uint32_t d = js_view_at(v, i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) n = 2;
    }
    *index = i + n;
    return js_substring(ctx, s, i, i + n);
}

static JSValue string_iterator_next(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    if (!js_is_object(this_val) || js_as_object(this_val)->shape->cls != &string_iterator_class)
        return js_throw_type_error(ctx, "next method called on incompatible receiver (not a String Iterator)");
    StringIterator *it = (StringIterator *)js_as_object(this_val);
    if (js_is_undefined(it->string)) return js_iter_result(ctx, JS_UNDEFINED, true);
    JSValue r = code_point_at(ctx, it->string, &it->index);
    if (js_is_empty(r)) {
        js_store(ctx, &it->obj.cell, &it->string, JS_UNDEFINED);
        return js_iter_result(ctx, JS_UNDEFINED, true);
    }
    return js_iter_result(ctx, r, false);
}

/* String.prototype[@@iterator] (§22.1.3.36) */
static JSValue string_proto_iterator(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    if (js_is_nullish(this_val)) return js_throw_type_error(ctx, "String.prototype[Symbol.iterator] called on null or undefined");
    JSValue s = js_to_string(ctx, this_val);
    if (js_is_exception(s)) return JS_EXCEPTION;
    JSShape *shape = js_shape_root(ctx, &string_iterator_class, ctx->intrinsics[JS_INTRINSIC_STRING_ITERATOR_PROTOTYPE], 0);
    StringIterator *it = (StringIterator *)js_alloc_object(ctx, JS_CELL_OBJECT, shape);
    js_store(ctx, &it->obj.cell, &it->string, s);
    it->index = 0;
    return js_object_value(&it->obj);
}

/* %IteratorPrototype%[@@iterator] (§27.1.2.1): returns this */
static JSValue iterator_proto_iterator(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)ctx, (void)callee, (void)argc, (void)argv, (void)new_target;
    return this_val;
}

/* ---- Iterator records: the protocol for for…of and spread (§7.4) ---------------------- */

/* GENERIC: iterator.next() through the protocol. ARRAY and STRING: a fast path taken when
 * the built-in iterator would be used and nobody could tell the difference (@@iterator and
 * the iterator prototype's next are the original functions): the same steps, without the
 * iterator and result objects. */
enum { MODE_GENERIC, MODE_ARRAY, MODE_STRING };

typedef struct IterRecord {
    JSHostCell host;
    JSValue    iterator;  /* the iterator (GENERIC), or the array or string itself */
    JSValue    next;      /* GENERIC: the next method */
    double     index;
    int        mode;
    bool       done;
} IterRecord;

static void record_visit(JSCell *c, JSTracer *trc) {
    IterRecord *r = (IterRecord *)c;
    js_trace_value(trc, r->iterator);
    js_trace_value(trc, r->next);
}

static const JSCellClass record_class = { "IteratorRecord", record_visit, NULL, NULL };

/* Whether o's own data property `key` holds exactly `expected` (no getter runs). */
static bool own_data_is(JSContext *ctx, JSValue o, JSValue key, JSValue expected) {
    JSPropertyDescriptor d;
    return js_get_own_property(ctx, js_as_object(o), key, &d) == 1 && (d.has & JS_DESC_VALUE) && js_same_bits(d.value, expected);
}

static JSValue describe_value(JSContext *ctx, JSValue v, char *buf, size_t cap) {
    if (js_is_object(v)) snprintf(buf, cap, js_is_callable(v) ? "function" : "object");
    else if (js_is_symbol(v)) snprintf(buf, cap, "symbol");
    else {
        JSValue s = js_to_string(ctx, v);
        if (js_is_exception(s)) return JS_EXCEPTION;
        buf[js_view_to_utf8(js_string_view(ctx, s), buf, cap - 1)] = '\0';
    }
    return JS_UNDEFINED;
}

/* GetIterator(v, sync) (§7.4.3), as a record. */
JSValue js_iter_start(JSContext *ctx, JSValue v) {
    JSValue method = js_is_nullish(v) ? JS_UNDEFINED : js_get_value(ctx, v, JS_SYMBOL(iterator));
    if (js_is_exception(method)) return JS_EXCEPTION;
    if (!js_is_callable(method)) {
        char buf[64];
        if (js_is_exception(describe_value(ctx, v, buf, sizeof buf))) return JS_EXCEPTION;
        return js_throw_type_error(ctx, "%s is not iterable", buf);
    }
    IterRecord *r = (IterRecord *)js_alloc_host_cell(ctx, &record_class, sizeof(IterRecord));
    JSCell *c = &r->host.cell;
    js_store(ctx, c, &r->next, JS_UNDEFINED);
    if (js_is_array(v) && js_same_bits(method, ctx->intrinsics[JS_INTRINSIC_ARRAY_VALUES]) &&
        own_data_is(ctx, ctx->intrinsics[JS_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE], JS_ATOM(next), ctx->intrinsics[JS_INTRINSIC_ARRAY_ITERATOR_NEXT])) {
        js_store(ctx, c, &r->iterator, v);
        r->mode = MODE_ARRAY;
        return js_cell(c);
    }
    if (js_is_string(v) && js_same_bits(method, ctx->intrinsics[JS_INTRINSIC_STRING_ITERATOR]) &&
        own_data_is(ctx, ctx->intrinsics[JS_INTRINSIC_STRING_ITERATOR_PROTOTYPE], JS_ATOM(next), ctx->intrinsics[JS_INTRINSIC_STRING_ITERATOR_NEXT])) {
        js_store(ctx, c, &r->iterator, v);
        r->mode = MODE_STRING;
        return js_cell(c);
    }
    JSValue it = js_call(ctx, method, v, 0, NULL);
    if (js_is_exception(it)) return JS_EXCEPTION;
    if (!js_is_object(it)) return js_throw_type_error(ctx, "Result of the Symbol.iterator method is not an object");
    js_store(ctx, c, &r->iterator, it);
    JSValue next = js_get_value(ctx, it, JS_ATOM(next));
    if (js_is_exception(next)) return JS_EXCEPTION;
    js_store(ctx, c, &r->next, next);
    r->mode = MODE_GENERIC;
    return js_cell(c);
}

/* IteratorStepValue (§7.4.8): the next value, or JS_EMPTY when done, or JS_EXCEPTION. */
JSValue js_iter_next(JSContext *ctx, JSValue rec) {
    IterRecord *r = (IterRecord *)js_as_cell(rec);
    if (r->done) return JS_EMPTY;
    JSValue value;
    if (r->mode == MODE_ARRAY) {
        value = array_step(ctx, r->iterator, r->index, KIND_VALUES);
        r->index++;
    } else if (r->mode == MODE_STRING) {
        uint32_t i = (uint32_t)r->index;
        value = code_point_at(ctx, r->iterator, &i);
        r->index = i;
    } else {
        JSValue result = js_call(ctx, r->next, r->iterator, 0, NULL);
        if (js_is_exception(result)) {
            r->done = true;
            return JS_EXCEPTION;
        }
        if (!js_is_object(result)) {
            r->done = true;
            char buf[64];
            if (js_is_exception(describe_value(ctx, result, buf, sizeof buf))) return JS_EXCEPTION;
            return js_throw_type_error(ctx, "Iterator result %s is not an object", buf);
        }
        JSValue done = js_get_value(ctx, result, JS_ATOM(done));
        if (js_is_exception(done)) {
            r->done = true;
            return JS_EXCEPTION;
        }
        if (js_truthy(done)) value = JS_EMPTY;
        else value = js_get_value(ctx, result, JS_ATOM(value));
    }
    if (js_is_exception(value) || js_is_empty(value)) r->done = true;
    return value;
}

/* IteratorClose (§7.4.11) after a normal completion (break, return): 0, or -1 on exception. */
int js_iter_close(JSContext *ctx, JSValue rec) {
    IterRecord *r = (IterRecord *)js_as_cell(rec);
    if (r->mode != MODE_GENERIC || r->done) return 0;  /* built-in array and string iterators have no return() */
    r->done = true;
    JSValue ret = js_get_value(ctx, r->iterator, JS_ATOM(return));
    if (js_is_exception(ret)) return -1;
    if (js_is_nullish(ret)) return 0;
    if (!js_is_callable(ret)) {
        js_discard(js_throw_type_error(ctx, "The iterator's 'return' method is not callable"));
        return -1;
    }
    JSValue result = js_call(ctx, ret, r->iterator, 0, NULL);
    if (js_is_exception(result)) return -1;
    if (!js_is_object(result)) {
        js_discard(js_throw_type_error(ctx, "The iterator's 'return' method returned a non-object"));
        return -1;
    }
    return 0;
}

/* IteratorClose after a throw completion: return() runs, but the original exception wins. */
void js_iter_close_throw(JSContext *ctx, JSValue rec) {
    IterRecord *r = (IterRecord *)js_as_cell(rec);
    if (r->mode != MODE_GENERIC || r->done) return;
    r->done = true;
    JSValue ret = js_get_value(ctx, r->iterator, JS_ATOM(return));
    if (!js_is_exception(ret) && js_is_callable(ret)) ret = js_call(ctx, ret, r->iterator, 0, NULL);
    if (js_is_exception(ret)) js_discard(js_take_exception(ctx));
}

/* ---- Destructuring (§8.6.2, §13.15.5) -------------------------------------------------- */

/* An array pattern's next value: undefined once the iterator is done. */
JSValue js_iter_value(JSContext *ctx, JSValue rec) {
    JSValue v = js_iter_next(ctx, rec);
    return js_is_empty(v) ? JS_UNDEFINED : v;
}

/* An array pattern's rest element: the values left, in a new array. */
JSValue js_iter_rest(JSContext *ctx, JSValue rec) {
    JSValue a = js_new_array(ctx, 0);
    for (;;) {
        JSValue v = js_iter_next(ctx, rec);
        if (js_is_exception(v)) return JS_EXCEPTION;
        if (js_is_empty(v)) return a;
        if (js_array_push(ctx, js_as_object(a), v) < 0) return JS_EXCEPTION;
    }
}

/* An object pattern's value: RequireObjectCoercible. */
JSValue js_require_coercible(JSContext *ctx, JSValue v) {
    if (!js_is_nullish(v)) return v;
    const char *what = js_is_null(v) ? "null" : "undefined";
    return js_throw_type_error(ctx, "Cannot destructure '%s' as it is %s.", what, what);
}

/* CopyDataProperties (§7.3.25): the source's own enumerable properties, symbols included,
 * defined on `target`, except the keys in the array `excluded` (EMPTY: none). Null and
 * undefined have none. 0, or -1 on exception. */
static int copy_data_properties(JSContext *ctx, JSObject *target, JSValue source, JSValue excluded) {
    uint32_t n_ex = js_is_empty(excluded) ? 0 : js_array_length(js_as_object(excluded));
    if (js_is_string(source)) {  /* ToObject: a String object's own indices */
        for (uint32_t i = 0; i < js_string_length(source); i++) {
            bool skip = false;
            for (uint32_t j = 0; j < n_ex && !skip; j++) {
                JSValue k = js_to_property_key(ctx, js_get_value(ctx, excluded, js_index_key(j)));
                skip = js_same_bits(k, js_index_key(i));
            }
            if (!skip) js_define_data(ctx, target, js_index_key(i), js_substring(ctx, source, i, i + 1), JS_PROP_DEFAULT);
        }
        return 0;
    }
    if (!js_is_object(source)) return 0;
    JSObject *from = js_as_object(source);
    JSValue keys = js_own_keys(ctx, from);
    if (js_is_exception(keys)) return -1;
    JSValueArray *list = (JSValueArray *)js_as_cell(keys);
    for (uint32_t i = 0; i < list->cell.aux; i++) {
        JSValue key = list->values[i];
        bool skip = false;
        for (uint32_t j = 0; j < n_ex && !skip; j++) {
            JSValue k = js_to_property_key(ctx, js_get_value(ctx, excluded, js_index_key(j)));
            if (js_is_exception(k)) return -1;
            skip = js_same_bits(k, key);
        }
        if (skip) continue;
        JSPropertyDescriptor d;
        int r = js_get_own_property(ctx, from, key, &d);
        if (r < 0) return -1;
        if (!r || !(d.attrs & JS_PROP_ENUMERABLE)) continue;
        JSValue v = js_get(ctx, from, key, source);
        if (js_is_exception(v)) return -1;
        js_define_data(ctx, target, key, v, JS_PROP_DEFAULT);
    }
    return 0;
}

/* An object pattern's rest: a new object with the source's own enumerable properties, except
 * `excluded` (an array of keys). */
JSValue js_object_rest(JSContext *ctx, JSValue source, JSValue excluded) {
    JSValue target = js_new_object(ctx);
    return copy_data_properties(ctx, js_as_object(target), source, excluded) < 0 ? JS_EXCEPTION : target;
}

/* `{ ...source }` in an object literal: its own enumerable properties, defined on `target`. */
int js_object_spread(JSContext *ctx, JSValue target, JSValue source) {
    return copy_data_properties(ctx, js_as_object(target), source, JS_EMPTY);
}

/* ---- Realm --------------------------------------------------------------------------- */

static JSValue define_symbol_method(JSContext *ctx, JSObject *o, JSValue sym, const char *name, JSNativeFn fn) {
    JSValue f = js_new_native(ctx, fn, js_atom_from_cstr(ctx, name), 0, JS_FN_STRICT);
    js_define_data(ctx, o, sym, f, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return f;
}

void js_iterator_realm_init(JSContext *ctx) {
    JSValue *in = ctx->intrinsics;
    JSValue object_proto = in[JS_INTRINSIC_OBJECT_PROTOTYPE];

    in[JS_INTRINSIC_ITERATOR_PROTOTYPE] = js_new_object_proto(ctx, object_proto, 4);
    JSObject *iterator_proto = js_as_object(in[JS_INTRINSIC_ITERATOR_PROTOTYPE]);
    (void)define_symbol_method(ctx, iterator_proto, JS_SYMBOL(iterator), "[Symbol.iterator]", iterator_proto_iterator);

    /* Array iterators; Array.prototype.values is also Array.prototype[@@iterator] */
    in[JS_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE] = js_new_object_proto(ctx, in[JS_INTRINSIC_ITERATOR_PROTOTYPE], 4);
    JSObject *aip = js_as_object(in[JS_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE]);
    in[JS_INTRINSIC_ARRAY_ITERATOR_NEXT] = js_define_method(ctx, aip, "next", array_iterator_next, 0);
    js_define_data(ctx, aip, JS_SYMBOL(toStringTag), js_atom_from_cstr(ctx, "Array Iterator"), JS_PROP_CONFIGURABLE);
    /* Array.prototype.keys / values / entries and @@iterator: array.c's table, in V8's order */

    /* String iterators */
    in[JS_INTRINSIC_STRING_ITERATOR_PROTOTYPE] = js_new_object_proto(ctx, in[JS_INTRINSIC_ITERATOR_PROTOTYPE], 4);
    JSObject *sip = js_as_object(in[JS_INTRINSIC_STRING_ITERATOR_PROTOTYPE]);
    in[JS_INTRINSIC_STRING_ITERATOR_NEXT] = js_define_method(ctx, sip, "next", string_iterator_next, 0);
    js_define_data(ctx, sip, JS_SYMBOL(toStringTag), js_atom_from_cstr(ctx, "String Iterator"), JS_PROP_CONFIGURABLE);
    in[JS_INTRINSIC_STRING_ITERATOR] = define_symbol_method(ctx, js_as_object(in[JS_INTRINSIC_STRING_PROTOTYPE]),
                                                            JS_SYMBOL(iterator), "[Symbol.iterator]", string_proto_iterator);
}
