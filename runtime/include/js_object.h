/*
 * js_object.h — the object model: shapes, objects, property keys,
 * and the ordinary internal methods ([[Get]], [[Set]], [[DefineOwnProperty]], …).
 *
 * Named properties (atoms, symbols) live in shape-described slots; indexed
 * properties (array indices, int32 keys) live in the elements store.
 */
#ifndef JS_OBJECT_H
#define JS_OBJECT_H

#include "js_exception.h"
#include "jsstring.h"

/* ---- Property attributes ------------------------------------------------ */

#define JS_PROP_WRITABLE      0x01u
#define JS_PROP_ENUMERABLE    0x02u
#define JS_PROP_CONFIGURABLE  0x04u
#define JS_PROP_ACCESSOR      0x08u  /* the slot holds a JSAccessorPair */
#define JS_PROP_DEFAULT       (JS_PROP_WRITABLE | JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE)

/* A property descriptor (§6.2.6): which fields are present, and their values. */
#define JS_DESC_VALUE         0x01u
#define JS_DESC_GET           0x02u
#define JS_DESC_SET           0x04u
#define JS_DESC_WRITABLE      0x08u
#define JS_DESC_ENUMERABLE    0x10u
#define JS_DESC_CONFIGURABLE  0x20u

typedef struct JSPropertyDescriptor {
    uint8_t has;     /* JS_DESC_* */
    uint8_t attrs;   /* JS_PROP_WRITABLE/ENUMERABLE/CONFIGURABLE, meaningful where `has` says so */
    JSValue value;
    JSValue get;     /* undefined or a function */
    JSValue set;
} JSPropertyDescriptor;

/* A data property with the given attributes. */
static inline JSPropertyDescriptor js_data_descriptor(JSValue value, uint8_t attrs) {
    JSPropertyDescriptor d = { JS_DESC_VALUE | JS_DESC_WRITABLE | JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE,
                               (uint8_t)(attrs & JS_PROP_DEFAULT), value, JS_UNDEFINED, JS_UNDEFINED };
    return d;
}

/* ---- Cells ---------------------------------------------------------------- */

typedef struct JSObject JSObject;
typedef struct JSShape JSShape;
typedef struct JSPropTable JSPropTable;
typedef struct JSTransitions JSTransitions;

/* A class hook returns this to fall back to the ordinary algorithm for a key. */
#define JS_ORDINARY 2
/* JS_ORDINARY, but the answer for this key isn't a function of the shape: caches don't remember it. */
#define JS_ORDINARY_UNCACHED 3

/* Exotic behavior. NULL hooks mean ordinary behavior.
 * Grows as exotic objects arrive (Function, arguments, Proxy…). Inline caches rely on
 * this: whether a hook takes over a named key depends only on the object's shape, or
 * the hook changes the shape (Function's lazy `prototype`). */
/* The internal methods an object overrides (Proxy §10.5, typed arrays §10.4.5): the core calls
 * these instead of the ordinary algorithms, also when the object is on a prototype chain. A NULL
 * entry is the ordinary method. [[GetOwnProperty]], [[DefineOwnProperty]] and [[Delete]] are the
 * class hooks above. Results as the core functions: 1/0/-1, or a value / JS_EXCEPTION. */
typedef struct JSObjectMethods {
    JSValue (*get_prototype_of)(JSContext *ctx, JSObject *o);
    int     (*set_prototype_of)(JSContext *ctx, JSObject *o, JSValue proto);
    int     (*is_extensible)(JSContext *ctx, JSObject *o);
    int     (*prevent_extensions)(JSContext *ctx, JSObject *o);
    int     (*has_property)(JSContext *ctx, JSObject *o, JSValue key);
    JSValue (*get)(JSContext *ctx, JSObject *o, JSValue key, JSValue receiver);
    int     (*set)(JSContext *ctx, JSObject *o, JSValue key, JSValue v, JSValue receiver, bool throw_on_fail);
    JSValue (*own_keys)(JSContext *ctx, JSObject *o);  /* a JSValueArray cell of property keys */
    /* Proxies only: the target without running traps (IsArray, util.inspect), JS_NULL once
     * revoked. Inline caches never remember a lookup that meets an object with it. */
    JSValue (*target)(JSObject *o);
} JSObjectMethods;

typedef struct JSClass {
    const char *name;
    /* Bytes before the inline slots: sizeof(JSObject) plus the class's own fields. */
    uint16_t instance_size;
    int (*get_own_property)(JSContext *ctx, JSObject *o, JSValue key, JSPropertyDescriptor *out);
    int (*define_own_property)(JSContext *ctx, JSObject *o, JSValue key, const JSPropertyDescriptor *desc, bool throw_on_fail);
    int (*delete_property)(JSContext *ctx, JSObject *o, JSValue key, bool throw_on_fail);
    /* Own string keys that come before the shape's (Array: "length"); count returned, keys written to out[]. */
    uint32_t (*extra_keys)(JSContext *ctx, JSObject *o, JSValue *out);
    void (*visit)(JSCell *cell, JSTracer *trc);            /* fields beyond JSObject */
    void (*finalize)(JSRuntime *rt, JSCell *cell);
    const JSObjectMethods *methods;  /* NULL: the ordinary internal methods */
} JSClass;

extern const JSClass js_class_object;  /* ordinary objects */
extern const JSClass js_class_array;   /* Array exotic objects (§10.4.2) */

#define JS_SHAPE_EXTENSIBLE  0x01u
#define JS_SHAPE_DICTIONARY  0x02u  /* private to one object; its table is the mutable truth */

struct JSShape {                    /* kind = SHAPE */
    JSCell         cell;
    const JSClass *cls;
    JSValue        proto;           /* an object or null */
    JSShape       *parent;          /* the shape before `key` was added; NULL for roots and dictionaries */
    JSValue        key;             /* added by this transition; EMPTY for roots */
    uint8_t        attrs;           /* of `key` */
    uint8_t        flags;           /* JS_SHAPE_* */
    uint16_t       inline_cap;      /* inline slots of objects with this shape */
    uint32_t       prop_count;      /* named properties = slots in use */
    uint16_t       slot_offset;     /* where inline slots start in the object: cls->instance_size */
    uint16_t       pad_;
    JSPropTable   *table;           /* key → (slot, attrs): lazy for shared shapes, the truth for dictionaries */
    JSTransitions *transitions;     /* (key, attrs) → child shape; weak */
    /* for…in's keys of objects with this shape (shared shapes only): its enumerable string keys
     * in order, a JSValueArray; EMPTY until a for…in first needs them (iterate.c) */
    JSValue        enum_keys;
};

/* The slot of an accessor property holds one of these. */
typedef struct JSAccessorPair {     /* kind = ACCESSOR */
    JSCell  cell;
    JSValue get;                    /* a function or undefined */
    JSValue set;
} JSAccessorPair;

#define JS_ELEMENTS_DENSE   0
#define JS_ELEMENTS_SPARSE  1  /* a JSSparseElements (elements.h) */

typedef struct JSElements {         /* kind = ELEMENTS */
    JSCell   cell;
    uint8_t  kind;                  /* JS_ELEMENTS_DENSE / SPARSE */
    uint8_t  flags;
    uint16_t pad_;
    uint32_t length;                /* DENSE: slots in use (index of the last present element + 1, at most) */
    uint32_t capacity;              /* DENSE: allocated slots */
    uint32_t pad2_;
    JSValue  data[];                /* DENSE: values; EMPTY = hole (and zero-filled memory is EMPTY) */
} JSElements;

/* The header of every object. The class's own fields (if any) follow it, then
 * shape->inline_cap inline named slots, at shape->slot_offset. */
struct JSObject {                   /* kind >= JS_CELL_OBJECT */
    JSCell        cell;             /* arrays: aux = length */
    JSShape      *shape;
    JSValueArray *ool;              /* overflow named slots, NULL until needed */
    JSElements   *elements;         /* never NULL: the static empty store at first */
};

static inline JSValue *js_object_slots(JSObject *o) {
    return (JSValue *)((char *)o + o->shape->slot_offset);
}

#define JS_DEFAULT_INLINE_SLOTS 4
#define JS_MAX_INLINE_SLOTS     64
#define JS_DICTIONARY_THRESHOLD 128  /* named properties before an object becomes a dictionary */

static inline bool js_is_object(JSValue v) {
    return js_is_cell(v) && js_as_cell(v)->kind >= JS_CELL_OBJECT;
}

static inline JSObject *js_as_object(JSValue v) { return (JSObject *)js_as_cell(v); }
static inline JSValue js_object_value(JSObject *o) { return js_cell(&o->cell); }

/* The shared, static, empty elements store. */
extern const JSElements js_empty_elements;

/* ---- Shapes ----------------------------------------------------------------- */

/* The root shape for (class, proto, inline capacity): shared, weakly held. */
JSShape *js_shape_root(JSContext *ctx, const JSClass *cls, JSValue proto, uint16_t inline_cap);
/* The shape after adding `key` with `attrs` (a shared transition). */
JSShape *js_shape_add(JSContext *ctx, JSShape *shape, JSValue key, uint8_t attrs);
/* The shape of (cls, proto, inline_cap) with `n` keys added (each with `attrs`), cached in the
 * realm's intrinsic `slot`: objects every program makes many of (functions, iterator results)
 * start with their properties in place, their slots filled directly, no transitions. */
JSShape *js_cached_shape(JSContext *ctx, JSIntrinsic slot, const JSClass *cls, JSValue proto, uint16_t inline_cap,
                         uint32_t n, const JSValue *keys, uint8_t attrs);
/* Finds `key`: its slot, and attrs in *attrs; -1 if absent. */
int32_t js_shape_find(JSShape *shape, JSValue key, uint8_t *attrs);

/* ---- Objects ----------------------------------------------------------------- */

/* A new object of `kind` with `shape`: header, class fields, inline slots (undefined), empty elements. */
JSObject *js_alloc_object(JSContext *ctx, JSCellKind kind, JSShape *shape);
/* {} with Object.prototype. */
JSValue js_new_object(JSContext *ctx);
/* An ordinary object with the given prototype (an object or null). */
JSValue js_new_object_proto(JSContext *ctx, JSValue proto, uint16_t inline_cap);

/* The value in slot `n` of `o`, inline or overflow. */
static inline JSValue *js_object_slot(JSObject *o, uint32_t n) {
    uint16_t cap = o->shape->inline_cap;
    return n < cap ? &js_object_slots(o)[n] : &o->ool->values[n - cap];
}

/* ---- Property keys --------------------------------------------------------------- */

/* A key: an array index (a number: int32 below 2^31, a double up to 2^32 - 2), an atom,
 * or a symbol. JS_EXCEPTION on failure. */
JS_WARN_UNUSED JSValue js_to_property_key(JSContext *ctx, JSValue v);
static inline bool js_key_is_index(JSValue key) { return js_is_number(key); }
static inline uint32_t js_key_index(JSValue key) {
    return js_is_int32(key) ? (uint32_t)js_as_int32(key) : (uint32_t)js_as_double(key);
}
/* The key for array index i. */
static inline JSValue js_index_key(uint32_t i) {
    return i < 2147483647u ? js_int32((int32_t)i) : js_double((double)i);
}

/* ---- Arrays ------------------------------------------------------------------------- */

#define JS_MAX_ARRAY_LENGTH 4294967295.0

static inline bool js_is_array(JSValue v) {
    return js_is_cell(v) && js_as_cell(v)->kind == JS_CELL_ARRAY;
}
static inline uint32_t js_array_length(JSObject *a) { return a->cell.aux; }

/* A new dense array: length 0, room for `capacity` elements. */
JSValue js_new_array(JSContext *ctx, uint32_t capacity);
/* A new array holding `n` values. */
JSValue js_new_array_from(JSContext *ctx, const JSValue *values, uint32_t n);
JS_WARN_UNUSED int js_array_push(JSContext *ctx, JSObject *a, JSValue v);
/* Generated code building a list with spreads (array literals, arguments): appends v
 * (EMPTY: a hole), or every element of an iterable. 0, or -1 on exception. */
JS_WARN_UNUSED int js_array_append(JSContext *ctx, JSValue arr, JSValue v);
JS_WARN_UNUSED int js_array_spread(JSContext *ctx, JSValue arr, JSValue iterable);
/* An object literal's getter or setter (the other, EMPTY, is left as it is): enumerable, configurable. */
void js_define_accessor(JSContext *ctx, JSObject *o, JSValue key, JSValue get, JSValue set);

/* ---- Internal methods (ordinary objects; exotic hooks arrive with their classes) ---- */

/* Results: 1 true, 0 false, -1 exception. */
JS_WARN_UNUSED int js_get_own_property(JSContext *ctx, JSObject *o, JSValue key, JSPropertyDescriptor *out);
JS_WARN_UNUSED int js_define_own_property(JSContext *ctx, JSObject *o, JSValue key, const JSPropertyDescriptor *desc, bool throw_on_fail);
JS_WARN_UNUSED int js_has_property(JSContext *ctx, JSObject *o, JSValue key);
JS_WARN_UNUSED int js_delete_property(JSContext *ctx, JSObject *o, JSValue key, bool throw_on_fail);
JS_WARN_UNUSED JSValue js_get(JSContext *ctx, JSObject *o, JSValue key, JSValue receiver);
JS_WARN_UNUSED int js_set(JSContext *ctx, JSObject *o, JSValue key, JSValue v, JSValue receiver, bool throw_on_fail);
/* The ordinary [[GetPrototypeOf]]: no user code (a proxy answers null). */
JSValue js_get_prototype_of(JSObject *o);
/* [[GetPrototypeOf]] and [[IsExtensible]] of any object, proxies' traps included. */
JS_WARN_UNUSED JSValue js_object_get_prototype_of(JSContext *ctx, JSObject *o);
JS_WARN_UNUSED int js_object_is_extensible(JSContext *ctx, JSObject *o);
/* IsArray (§7.2.2): through proxies; 1, 0, or -1 for a revoked one. */
JS_WARN_UNUSED int js_is_array_spec(JSContext *ctx, JSValue v);
/* A proxy's target without running traps (JS_NULL once revoked); EMPTY if v isn't a proxy. */
JSValue js_proxy_target(JSValue v);
/* The prototype a primitive's properties come from (ToObject(v).[[Prototype]]); v not nullish. */
JSObject *js_primitive_prototype(JSContext *ctx, JSValue v);

/* ---- Primitive wrappers (wrapper.c) --------------------------------------------------- */

extern const JSClass js_class_primitive_wrapper;
/* A wrapper for a non-nullish primitive, with `proto` (or the primitive's prototype if
 * `proto` isn't an object): new Number(1), Object("ab"). */
JSValue js_new_wrapper(JSContext *ctx, JSValue prim, JSValue proto);
/* ToObject (§7.1.18): objects as they are, primitives wrapped, a TypeError for null/undefined. */
JS_WARN_UNUSED JSValue js_to_object(JSContext *ctx, JSValue v);
bool js_is_wrapper(JSValue v);
JSValue js_wrapped_value(JSValue wrapper);
/* thisNumberValue and the like: v if `is_type(v)`, a wrapper's primitive if it is, else EMPTY. */
JSValue js_this_primitive(JSValue v, bool (*is_type)(JSValue));
JS_WARN_UNUSED int js_set_prototype_of(JSContext *ctx, JSObject *o, JSValue proto);
/* The ordinary [[IsExtensible]] (a proxy answers from its own shape: use js_object_is_extensible). */
bool js_is_extensible(JSObject *o);
JS_WARN_UNUSED int js_prevent_extensions(JSContext *ctx, JSObject *o);
/* Iterators (§7.4): GetIterator as a record, its next value (JS_EMPTY when done), and
 * IteratorClose after a normal completion (0 or -1) or a throw (the exception stays). */
JSValue js_iter_start(JSContext *ctx, JSValue v);
JSValue js_iter_next(JSContext *ctx, JSValue rec);
JS_WARN_UNUSED int js_iter_close(JSContext *ctx, JSValue rec);
void js_iter_close_throw(JSContext *ctx, JSValue rec);
/* Destructuring: an array pattern's next value (undefined when done) and rest array; an
 * object pattern's RequireObjectCoercible and rest object (all own enumerable properties
 * but the keys in the array `excluded`). */
JSValue js_iter_value(JSContext *ctx, JSValue rec);
JSValue js_iter_rest(JSContext *ctx, JSValue rec);
JSValue js_require_coercible(JSContext *ctx, JSValue v);
JSValue js_object_rest(JSContext *ctx, JSValue source, JSValue excluded);
/* `{ ...source }`: CopyDataProperties onto an object literal. 0, or -1 on exception. */
JS_WARN_UNUSED int js_object_spread(JSContext *ctx, JSValue target, JSValue source);
/* CreateIterResultObject: { value, done }. */
JSValue js_iter_result(JSContext *ctx, JSValue value, bool done);
/* LengthOfArrayLike: ToLength(obj.length) (§7.3.18); 0 or -1. */
JS_WARN_UNUSED int js_length_of_array_like(JSContext *ctx, JSValue obj, double *out);
void js_iterator_realm_init(JSContext *ctx);
/* for…in (§14.7.5): an iterator over v's enumerable string keys, prototypes included, and
 * its next key (a string; undefined when done; JS_EXCEPTION). */
JSValue js_for_in_start(JSContext *ctx, JSValue v);
JSValue js_for_in_next(JSContext *ctx, JSValue it);
/* The own keys in spec order (indices ascending, then strings, then symbols, by insertion). */
JS_WARN_UNUSED JSValue js_own_keys(JSContext *ctx, JSObject *o);

/* ---- Inline caches --------------------------------------------------------------- */

#define JS_IC_EMPTY  0
#define JS_IC_OWN    1  /* get: an own data property; set: an own writable data property */
#define JS_IC_PROTO  2  /* get: a data property of `holder`, `depth` prototypes up */
#define JS_IC_ADD    3  /* set: adding the key takes the receiver from `shape` to `next`; `depth` prototypes up to null, or to one whose writable data property it shadows */
#define JS_IC_GETTER 4  /* get: an accessor of `holder` (NULL: the receiver), `depth` prototypes up */
#define JS_IC_ABSENT 5  /* get: no such property on the receiver or its `depth` prototypes (the last's proto is null) */
#define JS_IC_MAX_DEPTH 8  /* prototypes a cache can check: Node's sockets are 6 deep (Socket, Duplex, Readable, Stream, EventEmitter, Object) */

/* One per property access site with a constant named key; a site is either a get or a
 * set. Monomorphic: a miss refills it. Never caches dictionary shapes (their layout
 * changes under the same pointer). Weak: the GC resets a cache whose shapes or holder
 * die, so every cache must be registered (js_register_prop_caches).
 *
 * `fast` is what the inline paths (js_get_prop, js_set_prop) test: the receiver shape of
 * an OWN cache whose slot is inline, else NULL. A hit is then one compare and one load at
 * `fast_off`, inlined at every access site; the other kinds, and OWN in an overflow slot,
 * hit in the out-of-line slow path. */
typedef struct JSPropCache {
    JSShape  *fast;                     /* OWN, inline slot: the receiver shape; else NULL */
    uint16_t  fast_off;                 /* with `fast`: the slot's byte offset in the object */
    uint8_t   kind;                     /* JS_IC_* */
    uint8_t   depth;                    /* PROTO: hops to the holder; ADD: prototypes checked (JS_IC_ADD) */
    uint32_t  slot;                     /* OWN, PROTO: the slot */
    JSShape  *shape;                    /* receiver shape; NULL = empty */
    JSObject *holder;                   /* PROTO */
    JSShape  *next;                     /* ADD */
    JSShape  *chain[JS_IC_MAX_DEPTH];   /* PROTO, ADD: the prototypes' shapes, checked on a hit */
    uint32_t  epoch;                    /* PROTO, ADD: the runtime's proto_epoch when `chain` was last seen to hold */
} JSPropCache;

/* A module's caches, once at startup (the GC resets them weakly). */
void js_register_prop_caches(JSRuntime *rt, JSPropCache *ics, size_t n);

/* The slow paths of a named access: `ic` is the site's cache, or NULL for a computed key's access
 * (the runtime's shared caches only). */
JS_WARN_UNUSED JSValue js_get_prop_slow(JSContext *ctx, JSValue obj, JSValue key, JSPropCache *ic);
JS_WARN_UNUSED int js_set_prop_slow(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict, JSPropCache *ic);

/* The slot a fast hit reads or writes. */
static inline JSValue *js_prop_cache_slot(JSObject *o, const JSPropCache *ic) {
    return (JSValue *)((char *)o + ic->fast_off);
}

/* obj.key with a named key (an atom). A hit is a type check, a shape compare and a load:
 * inlined at every site, so it stays this small (the rest is js_get_prop_slow's). */
static inline JSValue js_get_prop(JSContext *ctx, JSValue obj, JSValue key, JSPropCache *ic) {
    if (JS_LIKELY(js_is_object(obj)) && js_as_object(obj)->shape == ic->fast) return *js_prop_cache_slot(js_as_object(obj), ic);
    return js_get_prop_slow(ctx, obj, key, ic);
}

/* obj.key where the value is called (a method, optimizer step 11): js_get_prop, and a hit on
 * the prototype that holds it inline too, while no prototype has changed shape since the cache
 * saw the chain (proto_epoch). */
static JS_FAST_PATH JSValue js_get_method(JSContext *ctx, JSValue obj, JSValue key, JSPropCache *ic) {
    if (JS_LIKELY(js_is_object(obj))) {
        JSObject *o = js_as_object(obj);
        if (o->shape == ic->fast) return *js_prop_cache_slot(o, ic);
        if (JS_LIKELY(o->shape == ic->shape && ic->kind == JS_IC_PROTO && ic->epoch == ctx->rt->proto_epoch))
            return *js_object_slot(ic->holder, ic->slot);
    }
    return js_get_prop_slow(ctx, obj, key, ic);
}

/* s.key where the compiler proved s a string and key is neither `length` nor an index: a
 * property of String.prototype (a string has no other own properties), which `ic` caches with
 * String.prototype as the receiver. A hit is that object's shape compare and a load. */
static inline JSValue js_get_string_prop(JSContext *ctx, JSValue s, JSValue key, JSPropCache *ic) {
    JSObject *p = js_as_object(ctx->intrinsics[JS_INTRINSIC_STRING_PROTOTYPE]);
    if (JS_LIKELY(p->shape == ic->shape) && ic->kind == JS_IC_OWN) return *js_object_slot(p, ic->slot);
    return js_get_prop_slow(ctx, s, key, ic);
}

/* obj.key = v with a named key: 1 done, 0 failed (sloppy), -1 exception. */
static inline int js_set_prop(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict, JSPropCache *ic) {
    if (JS_LIKELY(js_is_object(obj)) && js_as_object(obj)->shape == ic->fast) {
        JSObject *o = js_as_object(obj);
        js_store(ctx, &o->cell, js_prop_cache_slot(o, ic), v);
        return 1;
    }
    return js_set_prop_slow(ctx, obj, key, v, strict, ic);
}

/* obj[key] and obj[key] = v at a site whose key is most likely always the same symbol or string
 * (the optimizer's guess: a module binding stored once, as Node's kState). `site` holds the key
 * the site's cache is for (EMPTY: none yet): while the key is that one, the access is a named
 * access's, inline cache and all. Another key the slow path makes the site's, or, when it isn't
 * a property key already (an index, a string not interned), accesses generically. */
JS_WARN_UNUSED JSValue js_get_keyed_slow(JSContext *ctx, JSValue obj, JSValue key, JSValue *site, JSPropCache *ic);
JS_WARN_UNUSED int js_set_keyed_slow(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict, JSValue *site, JSPropCache *ic);
static inline JSValue js_get_keyed(JSContext *ctx, JSValue obj, JSValue key, JSValue *site, JSPropCache *ic) {
    if (JS_LIKELY(js_same_bits(key, *site))) return js_get_prop(ctx, obj, key, ic);
    return js_get_keyed_slow(ctx, obj, key, site, ic);
}
static inline int js_set_keyed(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict, JSValue *site, JSPropCache *ic) {
    if (JS_LIKELY(js_same_bits(key, *site))) return js_set_prop(ctx, obj, key, v, strict, ic);
    return js_set_keyed_slow(ctx, obj, key, v, strict, site, ic);
}

/* An object's new shape. When the object is a prototype, caches that checked the chain it's on
 * may be stale: the runtime's proto_epoch moves on. */
static JS_FAST_PATH void js_object_set_shape(JSContext *ctx, JSObject *o, JSShape *s) {
    js_store_ptr(ctx, &o->cell, &o->shape, s);
    if (JS_UNLIKELY(o->cell.flags & JS_CELL_PROTOTYPE)) ctx->rt->proto_epoch++;
}

/* Whether the prototypes an ADD or PROTO cache saw still have the shapes it saw: then nothing on
 * the chain gained a setter, a read-only property or the key. */
static inline bool js_prop_cache_chain_holds(const JSPropCache *ic) {
    JSValue p = ic->shape->proto;
    for (unsigned d = 0; d < ic->depth; d++) {
        if (!js_is_object(p)) return false;
        JSShape *s = js_as_object(p)->shape;
        if (s != ic->chain[d]) return false;
        p = s->proto;
    }
    return true;
}

/* obj.key = v where the compiler expects the key to be added (`this.key = v` in a constructor,
 * optimizer step 10): js_set_prop, and a cached addition inline too, when the object has room
 * for it. Its new shape and the value are stores into an object the program just made. */
static JS_FAST_PATH int js_set_prop_add(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict, JSPropCache *ic) {
    if (JS_LIKELY(js_is_object(obj))) {
        JSObject *o = js_as_object(obj);
        JSShape *s = o->shape;
        if (JS_LIKELY(s == ic->shape && ic->kind == JS_IC_ADD && s->prop_count < s->inline_cap && ic->epoch == ctx->rt->proto_epoch)) {
            js_object_set_shape(ctx, o, ic->next);
            js_store(ctx, &o->cell, &js_object_slots(o)[s->prop_count], v);
            return 1;
        }
        if (s == ic->fast) {
            js_store(ctx, &o->cell, js_prop_cache_slot(o, ic), v);
            return 1;
        }
    }
    return js_set_prop_slow(ctx, obj, key, v, strict, ic);
}

/* Convenience: the value of `obj.key` / `obj.key = v` for any value (ToObject rules). */
JS_WARN_UNUSED JSValue js_get_value(JSContext *ctx, JSValue obj, JSValue key);
JS_WARN_UNUSED int js_set_value(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict);
/* ---- Generated code: property operators on any value --------------------------------- */

/* obj[key] and obj[key] = v with a computed key: ToPropertyKey after the nullish check. */
JS_WARN_UNUSED JSValue js_get_elem(JSContext *ctx, JSValue obj, JSValue key);
JS_WARN_UNUSED int js_set_elem(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict);
/* The same with a key the compiler proved a Number (get_index / set_index): a present element of
 * a dense array is read or written inline. A dense element is always a writable data property
 * (other attributes make the store sparse), so nothing else can see the access. */
static inline JSValue js_get_index(JSContext *ctx, JSValue obj, JSValue key) {
    if (JS_LIKELY(js_is_array(obj) && js_is_int32(key))) {
        JSElements *d = js_as_object(obj)->elements;
        uint32_t i = (uint32_t)js_as_int32(key);  /* negative: past any length */
        if (JS_LIKELY(d->kind == JS_ELEMENTS_DENSE && i < d->length && !js_is_empty(d->data[i]))) return d->data[i];
    }
    return js_get_elem(ctx, obj, key);
}
static inline int js_set_index(JSContext *ctx, JSValue obj, JSValue key, JSValue v, bool strict) {
    if (JS_LIKELY(js_is_array(obj) && js_is_int32(key))) {
        JSElements *d = js_as_object(obj)->elements;
        uint32_t i = (uint32_t)js_as_int32(key);
        if (JS_LIKELY(d->kind == JS_ELEMENTS_DENSE && i < d->length && !js_is_empty(d->data[i]))) {
            js_store(ctx, &d->cell, &d->data[i], v);
            return 1;
        }
    }
    return js_set_elem(ctx, obj, key, v, strict);
}
/* The same with an unboxed key (a C double): an integral one in range is the element's index. */
static inline bool js_f64_index(double key, uint32_t *i) {
    if (!(key >= 0 && key < 4294967295.0)) return false;  /* NaN too; the cast below is then defined */
    *i = (uint32_t)key;
    return (double)*i == key;
}
static inline JSValue js_get_index_f64(JSContext *ctx, JSValue obj, double key) {
    uint32_t i;
    if (JS_LIKELY(js_is_array(obj) && js_f64_index(key, &i))) {
        JSElements *d = js_as_object(obj)->elements;
        if (JS_LIKELY(d->kind == JS_ELEMENTS_DENSE && i < d->length && !js_is_empty(d->data[i]))) return d->data[i];
    }
    return js_get_elem(ctx, obj, js_number(key));
}
static inline int js_set_index_f64(JSContext *ctx, JSValue obj, double key, JSValue v, bool strict) {
    uint32_t i;
    if (JS_LIKELY(js_is_array(obj) && js_f64_index(key, &i))) {
        JSElements *d = js_as_object(obj)->elements;
        if (JS_LIKELY(d->kind == JS_ELEMENTS_DENSE && i < d->length && !js_is_empty(d->data[i]))) {
            js_store(ctx, &d->cell, &d->data[i], v);
            return 1;
        }
    }
    return js_set_elem(ctx, obj, js_number(key), v, strict);
}
/* obj.length: an array's and a string's inline, anything else as js_get_prop (an array's length
 * is always its own data property, a string's its own value). */
static inline JSValue js_get_length(JSContext *ctx, JSValue obj, JSValue key, JSPropCache *ic) {
    if (JS_LIKELY(js_is_array(obj))) return js_number((double)js_array_length(js_as_object(obj)));
    if (js_is_string(obj)) return js_int32((int32_t)js_string_length(obj));  /* below 2^30 */
    return js_get_prop(ctx, obj, key, ic);
}
/* ---- Static code's arrays ("use static": number[], string[], boolean[]) ------------------ */

/* An element's kind (an i32[] is a number[] whose reads the code converts). tsc's element types
 * aren't sound (a cast, an i32[] alias of a number[]), so every read checks it: a read's value is
 * of the kind or the read throws. An index past the end is a RangeError, never undefined or a hole. */
enum { JS_SARRAY_NUMBER, JS_SARRAY_STRING, JS_SARRAY_BOOLEAN };

static inline bool js_sarray_is(JSValue v, int kind) {
    switch (kind) {
        case JS_SARRAY_NUMBER: return js_is_number(v);
        case JS_SARRAY_STRING: return !js_is_empty(v) && js_is_string(v);
        default: return js_is_bool(v);
    }
}
/* A Number key as an index: -1 (past every end) when it isn't one. */
static inline int64_t js_sarray_index_f64(double key) {
    return key >= 0 && key < 4294967295.0 && (double)(int64_t)key == key ? (int64_t)key : -1;
}
static inline int64_t js_sarray_index(JSValue key) {
    return js_is_int32(key) ? js_as_int32(key) : js_sarray_index_f64(js_as_number(key));
}
JS_WARN_UNUSED JSValue js_sarray_get_slow(JSContext *ctx, JSValue arr, int64_t i, int kind);
JS_WARN_UNUSED int js_sarray_set_slow(JSContext *ctx, JSValue arr, int64_t i, JSValue v, int kind);
JS_WARN_UNUSED JSValue js_sarray_length_slow(JSContext *ctx, JSValue arr);
JS_WARN_UNUSED JSValue js_sarray_push_slow(JSContext *ctx, JSValue arr, JSValue v, int kind);

static JS_FAST_PATH JSValue js_sarray_get(JSContext *ctx, JSValue arr, int64_t i, int kind) {
    if (JS_LIKELY(js_is_array(arr))) {
        JSElements *d = js_as_object(arr)->elements;
        if (JS_LIKELY(d->kind == JS_ELEMENTS_DENSE && (uint64_t)i < d->length && js_sarray_is(d->data[i], kind))) return d->data[i];
    }
    return js_sarray_get_slow(ctx, arr, i, kind);
}
/* a[i] = v: at the length, a push; past it, a RangeError. */
static JS_FAST_PATH int js_sarray_set(JSContext *ctx, JSValue arr, int64_t i, JSValue v, int kind) {
    if (JS_LIKELY(js_is_array(arr) && js_sarray_is(v, kind))) {
        JSElements *d = js_as_object(arr)->elements;
        if (JS_LIKELY(d->kind == JS_ELEMENTS_DENSE && (uint64_t)i < d->length && !js_is_empty(d->data[i]))) {
            js_store(ctx, &d->cell, &d->data[i], v);
            return 1;
        }
    }
    return js_sarray_set_slow(ctx, arr, i, v, kind);
}
/* a.length, an int32 (a longer array is a RangeError). */
static JS_FAST_PATH JSValue js_sarray_length(JSContext *ctx, JSValue arr) {
    if (JS_LIKELY(js_is_array(arr) && js_array_length(js_as_object(arr)) <= INT32_MAX)) return js_int32((int32_t)js_array_length(js_as_object(arr)));
    return js_sarray_length_slow(ctx, arr);
}
/* a.push(v): the new length, an int32. */
static JS_FAST_PATH JSValue js_sarray_push(JSContext *ctx, JSValue arr, JSValue v, int kind) {
    if (JS_LIKELY(js_is_array(arr) && js_sarray_is(v, kind) && js_array_length(js_as_object(arr)) < INT32_MAX)) {
        if (JS_UNLIKELY(js_array_push(ctx, js_as_object(arr), v) < 0)) return JS_EXCEPTION;
        return js_int32((int32_t)js_array_length(js_as_object(arr)));
    }
    return js_sarray_push_slow(ctx, arr, v, kind);
}

/* ---- Static code's class instances ("use static") ------------------------------------- */

/* A field is a slot of the instance, in declaration order: an instance never leaves static code,
 * which reads and writes only the fields its class declares, so its shape only ever has them. An
 * instance being built has the fields defined so far: a slot past them is a TypeError (read or
 * written before its declaration defined it), never a slot that isn't there. A field of a number,
 * string or boolean is read checked against its kind (JS_SARRAY_*): one the constructor hasn't
 * set yet holds undefined, a TypeError too. */
#define JS_SFIELD_ANY (-1)

JS_WARN_UNUSED JSValue js_sfield_get_slow(JSContext *ctx, JSValue obj, JSValue key, const char *name);
JS_WARN_UNUSED int js_sfield_set_slow(JSContext *ctx, JSValue obj, JSValue v, JSValue key, const char *name);

static JS_FAST_PATH JSValue js_sfield_get(JSContext *ctx, JSValue obj, uint32_t slot, int kind, JSValue key, const char *name) {
    if (JS_LIKELY(js_is_object(obj))) {
        JSObject *o = js_as_object(obj);
        if (JS_LIKELY(slot < o->shape->prop_count)) {
            JSValue v = *js_object_slot(o, slot);
            if (JS_LIKELY(kind == JS_SFIELD_ANY || js_sarray_is(v, kind))) return v;
        }
    }
    return js_sfield_get_slow(ctx, obj, key, name);
}
/* 1 done, -1 exception. */
static JS_FAST_PATH int js_sfield_set(JSContext *ctx, JSValue obj, uint32_t slot, JSValue v, JSValue key, const char *name) {
    if (JS_LIKELY(js_is_object(obj))) {
        JSObject *o = js_as_object(obj);
        if (JS_LIKELY(slot < o->shape->prop_count)) {
            js_store(ctx, &o->cell, js_object_slot(o, slot), v);  /* an out-of-line slot's owner is the object too */
            return 1;
        }
    }
    return js_sfield_set_slow(ctx, obj, v, key, name);
}

/* delete obj[key]: true or false (sloppy), a TypeError when strict and not deletable.
 * `key` is a property key; js_delete_elem converts it first. */
JS_WARN_UNUSED JSValue js_delete_value(JSContext *ctx, JSValue obj, JSValue key, bool strict);
JS_WARN_UNUSED JSValue js_delete_elem(JSContext *ctx, JSValue obj, JSValue key, bool strict);
/* `{ __proto__: v }`: sets the prototype when v is an object or null, else nothing. */
void js_literal_set_proto(JSContext *ctx, JSValue obj, JSValue v);
/* SameValue (§7.2.10): NaN is NaN, +0 isn't -0. */
bool js_same_value(JSContext *ctx, JSValue a, JSValue b);
/* Object.freeze's SetIntegrityLevel(o, frozen): 0, or -1 with an exception. */
JS_WARN_UNUSED int js_freeze(JSContext *ctx, JSObject *o);
/* A tagged template's object (§13.2.8.4), created once per site and kept in *cache. */
JS_WARN_UNUSED JSValue js_template_object(JSContext *ctx, JSValue *cache, uint32_t n, const JSValue *cooked, const JSValue *raw);

/* ---- Private names (#x): keys only their class can name -------------------------------- */

/* A new private name (a fresh, never interned string flagged JS_STR_PRIVATE). */
JS_WARN_UNUSED JSValue js_new_private_name(JSContext *ctx, JSValue description);
static inline bool js_is_private_name(JSValue key) {
    return js_is_cell(key) && js_as_cell(key)->kind == JS_CELL_STR_FLAT && (js_as_cell(key)->flags & JS_STR_PRIVATE);
}
/* Adds a private element: kind 0 field, 1 method, 2 getter, 3 setter. 0, or -1 (TypeError: already there). */
JS_WARN_UNUSED int js_private_add(JSContext *ctx, JSValue obj, JSValue name, JSValue v, int kind);
JS_WARN_UNUSED JSValue js_private_get(JSContext *ctx, JSValue obj, JSValue name);
JS_WARN_UNUSED int js_private_set(JSContext *ctx, JSValue obj, JSValue name, JSValue v);
/* `#x in obj`. */
JS_WARN_UNUSED JSValue js_private_in(JSContext *ctx, JSValue name, JSValue obj);

/* A class field (§7.3.33 DefineField: CreateDataPropertyOrThrow). 0, or -1 on exception. */
JS_WARN_UNUSED int js_define_field(JSContext *ctx, JSValue obj, JSValue key, JSValue v);

/* Defines a builtin-style data property (e.g. while building intrinsics); never fails. */
void js_define_data(JSContext *ctx, JSObject *o, JSValue key, JSValue value, uint8_t attrs);

#endif /* JS_OBJECT_H */
