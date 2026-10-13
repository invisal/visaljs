/* Shapes: hidden classes, their transition tree and lookup tables. */
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "js_object.h"
#include "jscontext.h"
#include "shape.h"

/* ---- Property tables: ordered entries + an identity-keyed hash index ------ */

static uint32_t key_hash(JSValue key) {
    uint64_t x = key.bits * UINT64_C(0x9E3779B97F4A7C15);
    return (uint32_t)(x >> 32);
}

JSPropTable *js_prop_table_new(uint32_t capacity) {
    JSPropTable *t = calloc(1, sizeof *t);
    if (!t) js_fatal("out of memory (property table)");
    t->cap = capacity < 8 ? 8 : capacity;
    t->entries = malloc(t->cap * sizeof *t->entries);
    t->index_cap = 16;
    while (t->index_cap < 2 * t->cap) t->index_cap *= 2;
    t->index = malloc(t->index_cap * sizeof *t->index);
    if (!t->entries || !t->index) js_fatal("out of memory (property table)");
    memset(t->index, 0xFF, t->index_cap * sizeof *t->index);
    return t;
}

void js_prop_table_free(JSPropTable *t) {
    if (!t) return;
    free(t->entries);
    free(t->index);
    free(t);
}

static void reindex(JSPropTable *t) {
    while (t->index_cap < 2 * t->cap) t->index_cap *= 2;
    free(t->index);
    t->index = malloc(t->index_cap * sizeof *t->index);
    if (!t->index) js_fatal("out of memory (property table)");
    memset(t->index, 0xFF, t->index_cap * sizeof *t->index);
    for (uint32_t i = 0; i < t->count; i++) {
        uint32_t h = key_hash(t->entries[i].key) & (t->index_cap - 1);
        while (t->index[h] >= 0) h = (h + 1) & (t->index_cap - 1);
        t->index[h] = (int32_t)i;
    }
}

int32_t js_prop_table_find(const JSPropTable *t, JSValue key) {
    for (uint32_t h = key_hash(key) & (t->index_cap - 1);; h = (h + 1) & (t->index_cap - 1)) {
        int32_t i = t->index[h];
        if (i < 0) return -1;
        if (js_same_bits(t->entries[i].key, key)) return i;
    }
}

void js_prop_table_add(JSPropTable *t, JSValue key, uint32_t slot, uint8_t attrs) {
    if (t->count == t->cap) {
        t->cap *= 2;
        t->entries = realloc(t->entries, t->cap * sizeof *t->entries);
        if (!t->entries) js_fatal("out of memory (property table)");
        reindex(t);
    }
    uint32_t i = t->count++;
    t->entries[i] = (JSPropEntry){ key, slot, attrs };  /* barrier: the caller's, on the shape */
    uint32_t h = key_hash(key) & (t->index_cap - 1);
    while (t->index[h] >= 0) h = (h + 1) & (t->index_cap - 1);
    t->index[h] = (int32_t)i;
}

/* Removes entry i, keeping insertion order. */
void js_prop_table_remove(JSPropTable *t, uint32_t i) {
    memmove(&t->entries[i], &t->entries[i + 1], (t->count - i - 1) * sizeof *t->entries);
    t->count--;
    reindex(t);
}

JSPropTable *js_prop_table_clone(const JSPropTable *src) {
    JSPropTable *t = js_prop_table_new(src->count);
    for (uint32_t i = 0; i < src->count; i++) js_prop_table_add(t, src->entries[i].key, src->entries[i].slot, src->entries[i].attrs);
    return t;
}

/* ---- Shape cells ---------------------------------------------------------- */

static void shape_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    JSShape *s = (JSShape *)c;
    js_prop_table_free(s->table);
    if (s->transitions) {
        free(s->transitions->items);
        free(s->transitions);
    }
}

const JSCellClass js_shape_cell_class = { "Shape", NULL, shape_finalize, NULL }  /* gc_visit.h visits it */;

JSShape *js_alloc_shape(JSContext *ctx) {
    JSShape *s = (JSShape *)js_alloc_cell(ctx, JS_CELL_SHAPE, sizeof(JSShape));
    s->cell.flags |= JS_CELL_FINALIZABLE;  /* tables and transitions are malloc'd */
    js_block_of(s)->has_finalizable = 1;
    s->proto = JS_NULL;  /* barrier: fresh cell */
    s->key = JS_EMPTY;
    s->enum_keys = JS_EMPTY;
    return s;
}

/* ---- Roots: one per (class, proto, inline capacity), weakly held ------------ */

static uint32_t root_hash(const JSClass *cls, JSValue proto, uint16_t cap) {
    uint64_t x = ((uint64_t)(uintptr_t)cls ^ proto.bits ^ ((uint64_t)cap << 48)) * UINT64_C(0x9E3779B97F4A7C15);
    return (uint32_t)(x >> 32);
}

static void roots_put(JSShape **table, size_t cap, JSShape *s) {
    size_t i = root_hash(s->cls, s->proto, s->inline_cap) & (cap - 1);
    while (table[i]) i = (i + 1) & (cap - 1);
    table[i] = s;
}

static void roots_rebuild(JSShapeRegistry *r, size_t cap, bool (*keep)(JSShape *)) {
    JSShape **table = calloc(cap, sizeof *table);
    if (!table) js_fatal("out of memory (shape roots)");
    size_t count = 0;
    for (size_t i = 0; i < r->root_cap; i++)
        if (r->roots[i] && (!keep || keep(r->roots[i]))) {
            roots_put(table, cap, r->roots[i]);
            count++;
        }
    free(r->roots);
    r->roots = table;
    r->root_cap = cap;
    r->root_count = count;
}

JSShape *js_shape_root(JSContext *ctx, const JSClass *cls, JSValue proto, uint16_t inline_cap) {
    if (inline_cap > JS_MAX_INLINE_SLOTS) inline_cap = JS_MAX_INLINE_SLOTS;
    JSShapeRegistry *r = &ctx->rt->shapes;
    if (r->root_cap)
        for (size_t i = root_hash(cls, proto, inline_cap) & (r->root_cap - 1); r->roots[i]; i = (i + 1) & (r->root_cap - 1)) {
            JSShape *s = r->roots[i];
            if (s->cls == cls && js_same_bits(s->proto, proto) && s->inline_cap == inline_cap) return s;
        }
    JSShape *s = js_alloc_shape(ctx);  /* may collect: nothing above is held across it */
    s->cls = cls;
    s->proto = proto;  /* barrier: fresh cell */
    if (js_is_object(proto)) js_as_object(proto)->cell.flags |= JS_CELL_PROTOTYPE;  /* its shape changes now bump proto_epoch */
    s->flags = JS_SHAPE_EXTENSIBLE;
    s->inline_cap = inline_cap;
    s->slot_offset = cls->instance_size;
    if (2 * (r->root_count + 1) > r->root_cap) roots_rebuild(r, r->root_cap ? r->root_cap * 2 : 64, NULL);
    roots_put(r->roots, r->root_cap, s);
    r->root_count++;
    return s;
}

/* ---- Transitions ------------------------------------------------------------ */

uint32_t js_shape_transition_count(const JSShape *s) {
    return s->transitions ? s->transitions->count : 0;
}

JSShape *js_shape_add(JSContext *ctx, JSShape *shape, JSValue key, uint8_t attrs) {
    JSTransitions *t = shape->transitions;
    if (t)
        for (uint32_t i = 0; i < t->count; i++)
            if (js_same_bits(t->items[i].key, key) && t->items[i].attrs == attrs) return t->items[i].child;

    JSShape *child = js_alloc_shape(ctx);  /* `shape` is kept alive by the caller */
    child->cls = shape->cls;
    child->proto = shape->proto;  /* barrier: fresh cell */
    child->parent = shape;  /* barrier: fresh cell */
    child->key = key;
    child->attrs = attrs;
    child->flags = shape->flags;
    child->inline_cap = shape->inline_cap;
    child->slot_offset = shape->slot_offset;
    child->prop_count = shape->prop_count + 1;

    t = shape->transitions;
    if (!t) {
        t = shape->transitions = calloc(1, sizeof *t);
        if (!t) js_fatal("out of memory (transitions)");
        JSShapeRegistry *r = &ctx->rt->shapes;
        if (r->parent_count == r->parent_cap) {
            r->parent_cap = r->parent_cap ? r->parent_cap * 2 : 64;
            r->parents = realloc(r->parents, r->parent_cap * sizeof *r->parents);
            if (!r->parents) js_fatal("out of memory (shape registry)");
        }
        r->parents[r->parent_count++] = shape;
    }
    if (t->count == t->cap) {
        t->cap = t->cap ? t->cap * 2 : 2;
        t->items = realloc(t->items, t->cap * sizeof *t->items);
        if (!t->items) js_fatal("out of memory (transitions)");
    }
    t->items[t->count++] = (JSTransition){ key, attrs, child };
    return child;
}

/* ---- Lookup ------------------------------------------------------------------- */

#define WALK_LIMIT 8  /* above this many properties, build a table */

static void build_table(JSShape *s) {
    uint32_t n = s->prop_count;
    JSShape **chain = malloc((n ? n : 1) * sizeof *chain);
    if (!chain) js_fatal("out of memory (property table)");
    uint32_t k = n;
    for (JSShape *x = s; x->parent; x = x->parent) chain[--k] = x;
    s->table = js_prop_table_new(n);
    for (uint32_t i = 0; i < n; i++) js_prop_table_add(s->table, chain[i]->key, i, chain[i]->attrs);
    free(chain);
}

int32_t js_shape_find(JSShape *s, JSValue key, uint8_t *attrs) {
    if (!s->table && s->prop_count > WALK_LIMIT) build_table(s);
    if (s->table) {
        int32_t i = js_prop_table_find(s->table, key);
        if (i < 0) return -1;
        *attrs = s->table->entries[i].attrs;
        return (int32_t)s->table->entries[i].slot;
    }
    for (JSShape *x = s; x->parent; x = x->parent)
        if (js_same_bits(x->key, key)) {
            *attrs = x->attrs;
            return (int32_t)(x->prop_count - 1);
        }
    return -1;
}

JSPropTable *js_shape_entries(JSShape *s) {
    if (!s->table) build_table(s);
    return s->table;
}

/* ---- Weak processing (after marking) ------------------------------------- */

static bool shape_alive(JSShape *s) { return js_gc_is_marked(&s->cell); }

void js_shapes_sweep(JSRuntime *rt) {
    JSShapeRegistry *r = &rt->shapes;
    /* a dead parent's children are dead too: they point to it */
    size_t kept = 0;
    for (size_t i = 0; i < r->parent_count; i++) {
        JSShape *p = r->parents[i];
        if (!shape_alive(p)) continue;
        JSTransitions *t = p->transitions;
        uint32_t live = 0;
        for (uint32_t k = 0; k < t->count; k++)
            if (shape_alive(t->items[k].child)) t->items[live++] = t->items[k];
        t->count = live;
        if (live) r->parents[kept++] = p;
        else {
            free(t->items);
            free(t);
            p->transitions = NULL;
        }
    }
    r->parent_count = kept;
    if (r->root_cap) {
        size_t live = 0;
        for (size_t i = 0; i < r->root_cap; i++) live += r->roots[i] && shape_alive(r->roots[i]);
        size_t cap = 64;
        while (cap < 4 * live) cap *= 2;
        roots_rebuild(r, cap, shape_alive);
    }
}

void js_shapes_free(JSRuntime *rt) {
    free(rt->shapes.roots);
    free(rt->shapes.parents);
    memset(&rt->shapes, 0, sizeof rt->shapes);
}

JSShape *js_cached_shape(JSContext *ctx, JSIntrinsic slot, const JSClass *cls, JSValue proto, uint16_t inline_cap,
                         uint32_t n, const JSValue *keys, uint8_t attrs) {
    JSValue cached = ctx->intrinsics[slot];
    if (js_is_cell(cached) && js_as_cell(cached)->kind == JS_CELL_SHAPE) return (JSShape *)js_as_cell(cached);
    JSShape *s = js_shape_root(ctx, cls, proto, inline_cap);
    for (uint32_t i = 0; i < n; i++) s = js_shape_add(ctx, s, keys[i], attrs);
    ctx->intrinsics[slot] = js_cell(&s->cell);  /* a root: the shape (and its parents) stay alive */
    return s;
}
