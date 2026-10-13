/* How the marker visits the runtime's own cell kinds.
 *
 * Included by gc.c only, after it defines trace_value and trace_cell: the drain loop switches on
 * the kind and inlines these, instead of an indirect call per cell. Host cells keep their class's
 * visit. A visit only reads its cell and traces what it holds: no allocation, no writes.
 * Flat strings and BigInts hold no cells: they're marked, never visited. */
#ifndef GC_VISIT_H
#define GC_VISIT_H

#include "elements.h"
#include "internal.h"
#include "js_function.h"
#include "js_object.h"
#include "js_symbol.h"
#include "jsstring.h"
#include "shape.h"

static inline void visit_object(JSCell *c, JSTracer *trc) {
    JSObject *o = (JSObject *)c;
    JSShape *s = o->shape;
#if defined(__clang__) || defined(__GNUC__)
    if (o->ool) __builtin_prefetch(o->ool);
#endif
    trace_cell(trc, &s->cell);
    trace_cell(trc, &o->elements->cell);
    JSValue *slots = js_object_slots(o);
    for (uint16_t i = 0; i < s->inline_cap; i++) trace_value(trc, slots[i]);
    if (o->ool) mark_ool(trc, o->ool);
    if (s->cls->visit) s->cls->visit(c, trc);  /* the object's class: a Map's table, a Promise's reactions */
}

static inline void visit_env(JSCell *c, JSTracer *trc) {
    JSEnv *e = (JSEnv *)c;
    if (e->parent) trace_cell(trc, &e->parent->cell);
    for (uint32_t i = 0; i < c->aux; i++) trace_value(trc, e->vars[i]);
}

static inline void visit_value_array(JSCell *c, JSTracer *trc) {
    JSValueArray *a = (JSValueArray *)c;
    for (uint32_t i = 0; i < c->aux; i++) trace_value(trc, a->values[i]);
}

static inline void visit_elements(JSCell *c, JSTracer *trc) {
    JSElements *e = (JSElements *)c;
    if (e->kind == JS_ELEMENTS_SPARSE) {
        JSSparseElements *s = (JSSparseElements *)e;
        for (uint32_t k = 0; k < s->cap; k++)
            if (s->entries[k].state == 1) trace_value(trc, s->entries[k].value);
        return;
    }
    for (uint32_t i = 0; i < e->length; i++) trace_value(trc, e->data[i]);
}

static inline void visit_rope(JSCell *c, JSTracer *trc) {
    JSRope *r = (JSRope *)c;
    trace_value(trc, r->left);
    trace_value(trc, r->right);
}

static inline void visit_slice(JSCell *c, JSTracer *trc) {
    trace_value(trc, ((JSSlice *)c)->parent);
}

static inline void visit_shape(JSCell *c, JSTracer *trc) {
    JSShape *s = (JSShape *)c;
    trace_value(trc, s->proto);
    trace_value(trc, s->key);
    trace_value(trc, s->enum_keys);
    if (s->parent) trace_cell(trc, &s->parent->cell);
    /* a dictionary's keys exist only in its table; a shared table's keys are on the chain */
    if (s->table && (s->flags & JS_SHAPE_DICTIONARY))
        for (uint32_t i = 0; i < s->table->count; i++) trace_value(trc, s->table->entries[i].key);
    /* transitions are weak: children aren't traced (js_shapes_sweep) */
}

static inline void visit_accessor(JSCell *c, JSTracer *trc) {
    JSAccessorPair *p = (JSAccessorPair *)c;
    trace_value(trc, p->get);
    trace_value(trc, p->set);
}

static inline void visit_symbol(JSCell *c, JSTracer *trc) {
    const JSCell *d = ((JSSymbol *)c)->description;
    if (d) trace_cell(trc, (JSCell *)d);
}

#endif /* GC_VISIT_H */
