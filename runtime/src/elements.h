/* elements.h — indexed properties. Runtime-internal. */
#ifndef JS_ELEMENTS_H
#define JS_ELEMENTS_H

#include "js_object.h"

/* SPARSE: an open-addressing table index → (attrs, value), malloc'd and
 * owned by the cell (finalized). Values are traced by the cell's visitor. */
typedef struct JSSparseEntry {
    uint32_t index;
    uint8_t  state;   /* 0 empty, 1 used, 2 deleted */
    uint8_t  attrs;   /* JS_PROP_*; ACCESSOR: value is a JSAccessorPair */
    uint16_t pad_;
    JSValue  value;
} JSSparseEntry;

typedef struct JSSparseElements {  /* kind = ELEMENTS, JS_ELEMENTS_SPARSE */
    JSCell   cell;
    uint8_t  kind;
    uint8_t  flags;
    uint16_t pad_;
    uint32_t count;      /* used entries */
    uint32_t cap;        /* table size, a power of two */
    uint32_t tombstones;
    JSSparseEntry *entries;
} JSSparseElements;

/* Dense → sparse: when a write lands this far past the used slots, and the
 * result would be less than half full. */
#define JS_SPARSE_GAP 1024

int js_elements_get_own(JSContext *ctx, JSObject *o, uint32_t i, JSPropertyDescriptor *out);
int js_elements_define(JSContext *ctx, JSObject *o, uint32_t i, const JSPropertyDescriptor *desc, bool throw_on_fail);
int js_elements_delete(JSContext *ctx, JSObject *o, uint32_t i, bool throw_on_fail);
/* Fast path for [[Set]]: an existing writable data element. Returns 1 if stored. */
int js_elements_try_store(JSContext *ctx, JSObject *o, uint32_t i, JSValue v);
/* Appends v to a dense store at its length (Array.prototype.push's fast path: the caller has
 * checked that the store's length is the array's, and that adding an index is allowed). */
void js_elements_append_dense(JSContext *ctx, JSObject *o, JSValue v);
/* Array.prototype.fill on a plain dense array: 1 if stored, 0 to take the generic path. */
int js_elements_fill(JSContext *ctx, JSObject *o, uint32_t start, uint32_t end, JSValue v);
/* Present indices, ascending, into a new JSValueArray of keys. */
JSValueArray *js_elements_keys(JSContext *ctx, JSObject *o);
/* Removes elements at indices ≥ new_len, from the top. Stops at a
 * non-configurable one: returns its index + 1 then, else new_len. */
uint32_t js_elements_truncate(JSContext *ctx, JSObject *o, uint32_t new_len);

void js_elements_finalize(JSRuntime *rt, JSCell *c);

#endif /* JS_ELEMENTS_H */
