/* Objects and the ordinary internal methods (ECMAScript §10.1). */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "elements.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_function.h"
#include "js_object.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "jscontext.h"
#include "shape.h"

const JSClass js_class_object = { "Object", sizeof(JSObject), NULL, NULL, NULL, NULL, NULL, NULL, NULL };

const JSElements js_empty_elements = {
    { JS_CELL_ELEMENTS, 0, JS_CELL_STATIC, 0 }, JS_ELEMENTS_DENSE, 0, 0, 0, 0, 0,
};

/* ---- GC classes (gc_visit.h visits them) ----------------------------------- */

const JSCellClass js_accessor_cell_class = { "AccessorPair", NULL, NULL, NULL };
const JSCellClass js_elements_cell_class = { "Elements", NULL, js_elements_finalize, NULL };

static void object_finalize(JSRuntime *rt, JSCell *c) {
    JSObject *o = (JSObject *)c;
    if (o->shape->cls->finalize) o->shape->cls->finalize(rt, c);
}
const JSCellClass js_object_cell_class = { "Object", NULL, object_finalize, NULL };

/* ---- Allocation ---------------------------------------------------------------- */

JSObject *js_alloc_object(JSContext *ctx, JSCellKind kind, JSShape *shape) {
    size_t size = shape->slot_offset + (size_t)shape->inline_cap * sizeof(JSValue);
    JSObject *o = (JSObject *)js_alloc_cell(ctx, kind, size);
    o->shape = shape;  /* barrier: fresh cell */
    o->elements = (JSElements *)&js_empty_elements;  /* barrier: fresh cell */
    JSValue *slots = js_object_slots(o);
    for (uint16_t i = 0; i < shape->inline_cap; i++) slots[i] = JS_UNDEFINED;
    if (shape->cls->finalize) {
        o->cell.flags |= JS_CELL_FINALIZABLE;
        js_block_of(o)->has_finalizable = 1;
    }
    return o;
}

JSValue js_new_object_proto(JSContext *ctx, JSValue proto, uint16_t inline_cap) {
    JSShape *shape = js_shape_root(ctx, &js_class_object, proto, inline_cap);
    return js_object_value(js_alloc_object(ctx, JS_CELL_OBJECT, shape));
}

JSValue js_new_object(JSContext *ctx) {
    return js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], JS_DEFAULT_INLINE_SLOTS);
}

static JSValue array_with_proto(JSContext *ctx, JSValue proto, uint32_t capacity);

void js_realm_init(JSContext *ctx) {
    /* %Object.prototype%: an ordinary object whose [[Prototype]] is null */
    ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE] = js_new_object_proto(ctx, JS_NULL, 8);
    js_function_realm_init(ctx);
    /* %Array.prototype% is itself an Array exotic object (§23.1.3) */
    ctx->intrinsics[JS_INTRINSIC_ARRAY_PROTOTYPE] = array_with_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 0);
    js_global_realm_init(ctx);
}

/* ---- Property keys ---------------------------------------------------------------- */

#define MAX_INDEX 4294967294.0  /* array indices are 0 … 2^32 - 2 */

/* "0" or [1-9][0-9]* up to 2^32 - 2: the canonical form of an array index. */
static int64_t canonical_index(JSStrView v) {
    if (v.length == 0 || v.length > 10) return -1;
    uint32_t c0 = js_view_at(v, 0);
    if (c0 == '0') return v.length == 1 ? 0 : -1;
    uint64_t n = 0;
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        if (c < '0' || c > '9') return -1;
        n = n * 10 + (c - '0');
    }
    return n <= (uint64_t)MAX_INDEX ? (int64_t)n : -1;
}

JSValue js_to_property_key(JSContext *ctx, JSValue v) {
    JS_ASSERT_NOT_EXC(v);
    if (js_is_int32(v) && js_as_int32(v) >= 0) return js_index_key((uint32_t)js_as_int32(v));
    if (js_is_number(v)) {
        double d = js_as_number(v);
        if (d >= 0 && d <= MAX_INDEX && d == floor(d)) return js_index_key((uint32_t)d);  /* -0 too: String(-0) is "0" */
    }
    if (js_is_symbol(v)) return v;
    if (js_is_string(v)) {
        int64_t index = canonical_index(js_string_view(ctx, v));
        return index >= 0 ? js_index_key((uint32_t)index) : js_atomize(ctx, v);
    }
    if (js_is_object(v)) {
        JSValue p = js_to_primitive(ctx, v, JS_HINT_STRING);
        if (js_is_exception(p)) return JS_EXCEPTION;
        return js_to_property_key(ctx, p);
    }
    JSValue s = js_to_string(ctx, v);  /* numbers that aren't index keys, booleans, null, undefined */
    if (js_is_exception(s)) return JS_EXCEPTION;
    if (js_is_bigint(v)) return js_to_property_key(ctx, s);  /* 1n is the index key 1 */
    return js_atomize(ctx, s);
}

/* ---- SameValue ------------------------------------------------------------------- */

static bool same_value(JSContext *ctx, JSValue a, JSValue b) {
    return js_same_value(ctx, a, b);
}

bool js_same_value(JSContext *ctx, JSValue a, JSValue b) {
    if (js_is_number(a) && js_is_number(b)) {
        double x = js_as_number(a), y = js_as_number(b);
        if (x != x) return y != y;
        return x == y && signbit(x) == signbit(y);
    }
    if (js_is_string(a) && js_is_string(b)) return js_string_equals(ctx, a, b);
    if (js_is_bigint(a) && js_is_bigint(b)) return js_bigint_equals(a, b);
    return js_same_bits(a, b);
}

/* ---- Named slots -------------------------------------------------------------------- */

static bool is_dictionary(JSObject *o) { return (o->shape->flags & JS_SHAPE_DICTIONARY) != 0; }

static int32_t find_own(JSObject *o, JSValue key, uint8_t *attrs) {
    return js_shape_find(o->shape, key, attrs);
}

/* Makes room for slot `n` (the next slot to fill). */
static void ensure_slot(JSContext *ctx, JSObject *o, uint32_t n) {
    uint16_t cap = o->shape->inline_cap;
    if (n < cap) return;
    uint32_t need = n - cap + 1;
    uint32_t have = o->ool ? o->ool->cell.aux : 0;
    if (need <= have) return;
    uint32_t grown = have < 4 ? 4 : have + have / 2;  /* ×1.5 */
    if (grown < need) grown = need;
    JSValueArray *a = js_alloc_value_array(ctx, grown);
    for (uint32_t i = 0; i < grown; i++) a->values[i] = i < have ? o->ool->values[i] : JS_UNDEFINED;  /* barrier: fresh cell */
    js_store_ptr(ctx, &o->cell, &o->ool, a);
}

/* Gives `o` a private dictionary shape holding its current properties. */
static void to_dictionary(JSContext *ctx, JSObject *o) {
    if (is_dictionary(o)) return;
    JSShape *old = o->shape;
    JSShape *d = js_alloc_shape(ctx);
    d->cls = old->cls;
    d->proto = old->proto;  /* barrier: fresh cell */
    d->flags = (uint8_t)(old->flags | JS_SHAPE_DICTIONARY);
    d->inline_cap = old->inline_cap;
    d->slot_offset = old->slot_offset;
    d->prop_count = old->prop_count;
    d->table = js_prop_table_clone(js_shape_entries(old));
    js_object_set_shape(ctx, o, d);
}

static void add_own(JSContext *ctx, JSObject *o, JSValue key, JSValue value, uint8_t attrs) {
    JSShape *s = o->shape;
    if (!is_dictionary(o)) {
        bool crowded = s->prop_count >= JS_DICTIONARY_THRESHOLD;
        bool too_many_transitions = js_shape_transition_count(s) >= JS_MAX_TRANSITIONS;
        uint8_t ignored;
        if (!crowded && !too_many_transitions) {
            JSShape *child = js_shape_add(ctx, s, key, attrs);
            ensure_slot(ctx, o, s->prop_count);
            js_object_set_shape(ctx, o, child);
            js_store(ctx, &o->cell, js_object_slot(o, child->prop_count - 1), value);
            return;
        }
        if (too_many_transitions && js_shape_find(s, key, &ignored) < 0) {
            /* reuse an existing transition if there is one */
            JSTransitions *t = s->transitions;
            for (uint32_t i = 0; i < t->count; i++)
                if (js_same_bits(t->items[i].key, key) && t->items[i].attrs == attrs) {
                    ensure_slot(ctx, o, s->prop_count);
                    js_object_set_shape(ctx, o, t->items[i].child);
                    js_store(ctx, &o->cell, js_object_slot(o, o->shape->prop_count - 1), value);
                    return;
                }
        }
        to_dictionary(ctx, o);
    }
    uint32_t slot = o->shape->prop_count;
    ensure_slot(ctx, o, slot);
    js_prop_table_add(o->shape->table, key, slot, attrs);
    js_write_barrier(ctx, &o->shape->cell, NULL, key);  /* a dictionary's keys are traced from its shape */
    o->shape->prop_count++;
    js_store(ctx, &o->cell, js_object_slot(o, slot), value);
}

static void remove_own(JSContext *ctx, JSObject *o, JSValue key, int32_t slot) {
    JSShape *s = o->shape;
    if (!is_dictionary(o) && s->parent && js_same_bits(s->key, key)) {
        /* the last-added property: back to the parent shape */
        *js_object_slot(o, (uint32_t)slot) = JS_UNDEFINED;
        js_object_set_shape(ctx, o, s->parent);
        return;
    }
    to_dictionary(ctx, o);
    JSPropTable *t = o->shape->table;
    int32_t i = js_prop_table_find(t, key);
    uint32_t last = o->shape->prop_count - 1;
    /* keep slots dense: move the last slot's property into the freed one */
    if ((uint32_t)slot != last) {
        for (uint32_t k = 0; k < t->count; k++)
            if (t->entries[k].slot == last) {
                t->entries[k].slot = (uint32_t)slot;
                break;
            }
        js_store(ctx, &o->cell, js_object_slot(o, (uint32_t)slot), *js_object_slot(o, last));
    }
    *js_object_slot(o, last) = JS_UNDEFINED;
    js_prop_table_remove(t, (uint32_t)i);
    o->shape->prop_count--;
}

/* Changes the attributes of an existing property (a dictionary update). */
static void set_attrs(JSContext *ctx, JSObject *o, JSValue key, uint8_t attrs) {
    to_dictionary(ctx, o);
    JSPropTable *t = o->shape->table;
    t->entries[js_prop_table_find(t, key)].attrs = attrs;
}

/* ---- Internal methods ------------------------------------------------------------- */

static JSValue describe(JSContext *ctx, JSValue key, char *buf, size_t cap) {
    if (js_key_is_index(key)) snprintf(buf, cap, "%u", js_key_index(key));
    else {
        JSValue s = key;
        if (js_is_symbol(key)) {
            s = js_symbol_descriptive_string(ctx, key);
            if (js_is_exception(s)) {  /* out of memory while describing: say less */
                js_discard(js_take_exception(ctx));
                s = js_empty_string();
            }
        }
        size_t n = js_view_to_utf8(js_string_view(ctx, s), buf, cap - 1);
        buf[n < cap - 1 ? n : cap - 1] = '\0';
    }
    return JS_UNDEFINED;
}

int js_ordinary_get_own_property(JSContext *ctx, JSObject *o, JSValue key, JSPropertyDescriptor *out) {
    if (js_key_is_index(key)) return js_elements_get_own(ctx, o, js_key_index(key), out);
    uint8_t attrs;
    int32_t slot = find_own(o, key, &attrs);
    if (slot < 0) return 0;
    JSValue v = *js_object_slot(o, (uint32_t)slot);
    if (attrs & JS_PROP_ACCESSOR) {
        JSAccessorPair *p = (JSAccessorPair *)js_as_cell(v);
        *out = (JSPropertyDescriptor){ JS_DESC_GET | JS_DESC_SET | JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE,
                                       (uint8_t)(attrs & (JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE)), JS_UNDEFINED, p->get, p->set };
    } else {
        *out = js_data_descriptor(v, attrs);
    }
    return 1;
}

int js_get_own_property(JSContext *ctx, JSObject *o, JSValue key, JSPropertyDescriptor *out) {
    const JSClass *cls = o->shape->cls;
    if (cls->get_own_property) {
        int r = cls->get_own_property(ctx, o, key, out);
        if (r != JS_ORDINARY && r != JS_ORDINARY_UNCACHED) return r;
    }
    return js_ordinary_get_own_property(ctx, o, key, out);
}

static JSValue new_accessor(JSContext *ctx, JSValue get, JSValue set) {
    JSAccessorPair *p = (JSAccessorPair *)js_alloc_cell(ctx, JS_CELL_ACCESSOR, sizeof(JSAccessorPair));
    js_init_slot(&p->get, get);
    js_init_slot(&p->set, set);
    return js_cell(&p->cell);
}

static int reject(JSContext *ctx, bool throw_on_fail, const char *what, JSValue key) {
    if (!throw_on_fail) return 0;
    char name[128];
    describe(ctx, key, name, sizeof name);
    JSValue e = strcmp(what, "redefine") == 0 ? js_throw_type_error(ctx, "Cannot redefine property: %s", name)  /* V8's wording */
                                              : js_throw_type_error(ctx, "Cannot %s property '%s'", what, name);
    (void)e;
    return -1;
}

/* ValidateAndApplyPropertyDescriptor (§10.1.6.3). */
int js_ordinary_define_own_property(JSContext *ctx, JSObject *o, JSValue key, const JSPropertyDescriptor *desc, bool throw_on_fail) {
    if (js_key_is_index(key)) return js_elements_define(ctx, o, js_key_index(key), desc, throw_on_fail);
    bool is_accessor_desc = (desc->has & (JS_DESC_GET | JS_DESC_SET)) != 0;
    uint8_t attrs;
    int32_t slot = find_own(o, key, &attrs);

    if (slot < 0) {
        if (!js_is_extensible(o)) return reject(ctx, throw_on_fail, "define", key);
        uint8_t a = 0;
        if ((desc->has & JS_DESC_ENUMERABLE) && (desc->attrs & JS_PROP_ENUMERABLE)) a |= JS_PROP_ENUMERABLE;
        if ((desc->has & JS_DESC_CONFIGURABLE) && (desc->attrs & JS_PROP_CONFIGURABLE)) a |= JS_PROP_CONFIGURABLE;
        if (is_accessor_desc) {
            JSValue pair = new_accessor(ctx, desc->has & JS_DESC_GET ? desc->get : JS_UNDEFINED,
                                        desc->has & JS_DESC_SET ? desc->set : JS_UNDEFINED);
            add_own(ctx, o, key, pair, (uint8_t)(a | JS_PROP_ACCESSOR));
        } else {
            if ((desc->has & JS_DESC_WRITABLE) && (desc->attrs & JS_PROP_WRITABLE)) a |= JS_PROP_WRITABLE;
            add_own(ctx, o, key, desc->has & JS_DESC_VALUE ? desc->value : JS_UNDEFINED, a);
        }
        return 1;
    }

    JSPropertyDescriptor current = { 0, 0, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    if (js_ordinary_get_own_property(ctx, o, key, &current) < 0) return -1;
    bool current_accessor = (attrs & JS_PROP_ACCESSOR) != 0;
    if (!(attrs & JS_PROP_CONFIGURABLE)) {
        if ((desc->has & JS_DESC_CONFIGURABLE) && (desc->attrs & JS_PROP_CONFIGURABLE)) return reject(ctx, throw_on_fail, "redefine", key);
        if ((desc->has & JS_DESC_ENUMERABLE) && ((desc->attrs ^ attrs) & JS_PROP_ENUMERABLE)) return reject(ctx, throw_on_fail, "redefine", key);
        bool generic = !is_accessor_desc && !(desc->has & (JS_DESC_VALUE | JS_DESC_WRITABLE));
        if (!generic && is_accessor_desc != current_accessor) return reject(ctx, throw_on_fail, "redefine", key);
        if (current_accessor) {
            if ((desc->has & JS_DESC_GET) && !js_same_bits(desc->get, current.get)) return reject(ctx, throw_on_fail, "redefine", key);
            if ((desc->has & JS_DESC_SET) && !js_same_bits(desc->set, current.set)) return reject(ctx, throw_on_fail, "redefine", key);
        } else if (!(attrs & JS_PROP_WRITABLE)) {
            if ((desc->has & JS_DESC_WRITABLE) && (desc->attrs & JS_PROP_WRITABLE)) return reject(ctx, throw_on_fail, "redefine", key);
            if ((desc->has & JS_DESC_VALUE) && !same_value(ctx, desc->value, current.value)) return reject(ctx, throw_on_fail, "redefine", key);
        }
    }

    /* apply */
    uint8_t na = attrs;
    if (desc->has & JS_DESC_ENUMERABLE) na = (uint8_t)((na & ~JS_PROP_ENUMERABLE) | (desc->attrs & JS_PROP_ENUMERABLE));
    if (desc->has & JS_DESC_CONFIGURABLE) na = (uint8_t)((na & ~JS_PROP_CONFIGURABLE) | (desc->attrs & JS_PROP_CONFIGURABLE));
    JSValue value = *js_object_slot(o, (uint32_t)slot);
    if (is_accessor_desc && !current_accessor) {
        /* data → accessor: keep enumerable/configurable, drop writable */
        value = new_accessor(ctx, desc->has & JS_DESC_GET ? desc->get : JS_UNDEFINED, desc->has & JS_DESC_SET ? desc->set : JS_UNDEFINED);
        na = (uint8_t)((na & ~JS_PROP_WRITABLE) | JS_PROP_ACCESSOR);
    } else if (!is_accessor_desc && current_accessor && (desc->has & (JS_DESC_VALUE | JS_DESC_WRITABLE))) {
        /* accessor → data */
        value = desc->has & JS_DESC_VALUE ? desc->value : JS_UNDEFINED;
        na = (uint8_t)(na & ~JS_PROP_ACCESSOR);
        if ((desc->has & JS_DESC_WRITABLE) && (desc->attrs & JS_PROP_WRITABLE)) na |= JS_PROP_WRITABLE;
    } else if (current_accessor) {
        JSValue get = desc->has & JS_DESC_GET ? desc->get : current.get;
        JSValue set = desc->has & JS_DESC_SET ? desc->set : current.set;
        if ((desc->has & (JS_DESC_GET | JS_DESC_SET))) value = new_accessor(ctx, get, set);
    } else {
        if (desc->has & JS_DESC_WRITABLE) na = (uint8_t)((na & ~JS_PROP_WRITABLE) | (desc->attrs & JS_PROP_WRITABLE));
        if (desc->has & JS_DESC_VALUE) value = desc->value;
    }
    if (na != attrs) {
        set_attrs(ctx, o, key, na);
        slot = find_own(o, key, &attrs);  /* dictionary conversion kept the slot numbers */
    }
    js_store(ctx, &o->cell, js_object_slot(o, (uint32_t)slot), value);
    return 1;
}

int js_define_own_property(JSContext *ctx, JSObject *o, JSValue key, const JSPropertyDescriptor *desc, bool throw_on_fail) {
    const JSClass *cls = o->shape->cls;
    if (cls->define_own_property) {
        int r = cls->define_own_property(ctx, o, key, desc, throw_on_fail);
        if (r != JS_ORDINARY) return r;
    }
    return js_ordinary_define_own_property(ctx, o, key, desc, throw_on_fail);
}

static bool define_cached(JSContext *ctx, JSObject *o, JSValue key, JSValue value);
static void remember_define(JSContext *ctx, JSShape *before, JSObject *o, JSValue key);

void js_define_data(JSContext *ctx, JSObject *o, JSValue key, JSValue value, uint8_t attrs) {
    /* an object literal's properties: a new key's transition, seen before, is taken directly */
    bool plain = attrs == JS_PROP_DEFAULT && !js_key_is_index(key);
    if (plain && define_cached(ctx, o, key, value)) return;
    JSShape *before = o->shape;
    JSPropertyDescriptor d = js_data_descriptor(value, attrs);
    int r = js_define_own_property(ctx, o, key, &d, false);
    (void)r;
    if (plain) remember_define(ctx, before, o, key);
}

JSValue js_get_prototype_of(JSObject *o) {
    return o->shape->proto;
}

static const JSObjectMethods *methods_of(JSObject *o) { return o->shape->cls->methods; }
/* o's override of an internal method, or NULL for the ordinary one. */
#define METHOD(o, name) (methods_of(o) ? methods_of(o)->name : NULL)

JSValue js_object_get_prototype_of(JSContext *ctx, JSObject *o) {
    return METHOD(o, get_prototype_of) ? METHOD(o, get_prototype_of)(ctx, o) : o->shape->proto;
}

int js_object_is_extensible(JSContext *ctx, JSObject *o) {
    return METHOD(o, is_extensible) ? METHOD(o, is_extensible)(ctx, o) : js_is_extensible(o);
}

JSValue js_proxy_target(JSValue v) {
    if (!js_is_object(v)) return JS_EMPTY;
    const JSObjectMethods *m = methods_of(js_as_object(v));
    return m && m->target ? m->target(js_as_object(v)) : JS_EMPTY;
}

int js_is_array_spec(JSContext *ctx, JSValue v) {
    for (;;) {
        if (js_is_array(v)) return 1;
        JSValue t = js_proxy_target(v);
        if (js_is_empty(t)) return 0;
        if (js_is_null(t)) {
            js_discard(js_throw_type_error(ctx, "Cannot perform 'IsArray' on a proxy that has been revoked"));
            return -1;
        }
        v = t;
    }
}

/* The shape o would have with `proto`: its properties added, in order, to the root for proto.
 * The slots stay where they are, and the shape stays shared (and cacheable): a derived class's
 * constructor, a prototype re-parented with Object.setPrototypeOf. */
static void reroot(JSContext *ctx, JSObject *o, JSValue proto) {
    JSShape *s = o->shape;
    uint32_t n = s->prop_count;
    JSShape *small[32];
    JSShape **steps = n <= 32 ? small : malloc(n * sizeof *steps);
    if (!steps) js_fatal("out of memory changing a prototype");
    for (JSShape *x = s; x->parent; x = x->parent) steps[x->prop_count - 1] = x;
    JSShape *r = js_shape_root(ctx, s->cls, proto, s->inline_cap);
    for (uint32_t i = 0; i < n; i++) r = js_shape_add(ctx, r, steps[i]->key, steps[i]->attrs);
    if (steps != small) free(steps);
    js_object_set_shape(ctx, o, r);
}

int js_set_prototype_of(JSContext *ctx, JSObject *o, JSValue proto) {
    if (METHOD(o, set_prototype_of)) return METHOD(o, set_prototype_of)(ctx, o, proto);
    if (js_same_bits(proto, o->shape->proto)) return 1;
    if (!js_is_extensible(o)) return 0;
    for (JSValue p = proto; js_is_object(p); p = js_as_object(p)->shape->proto)
        if (js_as_object(p) == o) return 0;  /* no cycles */
    if (!is_dictionary(o) && o->shape->prop_count < JS_DICTIONARY_THRESHOLD) {
        reroot(ctx, o, proto);
        return 1;
    }
    to_dictionary(ctx, o);
    js_store(ctx, &o->shape->cell, &o->shape->proto, proto);
    return 1;
}

bool js_is_extensible(JSObject *o) {
    return (o->shape->flags & JS_SHAPE_EXTENSIBLE) != 0;
}

int js_prevent_extensions(JSContext *ctx, JSObject *o) {
    if (METHOD(o, prevent_extensions)) return METHOD(o, prevent_extensions)(ctx, o);
    return js_ordinary_prevent_extensions(ctx, o);
}

int js_ordinary_prevent_extensions(JSContext *ctx, JSObject *o) {
    if (!js_is_extensible(o)) return 1;
    to_dictionary(ctx, o);
    o->shape->flags &= (uint8_t)~JS_SHAPE_EXTENSIBLE;
    return 1;
}

int js_has_property(JSContext *ctx, JSObject *o, JSValue key) {
    return METHOD(o, has_property) ? METHOD(o, has_property)(ctx, o, key) : js_ordinary_has_property(ctx, o, key);
}

/* OrdinaryHasProperty (§10.1.7.1): own, then the prototype's [[HasProperty]]. */
int js_ordinary_has_property(JSContext *ctx, JSObject *o, JSValue key) {
    JSPropertyDescriptor d;
    int r = js_get_own_property(ctx, o, key, &d);
    if (r) return r;
    JSValue proto = js_get_prototype_of(o);
    return js_is_object(proto) ? js_has_property(ctx, js_as_object(proto), key) : 0;
}

int js_delete_property(JSContext *ctx, JSObject *o, JSValue key, bool throw_on_fail) {
    const JSClass *cls = o->shape->cls;
    if (cls->delete_property) {
        int r = cls->delete_property(ctx, o, key, throw_on_fail);
        if (r != JS_ORDINARY) return r;
    }
    return js_ordinary_delete(ctx, o, key, throw_on_fail);
}

int js_ordinary_delete(JSContext *ctx, JSObject *o, JSValue key, bool throw_on_fail) {
    if (js_key_is_index(key)) return js_elements_delete(ctx, o, js_key_index(key), throw_on_fail);
    uint8_t attrs;
    int32_t slot = find_own(o, key, &attrs);
    if (slot < 0) return 1;
    if (!(attrs & JS_PROP_CONFIGURABLE)) return reject(ctx, throw_on_fail, "delete", key);
    remove_own(ctx, o, key, slot);
    return 1;
}

/* Calls a getter (no argument) or a setter (one). */
static JSValue call_accessor(JSContext *ctx, JSValue fn, JSValue this_val, int argc, JSValue arg) {
    return js_call(ctx, fn, this_val, (uint32_t)argc, &arg);
}

JSValue js_get(JSContext *ctx, JSObject *o, JSValue key, JSValue receiver) {
    for (;;) {
        if (METHOD(o, get)) return METHOD(o, get)(ctx, o, key, receiver);
        JSPropertyDescriptor d;
        int r = js_get_own_property(ctx, o, key, &d);
        if (r < 0) return JS_EXCEPTION;
        if (r) {
            if (d.has & JS_DESC_VALUE) return d.value;
            return js_is_undefined(d.get) ? JS_UNDEFINED : call_accessor(ctx, d.get, receiver, 0, JS_UNDEFINED);
        }
        JSValue proto = js_get_prototype_of(o);
        if (!js_is_object(proto)) return JS_UNDEFINED;
        o = js_as_object(proto);
    }
}

/* OrdinaryGet (§10.1.8.1): own, then the prototype's [[Get]]. */
JSValue js_ordinary_get(JSContext *ctx, JSObject *o, JSValue key, JSValue receiver) {
    JSPropertyDescriptor d;
    int r = js_get_own_property(ctx, o, key, &d);
    if (r < 0) return JS_EXCEPTION;
    if (r) {
        if (d.has & JS_DESC_VALUE) return d.value;
        return js_is_undefined(d.get) ? JS_UNDEFINED : call_accessor(ctx, d.get, receiver, 0, JS_UNDEFINED);
    }
    JSValue proto = js_get_prototype_of(o);
    return js_is_object(proto) ? js_get(ctx, js_as_object(proto), key, receiver) : JS_UNDEFINED;
}

int js_set(JSContext *ctx, JSObject *o, JSValue key, JSValue v, JSValue receiver, bool throw_on_fail) {
    if (METHOD(o, set)) return METHOD(o, set)(ctx, o, key, v, receiver, throw_on_fail);
    return js_ordinary_set(ctx, o, key, v, receiver, throw_on_fail);
}

/* OrdinarySet (§10.1.9). */
int js_ordinary_set(JSContext *ctx, JSObject *o, JSValue key, JSValue v, JSValue receiver, bool throw_on_fail) {
    /* fast paths: an own writable data property of the receiver itself */
    if (js_is_object(receiver) && js_as_object(receiver) == o && js_key_is_index(key)) {
        /* not for classes that intercept indices (mapped arguments); arrays only guard length */
        bool plain = !o->shape->cls->define_own_property || o->shape->cls == &js_class_array;
        if (plain && js_elements_try_store(ctx, o, js_key_index(key), v)) return 1;
    } else if (js_is_object(receiver) && js_as_object(receiver) == o) {
        uint8_t attrs;
        int32_t slot = find_own(o, key, &attrs);
        if (slot >= 0 && (attrs & (JS_PROP_WRITABLE | JS_PROP_ACCESSOR)) == JS_PROP_WRITABLE) {
            js_store(ctx, &o->cell, js_object_slot(o, (uint32_t)slot), v);
            return 1;
        }
    }
    JSPropertyDescriptor own;
    bool found = false;
    for (JSObject *h = o;;) {
        int r = js_get_own_property(ctx, h, key, &own);
        if (r < 0) return -1;
        if (r) {
            found = true;
            break;
        }
        JSValue proto = js_get_prototype_of(h);
        if (!js_is_object(proto)) break;
        h = js_as_object(proto);
        if (METHOD(h, set)) return METHOD(h, set)(ctx, h, key, v, receiver, throw_on_fail);  /* a proxy up the chain */
    }
    if (!found) own = js_data_descriptor(JS_UNDEFINED, JS_PROP_DEFAULT);

    if (own.has & JS_DESC_VALUE) {
        if (!(own.attrs & JS_PROP_WRITABLE)) return reject(ctx, throw_on_fail, "assign to read only", key);
        if (!js_is_object(receiver)) return reject(ctx, throw_on_fail, "create", key);
        JSObject *r = js_as_object(receiver);
        JSPropertyDescriptor existing;
        int e = js_get_own_property(ctx, r, key, &existing);
        if (e < 0) return -1;
        if (e) {
            if (!(existing.has & JS_DESC_VALUE)) return reject(ctx, throw_on_fail, "assign to", key);
            if (!(existing.attrs & JS_PROP_WRITABLE)) return reject(ctx, throw_on_fail, "assign to read only", key);
            JSPropertyDescriptor d = { JS_DESC_VALUE, 0, v, JS_UNDEFINED, JS_UNDEFINED };
            return js_define_own_property(ctx, r, key, &d, throw_on_fail);
        }
        JSPropertyDescriptor d = js_data_descriptor(v, JS_PROP_DEFAULT);
        return js_define_own_property(ctx, r, key, &d, throw_on_fail);
    }
    if (js_is_undefined(own.set)) return reject(ctx, throw_on_fail, "set a property that has only a getter:", key);
    JSValue res = call_accessor(ctx, own.set, receiver, 1, v);
    return js_is_exception(res) ? -1 : 1;
}

/* Indices ascending, then the class's extra string keys, then string keys in insertion order,
 * then symbols in insertion order (§10.1.11.1). Private names never appear. */
JSValue js_own_keys(JSContext *ctx, JSObject *o) {
    return METHOD(o, own_keys) ? METHOD(o, own_keys)(ctx, o) : js_ordinary_own_keys(ctx, o);
}

JSValue js_ordinary_own_keys(JSContext *ctx, JSObject *o) {
    JSValueArray *indices = js_elements_keys(ctx, o);
    JSValue extra[4];
    uint32_t n_extra = o->shape->cls->extra_keys ? o->shape->cls->extra_keys(ctx, o, extra) : 0;
    uint32_t n_named = js_shape_entries(o->shape)->count;
    uint32_t n_idx = indices->cell.aux;
    JSValueArray *keys = js_alloc_value_array(ctx, n_idx + n_extra + n_named);
    JSPropTable *t = js_shape_entries(o->shape);
    uint32_t k = 0;
    for (uint32_t i = 0; i < n_idx; i++) keys->values[k++] = indices->values[i];  /* barrier: fresh cell */
    for (uint32_t i = 0; i < n_extra; i++) keys->values[k++] = extra[i];  /* barrier: fresh cell */
    for (int symbols = 0; symbols < 2; symbols++)
        for (uint32_t i = 0; i < n_named; i++) {
            JSValue key = t->entries[i].key;
            if (js_is_symbol(key) == (symbols == 1) && !js_is_private_name(key)) keys->values[k++] = key;  /* barrier: fresh cell */
        }
    keys->cell.aux = k;  /* private names don't count */
    return js_cell(&keys->cell);
}

/* ---- Arrays (§10.4.2) ------------------------------------------------------------ */

#define ARRAY_LENGTH_FROZEN 0x01u  /* cell flags (kind-specific): `length` is non-writable */

static bool length_writable(JSObject *a) { return !(a->cell.flags & ARRAY_LENGTH_FROZEN); }

static bool is_length(JSValue key) { return js_same_bits(key, JS_ATOM(length)); }

static int array_get_own(JSContext *ctx, JSObject *a, JSValue key, JSPropertyDescriptor *out) {
    (void)ctx;
    if (!is_length(key)) return JS_ORDINARY;
    *out = js_data_descriptor(js_number((double)js_array_length(a)), length_writable(a) ? JS_PROP_WRITABLE : 0);
    return 1;
}

static int array_reject(JSContext *ctx, bool throw_on_fail, const char *msg) {
    if (!throw_on_fail) return 0;
    js_discard(js_throw_type_error(ctx, "%s", msg));
    return -1;
}

/* ArraySetLength (§10.4.2.4). */
static int array_set_length(JSContext *ctx, JSObject *a, const JSPropertyDescriptor *desc, bool throw_on_fail) {
    if (desc->has & (JS_DESC_GET | JS_DESC_SET)) return array_reject(ctx, throw_on_fail, "Cannot redefine property: length");
    if (((desc->has & JS_DESC_CONFIGURABLE) && (desc->attrs & JS_PROP_CONFIGURABLE)) ||
        ((desc->has & JS_DESC_ENUMERABLE) && (desc->attrs & JS_PROP_ENUMERABLE)))
        return array_reject(ctx, throw_on_fail, "Cannot redefine property: length");
    bool make_frozen = (desc->has & JS_DESC_WRITABLE) && !(desc->attrs & JS_PROP_WRITABLE);
    if ((desc->has & JS_DESC_WRITABLE) && (desc->attrs & JS_PROP_WRITABLE) && !length_writable(a))
        return array_reject(ctx, throw_on_fail, "Cannot redefine property: length");
    uint32_t old_len = js_array_length(a);
    uint32_t new_len = old_len;
    if (desc->has & JS_DESC_VALUE) {
        double number;
        if (js_to_number(ctx, &number, desc->value)) return -1;
        new_len = (uint32_t)js_double_to_int32(number);
        if ((double)new_len != number) {
            js_discard(js_throw_range_error(ctx, "Invalid array length"));
            return -1;
        }
    }
    if (new_len != old_len && !length_writable(a)) return array_reject(ctx, throw_on_fail, "Cannot assign to read only property 'length' of object '[object Array]'");
    int result = 1;
    if (new_len < old_len) {
        uint32_t stop = js_elements_truncate(ctx, a, new_len);
        if (stop != new_len) {
            new_len = stop;  /* a non-configurable element stopped the deletion */
            result = array_reject(ctx, throw_on_fail, "Cannot delete a non-configurable array element");
        }
    }
    a->cell.aux = new_len;
    if (make_frozen) a->cell.flags |= ARRAY_LENGTH_FROZEN;
    return result;
}

static int array_define(JSContext *ctx, JSObject *a, JSValue key, const JSPropertyDescriptor *desc, bool throw_on_fail) {
    if (is_length(key)) return array_set_length(ctx, a, desc, throw_on_fail);
    if (!js_key_is_index(key)) return JS_ORDINARY;
    uint32_t i = js_key_index(key);
    uint32_t len = js_array_length(a);
    if (i >= len && !length_writable(a)) return array_reject(ctx, throw_on_fail, "Cannot add property to an array with a read-only length");
    int r = js_ordinary_define_own_property(ctx, a, key, desc, throw_on_fail);
    if (r == 1 && i >= len) a->cell.aux = i + 1;
    return r;
}

static int array_delete(JSContext *ctx, JSObject *a, JSValue key, bool throw_on_fail) {
    (void)a;
    if (!is_length(key)) return JS_ORDINARY;
    return array_reject(ctx, throw_on_fail, "Cannot delete property 'length' of [object Array]");
}

static uint32_t array_extra_keys(JSContext *ctx, JSObject *a, JSValue *out) {
    (void)ctx, (void)a;
    out[0] = JS_ATOM(length);
    return 1;
}

const JSClass js_class_array = {
    "Array", sizeof(JSObject), array_get_own, array_define, array_delete, array_extra_keys, NULL, NULL, NULL,
};

static JSValue array_of_shape(JSContext *ctx, JSShape *shape, uint32_t capacity) {
    JSObject *a = js_alloc_object(ctx, JS_CELL_ARRAY, shape);
    if (capacity) {
        JSElements *e = (JSElements *)js_alloc_cell(ctx, JS_CELL_ELEMENTS, sizeof(JSElements) + (size_t)capacity * sizeof(JSValue));
        e->kind = JS_ELEMENTS_DENSE;
        e->capacity = capacity;
        js_store_ptr(ctx, &a->cell, &a->elements, e);
    }
    return js_object_value(a);
}

static JSValue array_with_proto(JSContext *ctx, JSValue proto, uint32_t capacity) {
    return array_of_shape(ctx, js_shape_root(ctx, &js_class_array, proto, 0), capacity);  /* named properties on arrays are rare */
}

JSValue js_new_array(JSContext *ctx, uint32_t capacity) {
    if (JS_UNLIKELY(!ctx->array_shape)) ctx->array_shape = js_shape_root(ctx, &js_class_array, ctx->intrinsics[JS_INTRINSIC_ARRAY_PROTOTYPE], 0);
    return array_of_shape(ctx, ctx->array_shape, capacity);
}

JSValue js_new_array_from(JSContext *ctx, const JSValue *values, uint32_t n) {
    JSValue v = js_new_array(ctx, n);
    JSObject *a = js_as_object(v);
    if (n == 0) return v;  /* the static empty store: never written */
    for (uint32_t i = 0; i < n; i++) js_init_slot(&a->elements->data[i], values[i]);
    a->elements->length = n;
    a->cell.aux = n;
    return v;
}

int js_array_push(JSContext *ctx, JSObject *a, JSValue v) {
    uint32_t len = js_array_length(a);
    if (len == UINT32_MAX) {
        js_discard(js_throw_type_error(ctx, "Pushing 1 elements on an array-like of length 4294967295 is disallowed"));
        return -1;
    }
    /* the usual case, a dense array without holes at its end: what the define below would do */
    JSElements *e = a->elements;
    if (a->cell.kind == JS_CELL_ARRAY && e->kind == JS_ELEMENTS_DENSE && e->length == len && length_writable(a) && js_is_extensible(a)) {
        js_elements_append_dense(ctx, a, v);
        a->cell.aux = len + 1;
        return 1;
    }
    JSPropertyDescriptor d = js_data_descriptor(v, JS_PROP_DEFAULT);
    return js_define_own_property(ctx, a, js_index_key(len), &d, true);
}

static const char *const SARRAY_KINDS[] = { "number", "string", "boolean" };

static JSValue sarray_not_array(JSContext *ctx, int kind) {
    return js_throw_type_error(ctx, "A %s[] of static code isn't an array", SARRAY_KINDS[kind]);
}

static JSValue sarray_out_of_range(JSContext *ctx, int64_t i, uint32_t len) {
    if (i < 0) return js_throw_range_error(ctx, "Invalid array index for length %u", len);
    return js_throw_range_error(ctx, "Index %lld is out of range for length %u", (long long)i, len);
}

JSValue js_sarray_get_slow(JSContext *ctx, JSValue arr, int64_t i, int kind) {
    if (!js_is_array(arr)) return sarray_not_array(ctx, kind);
    uint32_t len = js_array_length(js_as_object(arr));
    if (i < 0 || i >= len) return sarray_out_of_range(ctx, i, len);
    /* a hole, a sparse store: the element as JavaScript reads it, which may be of another kind */
    JSValue v = js_get_elem(ctx, arr, js_number((double)i));
    if (js_is_exception(v) || js_sarray_is(v, kind)) return v;
    return js_throw_type_error(ctx, "Element %lld of a %s[] isn't a %s", (long long)i, SARRAY_KINDS[kind], SARRAY_KINDS[kind]);
}

int js_sarray_set_slow(JSContext *ctx, JSValue arr, int64_t i, JSValue v, int kind) {
    JSValue error = !js_is_array(arr) ? sarray_not_array(ctx, kind)
        : !js_sarray_is(v, kind) ? js_throw_type_error(ctx, "A %s[]'s element can't be another type", SARRAY_KINDS[kind])
        : JS_UNDEFINED;
    if (js_is_exception(error)) return -1;
    uint32_t len = js_array_length(js_as_object(arr));
    if (i == len) return js_array_push(ctx, js_as_object(arr), v);
    if (i < 0 || i > len) {
        js_discard(sarray_out_of_range(ctx, i, len));
        return -1;
    }
    return js_set_elem(ctx, arr, js_number((double)i), v, true);
}

JSValue js_sarray_length_slow(JSContext *ctx, JSValue arr) {
    if (!js_is_array(arr)) return sarray_not_array(ctx, JS_SARRAY_NUMBER);
    return js_throw_range_error(ctx, "A static array's length is below 2^31");
}

JSValue js_sarray_push_slow(JSContext *ctx, JSValue arr, JSValue v, int kind) {
    if (js_sarray_set_slow(ctx, arr, js_is_array(arr) ? js_array_length(js_as_object(arr)) : 0, v, kind) < 0) return JS_EXCEPTION;
    return js_sarray_length(ctx, arr);
}

int js_array_append(JSContext *ctx, JSValue arr, JSValue v) {
    JSObject *a = js_as_object(arr);
    if (!js_is_empty(v)) return js_array_push(ctx, a, v);
    /* a hole: only the length grows */
    uint32_t len = js_array_length(a);
    if (len == UINT32_MAX) {
        js_discard(js_throw_range_error(ctx, "Invalid array length"));
        return -1;
    }
    return js_set_value(ctx, arr, JS_ATOM(length), js_number((double)len + 1), true);
}

int js_array_spread(JSContext *ctx, JSValue arr, JSValue v) {
    /* every value of v's iterator (arrays and strings take the protocol's fast path) */
    JSValue rec = js_iter_start(ctx, v);
    if (js_is_exception(rec)) return -1;
    for (;;) {
        JSValue e = js_iter_next(ctx, rec);
        if (js_is_exception(e)) return -1;
        if (js_is_empty(e)) return 0;
        if (js_array_push(ctx, js_as_object(arr), e) < 0) return -1;
    }
}

void js_define_accessor(JSContext *ctx, JSObject *o, JSValue key, JSValue get, JSValue set) {
    JSPropertyDescriptor d = { JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE, JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE,
                               JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    if (!js_is_empty(get)) {
        d.has |= JS_DESC_GET;
        d.get = get;
    }
    if (!js_is_empty(set)) {
        d.has |= JS_DESC_SET;
        d.set = set;
    }
    int r = js_define_own_property(ctx, o, key, &d, false);  /* a literal's own new object: can't fail */
    (void)r;
}

/* ---- Values of any type ----------------------------------------------------------- */

static JSValue nullish_error(JSContext *ctx, JSValue obj, JSValue key, const char *verb) {
    char name[128];
    describe(ctx, key, name, sizeof name);
    return js_throw_type_error(ctx, "Cannot %s properties of %s (%s '%s')", verb,
                               js_is_null(obj) ? "null" : "undefined", verb[0] == 'r' ? "reading" : "setting", name);
}

JSObject *js_primitive_prototype(JSContext *ctx, JSValue v) {
    JSIntrinsic i = js_is_string(v) ? JS_INTRINSIC_STRING_PROTOTYPE
                  : js_is_bool(v)   ? JS_INTRINSIC_BOOLEAN_PROTOTYPE
                  : js_is_symbol(v) ? JS_INTRINSIC_SYMBOL_PROTOTYPE
                  : js_is_bigint(v) ? JS_INTRINSIC_BIGINT_PROTOTYPE
                                    : JS_INTRINSIC_NUMBER_PROTOTYPE;
    return js_as_object(ctx->intrinsics[i]);
}

/* A string's own properties (§10.4.3): its length and one-unit strings at its indices. */
static bool string_own(JSContext *ctx, JSValue s, JSValue key, JSValue *out) {
    uint32_t len = js_string_length(s);
    if (js_same_bits(key, JS_ATOM(length))) {
        *out = js_int32((int32_t)len);
        return true;
    }
    if (js_key_is_index(key) && js_key_index(key) < len) {
        uint32_t i = js_key_index(key);
        *out = js_substring(ctx, s, i, i + 1);
        return true;
    }
    return false;
}

JSValue js_get_value(JSContext *ctx, JSValue obj, JSValue key) {
    if (js_is_object(obj)) return js_key_is_index(key) ? js_get(ctx, js_as_object(obj), key, obj) : js_get_prop_slow(ctx, obj, key, NULL);
    if (js_is_nullish(obj)) return nullish_error(ctx, obj, key, "read");
    JSValue v;
    if (js_is_string(obj) && string_own(ctx, obj, key, &v)) return v;
    return js_get(ctx, js_primitive_prototype(ctx, obj), key, obj);  /* getters see the primitive as `this` */
}

int js_set_value(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict) {
    if (js_is_object(obj)) return js_key_is_index(key) ? js_set(ctx, js_as_object(obj), key, v, obj, strict) : js_set_prop_slow(ctx, obj, key, v, strict, NULL);
    if (js_is_nullish(obj)) {
        js_discard(nullish_error(ctx, obj, key, "set"));
        return -1;
    }
    JSValue own;
    if (js_is_string(obj) && string_own(ctx, obj, key, &own)) return reject(ctx, strict, "assign to read only", key);
    /* OrdinarySet with a primitive receiver: setters run, data properties can't be created */
    return js_set(ctx, js_primitive_prototype(ctx, obj), key, v, obj, strict);
}

/* ---- Inline caches ------------------------------------------------------------------ */

void js_register_prop_caches(JSRuntime *rt, JSPropCache *ics, size_t n) {
    JSPropCacheTables *t = &rt->prop_caches;
    if (t->count == t->cap) {
        t->cap = t->cap ? t->cap * 2 : 8;
        t->tables = realloc(t->tables, t->cap * sizeof *t->tables);
        if (!t->tables) js_fatal("out of memory registering inline caches");
    }
    t->tables[t->count].ics = ics;
    t->tables[t->count].n = n;
    t->count++;
}

/* Weak processing: a cache that refers to a dead shape or holder is emptied. */
#define MEGA_SIZE 2048  /* entries per table: 2^11 (mega_entry takes the hash's top 11 bits) */

typedef struct JSMegaEntry {
    JSValue     key;
    JSPropCache c;
} JSMegaEntry;

static JSMegaEntry *mega_entry(JSMegaEntry **table, JSShape *shape, JSValue key) {
    if (!*table) {
        *table = calloc(MEGA_SIZE, sizeof **table);
        if (!*table) js_fatal("out of memory allocating the property cache");
    }
    /* Fibonacci hashing of both: the top bits depend on every input bit (shapes differ in low ones) */
    uint64_t h = (((uint64_t)(uintptr_t)shape >> 4) ^ (key.bits * UINT64_C(0xC2B2AE3D27D4EB4F))) * UINT64_C(0x9E3779B97F4A7C15);
    return &(*table)[h >> 53];  /* 64 - log2(MEGA_SIZE) */
}

void js_prop_caches_sweep(JSRuntime *rt) {
    /* the shared caches hold shapes and holders unmarked: emptied, not swept */
    if (rt->mega_get) memset(rt->mega_get, 0, MEGA_SIZE * sizeof *rt->mega_get);
    if (rt->mega_set) memset(rt->mega_set, 0, MEGA_SIZE * sizeof *rt->mega_set);
    if (rt->mega_define) memset(rt->mega_define, 0, MEGA_SIZE * sizeof *rt->mega_define);
    for (size_t t = 0; t < rt->prop_caches.count; t++) {
        struct JSPropCacheTable *table = &rt->prop_caches.tables[t];
        for (size_t i = 0; i < table->n; i++) {
            JSPropCache *ic = &table->ics[i];
            if (ic->kind == JS_IC_EMPTY) continue;
            bool live = js_gc_is_marked(&ic->shape->cell);
            if ((ic->kind == JS_IC_PROTO || ic->kind == JS_IC_GETTER) && ic->holder) live = live && js_gc_is_marked(&ic->holder->cell);
            if (ic->kind == JS_IC_ADD) live = live && js_gc_is_marked(&ic->next->cell);
            for (unsigned d = 0; live && d < ic->depth; d++) live = js_gc_is_marked(&ic->chain[d]->cell);
            if (!live) memset(ic, 0, sizeof *ic);
        }
    }
}

void js_prop_caches_free(JSRuntime *rt) {
    free(rt->mega_get);
    free(rt->mega_set);
    free(rt->mega_define);
    rt->mega_get = rt->mega_set = rt->mega_define = NULL;
    free(rt->prop_caches.tables);
    memset(&rt->prop_caches, 0, sizeof rt->prop_caches);
}

/* js_define_data of a new key with default attributes: a transition from o's shape remembered
 * by remember_define. The shape fixes the class (no define hook), extensibility and that the key
 * isn't there yet, so the define would add it the same way. */
static bool define_cached(JSContext *ctx, JSObject *o, JSValue key, JSValue value) {
    JSMegaEntry *m = mega_entry(&ctx->rt->mega_define, o->shape, key);
    if (m->c.shape != o->shape || !js_same_bits(m->key, key)) return false;
    JSShape *next = m->c.next;  /* on the stack: kept alive if ensure_slot collects */
    ensure_slot(ctx, o, o->shape->prop_count);
    js_object_set_shape(ctx, o, next);
    js_store(ctx, &o->cell, js_object_slot(o, next->prop_count - 1), value);
    return true;
}

static void remember_define(JSContext *ctx, JSShape *before, JSObject *o, JSValue key) {
    if (before->cls->define_own_property || is_dictionary(o) || o->shape->parent != before || !js_same_bits(o->shape->key, key) ||
        o->shape->attrs != JS_PROP_DEFAULT)
        return;
    JSMegaEntry *m = mega_entry(&ctx->rt->mega_define, before, key);
    m->key = key;
    m->c = (JSPropCache){ .kind = JS_IC_ADD, .shape = before, .next = o->shape };
}

/* A cache with its inline fast path set: `fast` for an OWN cache whose slot is inline. */
static JSPropCache with_fast_path(JSPropCache c) {
    if (c.kind == JS_IC_OWN && c.slot < c.shape->inline_cap) {
        uint32_t off = c.shape->slot_offset + c.slot * (uint32_t)sizeof(JSValue);
        if (off <= UINT16_MAX) {
            c.fast = c.shape;
            c.fast_off = (uint16_t)off;
        }
    }
    return c;
}

/* Whether the prototypes after ic->shape still have the shapes the cache saw. */
/* A cache's prototypes are as it saw them: at the epoch it remembers no prototype has changed
 * shape since; else walk the chain, and remember the epoch it still holds at. */
static bool chain_holds(JSContext *ctx, JSPropCache *ic) {
    if (ic->epoch == ctx->rt->proto_epoch) return true;
    if (!js_prop_cache_chain_holds(ic)) return false;
    ic->epoch = ctx->rt->proto_epoch;
    return true;
}

/* Where a named key is along o's prototype chain, and whether caches may remember it. */
typedef struct Lookup {
    JSObject *holder;                  /* NULL: not found (the chain ended) */
    int32_t   slot;
    uint8_t   attrs;
    bool      cacheable;               /* no dictionaries, no exotic answers, not too deep */
    bool      exotic;                  /* a class hook answered: use the generic path */
    uint8_t   depth;
    JSShape  *chain[JS_IC_MAX_DEPTH];
} Lookup;

static void lookup(JSContext *ctx, JSObject *o, JSValue key, Lookup *l) {
    memset(l, 0, sizeof *l);
    l->cacheable = true;
    for (JSObject *h = o;;) {
        if (METHOD(h, target)) {  /* a proxy: its traps run on the generic path */
            l->exotic = true;
            return;
        }
        if (h->shape->cls->get_own_property) {
            JSPropertyDescriptor d;
            int r = h->shape->cls->get_own_property(ctx, h, key, &d);  /* may change h's shape */
            if (r == JS_ORDINARY_UNCACHED) l->cacheable = false;
            else if (r != JS_ORDINARY) {
                l->exotic = true;
                return;
            }
        }
        if (is_dictionary(h)) l->cacheable = false;
        l->slot = find_own(h, key, &l->attrs);
        if (l->slot >= 0) {
            l->holder = h;
            return;
        }
        JSValue proto = h->shape->proto;
        if (!js_is_object(proto)) return;
        h = js_as_object(proto);
        if (l->depth == JS_IC_MAX_DEPTH) l->cacheable = false;
        else l->chain[l->depth++] = h->shape;
    }
}

/* A cached get that still holds for o: true with the value (or JS_EXCEPTION from a getter). */
static bool cached_get(JSContext *ctx, JSObject *o, JSValue receiver, JSPropCache *c, JSValue *out) {
    if (c->shape != o->shape) return false;
    switch (c->kind) {
    case JS_IC_OWN: *out = *js_object_slot(o, c->slot); return true;
    case JS_IC_PROTO:
        if (!chain_holds(ctx, c)) return false;
        *out = *js_object_slot(c->holder, c->slot);
        return true;
    case JS_IC_GETTER: {
        if (!chain_holds(ctx, c)) return false;
        JSAccessorPair *p = (JSAccessorPair *)js_as_cell(*js_object_slot(c->holder ? c->holder : o, c->slot));
        *out = js_is_undefined(p->get) ? JS_UNDEFINED : call_accessor(ctx, p->get, receiver, 0, JS_UNDEFINED);
        return true;
    }
    case JS_IC_ABSENT:
        if (!chain_holds(ctx, c)) return false;
        *out = JS_UNDEFINED;
        return true;
    default: return false;
    }
}

JSValue js_get_prop_slow(JSContext *ctx, JSValue obj, JSValue key, JSPropCache *ic) {
    JS_ASSERT_NOT_EXC(obj);
    JSValue v;
    /* first: the site's cache, missed inline (a prototype's property, or an out-of-line slot's).
     * A site's key is one name: its cache never holds an index */
    if (ic && js_is_object(obj) && cached_get(ctx, js_as_object(obj), obj, ic, &v)) return v;
    if (js_key_is_index(key) || js_is_nullish(obj) || (js_is_string(obj) && is_length(key))) return js_get_value(ctx, obj, key);
    /* a primitive's named property (s.charCodeAt) is its prototype's: a string's own properties
     * are only its indices and length. The prototype is cached like an object, the primitive
     * still the receiver of a getter. */
    JSObject *o = js_is_object(obj) ? js_as_object(obj) : js_primitive_prototype(ctx, obj);
    if (ic && !js_is_object(obj) && cached_get(ctx, o, obj, ic, &v)) return v;
    if (o->cell.kind == JS_CELL_ARRAY && is_length(key)) return js_number((double)js_array_length(o));
    JSMegaEntry *m = mega_entry(&ctx->rt->mega_get, o->shape, key);
    if (js_same_bits(m->key, key) && cached_get(ctx, o, obj, &m->c, &v)) {
        if (ic) *ic = m->c;
        return v;
    }
    Lookup l;
    uint32_t epoch = ctx->rt->proto_epoch;  /* the chain as the lookup sees it */
    lookup(ctx, o, key, &l);
    if (l.exotic) return js_get(ctx, o, key, obj);
    if (l.cacheable) {
        uint8_t kind = !l.holder ? JS_IC_ABSENT : (l.attrs & JS_PROP_ACCESSOR) ? JS_IC_GETTER : l.holder == o ? JS_IC_OWN : JS_IC_PROTO;
        JSObject *holder = kind == JS_IC_ABSENT || l.holder == o ? NULL : l.holder;
        JSPropCache c = { .kind = kind, .depth = l.depth, .slot = l.holder ? (uint32_t)l.slot : 0, .shape = o->shape, .holder = holder, .epoch = epoch };
        memcpy(c.chain, l.chain, sizeof c.chain);
        c = with_fast_path(c);
        if (ic) *ic = c;
        m->key = key;
        m->c = c;
    }
    if (!l.holder) return JS_UNDEFINED;
    if (l.attrs & JS_PROP_ACCESSOR) {
        JSAccessorPair *p = (JSAccessorPair *)js_as_cell(*js_object_slot(l.holder, (uint32_t)l.slot));
        return js_is_undefined(p->get) ? JS_UNDEFINED : call_accessor(ctx, p->get, obj, 0, JS_UNDEFINED);
    }
    return *js_object_slot(l.holder, (uint32_t)l.slot);
}

int js_set_prop_slow(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict, JSPropCache *ic) {
    JS_ASSERT_NOT_EXC(obj);
    JS_ASSERT_NOT_EXC(v);
    if (!js_is_object(obj) || js_key_is_index(key)) return js_set_value(ctx, obj, key, v, strict);
    JSPropCache none;  /* no site (a computed key): only the shared cache */
    if (!ic) {
        none.kind = JS_IC_EMPTY;
        ic = &none;
    }
    JSObject *o = js_as_object(obj);
    if (ic->kind == JS_IC_ADD && o->shape == ic->shape && chain_holds(ctx, ic)) {
        JSShape *next = ic->next;  /* on the stack: kept alive if ensure_slot collects */
        ensure_slot(ctx, o, o->shape->prop_count);
        js_object_set_shape(ctx, o, next);
        js_store(ctx, &o->cell, js_object_slot(o, next->prop_count - 1), v);
        return 1;
    }
    JSMegaEntry *m = mega_entry(&ctx->rt->mega_set, o->shape, key);
    if (js_same_bits(m->key, key) && m->c.shape == o->shape) {
        if (m->c.kind == JS_IC_OWN) {
            *ic = m->c;
            js_store(ctx, &o->cell, js_object_slot(o, m->c.slot), v);
            return 1;
        }
        if (m->c.kind == JS_IC_ADD && chain_holds(ctx, &m->c)) {
            *ic = m->c;
            JSShape *next = m->c.next;
            ensure_slot(ctx, o, o->shape->prop_count);
            js_object_set_shape(ctx, o, next);
            js_store(ctx, &o->cell, js_object_slot(o, next->prop_count - 1), v);
            return 1;
        }
    }
    Lookup l;
    uint32_t epoch = ctx->rt->proto_epoch;  /* the chain as the lookup sees it */
    lookup(ctx, o, key, &l);
    JSShape *before = o->shape;
    bool cacheable = l.cacheable && !l.exotic;
    if (cacheable && l.holder == o && (l.attrs & (JS_PROP_WRITABLE | JS_PROP_ACCESSOR)) == JS_PROP_WRITABLE) {
        JSPropCache c = with_fast_path((JSPropCache){ .kind = JS_IC_OWN, .slot = (uint32_t)l.slot, .shape = before });
        *ic = c;
        m->key = key;
        m->c = c;
        js_store(ctx, &o->cell, js_object_slot(o, (uint32_t)l.slot), v);
        return 1;
    }
    int r = js_set(ctx, o, key, v, obj, strict);
    /* a plain add (no setter or read-only property on the chain, or a prototype's writable data
     * property it shadows, as EventEmitter.prototype._events): remember the transition */
    bool shadows = l.holder && l.holder != o && (l.attrs & (JS_PROP_WRITABLE | JS_PROP_ACCESSOR)) == JS_PROP_WRITABLE;
    if (r == 1 && cacheable && (!l.holder || shadows) && !before->cls->define_own_property && !is_dictionary(o) &&
        o->shape->parent == before && js_same_bits(o->shape->key, key)) {
        JSPropCache c = { .kind = JS_IC_ADD, .depth = l.depth, .shape = before, .next = o->shape, .epoch = epoch };
        memcpy(c.chain, l.chain, sizeof c.chain);
        *ic = c;
        m = mega_entry(&ctx->rt->mega_set, before, key);  /* js_set may have collected: the table was emptied, not moved */
        m->key = key;
        m->c = c;
    }
    return r;
}

/* ---- Generated code: computed keys, delete, literals --------------------------------- */

/* Whether `key` can be a keyed site's: a property key as it is (a symbol, an interned string
 * that isn't an index), so that the same bits mean the same key. Makes the site its. */
static bool take_site_key(JSContext *ctx, JSValue key, JSValue *site, JSPropCache *ic) {
    if (!js_is_symbol(key) && !(js_is_string(key) && js_is_atom(key))) return false;
    JSValue k = js_to_property_key(ctx, key);  /* a primitive: no user code */
    if (!js_same_bits(k, key) || js_key_is_index(k)) return false;
    memset(ic, 0, sizeof *ic);  /* its entries were for the old key */
    *site = key;
    return true;
}

JSValue js_get_keyed_slow(JSContext *ctx, JSValue obj, JSValue key, JSValue *site, JSPropCache *ic) {
    if (take_site_key(ctx, key, site, ic)) return js_get_prop(ctx, obj, key, ic);
    return js_get_elem(ctx, obj, key);
}

int js_set_keyed_slow(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict, JSValue *site, JSPropCache *ic) {
    if (take_site_key(ctx, key, site, ic)) return js_set_prop(ctx, obj, key, v, strict, ic);
    return js_set_elem(ctx, obj, key, v, strict);
}

JSValue js_get_elem(JSContext *ctx, JSValue obj, JSValue key) {
    JS_ASSERT_NOT_EXC(obj);
    JS_ASSERT_NOT_EXC(key);
    JSValue elem;  /* a typed array's element: the component reads it inline */
    if (js_is_int32(key) && ctx->rt->typed_array_get && ctx->rt->typed_array_get(obj, js_as_int32(key), &elem)) return elem;
    if (js_is_nullish(obj)) {
        JSValue k = js_is_object(key) ? key : js_to_property_key(ctx, key);  /* primitives only: no user code */
        if (js_is_exception(k)) return JS_EXCEPTION;
        return nullish_error(ctx, obj, js_is_object(k) ? js_empty_string() : k, "read");
    }
    JSValue k = js_to_property_key(ctx, key);
    if (js_is_exception(k)) return JS_EXCEPTION;
    return js_get_value(ctx, obj, k);
}

int js_set_elem(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict) {
    JS_ASSERT_NOT_EXC(v);
    /* a Number into a typed array's element: no ToNumber code to run, the component stores it inline */
    if (js_is_int32(key) && js_is_number(v) && ctx->rt->typed_array_set && ctx->rt->typed_array_set(obj, js_as_int32(key), js_as_number(v))) return 1;
    if (js_is_nullish(obj)) {
        JSValue k = js_is_object(key) ? js_empty_string() : js_to_property_key(ctx, key);
        if (js_is_exception(k)) return -1;
        js_discard(nullish_error(ctx, obj, k, "set"));
        return -1;
    }
    JSValue k = js_to_property_key(ctx, key);
    if (js_is_exception(k)) return -1;
    return js_set_value(ctx, obj, k, v, strict);
}

JSValue js_delete_value(JSContext *ctx, JSValue obj, JSValue key, bool strict) {
    if (js_is_nullish(obj)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    if (js_is_object(obj)) {
        int r = js_delete_property(ctx, js_as_object(obj), key, strict);
        return r < 0 ? JS_EXCEPTION : js_bool(r);
    }
    /* a primitive's own properties (a string's length and indices) can't be deleted */
    JSValue own;
    if (js_is_string(obj) && string_own(ctx, obj, key, &own)) {
        if (!strict) return JS_FALSE;
        return reject(ctx, true, "delete", key) < 0 ? JS_EXCEPTION : JS_FALSE;
    }
    return JS_TRUE;  /* deleting from the wrapper object ToObject would create */
}

JSValue js_delete_elem(JSContext *ctx, JSValue obj, JSValue key, bool strict) {
    if (js_is_nullish(obj)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    JSValue k = js_to_property_key(ctx, key);
    if (js_is_exception(k)) return JS_EXCEPTION;
    return js_delete_value(ctx, obj, k, strict);
}

void js_literal_set_proto(JSContext *ctx, JSValue obj, JSValue v) {
    if (!js_is_object(v) && !js_is_null(v)) return;
    int r = js_set_prototype_of(ctx, js_as_object(obj), v);  /* a fresh extensible object: can't fail */
    (void)r;
}

/* ---- Private names (§6.2.12, §7.3.31–7.3.33) -------------------------------------- */

JSValue js_new_private_name(JSContext *ctx, JSValue description) {
    /* a fresh flat string, never interned: unique by identity, so a key only its class can name.
     * "#x" has at least two units, so it's never one of the shared static one-unit strings. */
    JSValue s = js_new_string_view(ctx, js_string_view(ctx, description));
    if (js_is_exception(s)) return JS_EXCEPTION;
    js_as_cell(s)->flags |= JS_STR_PRIVATE;
    return s;
}

static void private_error(JSContext *ctx, const char *fmt, JSValue name) {
    char buf[128];
    describe(ctx, name, buf, sizeof buf);
    js_discard(js_throw_type_error(ctx, fmt, buf));
}

/* PrivateElementFind: the object's own element, or -1 (TypeError thrown: `what`). */
static int32_t private_find(JSContext *ctx, JSValue obj, JSValue name, uint8_t *attrs, const char *what) {
    int32_t slot = js_is_object(obj) ? find_own(js_as_object(obj), name, attrs) : -1;
    if (slot < 0) private_error(ctx, what, name);
    return slot;
}

int js_private_add(JSContext *ctx, JSValue obj, JSValue name, JSValue v, int kind) {
    if (!js_is_object(obj)) {
        private_error(ctx, "Cannot write private member %s to a non-object", name);
        return -1;
    }
    JSObject *o = js_as_object(obj);
    uint8_t attrs;
    int32_t slot = find_own(o, name, &attrs);
    if (slot >= 0) {
        /* a getter and setter of one name are one element: the second half joins the first */
        JSValue cur = *js_object_slot(o, (uint32_t)slot);
        if ((kind == 2 || kind == 3) && (attrs & JS_PROP_ACCESSOR)) {
            JSAccessorPair *p = (JSAccessorPair *)js_as_cell(cur);
            js_store(ctx, &p->cell, kind == 2 ? &p->get : &p->set, v);
            return 0;
        }
        private_error(ctx, "Cannot initialize %s twice on the same object", name);
        return -1;
    }
    /* private elements ignore extensibility (§7.3.31): added directly */
    if (kind == 0) add_own(ctx, o, name, v, JS_PROP_WRITABLE);
    else if (kind == 1) add_own(ctx, o, name, v, 0);
    else add_own(ctx, o, name, new_accessor(ctx, kind == 2 ? v : JS_UNDEFINED, kind == 3 ? v : JS_UNDEFINED), JS_PROP_ACCESSOR);
    return 0;
}

JSValue js_private_get(JSContext *ctx, JSValue obj, JSValue name) {
    uint8_t attrs;
    int32_t slot = private_find(ctx, obj, name, &attrs, "Cannot read private member %s from an object whose class did not declare it");
    if (slot < 0) return JS_EXCEPTION;
    JSValue v = *js_object_slot(js_as_object(obj), (uint32_t)slot);
    if (!(attrs & JS_PROP_ACCESSOR)) return v;
    JSAccessorPair *p = (JSAccessorPair *)js_as_cell(v);
    if (js_is_undefined(p->get)) {
        private_error(ctx, "'%s' was defined without a getter", name);
        return JS_EXCEPTION;
    }
    return js_call(ctx, p->get, obj, 0, NULL);
}

int js_private_set(JSContext *ctx, JSValue obj, JSValue name, JSValue v) {
    uint8_t attrs;
    int32_t slot = private_find(ctx, obj, name, &attrs, "Cannot write private member %s to an object whose class did not declare it");
    if (slot < 0) return -1;
    JSObject *o = js_as_object(obj);
    JSValue *cell = js_object_slot(o, (uint32_t)slot);
    if (!(attrs & JS_PROP_ACCESSOR)) {
        if (!(attrs & JS_PROP_WRITABLE)) {
            private_error(ctx, "Private method %s is not writable", name);
            return -1;
        }
        js_store(ctx, &o->cell, cell, v);
        return 1;
    }
    JSAccessorPair *p = (JSAccessorPair *)js_as_cell(*cell);
    if (js_is_undefined(p->set)) {
        private_error(ctx, "'%s' was defined without a setter", name);
        return -1;
    }
    JSValue r = js_call(ctx, p->set, obj, 1, &v);
    return js_is_exception(r) ? -1 : 1;
}

JSValue js_private_in(JSContext *ctx, JSValue name, JSValue obj) {
    if (!js_is_object(obj)) {
        private_error(ctx, "Cannot use 'in' operator to search for '%s' in a non-object", name);
        return JS_EXCEPTION;
    }
    uint8_t attrs;
    return js_bool(find_own(js_as_object(obj), name, &attrs) >= 0);
}

int js_define_field(JSContext *ctx, JSValue obj, JSValue key, JSValue v) {
    JSPropertyDescriptor d = js_data_descriptor(v, JS_PROP_DEFAULT);
    return js_define_own_property(ctx, js_as_object(obj), key, &d, true) < 0 ? -1 : 0;
}

/* ---- Integrity levels and template objects ----------------------------------------------- */

/* SetIntegrityLevel(o, frozen) (§7.3.15): no new properties, every own one non-configurable,
 * and data ones read-only. 0, or -1 with an exception. */
int js_freeze(JSContext *ctx, JSObject *o) {
    if (ctx->rt->typed_array_length && ctx->rt->typed_array_length(js_object_value(o)) > 0) {  /* V8 says so up front */
        js_discard(js_throw_type_error(ctx, "Cannot freeze array buffer views with elements"));
        return -1;
    }
    int r = js_prevent_extensions(ctx, o);
    if (r == 0) js_discard(js_throw_type_error(ctx, "'preventExtensions' on proxy: trap returned falsish"));  /* only proxies say no */
    if (r <= 0) return -1;
    JSValue keys = js_own_keys(ctx, o);
    if (js_is_exception(keys)) return -1;
    JSValueArray *list = (JSValueArray *)js_as_cell(keys);
    for (uint32_t i = 0; i < list->cell.aux; i++) {
        JSPropertyDescriptor current;
        int has = js_get_own_property(ctx, o, list->values[i], &current);
        if (has < 0) return -1;
        if (!has) continue;
        JSPropertyDescriptor d = { JS_DESC_CONFIGURABLE, 0, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
        if (current.has & JS_DESC_VALUE) d.has |= JS_DESC_WRITABLE;  /* a data property: also read-only */
        if (js_define_own_property(ctx, o, list->values[i], &d, true) < 0) return -1;
    }
    js_keep_alive(keys);
    return 0;
}

/* GetTemplateObject (§13.2.8.4): the site's frozen array of cooked strings with its frozen
 * `raw`, created on the first evaluation and kept in *cache (a module slot). */
JSValue js_template_object(JSContext *ctx, JSValue *cache, uint32_t n, const JSValue *cooked, const JSValue *raw) {
    if (js_is_object(*cache)) return *cache;
    JSValue template = js_new_array_from(ctx, cooked, n);
    if (js_is_exception(template)) return template;
    JSValue raw_obj = js_new_array_from(ctx, raw, n);
    if (js_is_exception(raw_obj) || js_freeze(ctx, js_as_object(raw_obj)) < 0) return JS_EXCEPTION;
    JSValue key = js_atom_from_cstr(ctx, "raw");
    if (js_is_exception(key)) return key;
    js_define_data(ctx, js_as_object(template), key, raw_obj, 0);
    if (js_freeze(ctx, js_as_object(template)) < 0) return JS_EXCEPTION;
    *cache = template;
    return template;
}
