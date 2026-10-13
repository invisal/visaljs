/*
 * jscell.h — the header word every heap cell starts with.
 */
#ifndef JSCELL_H
#define JSCELL_H

#include <stdint.h>

/* Cell kinds. Each has a JSCellClass (visit, finalize) in the GC. */
typedef enum JSCellKind {
    JS_CELL_INVALID = 0,   /* never a live cell */
    JS_CELL_STR_FLAT,      /* JSString: inline Latin-1 or UTF-16 characters */
    JS_CELL_STR_ROPE,      /* JSRope: lazy concatenation */
    JS_CELL_STR_SLICE,     /* JSSlice: a substring sharing its parent's characters */
    JS_CELL_VALUE_ARRAY,   /* internal: fixed-length JSValue array (overflow slots, …) */
    JS_CELL_HOST,          /* internal: native payload with its own class */
    JS_CELL_SHAPE,         /* JSShape: hidden class */
    JS_CELL_ACCESSOR,      /* JSAccessorPair: {get, set} in an accessor property's slot */
    JS_CELL_ELEMENTS,      /* JSElements: indexed properties */
    JS_CELL_ENV,           /* JSEnv: a scope's captured variables */
    JS_CELL_SYMBOL,        /* JSSymbol: a symbol primitive */
    JS_CELL_BIGINT,        /* JSBigInt: a BigInt primitive */
    /* Objects: every kind from here on starts with a JSObject (js_is_object). */
    JS_CELL_OBJECT,        /* ordinary objects, and exotic ones whose class is in the shape */
    JS_CELL_ARRAY,         /* JSArray */
    JS_CELL_FUNCTION,      /* JSFunction */
    JS_CELL_KIND_COUNT
} JSCellKind;

/* Cell flags. The low byte is kind-specific (e.g. STR_LATIN1; an array's frozen length). */
#define JS_CELL_STATIC       0x8000u  /* emitted by the compiler: never marked or swept */
#define JS_CELL_FINALIZABLE  0x4000u  /* the class finalizer must run when it dies */
#define JS_CELL_PROTOTYPE    0x2000u  /* an object some shape has as its prototype: its shape changes bump proto_epoch */

/* 8 bytes, so the fields after it start 8-aligned and a 16-byte header fits two more words.
 * `gc` belongs to the collector: the write barrier reads it, and
 * nothing outside the GC writes it. A byte of its own, so a collector thread can write it while
 * the program writes `flags`. 0 in a new cell and in a static one. */
#define JS_GC_YOUNG       0  /* allocated since the last collection (or static) */
#define JS_GC_REMEMBERED  1  /* old, and in the remembered set: stores into it need nothing more */
#define JS_GC_OLD         2  /* survived a collection: a store of a young cell into it is remembered */
#define JS_GC_OLD_LARGE   3  /* old and a large object: a store of a young cell marks a card of it */
typedef struct JSCell {
    uint8_t  kind;      /* JSCellKind */
    uint8_t  gc;
    uint16_t flags;
    uint32_t aux;       /* kind-specific */
} JSCell;

#define JS_CELL_HEADER(kind, flags) { (uint8_t)(kind), 0, (uint16_t)(flags), 0 }

static inline JSCellKind js_cell_kind(const JSCell *c) { return (JSCellKind)c->kind; }
static inline int js_cell_is_static(const JSCell *c) { return (c->flags & JS_CELL_STATIC) != 0; }

#endif /* JSCELL_H */
