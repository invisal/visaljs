/* Weak collections and references (ECMAScript §24.3–24.4, §26.1–26.2): WeakMap
 * and WeakSet (ephemerons), WeakRef with the kept-alive set, FinalizationRegistry.
 *
 * Each such object keeps its weak slots in malloc'd memory its class visit doesn't trace,
 * and is listed in rt->weak. After marking, the GC runs the ephemeron pass (a value lives
 * if its key does), then js_weak_sweep drops dead keys, clears dead WeakRef targets and
 * moves dead registrations to their registry's cleanup list. */
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "js_builtins.h"
#include "js_atoms.h"
#include "js_console.h"
#include "js_error.h"
#include "js_function.h"
#include "js_jobs.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "jscontext.h"

#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)
#define BUILTIN(fn)                                                                            \
    static JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,          \
                      const JSValue *argv, JSValue new_target)

static void *xrealloc(void *p, size_t n) {
    void *q = realloc(p, n);
    if (!q) js_fatal("out of memory in a weak collection");
    return q;
}

/* CanBeHeldWeakly (§9.13): objects, and symbols Symbol.for didn't make. */
static bool can_be_held_weakly(JSValue v) {
    return js_is_object(v) || (js_is_symbol(v) && !(js_as_cell(v)->flags & JS_SYM_REGISTERED));
}

static bool is_live(JSValue v) { return !js_is_cell(v) || js_gc_is_marked(js_as_cell(v)); }

/* ---- The runtime's list of weak containers --------------------------------------------- */

static void weak_register(JSContext *ctx, JSObject *o) {
    struct JSWeakList *l = &ctx->rt->weak;
    if (l->count == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 16;
        l->items = xrealloc(l->items, l->cap * sizeof *l->items);
    }
    l->items[l->count++] = o;
}

/* ---- WeakMap and WeakSet: open-addressing tables keyed by identity -------------------- */

#define TOMBSTONE JS_NULL  /* a deleted entry; null is never a key */

typedef struct WeakEntry {
    JSValue key;   /* EMPTY: free (zeroed memory), TOMBSTONE: deleted */
    JSValue value; /* WeakSet: unused */
} WeakEntry;

typedef struct WeakTable {
    JSObject   obj;
    WeakEntry *entries;  /* malloc'd, the heap's external memory; NULL until the first key */
    uint32_t   cap, count, used;  /* used: count + tombstones */
    uint32_t   writes;       /* entries set since the last collection, listed in rt->weak_writes */
    bool       all_written;  /* too many to list: a young collection looks at every entry */
} WeakTable;

static uint32_t hash_key(JSValue k) {
    uint64_t x = k.bits >> 4;
    return (uint32_t)((x * UINT64_C(0x9E3779B97F4A7C15)) >> 32);
}

static WeakEntry *find(WeakTable *t, JSValue key) {
    if (!t->cap) return NULL;
    for (uint32_t i = hash_key(key) & (t->cap - 1);; i = (i + 1) & (t->cap - 1)) {
        WeakEntry *e = &t->entries[i];
        if (js_is_empty(e->key)) return NULL;
        if (js_same_bits(e->key, key)) return e;
    }
}

static void insert_fresh(WeakEntry *entries, uint32_t cap, JSValue key, JSValue value) {
    uint32_t i = hash_key(key) & (cap - 1);
    while (!js_is_empty(entries[i].key)) i = (i + 1) & (cap - 1);
    entries[i] = (WeakEntry){ key, value };
}

/* Lists an entry set since the last collection. An entry set before has an old key and an old
 * value (the last collection marked both, or dropped the entry), so a young collection can't free
 * either: it looks only at the listed ones (js_weak_ephemerons, js_weak_sweep). Past a quarter of
 * the table, the table is listed whole instead, which bounds the list. */
static void note_write(JSRuntime *rt, WeakTable *t, JSValue key) {
    if (t->all_written) return;
    if (t->writes >= 64 && t->writes >= t->count / 4) {
        t->all_written = true;
        key = JS_EMPTY;
    }
    t->writes++;
    struct JSWeakWrites *l = &rt->weak_writes;
    if (l->count == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 64;
        l->items = xrealloc(l->items, l->cap * sizeof *l->items);
    }
    l->items[l->count++] = (struct JSWeakWrite){ &t->obj, key };
}

static void table_set(JSContext *ctx, WeakTable *t, JSValue key, JSValue value) {
    note_write(ctx->rt, t, key);
    WeakEntry *e = find(t, key);
    if (e) {
        e->value = value;  /* malloc'd memory: no write barrier */
        return;
    }
    if ((t->used + 1) * 4 > t->cap * 3) {  /* grow (or just drop tombstones) at 3/4 */
        uint32_t cap = t->cap ? t->cap : 8;
        while ((t->count + 1) * 2 > cap) cap *= 2;
        WeakEntry *entries = calloc(cap, sizeof *entries);
        if (!entries) js_fatal("out of memory in a weak collection");
        for (uint32_t i = 0; i < t->cap; i++) {
            JSValue k = t->entries[i].key;
            if (!js_is_empty(k) && !js_same_bits(k, TOMBSTONE)) insert_fresh(entries, cap, k, t->entries[i].value);
        }
        free(t->entries);
        js_gc_external_add(ctx->rt, ((size_t)cap - t->cap) * sizeof *entries);  /* external memory */
        t->entries = entries;
        t->cap = cap;
        t->used = t->count;
    }
    insert_fresh(t->entries, t->cap, key, value);
    t->count++;
    t->used++;
}

static bool table_delete(WeakTable *t, JSValue key) {
    WeakEntry *e = find(t, key);
    if (!e) return false;
    e->key = TOMBSTONE;
    e->value = JS_UNDEFINED;
    t->count--;
    return true;
}

static void table_finalize(JSRuntime *rt, JSCell *c) {
    WeakTable *t = (WeakTable *)c;
    js_gc_external_sub(rt, (size_t)t->cap * sizeof *t->entries);
    free(t->entries);
}

static const JSClass weak_map_class = { "WeakMap", sizeof(WeakTable), NULL, NULL, NULL, NULL, NULL, table_finalize, NULL };
static const JSClass weak_set_class = { "WeakSet", sizeof(WeakTable), NULL, NULL, NULL, NULL, NULL, table_finalize, NULL };

static WeakTable *this_table(JSContext *ctx, JSValue v, const JSClass *cls, const char *method) {
    if (js_is_object(v) && js_as_object(v)->shape->cls == cls) return (WeakTable *)js_as_object(v);
    js_discard(js_throw_type_error(ctx, "Method %s called on incompatible receiver", method));
    return NULL;
}

/* new WeakMap(iterable) / new WeakSet(iterable): each entry through this.set / this.add. */
static JSValue construct_table(JSContext *ctx, JSValue new_target, JSValue iterable, const JSClass *cls,
                               JSIntrinsic proto_fallback, const char *name, bool pairs) {
    if (js_is_undefined(new_target)) return js_throw_type_error(ctx, "Constructor %s requires 'new'", name);
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, proto_fallback);
    if (js_is_exception(proto)) return JS_EXCEPTION;
    WeakTable *t = (WeakTable *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, cls, proto, 0));
    weak_register(ctx, &t->obj);
    JSValue self = js_object_value(&t->obj);
    if (js_is_nullish(iterable)) return self;
    JSValue adder = js_get_value(ctx, self, js_atom_from_cstr(ctx, pairs ? "set" : "add"));
    if (js_is_exception(adder)) return JS_EXCEPTION;
    if (!js_is_callable(adder)) return js_throw_type_error(ctx, "'%s' returned for property '%s' of object '#<%s>' is not a function",
                                                           "undefined", pairs ? "set" : "add", name);
    JSValue rec = js_iter_start(ctx, iterable);
    if (js_is_exception(rec)) return JS_EXCEPTION;
    for (;;) {
        JSValue item = js_iter_next(ctx, rec);
        if (js_is_exception(item)) return JS_EXCEPTION;
        if (js_is_empty(item)) return self;
        JSValue args[2] = { item, JS_UNDEFINED };
        JSValue r = JS_UNDEFINED;
        if (pairs) {
            if (!js_is_object(item)) r = js_throw_type_error(ctx, "Iterator value is not an entry object");
            if (!js_is_exception(r)) r = args[0] = js_get_value(ctx, item, js_int32(0));
            if (!js_is_exception(r)) r = args[1] = js_get_value(ctx, item, js_int32(1));
        }
        if (!js_is_exception(r)) r = js_call(ctx, adder, self, pairs ? 2 : 1, args);
        if (js_is_exception(r)) {  /* close the iterator; the original error wins */
            JSValue e = js_take_exception(ctx);
            js_iter_close_throw(ctx, rec);
            return js_throw(ctx, e);
        }
    }
}

BUILTIN(weak_map_ctor) {
    (void)callee, (void)this_val;
    return construct_table(ctx, new_target, ARG(0), &weak_map_class, JS_INTRINSIC_WEAK_MAP_PROTOTYPE, "WeakMap", true);
}
BUILTIN(weak_set_ctor) {
    (void)callee, (void)this_val;
    return construct_table(ctx, new_target, ARG(0), &weak_set_class, JS_INTRINSIC_WEAK_SET_PROTOTYPE, "WeakSet", false);
}

BUILTIN(weak_map_get) {
    (void)callee, (void)new_target;
    WeakTable *t = this_table(ctx, this_val, &weak_map_class, "WeakMap.prototype.get");
    if (!t) return JS_EXCEPTION;
    WeakEntry *e = can_be_held_weakly(ARG(0)) ? find(t, ARG(0)) : NULL;
    return e ? e->value : JS_UNDEFINED;
}
BUILTIN(weak_map_has) {
    (void)callee, (void)new_target;
    WeakTable *t = this_table(ctx, this_val, &weak_map_class, "WeakMap.prototype.has");
    if (!t) return JS_EXCEPTION;
    return js_bool(can_be_held_weakly(ARG(0)) && find(t, ARG(0)));
}
BUILTIN(weak_map_delete) {
    (void)callee, (void)new_target;
    WeakTable *t = this_table(ctx, this_val, &weak_map_class, "WeakMap.prototype.delete");
    if (!t) return JS_EXCEPTION;
    return js_bool(can_be_held_weakly(ARG(0)) && table_delete(t, ARG(0)));
}
BUILTIN(weak_map_set) {
    (void)callee, (void)new_target;
    WeakTable *t = this_table(ctx, this_val, &weak_map_class, "WeakMap.prototype.set");
    if (!t) return JS_EXCEPTION;
    if (!can_be_held_weakly(ARG(0))) return js_throw_type_error(ctx, "Invalid value used as weak map key");
    table_set(ctx, t, ARG(0), ARG(1));
    return this_val;
}

BUILTIN(weak_set_add) {
    (void)callee, (void)new_target;
    WeakTable *t = this_table(ctx, this_val, &weak_set_class, "WeakSet.prototype.add");
    if (!t) return JS_EXCEPTION;
    if (!can_be_held_weakly(ARG(0))) return js_throw_type_error(ctx, "Invalid value used in weak set");
    if (!find(t, ARG(0))) table_set(ctx, t, ARG(0), JS_UNDEFINED);
    return this_val;
}
BUILTIN(weak_set_has) {
    (void)callee, (void)new_target;
    WeakTable *t = this_table(ctx, this_val, &weak_set_class, "WeakSet.prototype.has");
    if (!t) return JS_EXCEPTION;
    return js_bool(can_be_held_weakly(ARG(0)) && find(t, ARG(0)));
}
BUILTIN(weak_set_delete) {
    (void)callee, (void)new_target;
    WeakTable *t = this_table(ctx, this_val, &weak_set_class, "WeakSet.prototype.delete");
    if (!t) return JS_EXCEPTION;
    return js_bool(can_be_held_weakly(ARG(0)) && table_delete(t, ARG(0)));
}

/* ---- WeakRef and the kept-alive set (§26.1, §9.10) ------------------------------------- */

typedef struct WeakRef {
    JSObject obj;
    JSValue  target;  /* weak: undefined once collected */
} WeakRef;

static const JSClass weak_ref_class = { "WeakRef", sizeof(WeakRef), NULL, NULL, NULL, NULL, NULL, NULL, NULL };

/* AddToKeptObjects: a root until the end of the current job (ClearKeptObjects). */
static void keep_alive(JSContext *ctx, JSValue v) {
    struct JSKeptAlive *k = &ctx->rt->kept_alive;
    if (k->count == k->cap) {
        k->cap = k->cap ? k->cap * 2 : 16;
        k->items = xrealloc(k->items, k->cap * sizeof *k->items);
    }
    k->items[k->count++] = v;
}

void js_clear_kept_objects(JSRuntime *rt) { rt->kept_alive.count = 0; }

BUILTIN(weak_ref_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_type_error(ctx, "Constructor WeakRef requires 'new'");
    JSValue target = ARG(0);
    if (!can_be_held_weakly(target)) return js_throw_type_error(ctx, "WeakRef: invalid target");
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_WEAK_REF_PROTOTYPE);
    if (js_is_exception(proto)) return JS_EXCEPTION;
    WeakRef *w = (WeakRef *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &weak_ref_class, proto, 0));
    w->target = target;  /* not traced: weak */
    weak_register(ctx, &w->obj);
    keep_alive(ctx, target);
    return js_object_value(&w->obj);
}

BUILTIN(weak_ref_deref) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    if (!js_is_object(this_val) || js_as_object(this_val)->shape->cls != &weak_ref_class)
        return js_throw_type_error(ctx, "WeakRef.prototype.deref called on incompatible receiver");
    JSValue target = ((WeakRef *)js_as_object(this_val))->target;
    if (!js_is_undefined(target)) keep_alive(ctx, target);
    return target;
}

/* ---- FinalizationRegistry (§26.2) ------------------------------------------------------- */

typedef struct Registration {
    JSValue target;  /* weak; EMPTY once collected (waiting for the cleanup callback) */
    JSValue held;    /* strong */
    JSValue token;   /* weak; EMPTY: none */
} Registration;

typedef struct Registry {
    JSObject      obj;
    JSValue       cleanup;
    JSContext    *realm;
    Registration *cells;  /* malloc'd */
    uint32_t      count, cap;
    bool          pending;  /* some target was collected: a cleanup is due */
} Registry;

static void registry_visit(JSCell *c, JSTracer *trc) {
    Registry *r = (Registry *)c;
    js_trace_value(trc, r->cleanup);
    for (uint32_t i = 0; i < r->count; i++) js_trace_value(trc, r->cells[i].held);
}

static void registry_finalize(JSRuntime *rt, JSCell *c) {
    (void)rt;
    free(((Registry *)c)->cells);
}

static const JSClass registry_class = { "FinalizationRegistry", sizeof(Registry), NULL, NULL, NULL, NULL, registry_visit, registry_finalize, NULL };

static Registry *this_registry(JSContext *ctx, JSValue v, const char *method) {
    if (js_is_object(v) && js_as_object(v)->shape->cls == &registry_class) return (Registry *)js_as_object(v);
    js_discard(js_throw_type_error(ctx, "Method FinalizationRegistry.prototype.%s called on incompatible receiver", method));
    return NULL;
}

BUILTIN(registry_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_type_error(ctx, "Constructor FinalizationRegistry requires 'new'");
    if (!js_is_callable(ARG(0))) return js_throw_type_error(ctx, "FinalizationRegistry: cleanup must be callable");
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_FINALIZATION_REGISTRY_PROTOTYPE);
    if (js_is_exception(proto)) return JS_EXCEPTION;
    Registry *r = (Registry *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &registry_class, proto, 0));
    js_store(ctx, &r->obj.cell, &r->cleanup, ARG(0));
    r->realm = ctx;
    weak_register(ctx, &r->obj);
    return js_object_value(&r->obj);
}

BUILTIN(registry_register) {
    (void)callee, (void)new_target;
    Registry *r = this_registry(ctx, this_val, "register");
    if (!r) return JS_EXCEPTION;
    JSValue target = ARG(0), held = ARG(1), token = ARG(2);
    if (!can_be_held_weakly(target)) return js_throw_type_error(ctx, "FinalizationRegistry.prototype.register: invalid target");
    if (js_same_bits(target, held)) return js_throw_type_error(ctx, "FinalizationRegistry.prototype.register: target and holdings must not be same");
    if (!can_be_held_weakly(token)) {
        if (!js_is_undefined(token)) return js_throw_type_error(ctx, "FinalizationRegistry.prototype.register: invalid unregister token");
        token = JS_EMPTY;
    }
    if (r->count == r->cap) {
        r->cap = r->cap ? r->cap * 2 : 8;
        r->cells = xrealloc(r->cells, r->cap * sizeof *r->cells);
    }
    r->cells[r->count++] = (Registration){ target, held, token };  /* barrier: below */
    js_write_barrier(ctx, &r->obj.cell, NULL, held);  /* target and token are weak */
    return JS_UNDEFINED;
}

BUILTIN(registry_unregister) {
    (void)callee, (void)new_target;
    Registry *r = this_registry(ctx, this_val, "unregister");
    if (!r) return JS_EXCEPTION;
    JSValue token = ARG(0);
    if (!can_be_held_weakly(token)) return js_throw_type_error(ctx, "Invalid unregisterToken ('%s')", "not an object or symbol");
    bool removed = false;
    uint32_t n = 0;
    for (uint32_t i = 0; i < r->count; i++) {
        if (js_same_bits(r->cells[i].token, token)) removed = true;
        else r->cells[n++] = r->cells[i];  /* barrier: same owner */
    }
    r->count = n;
    return js_bool(removed);
}

/* CleanupFinalizationRegistry (§9.13): the callback once per collected target. */
static int cleanup_registry(Registry *r) {
    JSContext *ctx = r->realm;
    r->pending = false;
    for (uint32_t i = 0; i < r->count;) {
        if (!js_is_empty(r->cells[i].target)) {
            i++;
            continue;
        }
        JSValue held = r->cells[i].held;  /* on the C stack: still alive after the removal */
        r->cells[i] = r->cells[--r->count];  /* barrier: same owner */
        JSValue result = js_call(ctx, r->cleanup, JS_UNDEFINED, 1, &held);
        if (js_is_exception(result)) return -1;
        i = 0;  /* the callback may have registered or unregistered */
    }
    return 0;
}

/* The host's FINALIZATION_CLEANUP tasks: one registry at a time, each followed by
 * a checkpoint. 0, or -1 after an uncaught error (reported). */
int js_run_finalization_cleanups(JSContext *ctx) {
    JSRuntime *rt = ctx->rt;
    for (size_t i = 0; i < rt->weak.count; i++) {
        JSObject *o = rt->weak.items[i];
        if (o->shape->cls != &registry_class || !((Registry *)o)->pending) continue;
        Registry *r = (Registry *)o;
        JSValue keep = js_object_value(o);  /* a callback may drop the last reference */
        if (cleanup_registry(r) < 0 && js_report_uncaught(r->realm)) return -1;
        js_keep_alive(keep);
        if (js_run_microtasks(ctx) < 0) return -1;
    }
    return 0;
}

/* ---- The collector's side (gc.c) ------------------------------------------------------- */

/* An entry's ephemeron step: its value marked when its key is. Returns whether it marked it. */
static bool mark_value(JSTracer *trc, const WeakEntry *e) {
    if (!js_is_cell(e->key) || !js_gc_is_marked(js_as_cell(e->key)) || is_live(e->value)) return false;
    js_trace_value(trc, e->value);
    return true;
}

static bool mark_values(JSTracer *trc, const WeakTable *t) {
    bool marked = false;
    for (uint32_t k = 0; k < t->cap; k++) marked |= mark_value(trc, &t->entries[k]);
    return marked;
}

/* Drops the entry if its key died. */
static void sweep_entry(WeakTable *t, WeakEntry *e) {
    if (js_is_cell(e->key) && !js_gc_is_marked(js_as_cell(e->key))) {
        e->key = TOMBSTONE;
        e->value = JS_UNDEFINED;
        t->count--;
    }
}

static void sweep_entries(WeakTable *t) {
    for (uint32_t k = 0; k < t->cap; k++) sweep_entry(t, &t->entries[k]);
}

/* The ephemeron pass: marks the value of every live WeakMap entry whose key is marked; a young
 * collection, of the entries set since the last collection (note_write). true if anything new was
 * marked (the caller drains and calls again). */
bool js_weak_ephemerons(JSRuntime *rt, JSTracer *trc, bool full) {
    bool marked = false;
    if (full) {
        for (size_t i = 0; i < rt->weak.count; i++) {
            JSObject *o = rt->weak.items[i];
            if (o->shape->cls == &weak_map_class && js_gc_is_marked(&o->cell)) marked |= mark_values(trc, (WeakTable *)o);
        }
        return marked;
    }
    for (size_t i = 0; i < rt->weak_writes.count; i++) {
        struct JSWeakWrite w = rt->weak_writes.items[i];
        if (w.table->shape->cls != &weak_map_class || !js_gc_is_marked(&w.table->cell)) continue;
        WeakTable *t = (WeakTable *)w.table;
        if (js_is_empty(w.key)) {
            marked |= mark_values(trc, t);
        } else {
            WeakEntry *e = find(t, w.key);
            if (e) marked |= mark_value(trc, e);
        }
    }
    return marked;
}

/* After marking: forget dead containers, drop dead keys (a young collection: of the entries set
 * since the last collection), clear dead WeakRef targets, and queue the registrations whose
 * target died. Then the list of entries set starts anew. */
void js_weak_sweep(JSRuntime *rt, bool full) {
    struct JSWeakWrites *writes = &rt->weak_writes;
    if (!full) {
        for (size_t i = 0; i < writes->count; i++) {
            struct JSWeakWrite w = writes->items[i];
            if (!js_gc_is_marked(&w.table->cell)) continue;  /* dead: its entries go with it */
            WeakTable *t = (WeakTable *)w.table;
            if (js_is_empty(w.key)) {
                sweep_entries(t);
            } else {
                WeakEntry *e = find(t, w.key);
                if (e) sweep_entry(t, e);
            }
        }
    }
    for (size_t i = 0; i < writes->count; i++) {  /* dead tables too: they're finalized later */
        WeakTable *t = (WeakTable *)writes->items[i].table;
        t->writes = 0;
        t->all_written = false;
    }
    writes->count = 0;

    struct JSWeakList *l = &rt->weak;
    size_t n = 0;
    for (size_t i = 0; i < l->count; i++) {
        JSObject *o = l->items[i];
        if (!js_gc_is_marked(&o->cell)) continue;  /* dead: swept (and finalized) later */
        l->items[n++] = o;
        const JSClass *cls = o->shape->cls;
        if (cls == &weak_map_class || cls == &weak_set_class) {
            if (full) sweep_entries((WeakTable *)o);
        } else if (cls == &weak_ref_class) {
            WeakRef *w = (WeakRef *)o;
            if (!is_live(w->target)) w->target = JS_UNDEFINED;
        } else {
            Registry *r = (Registry *)o;
            for (uint32_t k = 0; k < r->count; k++) {
                Registration *c = &r->cells[k];
                if (!js_is_empty(c->token) && !is_live(c->token)) c->token = JS_EMPTY;
                if (!js_is_empty(c->target) && !is_live(c->target)) {
                    c->target = JS_EMPTY;  /* HostEnqueueFinalizationRegistryCleanupJob */
                    r->pending = true;
                }
            }
        }
    }
    l->count = n;
}

void js_weak_trace_roots(JSRuntime *rt, JSTracer *trc) {
    for (size_t i = 0; i < rt->kept_alive.count; i++) js_trace_value(trc, rt->kept_alive.items[i]);
}

void js_weak_free(JSRuntime *rt) {
    free(rt->weak.items);
    free(rt->weak_writes.items);
    free(rt->kept_alive.items);
}

/* ---- Realm ------------------------------------------------------------------------------- */

static void define_class(JSContext *ctx, JSObject *global, const char *name, JSNativeFn ctor, uint32_t length,
                         JSIntrinsic proto_slot, const JSBuiltin *methods, size_t n) {
    JSValue proto = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 8);
    ctx->intrinsics[proto_slot] = proto;
    JSValue key = js_atom_from_cstr(ctx, name);
    JSValue c = js_new_native(ctx, ctor, key, length, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), proto, 0);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), c, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    js_define_builtins(ctx, js_as_object(proto), methods, n);
    js_define_data(ctx, js_as_object(proto), JS_SYMBOL(toStringTag), key, JS_PROP_CONFIGURABLE);
    js_define_data(ctx, global, key, c, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
}

static void install_weak(JSContext *ctx, JSObject *global) {
    static const JSBuiltin weak_map[] = {
        JS_BUILTIN_FN("delete", weak_map_delete, 1), JS_BUILTIN_FN("get", weak_map_get, 1), JS_BUILTIN_FN("has", weak_map_has, 1), JS_BUILTIN_FN("set", weak_map_set, 2),
    };
    define_class(ctx, global, "WeakMap", weak_map_ctor, 0, JS_INTRINSIC_WEAK_MAP_PROTOTYPE, weak_map, JS_COUNTOF(weak_map));
    static const JSBuiltin weak_set[] = { JS_BUILTIN_FN("add", weak_set_add, 1), JS_BUILTIN_FN("delete", weak_set_delete, 1), JS_BUILTIN_FN("has", weak_set_has, 1) };
    define_class(ctx, global, "WeakSet", weak_set_ctor, 0, JS_INTRINSIC_WEAK_SET_PROTOTYPE, weak_set, JS_COUNTOF(weak_set));
    static const JSBuiltin weak_ref[] = { JS_BUILTIN_FN("deref", weak_ref_deref, 0) };
    define_class(ctx, global, "WeakRef", weak_ref_ctor, 1, JS_INTRINSIC_WEAK_REF_PROTOTYPE, weak_ref, JS_COUNTOF(weak_ref));
    static const JSBuiltin registry[] = { JS_BUILTIN_FN("register", registry_register, 2), JS_BUILTIN_FN("unregister", registry_unregister, 1) };
    define_class(ctx, global, "FinalizationRegistry", registry_ctor, 1, JS_INTRINSIC_FINALIZATION_REGISTRY_PROTOTYPE, registry, JS_COUNTOF(registry));
}
const JSComponent js_component_weak = { "weak", install_weak };
