/* shape.h — shape internals shared by shape.c and object.c. Runtime-internal. */
#ifndef JS_SHAPE_H
#define JS_SHAPE_H

#include "js_object.h"

typedef struct JSPropEntry {
    JSValue  key;
    uint32_t slot;
    uint8_t  attrs;
} JSPropEntry;

/* key → (slot, attrs): entries in insertion order, plus an open-addressing index. */
struct JSPropTable {
    uint32_t     count, cap;
    JSPropEntry *entries;
    uint32_t     index_cap;
    int32_t     *index;    /* entry numbers; -1 = empty */
};

typedef struct JSTransition {
    JSValue  key;
    uint8_t  attrs;
    JSShape *child;        /* weak */
} JSTransition;

struct JSTransitions {
    uint32_t      count, cap;
    JSTransition *items;
};

#define JS_MAX_TRANSITIONS 64  /* more distinct keys added to one shape: the object becomes a dictionary */

JSPropTable *js_prop_table_new(uint32_t capacity);
void js_prop_table_free(JSPropTable *t);
int32_t js_prop_table_find(const JSPropTable *t, JSValue key);
void js_prop_table_add(JSPropTable *t, JSValue key, uint32_t slot, uint8_t attrs);
void js_prop_table_remove(JSPropTable *t, uint32_t i);
JSPropTable *js_prop_table_clone(const JSPropTable *src);

JSShape *js_alloc_shape(JSContext *ctx);
uint32_t js_shape_transition_count(const JSShape *s);
/* All entries of a shape, in insertion order (builds the table if needed). */
JSPropTable *js_shape_entries(JSShape *s);

#endif /* JS_SHAPE_H */
