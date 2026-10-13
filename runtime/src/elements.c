/* Indexed properties: dense JSValue storage with EMPTY holes, or a
 * sparse table; objects start on the static empty store. */
#include "elements.h"

#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "jscontext.h"

static JSSparseElements *as_sparse(JSElements *e) { return (JSSparseElements *)e; }
static bool is_sparse(JSObject *o) { return o->elements->kind == JS_ELEMENTS_SPARSE; }

/* ---- Dense ---------------------------------------------------------------- */

static JSElements *alloc_dense(JSContext *ctx, uint32_t capacity) {
    JSElements *e = (JSElements *)js_alloc_cell(ctx, JS_CELL_ELEMENTS, sizeof(JSElements) + (size_t)capacity * sizeof(JSValue));
    e->kind = JS_ELEMENTS_DENSE;
    e->capacity = capacity;  /* zero-filled: every slot a hole */
    return e;
}

/* Makes dense capacity for index i, copying the present elements. */
static void grow_dense(JSContext *ctx, JSObject *o, uint32_t i) {
    JSElements *old = o->elements;
    uint32_t cap = old->capacity < 4 ? 4 : old->capacity + old->capacity / 2;  /* ×1.5 */
    if (cap <= i) cap = i + 1;
    JSElements *e = alloc_dense(ctx, cap);
    old = o->elements;  /* unchanged, but re-read after the allocation */
    memcpy(e->data, old->data, (size_t)old->length * sizeof(JSValue));
    e->length = old->length;
    js_store_ptr(ctx, &o->cell, &o->elements, e);
}

void js_elements_append_dense(JSContext *ctx, JSObject *o, JSValue v) {
    uint32_t i = o->elements->length;
    if (i >= o->elements->capacity) grow_dense(ctx, o, i);
    JSElements *d = o->elements;
    js_store(ctx, &d->cell, &d->data[i], v);
    d->length = i + 1;
}

/* Array.prototype.fill's fast path: stores v at [start, end) of an array, directly, when that
 * is what the generic loop of [[Set]]s would do. That needs an extensible array with dense
 * elements, end within its length, and prototypes that can't intercept an index: ordinary
 * objects or arrays without elements (a hole's [[Set]] would find their setters). 1 done, 0 not
 * applicable. */
int js_elements_fill(JSContext *ctx, JSObject *o, uint32_t start, uint32_t end, JSValue v) {
    if (o->cell.kind != JS_CELL_ARRAY || is_sparse(o) || !(o->shape->flags & JS_SHAPE_EXTENSIBLE)) return 0;
    if (start >= end || end > js_array_length(o) || start > o->elements->length + JS_SPARSE_GAP) return 0;
    for (JSValue p = o->shape->proto; js_is_object(p); p = js_as_object(p)->shape->proto) {
        JSObject *q = js_as_object(p);
        if (q->shape->cls != &js_class_object && q->shape->cls != &js_class_array) return 0;
        if (q->elements->kind != JS_ELEMENTS_DENSE || q->elements->length != 0) return 0;
    }
    if (end > o->elements->capacity) grow_dense(ctx, o, end - 1);
    JSElements *d = o->elements;
    for (uint32_t i = start; i < end; i++) js_store(ctx, &d->cell, &d->data[i], v);
    if (end > d->length) d->length = end;
    return 1;
}

/* ---- Sparse ------------------------------------------------------------------ */

static uint32_t index_hash(uint32_t i) {
    return (uint32_t)(((uint64_t)i * UINT64_C(0x9E3779B97F4A7C15)) >> 32);
}

static JSSparseEntry *sparse_find(JSSparseElements *s, uint32_t i) {
    for (uint32_t h = index_hash(i) & (s->cap - 1);; h = (h + 1) & (s->cap - 1)) {
        JSSparseEntry *e = &s->entries[h];
        if (e->state == 0) return NULL;
        if (e->state == 1 && e->index == i) return e;
    }
}

/* A sparse table's entries are the heap's external memory. */
static void sparse_rehash(JSContext *ctx, JSSparseElements *s, uint32_t cap) {
    JSSparseEntry *old = s->entries;
    uint32_t old_cap = s->cap;
    s->entries = calloc(cap, sizeof *s->entries);
    if (!s->entries) js_fatal("out of memory (sparse elements)");
    js_gc_external_add(ctx->rt, (size_t)cap * sizeof *s->entries);
    js_gc_external_sub(ctx->rt, (size_t)old_cap * sizeof *s->entries);
    s->cap = cap;
    s->tombstones = 0;
    for (uint32_t k = 0; k < old_cap; k++) {
        if (old[k].state != 1) continue;
        uint32_t h = index_hash(old[k].index) & (cap - 1);
        while (s->entries[h].state) h = (h + 1) & (cap - 1);
        s->entries[h] = old[k];  /* barrier: same owner */
    }
    free(old);
}

static JSSparseEntry *sparse_insert(JSContext *ctx, JSSparseElements *s, uint32_t i) {
    if (2 * (s->count + s->tombstones + 1) > s->cap) sparse_rehash(ctx, s, s->count * 4 + 16 > s->cap ? s->cap * 2 : s->cap);
    uint32_t h = index_hash(i) & (s->cap - 1);
    while (s->entries[h].state == 1) h = (h + 1) & (s->cap - 1);
    if (s->entries[h].state == 2) s->tombstones--;
    JSSparseEntry *e = &s->entries[h];
    *e = (JSSparseEntry){ i, 1, 0, 0, JS_UNDEFINED };
    s->count++;
    return e;
}

/* Replaces the object's elements with a sparse table of the same contents. */
static JSSparseElements *to_sparse(JSContext *ctx, JSObject *o) {
    if (is_sparse(o)) return as_sparse(o->elements);
    JSSparseElements *s = (JSSparseElements *)js_alloc_cell(ctx, JS_CELL_ELEMENTS, sizeof(JSSparseElements));
    s->cell.flags |= JS_CELL_FINALIZABLE;
    js_block_of(s)->has_finalizable = 1;
    s->kind = JS_ELEMENTS_SPARSE;
    s->cap = 16;
    s->entries = calloc(s->cap, sizeof *s->entries);
    if (!s->entries) js_fatal("out of memory (sparse elements)");
    js_gc_external_add(ctx->rt, (size_t)s->cap * sizeof *s->entries);
    JSElements *d = o->elements;
    for (uint32_t i = 0; i < d->length; i++) {
        if (js_is_empty(d->data[i])) continue;
        JSSparseEntry *e = sparse_insert(ctx, s, i);
        e->attrs = JS_PROP_DEFAULT;
        e->value = d->data[i];
    }
    js_store_ptr(ctx, &o->cell, &o->elements, (JSElements *)s);
    return s;
}

void js_elements_finalize(JSRuntime *rt, JSCell *c) {
    JSElements *e = (JSElements *)c;
    if (e->kind != JS_ELEMENTS_SPARSE) return;
    js_gc_external_sub(rt, (size_t)as_sparse(e)->cap * sizeof *as_sparse(e)->entries);
    free(as_sparse(e)->entries);
}

/* ---- Operations -------------------------------------------------------------- */

static JSPropertyDescriptor entry_descriptor(uint8_t attrs, JSValue v) {
    if (attrs & JS_PROP_ACCESSOR) {
        JSAccessorPair *p = (JSAccessorPair *)js_as_cell(v);
        return (JSPropertyDescriptor){ JS_DESC_GET | JS_DESC_SET | JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE,
                                       (uint8_t)(attrs & (JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE)), JS_UNDEFINED, p->get, p->set };
    }
    return js_data_descriptor(v, attrs);
}

int js_elements_get_own(JSContext *ctx, JSObject *o, uint32_t i, JSPropertyDescriptor *out) {
    (void)ctx;
    JSElements *d = o->elements;
    if (d->kind == JS_ELEMENTS_DENSE) {
        if (i >= d->length || js_is_empty(d->data[i])) return 0;
        *out = js_data_descriptor(d->data[i], JS_PROP_DEFAULT);
        return 1;
    }
    JSSparseEntry *e = sparse_find(as_sparse(d), i);
    if (!e) return 0;
    *out = entry_descriptor(e->attrs, e->value);
    return 1;
}

int js_elements_try_store(JSContext *ctx, JSObject *o, uint32_t i, JSValue v) {
    JSElements *d = o->elements;
    if (d->kind == JS_ELEMENTS_DENSE) {
        if (i >= d->length || js_is_empty(d->data[i])) return 0;
        js_store(ctx, &d->cell, &d->data[i], v);
        return 1;
    }
    JSSparseEntry *e = sparse_find(as_sparse(d), i);
    if (!e || (e->attrs & (JS_PROP_WRITABLE | JS_PROP_ACCESSOR)) != JS_PROP_WRITABLE) return 0;
    js_store(ctx, &d->cell, &e->value, v);
    return 1;
}

static int reject(JSContext *ctx, bool throw_on_fail, const char *what, uint32_t i) {
    if (!throw_on_fail) return 0;
    if (strcmp(what, "redefine") == 0) js_discard(js_throw_type_error(ctx, "Cannot redefine property: %u", i));  /* V8's wording */
    else js_discard(js_throw_type_error(ctx, "Cannot %s property '%u'", what, i));
    return -1;
}

static JSValue new_accessor(JSContext *ctx, JSValue get, JSValue set) {
    JSAccessorPair *p = (JSAccessorPair *)js_alloc_cell(ctx, JS_CELL_ACCESSOR, sizeof(JSAccessorPair));
    js_init_slot(&p->get, get);
    js_init_slot(&p->set, set);
    return js_cell(&p->cell);
}

static bool same_value(JSContext *ctx, JSValue a, JSValue b) {
    if (js_is_number(a) && js_is_number(b)) {
        double x = js_as_number(a), y = js_as_number(b);
        if (x != x) return y != y;
        return x == y && (x != 0 || (1 / x == 1 / y));
    }
    if (js_is_string(a) && js_is_string(b)) return js_string_equals(ctx, a, b);
    return js_same_bits(a, b);
}

/* ValidateAndApplyPropertyDescriptor for an element (same rules as named properties). */
int js_elements_define(JSContext *ctx, JSObject *o, uint32_t i, const JSPropertyDescriptor *desc, bool throw_on_fail) {
    bool accessor_desc = (desc->has & (JS_DESC_GET | JS_DESC_SET)) != 0;
    JSPropertyDescriptor cur = { 0, 0, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    int exists = js_elements_get_own(ctx, o, i, &cur);
    uint8_t attrs = 0;
    bool cur_accessor = exists && !(cur.has & JS_DESC_VALUE);
    if (exists) attrs = (uint8_t)(cur.attrs | (cur_accessor ? JS_PROP_ACCESSOR : 0));

    if (!exists) {
        if (!js_is_extensible(o)) return reject(ctx, throw_on_fail, "define", i);
        attrs = 0;
        if ((desc->has & JS_DESC_ENUMERABLE) && (desc->attrs & JS_PROP_ENUMERABLE)) attrs |= JS_PROP_ENUMERABLE;
        if ((desc->has & JS_DESC_CONFIGURABLE) && (desc->attrs & JS_PROP_CONFIGURABLE)) attrs |= JS_PROP_CONFIGURABLE;
        if (!accessor_desc && (desc->has & JS_DESC_WRITABLE) && (desc->attrs & JS_PROP_WRITABLE)) attrs |= JS_PROP_WRITABLE;
    } else if (!(attrs & JS_PROP_CONFIGURABLE)) {
        if ((desc->has & JS_DESC_CONFIGURABLE) && (desc->attrs & JS_PROP_CONFIGURABLE)) return reject(ctx, throw_on_fail, "redefine", i);
        if ((desc->has & JS_DESC_ENUMERABLE) && ((desc->attrs ^ attrs) & JS_PROP_ENUMERABLE)) return reject(ctx, throw_on_fail, "redefine", i);
        bool generic = !accessor_desc && !(desc->has & (JS_DESC_VALUE | JS_DESC_WRITABLE));
        if (!generic && accessor_desc != cur_accessor) return reject(ctx, throw_on_fail, "redefine", i);
        if (cur_accessor) {
            if ((desc->has & JS_DESC_GET) && !js_same_bits(desc->get, cur.get)) return reject(ctx, throw_on_fail, "redefine", i);
            if ((desc->has & JS_DESC_SET) && !js_same_bits(desc->set, cur.set)) return reject(ctx, throw_on_fail, "redefine", i);
        } else if (!(attrs & JS_PROP_WRITABLE)) {
            if ((desc->has & JS_DESC_WRITABLE) && (desc->attrs & JS_PROP_WRITABLE)) return reject(ctx, throw_on_fail, "redefine", i);
            if ((desc->has & JS_DESC_VALUE) && !same_value(ctx, desc->value, cur.value)) return reject(ctx, throw_on_fail, "redefine", i);
        }
    }

    /* the new attributes and value */
    uint8_t na = attrs;
    JSValue value = exists ? (cur_accessor ? JS_EMPTY : cur.value) : JS_UNDEFINED;
    if (exists) {
        if (desc->has & JS_DESC_ENUMERABLE) na = (uint8_t)((na & ~JS_PROP_ENUMERABLE) | (desc->attrs & JS_PROP_ENUMERABLE));
        if (desc->has & JS_DESC_CONFIGURABLE) na = (uint8_t)((na & ~JS_PROP_CONFIGURABLE) | (desc->attrs & JS_PROP_CONFIGURABLE));
    }
    if (accessor_desc) {
        JSValue get = desc->has & JS_DESC_GET ? desc->get : (cur_accessor ? cur.get : JS_UNDEFINED);
        JSValue set = desc->has & JS_DESC_SET ? desc->set : (cur_accessor ? cur.set : JS_UNDEFINED);
        value = new_accessor(ctx, get, set);
        na = (uint8_t)((na & ~JS_PROP_WRITABLE) | JS_PROP_ACCESSOR);
    } else if (cur_accessor && !(desc->has & (JS_DESC_VALUE | JS_DESC_WRITABLE))) {
        value = new_accessor(ctx, cur.get, cur.set);  /* attributes only */
    } else {
        if (cur_accessor) {
            na = (uint8_t)(na & ~(JS_PROP_ACCESSOR | JS_PROP_WRITABLE));
            value = JS_UNDEFINED;
        }
        if (desc->has & JS_DESC_WRITABLE) na = (uint8_t)((na & ~JS_PROP_WRITABLE) | (desc->attrs & JS_PROP_WRITABLE));
        if (desc->has & JS_DESC_VALUE) value = desc->value;
    }

    /* store: dense only for plain writable-enumerable-configurable data */
    if (na == JS_PROP_DEFAULT && !is_sparse(o)) {
        JSElements *d = o->elements;
        if (i >= d->capacity) {
            /* Counted, not taken from length: holes don't fill a store. Flag enums
             * (E[1] … E[2 ** 30]) double the index on each write, which an upper bound
             * of length never sees as half empty. Only writes past the gap count. */
            if (i > d->length + JS_SPARSE_GAP) {
                uint64_t present = 0;
                for (uint32_t k = 0; k < d->length; k++) present += !js_is_empty(d->data[k]);
                if ((present + 1) * 2 < (uint64_t)i + 1) goto sparse;
            }
            grow_dense(ctx, o, i);
            d = o->elements;
        }
        js_store(ctx, &d->cell, &d->data[i], value);
        if (i >= d->length) d->length = i + 1;
        return 1;
    }
sparse:;
    JSSparseElements *s = to_sparse(ctx, o);
    JSSparseEntry *e = sparse_find(s, i);
    if (!e) e = sparse_insert(ctx, s, i);
    e->attrs = na;
    js_store(ctx, &s->cell, &e->value, value);
    return 1;
}

int js_elements_delete(JSContext *ctx, JSObject *o, uint32_t i, bool throw_on_fail) {
    JSElements *d = o->elements;
    if (d->kind == JS_ELEMENTS_DENSE) {
        if (i < d->length) d->data[i] = JS_EMPTY;  /* a hole; the store stays dense; barrier: not a cell */
        return 1;
    }
    JSSparseEntry *e = sparse_find(as_sparse(d), i);
    if (!e) return 1;
    if (!(e->attrs & JS_PROP_CONFIGURABLE)) return reject(ctx, throw_on_fail, "delete", i);
    e->state = 2;
    e->value = JS_UNDEFINED;
    as_sparse(d)->count--;
    as_sparse(d)->tombstones++;
    return 1;
}

static int cmp_u32(const void *a, const void *b) {
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return x < y ? -1 : x > y;
}

JSValueArray *js_elements_keys(JSContext *ctx, JSObject *o) {
    JSElements *d = o->elements;
    if (d->kind == JS_ELEMENTS_DENSE) {
        uint32_t n = 0;
        for (uint32_t i = 0; i < d->length; i++) n += !js_is_empty(d->data[i]);
        JSValueArray *keys = js_alloc_value_array(ctx, n);
        d = o->elements;
        for (uint32_t i = 0, k = 0; i < d->length; i++)
            if (!js_is_empty(d->data[i])) keys->values[k++] = js_index_key(i);  /* barrier: fresh cell */
        return keys;
    }
    JSSparseElements *s = as_sparse(d);
    uint32_t n = s->count;
    uint32_t *idx = malloc((n ? n : 1) * sizeof *idx);
    if (!idx) js_fatal("out of memory (element keys)");
    for (uint32_t k = 0, j = 0; k < s->cap; k++)
        if (s->entries[k].state == 1) idx[j++] = s->entries[k].index;
    qsort(idx, n, sizeof *idx, cmp_u32);
    JSValueArray *keys = js_alloc_value_array(ctx, n);
    for (uint32_t k = 0; k < n; k++) keys->values[k] = js_index_key(idx[k]);  /* barrier: fresh cell */
    free(idx);
    return keys;
}

uint32_t js_elements_truncate(JSContext *ctx, JSObject *o, uint32_t new_len) {
    (void)ctx;
    JSElements *d = o->elements;
    if (d->kind == JS_ELEMENTS_DENSE) {
        if (d->length > new_len) {
            if (d->cell.flags & JS_CELL_STATIC) return new_len;
            for (uint32_t i = new_len; i < d->length; i++) d->data[i] = JS_EMPTY;  /* barrier: not a cell */
            d->length = new_len;
        }
        return new_len;
    }
    /* from the top down, stopping at a non-configurable element */
    JSSparseElements *s = as_sparse(d);
    uint32_t stop = new_len;
    for (uint32_t k = 0; k < s->cap; k++) {
        JSSparseEntry *e = &s->entries[k];
        if (e->state == 1 && e->index >= new_len && !(e->attrs & JS_PROP_CONFIGURABLE) && e->index + 1 > stop) stop = e->index + 1;
    }
    for (uint32_t k = 0; k < s->cap; k++) {
        JSSparseEntry *e = &s->entries[k];
        if (e->state == 1 && e->index >= stop) {
            e->state = 2;
            e->value = JS_UNDEFINED;
            s->count--;
            s->tombstones++;
        }
    }
    return stop;
}
