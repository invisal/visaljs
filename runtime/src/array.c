/* Array and Array.prototype (§23.1): core built-ins. The methods are generic, as
 * the spec makes them: they work on any array-like through Get/Set/HasProperty/Delete, so
 * holes, getters and proxies-to-come behave as in V8. Methods that create arrays honour
 * Symbol.species (ArraySpeciesCreate). */
#include "builtins_util.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "elements.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_exception.h"
#include "js_generator.h"
#include "js_promise.h"
#include "js_ops.h"
#include "jsstring.h"

/* ---- Abstract operations ------------------------------------------------------------------ */

static JSValue get_index(JSContext *ctx, JSValue o, double i) {
    JSValue k = js_index_key_of(ctx, i);
    return js_is_exception(k) ? k : js_get_value(ctx, o, k);
}

static int has_index(JSContext *ctx, JSValue o, double i) {
    JSValue k = js_index_key_of(ctx, i);
    return js_is_exception(k) ? -1 : js_has_value(ctx, o, k);
}

static int set_index(JSContext *ctx, JSValue o, double i, JSValue v) {
    JSValue k = js_index_key_of(ctx, i);
    return js_is_exception(k) ? -1 : js_set_value(ctx, o, k, v, true);
}

static int delete_index(JSContext *ctx, JSValue o, double i) {
    JSValue k = js_index_key_of(ctx, i);
    if (js_is_exception(k)) return -1;
    return js_is_exception(js_delete_value(ctx, o, k, true)) ? -1 : 0;
}

static int create_index(JSContext *ctx, JSValue o, double i, JSValue v) {
    JSValue k = js_index_key_of(ctx, i);
    return js_is_exception(k) ? -1 : js_create_data_property(ctx, o, k, v);
}

static int set_length(JSContext *ctx, JSValue o, double len) {
    return js_set_value(ctx, o, JS_ATOM(length), js_number(len), true) < 0 ? -1 : 0;
}

/* The receiver and its length: ToObject(this) (primitives stay primitive: their indexed
 * properties are readable through Get), LengthOfArrayLike. */
static int receiver(JSContext *ctx, JSValue this_val, const char *method, double *len) {
    if (!js_require_this(ctx, this_val, method)) return -1;
    return js_length_of_array_like(ctx, this_val, len);
}

/* ArrayCreate (§10.4.2.2) */
static JSValue array_create(JSContext *ctx, double length) {
    if (length > JS_MAX_ARRAY_LENGTH) return js_throw_range_error(ctx, "Invalid array length");
    JSValue a = js_new_array(ctx, 0);
    if (js_is_exception(a) || (length != 0 && set_length(ctx, a, length) < 0)) return JS_EXCEPTION;
    return a;
}

static JSValue array_ctor(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);

/* ArraySpeciesCreate (§10.4.2.3) */
static JSValue array_species_create(JSContext *ctx, JSValue original, double length) {
    int is_array = js_is_array_spec(ctx, original);
    if (is_array < 0) return JS_EXCEPTION;
    if (!is_array) return array_create(ctx, length);
    JSValue c = js_get_value(ctx, original, JS_ATOM(constructor));
    if (js_is_exception(c)) return c;
    /* another realm's %Array% counts as none: arrays stay in the caller's realm */
    if (js_is_function(c) && js_as_function(c)->entry == array_ctor && js_as_function(c)->realm != ctx) c = JS_UNDEFINED;
    if (js_is_object(c)) {
        c = js_get_value(ctx, c, JS_SYMBOL(species));
        if (js_is_exception(c)) return c;
        if (js_is_null(c)) c = JS_UNDEFINED;
    }
    if (js_is_undefined(c)) return array_create(ctx, length);
    if (!js_is_constructor(c)) return js_throw_type_error(ctx, "object.constructor[Symbol.species] is not a constructor");
    JSValue n = js_number(length);
    return js_construct(ctx, c, 1, &n, c, NULL);
}

static bool callable_or_throw(JSContext *ctx, JSValue f) {
    if (js_is_callable(f)) return true;
    js_discard(js_throw_type_error(ctx, "%s is not a function", "callback"));
    return false;
}

/* ---- Array (§23.1.1, §23.1.2) ------------------------------------------------------------------ */

static JSValue array_ctor(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)this_val;
    JSValue proto = ctx->intrinsics[JS_INTRINSIC_ARRAY_PROTOTYPE];
    if (!js_is_undefined(new_target) && !js_same_bits(new_target, callee)) {
        proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_ARRAY_PROTOTYPE);
        if (js_is_exception(proto)) return JS_EXCEPTION;
    }
    JSValue a;
    if (argc == 1 && js_is_number(argv[0])) {
        double d = js_as_number(argv[0]);
        if (d < 0 || d > JS_MAX_ARRAY_LENGTH || d != floor(d)) return js_throw_range_error(ctx, "Invalid array length");
        a = array_create(ctx, d);
    } else {
        a = js_new_array_from(ctx, argv, argc);
    }
    if (js_is_exception(a)) return a;
    if (!js_same_bits(proto, ctx->intrinsics[JS_INTRINSIC_ARRAY_PROTOTYPE]) && js_set_prototype_of(ctx, js_as_object(a), proto) < 0)
        return JS_EXCEPTION;
    return a;
}

CORE(array_is_array) {
    UNUSED_ARGS;
    int r = js_is_array_spec(ctx, ARG(0));
    return r < 0 ? JS_EXCEPTION : js_bool(r);
}

/* A new array for Array.from / Array.of: Construct(C, args) when `this` is a constructor. */
static JSValue construct_or_array(JSContext *ctx, JSValue c, bool with_length, double length) {
    if (!js_is_constructor(c)) return array_create(ctx, with_length ? length : 0);
    JSValue n = js_number(length);
    return js_construct(ctx, c, with_length ? 1 : 0, &n, c, NULL);
}

/* Array.from(items, mapfn, thisArg) (§23.1.2.1) */
CORE(array_from) {
    UNUSED_ARGS;
    JSValue items = ARG(0), mapfn = ARG(1), this_arg = ARG(2);
    bool mapping = !js_is_undefined(mapfn);
    if (mapping && !callable_or_throw(ctx, mapfn)) return JS_EXCEPTION;
    if (js_is_nullish(items)) return js_throw_type_error(ctx, "%s is not iterable", js_is_null(items) ? "null" : "undefined");
    JSValue using_iterator = js_get_value(ctx, items, JS_SYMBOL(iterator));
    if (js_is_exception(using_iterator)) return using_iterator;
    if (!js_is_nullish(using_iterator)) {
        JSValue a = construct_or_array(ctx, this_val, false, 0);
        if (js_is_exception(a)) return a;
        JSValue rec = js_iter_start(ctx, items);
        if (js_is_exception(rec)) return rec;
        for (double k = 0;; k++) {
            JSValue v = js_iter_next(ctx, rec);
            if (js_is_exception(v)) return v;
            if (js_is_empty(v)) return set_length(ctx, a, k) < 0 ? JS_EXCEPTION : a;
            if (mapping) {
                JSValue args[2] = { v, js_number(k) };
                v = js_call(ctx, mapfn, this_arg, 2, args);
            }
            if (js_is_exception(v) || create_index(ctx, a, k, v) < 0) {
                js_iter_close_throw(ctx, rec);
                return JS_EXCEPTION;
            }
        }
    }
    double len;
    if (js_length_of_array_like(ctx, items, &len) < 0) return JS_EXCEPTION;
    JSValue a = construct_or_array(ctx, this_val, true, len);
    if (js_is_exception(a)) return a;
    for (double k = 0; k < len; k++) {
        JSValue v = get_index(ctx, items, k);
        if (!js_is_exception(v) && mapping) {
            JSValue args[2] = { v, js_number(k) };
            v = js_call(ctx, mapfn, this_arg, 2, args);
        }
        if (js_is_exception(v) || create_index(ctx, a, k, v) < 0) return JS_EXCEPTION;
    }
    return set_length(ctx, a, len) < 0 ? JS_EXCEPTION : a;
}

/* Array.of(...items) (§23.1.2.3) */
CORE(array_of) {
    UNUSED_ARGS;
    JSValue a = construct_or_array(ctx, this_val, true, argc);
    if (js_is_exception(a)) return a;
    for (uint32_t k = 0; k < argc; k++)
        if (create_index(ctx, a, k, argv[k]) < 0) return JS_EXCEPTION;
    return set_length(ctx, a, argc) < 0 ? JS_EXCEPTION : a;
}

CORE(array_species) {
    UNUSED_ARGS;
    return this_val;
}

/* ---- Array.fromAsync (ES2026) --------------------------------------- */

/* fromAsync's state, one per call: what its async steps share. Its slots: */
enum { FA_PROMISE, FA_ARRAY, FA_SOURCE, FA_MAPFN, FA_THIS_ARG, FA_K, FA_LEN, FA_ITERATING, FA_SLOTS };

static JSValue fa_get(JSValue st, int slot) {
    return ((JSValueArray *)js_as_cell(st))->values[slot];
}

static void fa_set(JSContext *ctx, JSValue st, int slot, JSValue v) {
    JSValueArray *a = (JSValueArray *)js_as_cell(st);
    js_store(ctx, &a->cell, &a->values[slot], v);
}

static void fa_step(JSContext *ctx, JSValue st);

/* Rejects the result with the pending exception. */
static void fa_reject(JSContext *ctx, JSValue st) {
    js_promise_reject_internal(ctx, fa_get(st, FA_PROMISE), js_take_exception(ctx));
}

/* A reaction closure bound to the state (its home_object slot). */
static JSValue fa_closure(JSContext *ctx, JSNativeFn fn, JSValue st) {
    JSValue f = js_new_native(ctx, fn, js_empty_string(), 1, JS_FN_STRICT);
    if (!js_is_exception(f)) js_set_home_object(ctx, f, st);
    return f;
}

/* Await(v): when it settles, `on_fulfilled` or `on_rejected` runs with the state. */
static void fa_await(JSContext *ctx, JSValue st, JSValue v, JSNativeFn on_fulfilled, JSNativeFn on_rejected) {
    JSValue p = js_promise_resolve(ctx, v);
    JSValue f = js_is_exception(p) ? p : fa_closure(ctx, on_fulfilled, st);
    JSValue r = js_is_exception(f) ? f : fa_closure(ctx, on_rejected, st);
    if (js_is_exception(r)) {
        fa_reject(ctx, st);
        return;
    }
    js_promise_then_internal(ctx, p, f, r, JS_UNDEFINED);
}

#define FA_STATE js_as_function(callee)->home_object

/* An abrupt completion inside the iteration: AsyncIteratorClose, then reject with it. */
static JSValue fa_close_rejected(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target);

static void fa_fail(JSContext *ctx, JSValue st) {
    JSValue error = js_take_exception(ctx);
    if (js_truthy(fa_get(st, FA_ITERATING))) {
        fa_set(ctx, st, FA_K, error);  /* kept for after return() settles */
        JSValue awaited = js_async_iter_return(ctx, fa_get(st, FA_SOURCE));
        if (!js_is_exception(awaited) && !js_is_empty(awaited)) {
            fa_await(ctx, st, awaited, fa_close_rejected, fa_close_rejected);
            return;
        }
        if (js_is_exception(awaited)) js_discard(js_take_exception(ctx));  /* the original error wins */
    }
    js_promise_reject_internal(ctx, fa_get(st, FA_PROMISE), error);
}

static JSValue fa_close_rejected(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSValue st = FA_STATE;
    js_promise_reject_internal(ctx, fa_get(st, FA_PROMISE), fa_get(st, FA_K));
    return JS_UNDEFINED;
}

static JSValue fa_rejected(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)this_val, (void)new_target;
    js_promise_reject_internal(ctx, fa_get(FA_STATE, FA_PROMISE), ARG(0));
    return JS_UNDEFINED;
}

/* A mapped value rejected: close the iterator, then reject. */
static JSValue fa_mapped_rejected(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)this_val, (void)new_target;
    JSValue e = js_throw(ctx, ARG(0));
    (void)e;
    fa_fail(ctx, FA_STATE);
    return JS_UNDEFINED;
}

/* The element (mapped, awaited): A[k] = v, then the next one. */
static JSValue fa_store(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)this_val, (void)new_target;
    JSValue st = FA_STATE;
    double k = js_as_number(fa_get(st, FA_K));
    if (create_index(ctx, fa_get(st, FA_ARRAY), k, ARG(0)) < 0) {
        fa_fail(ctx, st);
        return JS_UNDEFINED;
    }
    fa_set(ctx, st, FA_K, js_number(k + 1));
    fa_step(ctx, st);
    return JS_UNDEFINED;
}

/* A value: mapped and awaited (mapfn), or stored. */
static void fa_value(JSContext *ctx, JSValue st, JSValue v) {
    JSValue mapfn = fa_get(st, FA_MAPFN);
    if (js_is_undefined(mapfn)) {
        JSValue args[1] = { v };
        JSValue f = fa_closure(ctx, fa_store, st);
        if (js_is_exception(f)) {
            fa_fail(ctx, st);
            return;
        }
        fa_store(ctx, f, JS_UNDEFINED, 1, args, JS_UNDEFINED);
        return;
    }
    JSValue args[2] = { v, fa_get(st, FA_K) };
    JSValue mapped = js_call(ctx, mapfn, fa_get(st, FA_THIS_ARG), 2, args);
    if (js_is_exception(mapped)) {
        fa_fail(ctx, st);
        return;
    }
    fa_await(ctx, st, mapped, fa_store, fa_mapped_rejected);
}

/* An array-like's element, awaited. */
static JSValue fa_element(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)this_val, (void)new_target;
    fa_value(ctx, FA_STATE, ARG(0));
    return JS_UNDEFINED;
}

/* An iterator result, awaited: done, or a value. */
static JSValue fa_result(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)this_val, (void)new_target;
    JSValue st = FA_STATE;
    fa_set(ctx, st, FA_ITERATING, JS_FALSE);  /* errors reading the result don't close the iterator */
    JSValue v = js_async_iter_value(ctx, fa_get(st, FA_SOURCE), ARG(0));
    if (js_is_exception(v)) {
        fa_reject(ctx, st);
        return JS_UNDEFINED;
    }
    if (js_is_empty(v)) {  /* done */
        JSValue a = fa_get(st, FA_ARRAY);
        if (set_length(ctx, a, js_as_number(fa_get(st, FA_K))) < 0) fa_reject(ctx, st);
        else js_promise_resolve_internal(ctx, fa_get(st, FA_PROMISE), a);
        return JS_UNDEFINED;
    }
    fa_set(ctx, st, FA_ITERATING, JS_TRUE);
    fa_value(ctx, st, v);
    return JS_UNDEFINED;
}

static void fa_step(JSContext *ctx, JSValue st) {
    double k = js_as_number(fa_get(st, FA_K));
    if (js_is_undefined(fa_get(st, FA_LEN))) {  /* an iterator */
        if (k >= JS_MAX_SAFE_INTEGER) {
            js_discard(js_throw_type_error(ctx, "Invalid array length"));
            fa_fail(ctx, st);
            return;
        }
        fa_set(ctx, st, FA_ITERATING, JS_FALSE);
        JSValue next = js_async_iter_next(ctx, fa_get(st, FA_SOURCE));
        if (js_is_exception(next)) {
            fa_reject(ctx, st);
            return;
        }
        fa_await(ctx, st, next, fa_result, fa_rejected);
        return;
    }
    JSValue a = fa_get(st, FA_ARRAY);
    if (k >= js_as_number(fa_get(st, FA_LEN))) {
        if (set_length(ctx, a, k) < 0) fa_reject(ctx, st);
        else js_promise_resolve_internal(ctx, fa_get(st, FA_PROMISE), a);
        return;
    }
    JSValue v = get_index(ctx, fa_get(st, FA_SOURCE), k);
    if (js_is_exception(v)) {
        fa_reject(ctx, st);
        return;
    }
    fa_await(ctx, st, v, fa_element, fa_rejected);
}

/* Array.fromAsync(items, mapfn, thisArg): a promise of the array; every value (and mapped
 * value) is awaited in turn, as an async function would. */
CORE(array_from_async) {
    UNUSED_ARGS;
    JSValue promise = js_new_promise(ctx);
    if (js_is_exception(promise)) return promise;
    JSValue st = js_cell(&js_alloc_value_array(ctx, FA_SLOTS)->cell);
    for (int i = 0; i < FA_SLOTS; i++) fa_set(ctx, st, i, JS_UNDEFINED);
    fa_set(ctx, st, FA_PROMISE, promise);
    fa_set(ctx, st, FA_K, js_int32(0));
    fa_set(ctx, st, FA_ITERATING, JS_FALSE);
    JSValue items = ARG(0), mapfn = ARG(1);
    if (!js_is_undefined(mapfn) && !js_is_callable(mapfn)) {
        js_discard(js_throw_type_error(ctx, "%s is not a function", "mapfn"));
        fa_reject(ctx, st);
        return promise;
    }
    fa_set(ctx, st, FA_MAPFN, mapfn);
    fa_set(ctx, st, FA_THIS_ARG, ARG(2));
    if (js_is_nullish(items)) {
        js_discard(js_throw_type_error(ctx, "%s is not iterable", js_is_null(items) ? "null" : "undefined"));
        fa_reject(ctx, st);
        return promise;
    }
    JSValue async_method = js_get_value(ctx, items, JS_SYMBOL(asyncIterator));
    JSValue sync_method = js_is_exception(async_method) || !js_is_nullish(async_method) ? JS_UNDEFINED : js_get_value(ctx, items, JS_SYMBOL(iterator));
    if (js_is_exception(async_method) || js_is_exception(sync_method)) {
        fa_reject(ctx, st);
        return promise;
    }
    if (!js_is_nullish(async_method) || !js_is_nullish(sync_method)) {
        JSValue a = construct_or_array(ctx, this_val, false, 0);
        JSValue rec = js_is_exception(a) ? a : js_async_iter_start(ctx, items);
        if (js_is_exception(rec)) {
            fa_reject(ctx, st);
            return promise;
        }
        fa_set(ctx, st, FA_ARRAY, a);
        fa_set(ctx, st, FA_SOURCE, rec);
    } else {
        double len;
        if (js_length_of_array_like(ctx, items, &len) < 0) {
            fa_reject(ctx, st);
            return promise;
        }
        JSValue a = construct_or_array(ctx, this_val, true, len);
        if (js_is_exception(a)) {
            fa_reject(ctx, st);
            return promise;
        }
        fa_set(ctx, st, FA_ARRAY, a);
        fa_set(ctx, st, FA_SOURCE, items);
        fa_set(ctx, st, FA_LEN, js_number(len));
    }
    fa_step(ctx, st);
    return promise;
}

/* ---- Array.prototype (§23.1.3) -------------------------------------------------------------- */

CORE(array_proto_at) {
    UNUSED_ARGS;
    double len, rel;
    if (receiver(ctx, this_val, "Array.prototype.at", &len) < 0 || js_to_integer_or_infinity(ctx, &rel, ARG(0)) < 0) return JS_EXCEPTION;
    double k = rel >= 0 ? rel : len + rel;
    if (k < 0 || k >= len) return JS_UNDEFINED;
    return get_index(ctx, this_val, k);
}

/* IsConcatSpreadable (§23.1.3.2.1) */
static int is_concat_spreadable(JSContext *ctx, JSValue v) {
    if (!js_is_object(v)) return 0;
    JSValue s = js_get_value(ctx, v, JS_SYMBOL(isConcatSpreadable));
    if (js_is_exception(s)) return -1;
    if (!js_is_undefined(s)) return js_truthy(s);
    return js_is_array_spec(ctx, v);
}

CORE(array_proto_concat) {
    UNUSED_ARGS;
    if (!js_require_this(ctx, this_val, "Array.prototype.concat")) return JS_EXCEPTION;
    JSValue a = array_species_create(ctx, this_val, 0);
    if (js_is_exception(a)) return a;
    double n = 0;
    for (uint32_t i = 0; i <= argc; i++) {
        JSValue e = i == 0 ? this_val : argv[i - 1];
        int spreadable = is_concat_spreadable(ctx, e);
        if (spreadable < 0) return JS_EXCEPTION;
        if (spreadable) {
            double len;
            if (js_length_of_array_like(ctx, e, &len) < 0) return JS_EXCEPTION;
            if (n + len > JS_MAX_SAFE_INTEGER) return js_throw_type_error(ctx, "Invalid array length");
            for (double k = 0; k < len; k++, n++) {
                int has = has_index(ctx, e, k);
                if (has < 0) return JS_EXCEPTION;
                if (!has) continue;
                JSValue v = get_index(ctx, e, k);
                if (js_is_exception(v) || create_index(ctx, a, n, v) < 0) return JS_EXCEPTION;
            }
        } else {
            if (n >= JS_MAX_SAFE_INTEGER) return js_throw_type_error(ctx, "Invalid array length");
            if (create_index(ctx, a, n++, e) < 0) return JS_EXCEPTION;
        }
    }
    return set_length(ctx, a, n) < 0 ? JS_EXCEPTION : a;
}

CORE(array_proto_copy_within) {
    UNUSED_ARGS;
    double len, to, from, final;
    if (receiver(ctx, this_val, "Array.prototype.copyWithin", &len) < 0) return JS_EXCEPTION;
    if (js_relative_index(ctx, ARG(0), len, 0, &to) < 0 || js_relative_index(ctx, ARG(1), len, 0, &from) < 0 ||
        js_relative_index(ctx, ARG(2), len, len, &final) < 0)
        return JS_EXCEPTION;
    double count = fmin(final - from, len - to);
    double dir = 1;
    if (from < to && to < from + count) {
        dir = -1;
        from += count - 1;
        to += count - 1;
    }
    for (; count > 0; count--, from += dir, to += dir) {
        int has = has_index(ctx, this_val, from);
        if (has < 0) return JS_EXCEPTION;
        if (has) {
            JSValue v = get_index(ctx, this_val, from);
            if (js_is_exception(v) || set_index(ctx, this_val, to, v) < 0) return JS_EXCEPTION;
        } else if (delete_index(ctx, this_val, to) < 0) {
            return JS_EXCEPTION;
        }
    }
    return this_val;
}

CORE(array_proto_fill) {
    UNUSED_ARGS;
    double len, k, final;
    if (receiver(ctx, this_val, "Array.prototype.fill", &len) < 0) return JS_EXCEPTION;
    if (js_relative_index(ctx, ARG(1), len, 0, &k) < 0 || js_relative_index(ctx, ARG(2), len, len, &final) < 0) return JS_EXCEPTION;
    /* an array's length is below 2^32: k and final are uint32s */
    if (js_is_array(this_val) && k < final && js_elements_fill(ctx, js_as_object(this_val), (uint32_t)k, (uint32_t)final, ARG(0))) return this_val;
    for (; k < final; k++)
        if (set_index(ctx, this_val, k, ARG(0)) < 0) return JS_EXCEPTION;
    return this_val;
}

/* find, findIndex, findLast, findLastIndex: every index (holes are undefined), in order. */
static JSValue find(JSContext *ctx, JSValue o, uint32_t argc, const JSValue *argv, bool last, bool index, const char *method) {
    double len;
    if (receiver(ctx, o, method, &len) < 0 || !callable_or_throw(ctx, ARG(0))) return JS_EXCEPTION;
    for (double i = 0; i < len; i++) {
        double k = last ? len - 1 - i : i;
        JSValue v = get_index(ctx, o, k);
        if (js_is_exception(v)) return v;
        JSValue args[3] = { v, js_number(k), o };
        JSValue r = js_call(ctx, ARG(0), ARG(1), 3, args);
        if (js_is_exception(r)) return r;
        if (js_truthy(r)) return index ? js_number(k) : v;
    }
    return index ? js_int32(-1) : JS_UNDEFINED;
}

CORE(array_proto_find) {
    UNUSED_ARGS;
    return find(ctx, this_val, argc, argv, false, false, "Array.prototype.find");
}

CORE(array_proto_find_index) {
    UNUSED_ARGS;
    return find(ctx, this_val, argc, argv, false, true, "Array.prototype.findIndex");
}

CORE(array_proto_find_last) {
    UNUSED_ARGS;
    return find(ctx, this_val, argc, argv, true, false, "Array.prototype.findLast");
}

CORE(array_proto_find_last_index) {
    UNUSED_ARGS;
    return find(ctx, this_val, argc, argv, true, true, "Array.prototype.findLastIndex");
}

CORE(array_proto_index_of) {
    UNUSED_ARGS;
    double len, from;
    if (receiver(ctx, this_val, "Array.prototype.indexOf", &len) < 0) return JS_EXCEPTION;
    if (len == 0) return js_int32(-1);
    if (js_relative_index(ctx, ARG(1), len, 0, &from) < 0) return JS_EXCEPTION;
    for (double i = from; i < len; i++) {
        int has = has_index(ctx, this_val, i);
        if (has < 0) return JS_EXCEPTION;
        if (!has) continue;
        JSValue e = get_index(ctx, this_val, i);
        if (js_is_exception(e)) return e;
        if (js_truthy(js_strict_eq(ctx, e, ARG(0)))) return js_number(i);
    }
    return js_int32(-1);
}

CORE(array_proto_last_index_of) {
    UNUSED_ARGS;
    double len, n;
    if (receiver(ctx, this_val, "Array.prototype.lastIndexOf", &len) < 0) return JS_EXCEPTION;
    if (len == 0) return js_int32(-1);
    if (argc > 1) {
        if (js_to_integer_or_infinity(ctx, &n, argv[1]) < 0) return JS_EXCEPTION;
    } else {
        n = len - 1;
    }
    if (n == -INFINITY) return js_int32(-1);
    for (double k = n >= 0 ? fmin(n, len - 1) : len + n; k >= 0; k--) {
        int has = has_index(ctx, this_val, k);
        if (has < 0) return JS_EXCEPTION;
        if (!has) continue;
        JSValue e = get_index(ctx, this_val, k);
        if (js_is_exception(e)) return e;
        if (js_truthy(js_strict_eq(ctx, e, ARG(0)))) return js_number(k);
    }
    return js_int32(-1);
}

CORE(array_proto_includes) {
    UNUSED_ARGS;
    double len, from;
    if (receiver(ctx, this_val, "Array.prototype.includes", &len) < 0) return JS_EXCEPTION;
    if (len == 0) return JS_FALSE;
    if (js_relative_index(ctx, ARG(1), len, 0, &from) < 0) return JS_EXCEPTION;
    for (double k = from; k < len; k++) {
        JSValue e = get_index(ctx, this_val, k);
        if (js_is_exception(e)) return e;
        /* SameValueZero: NaN finds NaN, +0 finds -0 */
        if (js_same_value(ctx, e, ARG(0)) || (js_is_number(e) && js_is_number(ARG(0)) && js_as_number(e) == js_as_number(ARG(0))))
            return JS_TRUE;
    }
    return JS_FALSE;
}

CORE(array_proto_push) {
    UNUSED_ARGS;
    if (!js_require_this(ctx, this_val, "Array.prototype.push")) return JS_EXCEPTION;
    if (js_is_array(this_val)) {
        for (uint32_t i = 0; i < argc; i++)
            if (js_array_push(ctx, js_as_object(this_val), argv[i]) < 0) return JS_EXCEPTION;
        return js_number((double)js_array_length(js_as_object(this_val)));
    }
    double len;
    if (js_length_of_array_like(ctx, this_val, &len) < 0) return JS_EXCEPTION;
    if (len + argc > JS_MAX_SAFE_INTEGER) return js_throw_type_error(ctx, "Pushing %u elements on an array-like of length %.0f is disallowed", argc, len);
    for (uint32_t i = 0; i < argc; i++)
        if (set_index(ctx, this_val, len + i, argv[i]) < 0) return JS_EXCEPTION;
    return set_length(ctx, this_val, len + argc) < 0 ? JS_EXCEPTION : js_number(len + argc);
}

CORE(array_proto_pop) {
    UNUSED_ARGS;
    double len;
    if (receiver(ctx, this_val, "Array.prototype.pop", &len) < 0) return JS_EXCEPTION;
    if (len == 0) return set_length(ctx, this_val, 0) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
    JSValue v = get_index(ctx, this_val, len - 1);
    if (js_is_exception(v) || delete_index(ctx, this_val, len - 1) < 0 || set_length(ctx, this_val, len - 1) < 0) return JS_EXCEPTION;
    return v;
}

CORE(array_proto_reverse) {
    UNUSED_ARGS;
    double len;
    if (receiver(ctx, this_val, "Array.prototype.reverse", &len) < 0) return JS_EXCEPTION;
    for (double lower = 0, upper = len - 1; lower < upper; lower++, upper--) {
        int has_lower = has_index(ctx, this_val, lower);
        JSValue lv = has_lower > 0 ? get_index(ctx, this_val, lower) : JS_UNDEFINED;
        if (has_lower < 0 || js_is_exception(lv)) return JS_EXCEPTION;
        int has_upper = has_index(ctx, this_val, upper);
        JSValue uv = has_upper > 0 ? get_index(ctx, this_val, upper) : JS_UNDEFINED;
        if (has_upper < 0 || js_is_exception(uv)) return JS_EXCEPTION;
        int r = 0;
        if (has_lower && has_upper) r = set_index(ctx, this_val, lower, uv) < 0 || set_index(ctx, this_val, upper, lv) < 0 ? -1 : 0;
        else if (has_upper) r = set_index(ctx, this_val, lower, uv) < 0 || delete_index(ctx, this_val, upper) < 0 ? -1 : 0;
        else if (has_lower) r = delete_index(ctx, this_val, lower) < 0 || set_index(ctx, this_val, upper, lv) < 0 ? -1 : 0;
        if (r < 0) return JS_EXCEPTION;
    }
    return this_val;
}

/* Moves [from, from + count) to `to` (shift, unshift, splice): holes stay holes. */
static int move_range(JSContext *ctx, JSValue o, double from, double to, double count, bool backwards) {
    for (double i = 0; i < count; i++) {
        double f = backwards ? from + count - 1 - i : from + i, t = backwards ? to + count - 1 - i : to + i;
        int has = has_index(ctx, o, f);
        if (has < 0) return -1;
        if (has) {
            JSValue v = get_index(ctx, o, f);
            if (js_is_exception(v) || set_index(ctx, o, t, v) < 0) return -1;
        } else if (delete_index(ctx, o, t) < 0) {
            return -1;
        }
    }
    return 0;
}

CORE(array_proto_shift) {
    UNUSED_ARGS;
    double len;
    if (receiver(ctx, this_val, "Array.prototype.shift", &len) < 0) return JS_EXCEPTION;
    if (len == 0) return set_length(ctx, this_val, 0) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
    JSValue first = get_index(ctx, this_val, 0);
    if (js_is_exception(first) || move_range(ctx, this_val, 1, 0, len - 1, false) < 0 ||
        delete_index(ctx, this_val, len - 1) < 0 || set_length(ctx, this_val, len - 1) < 0)
        return JS_EXCEPTION;
    return first;
}

CORE(array_proto_unshift) {
    UNUSED_ARGS;
    double len;
    if (receiver(ctx, this_val, "Array.prototype.unshift", &len) < 0) return JS_EXCEPTION;
    if (argc > 0) {
        if (len + argc > JS_MAX_SAFE_INTEGER) return js_throw_type_error(ctx, "Invalid array length");
        if (move_range(ctx, this_val, 0, argc, len, true) < 0) return JS_EXCEPTION;
        for (uint32_t j = 0; j < argc; j++)
            if (set_index(ctx, this_val, j, argv[j]) < 0) return JS_EXCEPTION;
    }
    return set_length(ctx, this_val, len + argc) < 0 ? JS_EXCEPTION : js_number(len + argc);
}

CORE(array_proto_slice) {
    UNUSED_ARGS;
    double len, k, final;
    if (receiver(ctx, this_val, "Array.prototype.slice", &len) < 0) return JS_EXCEPTION;
    if (js_relative_index(ctx, ARG(0), len, 0, &k) < 0 || js_relative_index(ctx, ARG(1), len, len, &final) < 0) return JS_EXCEPTION;
    double count = fmax(final - k, 0);
    JSValue a = array_species_create(ctx, this_val, count);
    if (js_is_exception(a)) return a;
    double n = 0;
    for (; k < final; k++, n++) {
        int has = has_index(ctx, this_val, k);
        if (has < 0) return JS_EXCEPTION;
        if (!has) continue;
        JSValue v = get_index(ctx, this_val, k);
        if (js_is_exception(v) || create_index(ctx, a, n, v) < 0) return JS_EXCEPTION;
    }
    return set_length(ctx, a, n) < 0 ? JS_EXCEPTION : a;
}

CORE(array_proto_splice) {
    UNUSED_ARGS;
    double len, start, delete_count;
    if (receiver(ctx, this_val, "Array.prototype.splice", &len) < 0) return JS_EXCEPTION;
    if (js_relative_index(ctx, ARG(0), len, 0, &start) < 0) return JS_EXCEPTION;
    uint32_t item_count = argc > 2 ? argc - 2 : 0;
    if (argc == 0) {
        delete_count = 0;
    } else if (argc == 1) {
        delete_count = len - start;
    } else {
        if (js_to_integer_or_infinity(ctx, &delete_count, argv[1]) < 0) return JS_EXCEPTION;
        delete_count = fmin(fmax(delete_count, 0), len - start);
    }
    if (len + item_count - delete_count > JS_MAX_SAFE_INTEGER) return js_throw_type_error(ctx, "Invalid array length");
    JSValue a = array_species_create(ctx, this_val, delete_count);
    if (js_is_exception(a)) return a;
    for (double k = 0; k < delete_count; k++) {
        int has = has_index(ctx, this_val, start + k);
        if (has < 0) return JS_EXCEPTION;
        if (!has) continue;
        JSValue v = get_index(ctx, this_val, start + k);
        if (js_is_exception(v) || create_index(ctx, a, k, v) < 0) return JS_EXCEPTION;
    }
    if (set_length(ctx, a, delete_count) < 0) return JS_EXCEPTION;
    double tail = len - start - delete_count;
    if (item_count < delete_count) {
        if (move_range(ctx, this_val, start + delete_count, start + item_count, tail, false) < 0) return JS_EXCEPTION;
        for (double k = len; k > len - delete_count + item_count; k--)
            if (delete_index(ctx, this_val, k - 1) < 0) return JS_EXCEPTION;
    } else if (item_count > delete_count) {
        if (move_range(ctx, this_val, start + delete_count, start + item_count, tail, true) < 0) return JS_EXCEPTION;
    }
    for (uint32_t j = 0; j < item_count; j++)
        if (set_index(ctx, this_val, start + j, argv[j + 2]) < 0) return JS_EXCEPTION;
    return set_length(ctx, this_val, len - delete_count + item_count) < 0 ? JS_EXCEPTION : a;
}

/* ---- Sorting (§23.1.3.30.1 SortIndexedProperties, §23.1.3.30.2 CompareArrayElements) ---------- */

/* <0, 0, >0; -2 with an exception (as `failed`). undefined sorts last; no comparator compares
 * the strings. */
static double compare_elements(JSContext *ctx, JSValue comparefn, JSValue x, JSValue y, bool *failed) {
    if (js_is_undefined(x) && js_is_undefined(y)) return 0;
    if (js_is_undefined(x)) return 1;
    if (js_is_undefined(y)) return -1;
    if (!js_is_undefined(comparefn)) {
        JSValue args[2] = { x, y };
        JSValue r = js_call(ctx, comparefn, JS_UNDEFINED, 2, args);
        double d;
        if (js_is_exception(r) || js_to_number(ctx, &d, r)) {
            *failed = true;
            return 0;
        }
        return d != d ? 0 : d;
    }
    JSValue xs = js_to_string(ctx, x);
    JSValue ys = js_is_exception(xs) ? xs : js_to_string(ctx, y);
    if (js_is_exception(ys)) {
        *failed = true;
        return 0;
    }
    return js_string_compare(ctx, xs, ys);
}

/* A stable merge sort; stops at the first exception. */
static bool merge_sort(JSContext *ctx, JSValue comparefn, JSValue *items, JSValue *tmp, size_t n) {
    for (size_t width = 1; width < n; width *= 2) {
        for (size_t lo = 0; lo < n; lo += 2 * width) {
            size_t mid = lo + width < n ? lo + width : n, hi = lo + 2 * width < n ? lo + 2 * width : n;
            size_t i = lo, j = mid, k = lo;
            while (i < mid && j < hi) {
                bool failed = false;
                double c = compare_elements(ctx, comparefn, items[j], items[i], &failed);
                if (failed) return false;
                tmp[k++] = c < 0 ? items[j++] : items[i++];  /* equal: the left one first (stable) */
            }
            while (i < mid) tmp[k++] = items[i++];
            while (j < hi) tmp[k++] = items[j++];
        }
        memcpy(items, tmp, n * sizeof *items);
    }
    return true;
}

/* The elements [0, len) (holes skipped, or read as undefined), sorted, as a JS array. */
static JSValue sorted_items(JSContext *ctx, JSValue o, double len, JSValue comparefn, bool skip_holes) {
    JSValue list = js_new_array(ctx, 0);
    if (js_is_exception(list)) return list;
    for (double k = 0; k < len; k++) {
        if (skip_holes) {
            int has = has_index(ctx, o, k);
            if (has < 0) return JS_EXCEPTION;
            if (!has) continue;
        }
        JSValue v = get_index(ctx, o, k);
        if (js_is_exception(v) || js_array_push(ctx, js_as_object(list), v) < 0) return JS_EXCEPTION;
    }
    uint32_t n = js_array_length(js_as_object(list));
    JSValue *items = malloc((n ? n : 1) * 2 * sizeof *items);
    if (!items) js_fatal("out of memory sorting");
    for (uint32_t i = 0; i < n; i++) items[i] = js_get_elem(ctx, list, js_index_key(i));
    /* `list` keeps the elements alive (the scan doesn't see `items`) while comparators run */
    bool ok = merge_sort(ctx, comparefn, items, items + n, n);
    JSValue sorted = ok ? js_new_array_from(ctx, items, n) : JS_EXCEPTION;
    free(items);
    js_keep_alive(list);
    return sorted;
}

static bool comparefn_ok(JSContext *ctx, JSValue comparefn) {
    if (js_is_undefined(comparefn) || js_is_callable(comparefn)) return true;
    js_discard(js_throw_type_error(ctx, "The comparison function must be either a function or undefined"));
    return false;
}

CORE(array_proto_sort) {
    UNUSED_ARGS;
    double len;
    if (!comparefn_ok(ctx, ARG(0)) || receiver(ctx, this_val, "Array.prototype.sort", &len) < 0) return JS_EXCEPTION;
    JSValue sorted = sorted_items(ctx, this_val, len, ARG(0), true);
    if (js_is_exception(sorted)) return sorted;
    uint32_t n = js_array_length(js_as_object(sorted));
    for (uint32_t j = 0; j < n; j++) {
        JSValue v = js_get_elem(ctx, sorted, js_index_key(j));
        if (set_index(ctx, this_val, j, v) < 0) return JS_EXCEPTION;
    }
    for (double j = n; j < len; j++)  /* the holes, now at the end */
        if (delete_index(ctx, this_val, j) < 0) return JS_EXCEPTION;
    return this_val;
}

CORE(array_proto_to_sorted) {
    UNUSED_ARGS;
    double len;
    if (!comparefn_ok(ctx, ARG(0)) || receiver(ctx, this_val, "Array.prototype.toSorted", &len) < 0) return JS_EXCEPTION;
    if (len > JS_MAX_ARRAY_LENGTH) return js_throw_range_error(ctx, "Invalid array length");
    return sorted_items(ctx, this_val, len, ARG(0), false);
}

/* ---- Iteration with callbacks -------------------------------------------------------------- */

enum { FOR_EACH, MAP, FILTER, EVERY, SOME };

/* forEach, map, filter, every, some (§23.1.3.15 …): callback(value, index, o) over present elements. */
static JSValue iterate(JSContext *ctx, JSValue o, uint32_t argc, const JSValue *argv, int kind, const char *method) {
    double len;
    if (receiver(ctx, o, method, &len) < 0 || !callable_or_throw(ctx, ARG(0))) return JS_EXCEPTION;
    JSValue a = JS_UNDEFINED;
    if (kind == MAP || kind == FILTER) {
        a = array_species_create(ctx, o, kind == MAP ? len : 0);
        if (js_is_exception(a)) return a;
    }
    double to = 0;
    for (double k = 0; k < len; k++) {
        int has = has_index(ctx, o, k);
        if (has < 0) return JS_EXCEPTION;
        if (!has) continue;
        JSValue v = get_index(ctx, o, k);
        if (js_is_exception(v)) return v;
        JSValue args[3] = { v, js_number(k), o };
        JSValue r = js_call(ctx, ARG(0), ARG(1), 3, args);
        if (js_is_exception(r)) return r;
        switch (kind) {
        case MAP:
            if (create_index(ctx, a, k, r) < 0) return JS_EXCEPTION;
            break;
        case FILTER:
            if (js_truthy(r) && create_index(ctx, a, to++, v) < 0) return JS_EXCEPTION;
            break;
        case EVERY:
            if (!js_truthy(r)) return JS_FALSE;
            break;
        case SOME:
            if (js_truthy(r)) return JS_TRUE;
            break;
        }
    }
    return kind == EVERY ? JS_TRUE : kind == SOME ? JS_FALSE : a;
}

CORE(array_proto_for_each) {
    UNUSED_ARGS;
    return iterate(ctx, this_val, argc, argv, FOR_EACH, "Array.prototype.forEach");
}

CORE(array_proto_map) {
    UNUSED_ARGS;
    return iterate(ctx, this_val, argc, argv, MAP, "Array.prototype.map");
}

CORE(array_proto_filter) {
    UNUSED_ARGS;
    return iterate(ctx, this_val, argc, argv, FILTER, "Array.prototype.filter");
}

CORE(array_proto_every) {
    UNUSED_ARGS;
    return iterate(ctx, this_val, argc, argv, EVERY, "Array.prototype.every");
}

CORE(array_proto_some) {
    UNUSED_ARGS;
    return iterate(ctx, this_val, argc, argv, SOME, "Array.prototype.some");
}

/* reduce / reduceRight (§23.1.3.24, §23.1.3.25) */
static JSValue reduce(JSContext *ctx, JSValue o, uint32_t argc, const JSValue *argv, bool right, const char *method) {
    double len;
    if (receiver(ctx, o, method, &len) < 0 || !callable_or_throw(ctx, ARG(0))) return JS_EXCEPTION;
    double k = 0;
    JSValue acc = JS_UNDEFINED;
    if (argc >= 2) {
        acc = argv[1];
    } else {
        bool found = false;
        for (; k < len && !found; k++) {
            double i = right ? len - 1 - k : k;
            int has = has_index(ctx, o, i);
            if (has < 0) return JS_EXCEPTION;
            if (has) {
                acc = get_index(ctx, o, i);
                if (js_is_exception(acc)) return acc;
                found = true;
            }
        }
        if (!found) return js_throw_type_error(ctx, "Reduce of empty array with no initial value");
    }
    for (; k < len; k++) {
        double i = right ? len - 1 - k : k;
        int has = has_index(ctx, o, i);
        if (has < 0) return JS_EXCEPTION;
        if (!has) continue;
        JSValue v = get_index(ctx, o, i);
        if (js_is_exception(v)) return v;
        JSValue args[4] = { acc, v, js_number(i), o };
        acc = js_call(ctx, ARG(0), JS_UNDEFINED, 4, args);
        if (js_is_exception(acc)) return acc;
    }
    return acc;
}

CORE(array_proto_reduce) {
    UNUSED_ARGS;
    return reduce(ctx, this_val, argc, argv, false, "Array.prototype.reduce");
}

CORE(array_proto_reduce_right) {
    UNUSED_ARGS;
    return reduce(ctx, this_val, argc, argv, true, "Array.prototype.reduceRight");
}

/* FlattenIntoArray (§23.1.3.13.1); returns the next index, or -1. */
static double flatten_into(JSContext *ctx, JSValue target, JSValue source, double source_len, double start, double depth,
                           JSValue mapper, JSValue this_arg) {
    double target_index = start;
    for (double k = 0; k < source_len; k++) {
        int has = has_index(ctx, source, k);
        if (has < 0) return -1;
        if (!has) continue;
        JSValue e = get_index(ctx, source, k);
        if (js_is_exception(e)) return -1;
        if (!js_is_undefined(mapper)) {
            JSValue args[3] = { e, js_number(k), source };
            e = js_call(ctx, mapper, this_arg, 3, args);
            if (js_is_exception(e)) return -1;
        }
        int is_array = depth > 0 ? js_is_array_spec(ctx, e) : 0;
        if (is_array < 0) return -1;
        if (is_array) {
            double len;
            if (js_length_of_array_like(ctx, e, &len) < 0) return -1;
            target_index = flatten_into(ctx, target, e, len, target_index, depth - 1, JS_UNDEFINED, JS_UNDEFINED);
            if (target_index < 0) return -1;
        } else {
            if (target_index >= JS_MAX_SAFE_INTEGER) {
                js_discard(js_throw_type_error(ctx, "Invalid array length"));
                return -1;
            }
            if (create_index(ctx, target, target_index++, e) < 0) return -1;
        }
    }
    return target_index;
}

CORE(array_proto_flat) {
    UNUSED_ARGS;
    double len, depth = 1;
    if (receiver(ctx, this_val, "Array.prototype.flat", &len) < 0) return JS_EXCEPTION;
    if (!js_is_undefined(ARG(0))) {
        if (js_to_integer_or_infinity(ctx, &depth, ARG(0)) < 0) return JS_EXCEPTION;
        if (depth < 0) depth = 0;
    }
    JSValue a = array_species_create(ctx, this_val, 0);
    if (js_is_exception(a)) return a;
    return flatten_into(ctx, a, this_val, len, 0, depth, JS_UNDEFINED, JS_UNDEFINED) < 0 ? JS_EXCEPTION : a;
}

CORE(array_proto_flat_map) {
    UNUSED_ARGS;
    double len;
    if (receiver(ctx, this_val, "Array.prototype.flatMap", &len) < 0 || !callable_or_throw(ctx, ARG(0))) return JS_EXCEPTION;
    JSValue a = array_species_create(ctx, this_val, 0);
    if (js_is_exception(a)) return a;
    return flatten_into(ctx, a, this_val, len, 0, 1, ARG(0), ARG(1)) < 0 ? JS_EXCEPTION : a;
}

/* ---- Changing copies (ES2023) ----------------------------------------------------------------- */

CORE(array_proto_to_reversed) {
    UNUSED_ARGS;
    double len;
    if (receiver(ctx, this_val, "Array.prototype.toReversed", &len) < 0) return JS_EXCEPTION;
    JSValue a = array_create(ctx, len);
    if (js_is_exception(a)) return a;
    for (double k = 0; k < len; k++) {
        JSValue v = get_index(ctx, this_val, len - 1 - k);
        if (js_is_exception(v) || create_index(ctx, a, k, v) < 0) return JS_EXCEPTION;
    }
    return a;
}

CORE(array_proto_to_spliced) {
    UNUSED_ARGS;
    double len, start, skip;
    if (receiver(ctx, this_val, "Array.prototype.toSpliced", &len) < 0) return JS_EXCEPTION;
    if (js_relative_index(ctx, ARG(0), len, 0, &start) < 0) return JS_EXCEPTION;
    uint32_t insert = argc > 2 ? argc - 2 : 0;
    if (argc == 0) {
        skip = 0;
    } else if (argc == 1) {
        skip = len - start;
    } else {
        if (js_to_integer_or_infinity(ctx, &skip, argv[1]) < 0) return JS_EXCEPTION;
        skip = fmin(fmax(skip, 0), len - start);
    }
    double new_len = len + insert - skip;
    if (new_len > JS_MAX_SAFE_INTEGER) return js_throw_type_error(ctx, "Invalid array length");
    JSValue a = array_create(ctx, new_len);
    if (js_is_exception(a)) return a;
    double i = 0;
    for (; i < start; i++) {
        JSValue v = get_index(ctx, this_val, i);
        if (js_is_exception(v) || create_index(ctx, a, i, v) < 0) return JS_EXCEPTION;
    }
    for (uint32_t j = 0; j < insert; j++, i++)
        if (create_index(ctx, a, i, argv[j + 2]) < 0) return JS_EXCEPTION;
    for (double r = start + skip; i < new_len; i++, r++) {
        JSValue v = get_index(ctx, this_val, r);
        if (js_is_exception(v) || create_index(ctx, a, i, v) < 0) return JS_EXCEPTION;
    }
    return a;
}

CORE(array_proto_with) {
    UNUSED_ARGS;
    double len, rel;
    if (receiver(ctx, this_val, "Array.prototype.with", &len) < 0 || js_to_integer_or_infinity(ctx, &rel, ARG(0)) < 0) return JS_EXCEPTION;
    double index = rel >= 0 ? rel : len + rel;
    if (index >= len || index < 0) return js_throw_range_error(ctx, "Invalid index : %.0f", rel);
    JSValue a = array_create(ctx, len);
    if (js_is_exception(a)) return a;
    for (double k = 0; k < len; k++) {
        JSValue v = k == index ? ARG(1) : get_index(ctx, this_val, k);
        if (js_is_exception(v) || create_index(ctx, a, k, v) < 0) return JS_EXCEPTION;
    }
    return a;
}

/* ---- Strings ------------------------------------------------------------------------------------- */

static JSValue join(JSContext *ctx, JSValue o, JSValue sep_arg, bool locale) {
    double len;
    if (receiver(ctx, o, locale ? "Array.prototype.toLocaleString" : "Array.prototype.join", &len) < 0) return JS_EXCEPTION;
    JSValue sep = locale || js_is_undefined(sep_arg) ? js_char_string(',') : js_to_string(ctx, sep_arg);
    if (js_is_exception(sep)) return JS_EXCEPTION;
    JSValue r = js_empty_string();
    for (double i = 0; i < len; i++) {
        if (i > 0) r = js_concat(ctx, r, sep);
        if (js_is_exception(r)) return JS_EXCEPTION;
        JSValue e = get_index(ctx, o, i);
        if (js_is_exception(e)) return e;
        if (js_is_nullish(e)) continue;
        JSValue s;
        if (locale) {
            JSValue f = js_get_value(ctx, e, js_atom_from_cstr(ctx, "toLocaleString"));
            s = js_is_exception(f) ? f : js_call(ctx, f, e, 0, NULL);
            if (!js_is_exception(s)) s = js_to_string(ctx, s);
        } else {
            s = js_to_string(ctx, e);
        }
        if (js_is_exception(s)) return s;
        r = js_concat(ctx, r, s);
        if (js_is_exception(r)) return r;
    }
    return r;
}

CORE(array_proto_join) {
    UNUSED_ARGS;
    return join(ctx, this_val, ARG(0), false);
}

CORE(array_proto_to_locale_string) {
    UNUSED_ARGS;
    return join(ctx, this_val, JS_UNDEFINED, true);
}

CORE(array_proto_to_string) {
    UNUSED_ARGS;
    if (!js_require_this(ctx, this_val, "Array.prototype.toString")) return JS_EXCEPTION;
    JSValue f = js_get_value(ctx, this_val, js_atom_from_cstr(ctx, "join"));
    if (js_is_exception(f)) return JS_EXCEPTION;
    if (js_is_callable(f)) return js_call(ctx, f, this_val, 0, NULL);
    return js_object_to_string_tag(ctx, this_val);
}

/* ---- The objects --------------------------------------------------------------------------------- */

JSValue js_array_realm_init(JSContext *ctx, JSObject *global,
                         JSValue (*define_constructor)(JSContext *, JSObject *, const char *, JSNativeFn, uint32_t, JSValue)) {
    return define_constructor(ctx, global, "Array", array_ctor, 1, ctx->intrinsics[JS_INTRINSIC_ARRAY_PROTOTYPE]);
}

void js_array_realm_finish(JSContext *ctx) {
    JSValue *in = ctx->intrinsics;
    JSObject *array_proto = js_as_object(in[JS_INTRINSIC_ARRAY_PROTOTYPE]);
    JSPropertyDescriptor values;
    if (js_get_own_property(ctx, array_proto, js_atom_from_cstr(ctx, "values"), &values) == 1) in[JS_INTRINSIC_ARRAY_VALUES] = values.value;
    /* @@unscopables (§23.1.3.41): the names `with` statements don't see */
    static const char *const unscopable[] = {
        "at", "copyWithin", "entries", "fill", "find", "findIndex", "findLast", "findLastIndex", "flat", "flatMap",
        "includes", "keys", "toReversed", "toSorted", "toSpliced", "values",
    };
    JSValue list = js_new_object_proto(ctx, JS_NULL, JS_DEFAULT_INLINE_SLOTS);
    for (size_t i = 0; i < JS_COUNTOF(unscopable); i++)
        js_define_data(ctx, js_as_object(list), js_atom_from_cstr(ctx, unscopable[i]), JS_TRUE, JS_PROP_DEFAULT);
    js_define_data(ctx, array_proto, JS_SYMBOL(unscopables), list, JS_PROP_CONFIGURABLE);
}
