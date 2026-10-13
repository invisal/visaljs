/* for…in (ECMAScript §14.7.5.9 EnumerateObjectProperties, §14.7.5.10 the iterator). */
#include "internal.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_object.h"
#include "js_symbol.h"
#include "jscontext.h"
#include "shape.h"

/* The keys still to visit: `object`'s own keys from `index` on, then its prototype's, and
 * so on. `visited` (a null-prototype object used as a set) holds every key already seen,
 * so a key shadowed by an earlier object (enumerable or not) is skipped.
 *
 * The fast path (`shape` set): an ordinary object without elements, whose prototypes have no
 * enumerable keys (`{…}`, class instances). Its keys are then its shape's enumerable string keys,
 * listed once per shape (enum_keys), and there is nothing to shadow, so no `visited`. While the
 * object keeps that shape (shared shapes never change), each key is still there and enumerable;
 * after a change, each is looked up as on the slow path. */
typedef struct ForIn {
    JSHostCell host;
    JSValue    object;   /* null when done */
    JSValue    keys;     /* object's own keys (a value array), JS_EMPTY until listed */
    JSValue    proto;    /* object's prototype, read right after its keys (as V8 does) */
    JSValue    visited;
    JSValue    string;   /* a string primitive: its indices come first; else undefined */
    uint32_t   index;
    JSShape   *shape;    /* the fast path: the object's shape when the loop began; else NULL */
} ForIn;

static void for_in_visit(JSCell *c, JSTracer *trc) {
    ForIn *f = (ForIn *)c;
    js_trace_value(trc, f->object);
    js_trace_value(trc, f->keys);
    js_trace_value(trc, f->proto);
    js_trace_value(trc, f->visited);
    js_trace_value(trc, f->string);
    if (f->shape) js_trace_cell(trc, &f->shape->cell);
}

static const JSCellClass for_in_class = { "ForInIterator", for_in_visit, NULL, NULL };

/* Whether for…in sees `o`'s keys exactly as its shape lists them: an object with the ordinary
 * internal methods, no own keys outside its shape (Array's `length`, a String's indices), and
 * no elements. */
static bool plain_keys(JSObject *o) {
    const JSClass *cls = o->shape->cls;
    if (cls->methods || cls->get_own_property || cls->extra_keys) return false;
    return o->elements->kind == JS_ELEMENTS_DENSE && o->elements->length == 0;
}

/* The enumerable string keys of `s`'s properties, in order: a new value array. */
static JSValueArray *enumerable_keys(JSContext *ctx, JSShape *s) {
    JSPropTable *t = js_shape_entries(s);
    uint32_t n = 0;
    for (uint32_t i = 0; i < t->count; i++)
        n += js_is_string(t->entries[i].key) && (t->entries[i].attrs & JS_PROP_ENUMERABLE);
    JSValueArray *keys = js_alloc_value_array(ctx, n);
    t = js_shape_entries(s);  /* the allocation may have collected: the table is malloc'd, not moved */
    for (uint32_t i = 0, k = 0; i < t->count && k < n; i++)
        if (js_is_string(t->entries[i].key) && (t->entries[i].attrs & JS_PROP_ENUMERABLE)) keys->values[k++] = t->entries[i].key;  /* barrier: fresh cell */
    return keys;
}

/* `s`'s enumerable string keys: cached on a shared shape, listed anew for a dictionary's
 * (it changes in place). */
static JSValueArray *shape_enum_keys(JSContext *ctx, JSShape *s) {
    if (s->flags & JS_SHAPE_DICTIONARY) return enumerable_keys(ctx, s);
    if (js_is_empty(s->enum_keys)) {
        JSValueArray *keys = enumerable_keys(ctx, s);
        js_store(ctx, &s->cell, &s->enum_keys, js_cell(&keys->cell));
    }
    return (JSValueArray *)js_as_cell(s->enum_keys);
}

/* Whether nothing on `o`'s prototype chain is enumerable: then for…in lists only `o`'s own keys. */
static bool protos_enumerate_nothing(JSContext *ctx, JSObject *o) {
    for (JSValue p = o->shape->proto; js_is_object(p); p = js_as_object(p)->shape->proto) {
        JSObject *po = js_as_object(p);
        if (!plain_keys(po)) return false;
        JSShape *s = po->shape;
        if (s->flags & JS_SHAPE_DICTIONARY) {
            JSPropTable *t = js_shape_entries(s);
            for (uint32_t i = 0; i < t->count; i++)
                if (js_is_string(t->entries[i].key) && (t->entries[i].attrs & JS_PROP_ENUMERABLE)) return false;
        } else if (shape_enum_keys(ctx, s)->cell.aux != 0) {
            return false;
        }
    }
    return true;
}

JSValue js_for_in_start(JSContext *ctx, JSValue v) {
    if (js_is_object(v)) {
        JSObject *o = js_as_object(v);
        if (plain_keys(o) && protos_enumerate_nothing(ctx, o)) {
            JSValueArray *keys = shape_enum_keys(ctx, o->shape);
            ForIn *f = (ForIn *)js_alloc_host_cell(ctx, &for_in_class, sizeof(ForIn));
            JSCell *c = &f->host.cell;
            js_store(ctx, c, &f->object, v);
            js_store(ctx, c, &f->keys, js_cell(&keys->cell));
            js_store(ctx, c, &f->proto, JS_NULL);
            js_store(ctx, c, &f->visited, JS_UNDEFINED);
            js_store(ctx, c, &f->string, JS_UNDEFINED);
            f->shape = o->shape;  /* barrier: fresh cell */
            return js_cell(c);
        }
    }
    ForIn *f = (ForIn *)js_alloc_host_cell(ctx, &for_in_class, sizeof(ForIn));
    JSCell *c = &f->host.cell;
    js_store(ctx, c, &f->keys, JS_EMPTY);
    js_store(ctx, c, &f->string, js_is_string(v) ? v : JS_UNDEFINED);
    /* null and undefined: no keys; other primitives: their prototype's (ToObject) */
    JSValue object = js_is_nullish(v) ? JS_NULL : js_is_object(v) ? v : js_object_value(js_primitive_prototype(ctx, v));
    js_store(ctx, c, &f->object, object);
    js_store(ctx, c, &f->visited, js_new_object_proto(ctx, JS_NULL, JS_DEFAULT_INLINE_SLOTS));
    return js_cell(c);
}

/* Marks `key` visited; false if it already was. */
static bool first_visit(JSContext *ctx, ForIn *f, JSValue key) {
    JSObject *visited = js_as_object(f->visited);
    JSPropertyDescriptor d;
    if (js_get_own_property(ctx, visited, key, &d) == 1) return false;
    js_define_data(ctx, visited, key, JS_TRUE, JS_PROP_DEFAULT);
    return true;
}

/* The fast path's next key. */
static JSValue fast_next(JSContext *ctx, ForIn *f) {
    JSObject *o = js_as_object(f->object);
    JSValueArray *keys = (JSValueArray *)js_as_cell(f->keys);
    bool unchanged = o->shape == f->shape && !(f->shape->flags & JS_SHAPE_DICTIONARY);
    while (f->index < keys->cell.aux) {
        JSValue key = keys->values[f->index++];
        if (unchanged) return key;
        /* deleted since the loop began, or no longer enumerable: skipped */
        JSPropertyDescriptor d;
        int r = js_get_own_property(ctx, o, key, &d);
        if (r < 0) return JS_EXCEPTION;
        if (r == 1 && (d.attrs & JS_PROP_ENUMERABLE)) return key;
    }
    return JS_UNDEFINED;
}

/* The next key (a string), undefined when there are no more, or JS_EXCEPTION. */
JSValue js_for_in_next(JSContext *ctx, JSValue it) {
    ForIn *f = (ForIn *)js_as_cell(it);
    JSCell *c = &f->host.cell;
    if (f->shape) return fast_next(ctx, f);
    /* a string's own indices, before anything on String.prototype */
    if (js_is_string(f->string)) {
        if (f->index < js_string_length(f->string)) {
            JSValue key = js_index_key(f->index++);
            (void)first_visit(ctx, f, key);
            return js_to_string(ctx, key);
        }
        js_store(ctx, c, &f->string, JS_UNDEFINED);
        f->index = 0;
    }
    while (js_is_object(f->object)) {
        JSObject *o = js_as_object(f->object);
        if (js_is_empty(f->keys)) {
            JSValue keys = js_own_keys(ctx, o);
            if (js_is_exception(keys)) return JS_EXCEPTION;
            js_store(ctx, c, &f->keys, keys);
            JSValue proto = js_object_get_prototype_of(ctx, o);
            if (js_is_exception(proto)) return proto;
            js_store(ctx, c, &f->proto, proto);
            f->index = 0;
        }
        JSValueArray *keys = (JSValueArray *)js_as_cell(f->keys);
        while (f->index < keys->cell.aux) {
            JSValue key = keys->values[f->index++];
            if (js_is_symbol(key) || !first_visit(ctx, f, key)) continue;
            /* deleted since the keys were listed, or not enumerable: skipped (still shadows) */
            JSPropertyDescriptor d;
            int r = js_get_own_property(ctx, o, key, &d);
            if (r < 0) return JS_EXCEPTION;
            if (r == 0 || !(d.attrs & JS_PROP_ENUMERABLE)) continue;
            return js_is_number(key) ? js_to_string(ctx, key) : key;
        }
        js_store(ctx, c, &f->object, f->proto);
        js_store(ctx, c, &f->keys, JS_EMPTY);
    }
    return JS_UNDEFINED;
}
