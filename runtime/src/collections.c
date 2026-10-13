/* Map and Set (ECMAScript §24.1–24.2), an optional component: with Map.groupBy,
 * Map.prototype.getOrInsert / getOrInsertComputed, and the Set methods (union, …).
 *
 * Each Map or Set holds an ordered hash table (V8's OrderedHashTable): the entries in insertion
 * order, a deleted one left as a hole, and buckets chaining entry indices by hash. When the table
 * grows, shrinks or is cleared, a new table replaces it and the old one points to the new one. An
 * iterator still on an old table moves over lazily: its index becomes the number of live entries
 * before it (0 after a clear). So iterators see entries added while they run and skip deleted
 * ones, as the spec's list with empty slots does. */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "internal.h"
#include "builtins_util.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_function.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "jscontext.h"
#include "jsstring.h"

#define NIL UINT32_MAX
#define MIN_CAP 4

/* ---- Ordered hash tables ------------------------------------------------------------------ */

typedef struct Entry {
    JSValue  key;    /* EMPTY: deleted */
    JSValue  value;  /* Set: unused */
    uint32_t chain;  /* the next entry in the bucket, or NIL */
    uint32_t hash;
} Entry;

typedef struct Table {
    JSHostCell host;
    JSValue    next;      /* the table that replaced this one; undefined while current */
    uint32_t   cap;       /* entries */
    uint32_t   used;      /* entries filled, holes included */
    uint32_t   count;     /* live entries */
    bool       cleared;   /* replaced by clear(): iterators restart at 0 */
    Entry      entries[]; /* then uint32_t buckets[cap / 2] */
} Table;

static uint32_t *buckets_of(Table *t) { return (uint32_t *)(t->entries + t->cap); }

static void table_visit(JSCell *c, JSTracer *trc) {
    Table *t = (Table *)c;
    js_trace_value(trc, t->next);
    for (uint32_t i = 0; i < t->used; i++) {
        js_trace_value(trc, t->entries[i].key);
        js_trace_value(trc, t->entries[i].value);
    }
}

/* A young collection's visit of a big table's marked cards. */
static void table_visit_range(JSCell *c, JSTracer *trc, size_t from, size_t to) {
    Table *t = (Table *)c;
    if (from < offsetof(Table, entries)) js_trace_value(trc, t->next);
    size_t first = from < offsetof(Table, entries) ? 0 : (from - offsetof(Table, entries)) / sizeof(Entry);
    size_t last = to <= offsetof(Table, entries) ? 0 : (to - offsetof(Table, entries) + sizeof(Entry) - 1) / sizeof(Entry);
    for (size_t i = first; i < last && i < t->used; i++) {
        js_trace_value(trc, t->entries[i].key);
        js_trace_value(trc, t->entries[i].value);
    }
}

static const JSCellClass table_class = { "OrderedHashTable", table_visit, NULL, table_visit_range };

static Table *new_table(JSContext *ctx, uint32_t cap) {
    size_t size = sizeof(Table) + cap * sizeof(Entry) + (cap / 2) * sizeof(uint32_t);
    Table *t = (Table *)js_alloc_host_cell(ctx, &table_class, size);  /* zeroed: keys are EMPTY */
    t->next = JS_UNDEFINED;
    t->cap = cap;
    memset(buckets_of(t), 0xFF, (cap / 2) * sizeof(uint32_t));
    return t;
}

/* CanonicalizeKeyedCollectionKey (§24.5.1), and one encoding per number: -0 is +0, an
 * integral double is an int32. Then SameValueZero is: same bits, or equal strings. */
static JSValue canonical_key(JSValue k) {
    if (!js_is_double(k)) return k;
    double d = js_as_double(k);
    return d == 0 ? js_int32(0) : js_number(d);
}

static uint32_t hash_key(JSContext *ctx, JSValue k) {
    if (js_is_string(k)) return js_string_hash(ctx, k);
    if (js_is_bigint(k)) return js_bigint_hash(k);  /* by value, as SameValueZero compares them */
    uint64_t x = k.bits ^ (k.bits >> 29);
    return (uint32_t)((x * UINT64_C(0x9E3779B97F4A7C15)) >> 32);
}

static bool same_key(JSContext *ctx, JSValue a, JSValue b) {
    return js_same_bits(a, b) || (js_is_string(a) && js_is_string(b) && js_string_equals(ctx, a, b)) ||
           (js_is_bigint(a) && js_is_bigint(b) && js_bigint_equals(a, b));
}

/* The entry index of a canonical key, or NIL. */
static uint32_t table_find(JSContext *ctx, Table *t, JSValue key, uint32_t hash) {
    for (uint32_t i = buckets_of(t)[hash & (t->cap / 2 - 1)]; i != NIL; i = t->entries[i].chain) {
        Entry *e = &t->entries[i];
        if (e->hash == hash && same_key(ctx, e->key, key)) return i;
    }
    return NIL;
}

static void table_append(Table *t, JSValue key, JSValue value, uint32_t hash) {
    uint32_t *b = &buckets_of(t)[hash & (t->cap / 2 - 1)];
    t->entries[t->used] = (Entry){ key, value, *b, hash };  /* barrier: collection_add's, after it */
    *b = t->used++;
    t->count++;
}

/* A Map or Set: its current table. */
typedef struct Collection {
    JSObject obj;
    JSValue  table;
} Collection;

static Table *table_of(Collection *c) { return (Table *)js_as_cell(c->table); }

static void collection_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((Collection *)c)->table); }

static const JSClass map_class = { "Map", sizeof(Collection), NULL, NULL, NULL, NULL, collection_visit, NULL, NULL };
static const JSClass set_class = { "Set", sizeof(Collection), NULL, NULL, NULL, NULL, collection_visit, NULL, NULL };

/* Replaces c's table by one of `cap` entries holding the live ones, in order. */
static void rehash(JSContext *ctx, Collection *c, uint32_t cap) {
    Table *old = table_of(c);
    Table *t = new_table(ctx, cap);
    for (uint32_t i = 0; i < old->used; i++) {
        Entry *e = &old->entries[i];
        if (!js_is_empty(e->key)) table_append(t, e->key, e->value, e->hash);
    }
    js_store(ctx, &old->host.cell, &old->next, js_cell(&t->host.cell));
    js_store(ctx, &c->obj.cell, &c->table, js_cell(&t->host.cell));
}

/* Adds a canonical key that isn't there. */
static void collection_add(JSContext *ctx, Collection *c, JSValue key, JSValue value, uint32_t hash) {
    Table *t = table_of(c);
    if (t->used == t->cap) {
        rehash(ctx, c, t->count >= t->cap / 2 ? t->cap * 2 : t->cap);
        t = table_of(c);
    }
    table_append(t, key, value, hash);
    Entry *e = &t->entries[t->used - 1];
    js_write_barrier(ctx, &t->host.cell, &e->key, key);
    js_write_barrier(ctx, &t->host.cell, &e->value, value);
}

/* Sets key's value (adding it at the end if new). */
static void collection_set(JSContext *ctx, Collection *c, JSValue key, JSValue value) {
    key = canonical_key(key);
    uint32_t hash = hash_key(ctx, key);
    Table *t = table_of(c);
    uint32_t i = table_find(ctx, t, key, hash);
    if (i != NIL) js_store(ctx, &t->host.cell, &t->entries[i].value, value);
    else collection_add(ctx, c, key, value, hash);
}

static Entry *collection_find(JSContext *ctx, Collection *c, JSValue key) {
    key = canonical_key(key);
    Table *t = table_of(c);
    uint32_t i = table_find(ctx, t, key, hash_key(ctx, key));
    return i == NIL ? NULL : &t->entries[i];
}

static bool collection_delete(JSContext *ctx, Collection *c, JSValue key) {
    Entry *e = collection_find(ctx, c, key);
    if (!e) return false;
    e->key = JS_EMPTY;
    e->value = JS_UNDEFINED;
    Table *t = table_of(c);
    t->count--;
    if (t->cap > MIN_CAP && t->count < t->cap / 4) rehash(ctx, c, t->cap / 2);
    return true;
}

static void collection_clear(JSContext *ctx, Collection *c) {
    Table *old = table_of(c);
    Table *t = new_table(ctx, MIN_CAP);
    old->cleared = true;
    old->used = 0;  /* its iterators restart at 0 of the new table: the entries are dead */
    js_store(ctx, &old->host.cell, &old->next, js_cell(&t->host.cell));
    js_store(ctx, &c->obj.cell, &c->table, js_cell(&t->host.cell));
}

/* ---- Cursors: a position in a table, which follows it when it's replaced -------------------- */

typedef struct Cursor {
    Table   *table;
    uint32_t index;
} Cursor;

static void cursor_follow(Cursor *k) {
    while (!js_is_undefined(k->table->next)) {
        Table *t = k->table;
        uint32_t live = 0;
        if (!t->cleared)
            for (uint32_t j = 0; j < k->index && j < t->used; j++) live += !js_is_empty(t->entries[j].key);
        k->index = live;
        k->table = (Table *)js_as_cell(t->next);
    }
}

/* The next live entry, or NULL at the end. */
static Entry *cursor_next(Cursor *k) {
    cursor_follow(k);
    while (k->index < k->table->used) {
        Entry *e = &k->table->entries[k->index++];
        if (!js_is_empty(e->key)) return e;
    }
    return NULL;
}

static Cursor cursor_start(Collection *c) { return (Cursor){ table_of(c), 0 }; }

/* ---- Receivers and errors ----------------------------------------------------------------- */

static JSValue throw_incompatible(JSContext *ctx, const char *method, JSValue receiver) {
    char what[128];
    js_describe_value(ctx, receiver, what, sizeof what);
    return js_throw_type_error(ctx, "Method %s called on incompatible receiver %s", method, what);
}

static Collection *this_collection(JSContext *ctx, JSValue v, const JSClass *cls, const char *method) {
    if (js_is_object(v) && js_as_object(v)->shape->cls == cls) return (Collection *)js_as_object(v);
    js_discard(throw_incompatible(ctx, method, v));
    return NULL;
}

#define THIS_MAP(method)                                                   \
    Collection *c = this_collection(ctx, this_val, &map_class, method);    \
    if (!c) return JS_EXCEPTION
#define THIS_SET(method)                                                   \
    Collection *c = this_collection(ctx, this_val, &set_class, method);    \
    if (!c) return JS_EXCEPTION

static JSValue throw_not_function(JSContext *ctx, JSValue v) {
    char what[128];
    js_describe_value(ctx, v, what, sizeof what);
    return js_throw_type_error(ctx, "%s is not a function", what);
}

/* The same, as V8 words it for a callback: "number 1 is not a function", "object is not a function". */
static JSValue throw_not_callback(JSContext *ctx, JSValue v) {
    if (js_is_undefined(v)) return js_throw_type_error(ctx, "undefined is not a function");
    if (js_is_null(v)) return js_throw_type_error(ctx, "object null is not a function");
    if (js_is_symbol(v)) return js_throw_type_error(ctx, "symbol is not a function");
    if (js_is_object(v)) return js_throw_type_error(ctx, "object is not a function");
    char what[128];
    js_describe_value(ctx, v, what, sizeof what);
    if (js_is_string(v)) return js_throw_type_error(ctx, "string \"%s\" is not a function", what);
    return js_throw_type_error(ctx, "%s %s is not a function", js_is_bool(v) ? "boolean" : "number", what);
}

/* ---- Constructors -------------------------------------------------------------------------- */

static Collection *new_collection(JSContext *ctx, const JSClass *cls, JSValue proto) {
    Collection *c = (Collection *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, cls, proto, 0));
    Table *t = new_table(ctx, MIN_CAP);
    js_store(ctx, &c->obj.cell, &c->table, js_cell(&t->host.cell));
    return c;
}

/* new Map(iterable) / new Set(iterable) (§24.1.1.1, §24.2.2.1): each entry through this.set / this.add. */
static JSValue construct(JSContext *ctx, JSValue new_target, JSValue iterable, const JSClass *cls, JSIntrinsic proto_slot, bool pairs) {
    if (js_is_undefined(new_target)) return js_throw_type_error(ctx, "Constructor %s requires 'new'", cls->name);
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, proto_slot);
    if (js_is_exception(proto)) return JS_EXCEPTION;
    Collection *c = new_collection(ctx, cls, proto);
    JSValue self = js_object_value(&c->obj);
    if (js_is_nullish(iterable)) return self;
    const char *adder_name = pairs ? "set" : "add";
    JSValue adder = js_get_value(ctx, self, js_atom_from_cstr(ctx, adder_name));
    if (js_is_exception(adder)) return JS_EXCEPTION;
    if (!js_is_callable(adder)) {
        char what[128];
        js_describe_value(ctx, adder, what, sizeof what);
        return js_throw_type_error(ctx, "'%s' returned for property '%s' of object '#<%s>' is not a function", what, adder_name, cls->name);
    }
    JSValue rec = js_iter_start(ctx, iterable);
    if (js_is_exception(rec)) return JS_EXCEPTION;
    for (;;) {
        JSValue item = js_iter_next(ctx, rec);
        if (js_is_exception(item)) return JS_EXCEPTION;
        if (js_is_empty(item)) return self;
        JSValue args[2] = { item, JS_UNDEFINED };
        JSValue r = JS_UNDEFINED;
        if (pairs) {
            if (!js_is_object(item)) {
                char what[128];
                js_describe_value(ctx, item, what, sizeof what);
                r = js_throw_type_error(ctx, "Iterator value %s is not an entry object", what);
            }
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

BUILTIN(map_ctor) {
    (void)callee, (void)this_val;
    return construct(ctx, new_target, ARG(0), &map_class, JS_INTRINSIC_MAP_PROTOTYPE, true);
}

BUILTIN(set_ctor) {
    (void)callee, (void)this_val;
    return construct(ctx, new_target, ARG(0), &set_class, JS_INTRINSIC_SET_PROTOTYPE, false);
}

/* get Map[@@species], get Set[@@species] */
BUILTIN(get_species) {
    UNUSED_ARGS;
    return this_val;
}

/* Map.groupBy(items, callback) (§24.1.2.1): a Map from each key to the array of its items. */
BUILTIN(map_group_by) {
    (void)callee, (void)this_val, (void)new_target;
    JSValue items = ARG(0), callback = ARG(1);
    if (js_is_nullish(items)) return js_throw_type_error(ctx, "Map.groupBy requires an iterable");
    if (!js_is_callable(callback)) return throw_not_function(ctx, callback);
    Collection *c = new_collection(ctx, &map_class, ctx->intrinsics[JS_INTRINSIC_MAP_PROTOTYPE]);
    JSValue map = js_object_value(&c->obj);
    JSValue rec = js_iter_start(ctx, items);
    if (js_is_exception(rec)) return rec;
    for (double k = 0;; k++) {
        JSValue v = js_iter_next(ctx, rec);
        if (js_is_exception(v)) return v;
        if (js_is_empty(v)) return map;
        JSValue args[2] = { v, js_number(k) };
        JSValue key = js_call(ctx, callback, JS_UNDEFINED, 2, args);
        if (js_is_exception(key)) {
            js_iter_close_throw(ctx, rec);
            return JS_EXCEPTION;
        }
        Entry *e = collection_find(ctx, c, key);
        JSValue group = e ? e->value : js_new_array(ctx, 0);
        if (!e) collection_set(ctx, c, key, group);
        if (js_array_push(ctx, js_as_object(group), v) < 0) return JS_EXCEPTION;
    }
}

/* ---- Map.prototype (§24.1.3) ---------------------------------------------------------------- */

BUILTIN(map_get) {
    (void)callee, (void)new_target;
    THIS_MAP("Map.prototype.get");
    Entry *e = collection_find(ctx, c, ARG(0));
    return e ? e->value : JS_UNDEFINED;
}

BUILTIN(map_set) {
    (void)callee, (void)new_target;
    THIS_MAP("Map.prototype.set");
    collection_set(ctx, c, ARG(0), ARG(1));
    return this_val;
}

BUILTIN(map_has) {
    (void)callee, (void)new_target;
    THIS_MAP("Map.prototype.has");
    return js_bool(collection_find(ctx, c, ARG(0)) != NULL);
}

BUILTIN(map_delete) {
    (void)callee, (void)new_target;
    THIS_MAP("Map.prototype.delete");
    return js_bool(collection_delete(ctx, c, ARG(0)));
}

BUILTIN(map_clear) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    THIS_MAP("Map.prototype.clear");
    collection_clear(ctx, c);
    return JS_UNDEFINED;
}

/* Map.prototype.getOrInsert(key, value): key's value, after setting it to value if absent. */
BUILTIN(map_get_or_insert) {
    (void)callee, (void)new_target;
    THIS_MAP("Map.prototype.getOrInsert");
    Entry *e = collection_find(ctx, c, ARG(0));
    if (e) return e->value;
    collection_set(ctx, c, ARG(0), ARG(1));
    return ARG(1);
}

/* Map.prototype.getOrInsertComputed(key, callback): the callback's result is stored (even if
 * the callback added the key meanwhile). */
BUILTIN(map_get_or_insert_computed) {
    (void)callee, (void)new_target;
    THIS_MAP("Map.prototype.getOrInsertComputed");
    JSValue callback = ARG(1);
    if (!js_is_callable(callback)) return throw_not_function(ctx, callback);
    JSValue key = canonical_key(ARG(0));
    Entry *e = collection_find(ctx, c, key);
    if (e) return e->value;
    JSValue value = js_call(ctx, callback, JS_UNDEFINED, 1, &key);
    if (js_is_exception(value)) return value;
    collection_set(ctx, c, key, value);
    return value;
}

/* forEach (§24.1.3.5, §24.2.4.7): callback(value, key, collection) over the live entries. */
static JSValue for_each(JSContext *ctx, Collection *c, JSValue this_val, uint32_t argc, const JSValue *argv, bool pairs) {
    JSValue callback = ARG(0);
    if (!js_is_callable(callback)) return throw_not_callback(ctx, callback);
    Cursor k = cursor_start(c);
    for (Entry *e; (e = cursor_next(&k));) {
        JSValue args[3] = { pairs ? e->value : e->key, e->key, this_val };
        JSValue r = js_call(ctx, callback, ARG(1), 3, args);
        if (js_is_exception(r)) return r;
    }
    return JS_UNDEFINED;
}

BUILTIN(map_for_each) {
    (void)callee, (void)new_target;
    THIS_MAP("Map.prototype.forEach");
    return for_each(ctx, c, this_val, argc, argv, true);
}

BUILTIN(map_size) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    THIS_MAP("get Map.prototype.size");
    return js_number(table_of(c)->count);
}

/* ---- Map and Set iterators (§24.1.5, §24.2.6) ------------------------------------------------ */

enum { KIND_KEYS, KIND_VALUES, KIND_ENTRIES };

typedef struct CollectionIterator {
    JSObject obj;
    JSValue  table;  /* undefined once exhausted */
    uint32_t index;
    uint8_t  kind;
} CollectionIterator;

static void iterator_visit(JSCell *c, JSTracer *trc) { js_trace_value(trc, ((CollectionIterator *)c)->table); }

static const JSClass map_iterator_class = { "Map Iterator", sizeof(CollectionIterator), NULL, NULL, NULL, NULL, iterator_visit, NULL, NULL };
static const JSClass set_iterator_class = { "Set Iterator", sizeof(CollectionIterator), NULL, NULL, NULL, NULL, iterator_visit, NULL, NULL };

static JSValue new_iterator(JSContext *ctx, Collection *c, const JSClass *cls, JSIntrinsic proto, int kind) {
    JSShape *shape = js_shape_root(ctx, cls, ctx->intrinsics[proto], 0);
    CollectionIterator *it = (CollectionIterator *)js_alloc_object(ctx, JS_CELL_OBJECT, shape);
    js_store(ctx, &it->obj.cell, &it->table, c->table);
    it->index = 0;
    it->kind = (uint8_t)kind;
    return js_object_value(&it->obj);
}

static JSValue iterator_next(JSContext *ctx, JSValue this_val, const JSClass *cls, const char *method) {
    if (!js_is_object(this_val) || js_as_object(this_val)->shape->cls != cls) return throw_incompatible(ctx, method, this_val);
    CollectionIterator *it = (CollectionIterator *)js_as_object(this_val);
    if (js_is_undefined(it->table)) return js_iter_result(ctx, JS_UNDEFINED, true);
    Cursor k = { (Table *)js_as_cell(it->table), it->index };
    Entry *e = cursor_next(&k);
    if (!e) {
        js_store(ctx, &it->obj.cell, &it->table, JS_UNDEFINED);
        return js_iter_result(ctx, JS_UNDEFINED, true);
    }
    js_store(ctx, &it->obj.cell, &it->table, js_cell(&k.table->host.cell));
    it->index = k.index;
    JSValue value = cls == &set_iterator_class ? e->key : e->value;  /* a Set's value is its key */
    if (it->kind == KIND_KEYS) value = e->key;
    if (it->kind == KIND_ENTRIES) {
        JSValue pair[2] = { e->key, value };
        value = js_new_array_from(ctx, pair, 2);
    }
    return js_iter_result(ctx, value, false);
}

BUILTIN(map_iterator_next) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    return iterator_next(ctx, this_val, &map_iterator_class, "Map Iterator.prototype.next");
}

BUILTIN(set_iterator_next) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    return iterator_next(ctx, this_val, &set_iterator_class, "Set Iterator.prototype.next");
}

#define MAP_ITERATOR_METHOD(fn, kind, method)                                                          \
    BUILTIN(fn) {                                                                                      \
        (void)callee, (void)argc, (void)argv, (void)new_target;                                        \
        THIS_MAP(method);                                                                              \
        return new_iterator(ctx, c, &map_iterator_class, JS_INTRINSIC_MAP_ITERATOR_PROTOTYPE, kind);   \
    }
MAP_ITERATOR_METHOD(map_keys, KIND_KEYS, "Map.prototype.keys")
MAP_ITERATOR_METHOD(map_values, KIND_VALUES, "Map.prototype.values")
MAP_ITERATOR_METHOD(map_entries, KIND_ENTRIES, "Map.prototype.entries")

BUILTIN(set_values) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    THIS_SET("Set.prototype.values");
    return new_iterator(ctx, c, &set_iterator_class, JS_INTRINSIC_SET_ITERATOR_PROTOTYPE, KIND_VALUES);
}

BUILTIN(set_entries) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    THIS_SET("Set.prototype.entries");
    return new_iterator(ctx, c, &set_iterator_class, JS_INTRINSIC_SET_ITERATOR_PROTOTYPE, KIND_ENTRIES);
}

/* ---- Set.prototype (§24.2.4) ------------------------------------------------------------------ */

static void set_add(JSContext *ctx, Collection *c, JSValue v) {
    if (!collection_find(ctx, c, v)) collection_set(ctx, c, v, JS_UNDEFINED);
}

BUILTIN(set_proto_add) {
    (void)callee, (void)new_target;
    THIS_SET("Set.prototype.add");
    set_add(ctx, c, ARG(0));
    return this_val;
}

BUILTIN(set_has) {
    (void)callee, (void)new_target;
    THIS_SET("Set.prototype.has");
    return js_bool(collection_find(ctx, c, ARG(0)) != NULL);
}

BUILTIN(set_delete) {
    (void)callee, (void)new_target;
    THIS_SET("Set.prototype.delete");
    return js_bool(collection_delete(ctx, c, ARG(0)));
}

BUILTIN(set_clear) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    THIS_SET("Set.prototype.clear");
    collection_clear(ctx, c);
    return JS_UNDEFINED;
}

BUILTIN(set_for_each) {
    (void)callee, (void)new_target;
    THIS_SET("Set.prototype.forEach");
    return for_each(ctx, c, this_val, argc, argv, false);
}

BUILTIN(set_size) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    THIS_SET("get Set.prototype.size");
    return js_number(table_of(c)->count);
}

/* ---- The Set methods (§24.2.4: union, intersection, …) ----------------------------------------- */

/* GetSetRecord (§24.2.1.2): the other set's size, has and keys. */
typedef struct SetRecord {
    JSValue set, has, keys;
    double  size;
} SetRecord;

static int get_set_record(JSContext *ctx, JSValue other, const char *method, SetRecord *r) {
    if (!js_is_object(other)) {
        js_discard(js_throw_type_error(ctx, "%s argument must be an object", method));
        return -1;
    }
    JSValue raw = js_get_value(ctx, other, js_atom_from_cstr(ctx, "size"));
    if (js_is_exception(raw)) return -1;
    double n;
    if (js_to_number(ctx, &n, raw) < 0) return -1;
    if (isnan(n)) {
        js_discard(js_throw_type_error(ctx, "The .size property is NaN"));
        return -1;
    }
    if (js_to_integer_or_infinity(ctx, &n, js_number(n)) < 0) return -1;
    if (n < 0) {
        JSValue s = js_to_string(ctx, js_number(n));
        char t[64];
        t[js_view_to_utf8(js_string_view(ctx, s), t, sizeof t - 1)] = '\0';
        js_discard(js_throw_range_error(ctx, "'%s' is an invalid size", t));
        return -1;
    }
    JSValue has = js_get_value(ctx, other, js_atom_from_cstr(ctx, "has"));
    if (js_is_exception(has)) return -1;
    if (!js_is_callable(has)) {
        js_discard(js_throw_type_error(ctx, "string \"has\" is not a function"));
        return -1;
    }
    JSValue keys = js_get_value(ctx, other, js_atom_from_cstr(ctx, "keys"));
    if (js_is_exception(keys)) return -1;
    if (!js_is_callable(keys)) {
        js_discard(js_throw_type_error(ctx, "string \"keys\" is not a function"));
        return -1;
    }
    *r = (SetRecord){ other, has, keys, n };
    return 0;
}

/* GetIteratorFromMethod(other, keys), then IteratorStepValue and IteratorClose on it. */
typedef struct KeysIter {
    JSValue iterator, next;
} KeysIter;

static int keys_start(JSContext *ctx, const SetRecord *r, KeysIter *k) {
    JSValue it = js_call(ctx, r->keys, r->set, 0, NULL);
    if (js_is_exception(it)) return -1;
    if (!js_is_object(it)) {
        js_discard(js_throw_type_error(ctx, "Result of the keys method is not an object"));
        return -1;
    }
    JSValue next = js_get_value(ctx, it, JS_ATOM(next));
    if (js_is_exception(next)) return -1;
    *k = (KeysIter){ it, next };
    return 0;
}

/* The next key (canonical), EMPTY when done, or EXCEPTION. */
static JSValue keys_step(JSContext *ctx, KeysIter *k) {
    if (!js_is_callable(k->next)) return js_throw_type_error(ctx, "string \"next\" is not a function");
    JSValue result = js_call(ctx, k->next, k->iterator, 0, NULL);
    if (js_is_exception(result)) return result;
    if (!js_is_object(result)) {
        char what[128];
        js_describe_value(ctx, result, what, sizeof what);
        return js_throw_type_error(ctx, "Iterator result %s is not an object", what);
    }
    JSValue done = js_get_value(ctx, result, JS_ATOM(done));
    if (js_is_exception(done)) return done;
    if (js_truthy(done)) return JS_EMPTY;
    JSValue v = js_get_value(ctx, result, JS_ATOM(value));
    return js_is_exception(v) ? v : canonical_key(v);
}

/* IteratorClose after a normal completion: 0, or -1. */
static int keys_close(JSContext *ctx, KeysIter *k) {
    JSValue ret = js_get_value(ctx, k->iterator, JS_ATOM(return));
    if (js_is_exception(ret)) return -1;
    if (js_is_nullish(ret)) return 0;
    if (!js_is_callable(ret)) {
        js_discard(throw_not_callback(ctx, ret));
        return -1;
    }
    JSValue r = js_call(ctx, ret, k->iterator, 0, NULL);
    if (js_is_exception(r)) return -1;
    if (!js_is_object(r)) {
        js_discard(js_throw_type_error(ctx, "The iterator's 'return' method returned a non-object"));
        return -1;
    }
    return 0;
}

/* ToBoolean(Call(other.has, other, « e »)): 1, 0, or -1. */
static int other_has(JSContext *ctx, const SetRecord *r, JSValue e) {
    JSValue v = js_call(ctx, r->has, r->set, 1, &e);
    return js_is_exception(v) ? -1 : js_truthy(v);
}

/* A new Set (of %Set.prototype%) holding c's elements. */
static Collection *copy_set(JSContext *ctx, Collection *c) {
    Collection *copy = new_collection(ctx, &set_class, ctx->intrinsics[JS_INTRINSIC_SET_PROTOTYPE]);
    Cursor k = cursor_start(c);
    for (Entry *e; (e = cursor_next(&k));) collection_add(ctx, copy, e->key, JS_UNDEFINED, e->hash);
    return copy;
}

#define SET_METHOD_PROLOGUE(method)                        \
    (void)callee, (void)new_target;                        \
    THIS_SET(method);                                      \
    SetRecord rec;                                         \
    if (get_set_record(ctx, ARG(0), method, &rec) < 0) return JS_EXCEPTION

BUILTIN(set_union) {
    SET_METHOD_PROLOGUE("Set.prototype.union");
    KeysIter k;
    if (keys_start(ctx, &rec, &k) < 0) return JS_EXCEPTION;
    Collection *result = copy_set(ctx, c);
    for (;;) {
        JSValue v = keys_step(ctx, &k);
        if (js_is_exception(v)) return v;
        if (js_is_empty(v)) return js_object_value(&result->obj);
        set_add(ctx, result, v);
    }
}

BUILTIN(set_intersection) {
    SET_METHOD_PROLOGUE("Set.prototype.intersection");
    Collection *result = new_collection(ctx, &set_class, ctx->intrinsics[JS_INTRINSIC_SET_PROTOTYPE]);
    if (table_of(c)->count <= rec.size) {
        Cursor cur = cursor_start(c);
        for (Entry *e; (e = cursor_next(&cur));) {
            JSValue v = e->key;
            int in = other_has(ctx, &rec, v);
            if (in < 0) return JS_EXCEPTION;
            if (in) set_add(ctx, result, v);
        }
    } else {
        KeysIter k;
        if (keys_start(ctx, &rec, &k) < 0) return JS_EXCEPTION;
        for (;;) {
            JSValue v = keys_step(ctx, &k);
            if (js_is_exception(v)) return v;
            if (js_is_empty(v)) break;
            if (collection_find(ctx, c, v)) set_add(ctx, result, v);
        }
    }
    return js_object_value(&result->obj);
}

BUILTIN(set_difference) {
    SET_METHOD_PROLOGUE("Set.prototype.difference");
    Collection *result = copy_set(ctx, c);
    if (table_of(c)->count <= rec.size) {
        /* the copy's elements, by index: has() may change this set, not the copy */
        uint32_t n = table_of(result)->used;
        for (uint32_t i = 0; i < n; i++) {
            JSValue v = table_of(result)->entries[i].key;
            if (js_is_empty(v)) continue;
            int in = other_has(ctx, &rec, v);
            if (in < 0) return JS_EXCEPTION;
            if (in) {  /* a hole, never a rehash: the indices must stay */
                Table *t = table_of(result);
                t->entries[i].key = JS_EMPTY;
                t->count--;
            }
        }
    } else {
        KeysIter k;
        if (keys_start(ctx, &rec, &k) < 0) return JS_EXCEPTION;
        for (;;) {
            JSValue v = keys_step(ctx, &k);
            if (js_is_exception(v)) return v;
            if (js_is_empty(v)) break;
            collection_delete(ctx, result, v);
        }
    }
    return js_object_value(&result->obj);
}

BUILTIN(set_symmetric_difference) {
    SET_METHOD_PROLOGUE("Set.prototype.symmetricDifference");
    KeysIter k;
    if (keys_start(ctx, &rec, &k) < 0) return JS_EXCEPTION;
    Collection *result = copy_set(ctx, c);
    for (;;) {
        JSValue v = keys_step(ctx, &k);
        if (js_is_exception(v)) return v;
        if (js_is_empty(v)) return js_object_value(&result->obj);
        bool in_result = collection_find(ctx, result, v) != NULL;
        if (collection_find(ctx, c, v)) {
            if (in_result) collection_delete(ctx, result, v);
        } else if (!in_result) {
            collection_set(ctx, result, v, JS_UNDEFINED);
        }
    }
}

BUILTIN(set_is_subset_of) {
    SET_METHOD_PROLOGUE("Set.prototype.isSubsetOf");
    if (table_of(c)->count > rec.size) return JS_FALSE;
    Cursor cur = cursor_start(c);
    for (Entry *e; (e = cursor_next(&cur));) {
        int in = other_has(ctx, &rec, e->key);
        if (in <= 0) return in < 0 ? JS_EXCEPTION : JS_FALSE;
    }
    return JS_TRUE;
}

BUILTIN(set_is_superset_of) {
    SET_METHOD_PROLOGUE("Set.prototype.isSupersetOf");
    if (table_of(c)->count < rec.size) return JS_FALSE;
    KeysIter k;
    if (keys_start(ctx, &rec, &k) < 0) return JS_EXCEPTION;
    for (;;) {
        JSValue v = keys_step(ctx, &k);
        if (js_is_exception(v)) return v;
        if (js_is_empty(v)) return JS_TRUE;
        if (!collection_find(ctx, c, v)) return keys_close(ctx, &k) < 0 ? JS_EXCEPTION : JS_FALSE;
    }
}

BUILTIN(set_is_disjoint_from) {
    SET_METHOD_PROLOGUE("Set.prototype.isDisjointFrom");
    if (table_of(c)->count <= rec.size) {
        Cursor cur = cursor_start(c);
        for (Entry *e; (e = cursor_next(&cur));) {
            int in = other_has(ctx, &rec, e->key);
            if (in != 0) return in < 0 ? JS_EXCEPTION : JS_FALSE;
        }
        return JS_TRUE;
    }
    KeysIter k;
    if (keys_start(ctx, &rec, &k) < 0) return JS_EXCEPTION;
    for (;;) {
        JSValue v = keys_step(ctx, &k);
        if (js_is_exception(v)) return v;
        if (js_is_empty(v)) return JS_TRUE;
        if (collection_find(ctx, c, v)) return keys_close(ctx, &k) < 0 ? JS_EXCEPTION : JS_FALSE;
    }
}

/* ---- util.inspect's view (inspect.c, through rt->collection_preview) ------------------------- */

/* A Map's or Set's entries, or what an iterator has left: an array of [k1, v1, k2, v2, …] when
 * *pairs (a Map, an entries iterator), else of values. EMPTY for any other value. */
static JSValue collection_preview(JSContext *ctx, JSValue v, JSCollectionPreview *what) {
    if (!js_is_object(v)) return JS_EMPTY;
    const JSClass *cls = js_as_object(v)->shape->cls;
    Cursor k;
    bool pairs, values;
    if (cls == &map_class || cls == &set_class) {
        k = cursor_start((Collection *)js_as_object(v));
        pairs = cls == &map_class;
        values = false;
        *what = pairs ? JS_PREVIEW_MAP : JS_PREVIEW_SET;
    } else if (cls == &map_iterator_class || cls == &set_iterator_class) {
        CollectionIterator *it = (CollectionIterator *)js_as_object(v);
        *what = cls == &map_iterator_class ? JS_PREVIEW_MAP_ITERATOR : JS_PREVIEW_SET_ITERATOR;
        pairs = it->kind == KIND_ENTRIES;
        values = it->kind == KIND_VALUES && cls == &map_iterator_class;
        if (pairs) *what = cls == &map_iterator_class ? JS_PREVIEW_MAP_ENTRIES : JS_PREVIEW_SET_ENTRIES;
        if (js_is_undefined(it->table)) return js_new_array(ctx, 0);
        k = (Cursor){ (Table *)js_as_cell(it->table), it->index };
    } else {
        return JS_EMPTY;
    }
    JSValue out = js_new_array(ctx, 0);
    for (Entry *e; (e = cursor_next(&k));) {
        bool is_set = cls == &set_class || cls == &set_iterator_class;
        if (js_array_push(ctx, js_as_object(out), values ? e->value : e->key) < 0) return JS_EXCEPTION;
        if (pairs && js_array_push(ctx, js_as_object(out), is_set ? e->key : e->value) < 0) return JS_EXCEPTION;
    }
    return out;
}

/* ---- Realm ------------------------------------------------------------------------------------- */

static const JSBuiltin map_statics[] = {
    JS_BUILTIN_FN("groupBy", map_group_by, 2),
    JS_BUILTIN_SYMBOL_GETTER(species, get_species),
};

static const JSBuiltin map_proto[] = {
    JS_BUILTIN_FN("get", map_get, 1),
    JS_BUILTIN_FN("set", map_set, 2),
    JS_BUILTIN_FN("has", map_has, 1),
    JS_BUILTIN_FN("delete", map_delete, 1),
    JS_BUILTIN_FN("clear", map_clear, 0),
    JS_BUILTIN_FN("entries", map_entries, 0),
    JS_BUILTIN_FN("forEach", map_for_each, 1),
    JS_BUILTIN_FN("keys", map_keys, 0),
    JS_BUILTIN_GETTER("size", map_size),
    JS_BUILTIN_FN("values", map_values, 0),
    JS_BUILTIN_FN("getOrInsert", map_get_or_insert, 2),
    JS_BUILTIN_FN("getOrInsertComputed", map_get_or_insert_computed, 2),
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "Map", JS_PROP_CONFIGURABLE),
    JS_BUILTIN_SYMBOL_ALIAS(iterator, "entries"),
};

static const JSBuiltin set_statics[] = {
    JS_BUILTIN_SYMBOL_GETTER(species, get_species),
};

static const JSBuiltin set_proto[] = {
    JS_BUILTIN_FN("has", set_has, 1),
    JS_BUILTIN_FN("add", set_proto_add, 1),
    JS_BUILTIN_FN("delete", set_delete, 1),
    JS_BUILTIN_FN("clear", set_clear, 0),
    JS_BUILTIN_FN("entries", set_entries, 0),
    JS_BUILTIN_FN("forEach", set_for_each, 1),
    JS_BUILTIN_GETTER("size", set_size),
    JS_BUILTIN_FN("values", set_values, 0),
    JS_BUILTIN_ALIAS("keys", "values"),
    JS_BUILTIN_FN("union", set_union, 1),
    JS_BUILTIN_FN("intersection", set_intersection, 1),
    JS_BUILTIN_FN("difference", set_difference, 1),
    JS_BUILTIN_FN("symmetricDifference", set_symmetric_difference, 1),
    JS_BUILTIN_FN("isSubsetOf", set_is_subset_of, 1),
    JS_BUILTIN_FN("isSupersetOf", set_is_superset_of, 1),
    JS_BUILTIN_FN("isDisjointFrom", set_is_disjoint_from, 1),
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "Set", JS_PROP_CONFIGURABLE),
    JS_BUILTIN_SYMBOL_ALIAS(iterator, "values"),
};

static const JSBuiltin map_iterator_proto[] = {
    JS_BUILTIN_FN("next", map_iterator_next, 0),
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "Map Iterator", JS_PROP_CONFIGURABLE),
};

static const JSBuiltin set_iterator_proto[] = {
    JS_BUILTIN_FN("next", set_iterator_next, 0),
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "Set Iterator", JS_PROP_CONFIGURABLE),
};

static void define_class(JSContext *ctx, JSObject *global, const char *name, JSNativeFn ctor, JSIntrinsic proto_slot,
                         const JSBuiltin *statics, size_t nstatics, const JSBuiltin *methods, size_t n) {
    JSValue proto = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 8);
    ctx->intrinsics[proto_slot] = proto;
    JSValue key = js_atom_from_cstr(ctx, name);
    JSValue c = js_new_native(ctx, ctor, key, 0, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), proto, 0);
    js_define_builtins(ctx, js_as_object(c), statics, nstatics);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), c, JS_BUILTIN_METHOD_ATTRS);
    js_define_builtins(ctx, js_as_object(proto), methods, n);
    js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
}

static void install_collections(JSContext *ctx, JSObject *global) {
    define_class(ctx, global, "Map", map_ctor, JS_INTRINSIC_MAP_PROTOTYPE, map_statics, JS_COUNTOF(map_statics), map_proto, JS_COUNTOF(map_proto));
    define_class(ctx, global, "Set", set_ctor, JS_INTRINSIC_SET_PROTOTYPE, set_statics, JS_COUNTOF(set_statics), set_proto, JS_COUNTOF(set_proto));
    JSValue iterator_proto = ctx->intrinsics[JS_INTRINSIC_ITERATOR_PROTOTYPE];
    ctx->intrinsics[JS_INTRINSIC_MAP_ITERATOR_PROTOTYPE] = js_new_object_proto(ctx, iterator_proto, 2);
    js_define_builtins(ctx, js_as_object(ctx->intrinsics[JS_INTRINSIC_MAP_ITERATOR_PROTOTYPE]), map_iterator_proto, JS_COUNTOF(map_iterator_proto));
    ctx->intrinsics[JS_INTRINSIC_SET_ITERATOR_PROTOTYPE] = js_new_object_proto(ctx, iterator_proto, 2);
    js_define_builtins(ctx, js_as_object(ctx->intrinsics[JS_INTRINSIC_SET_ITERATOR_PROTOTYPE]), set_iterator_proto, JS_COUNTOF(set_iterator_proto));
    ctx->rt->collection_preview = collection_preview;
}

const JSComponent js_component_collections = { "collections", install_collections };
