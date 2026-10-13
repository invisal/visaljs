/*
 * js_atoms.h — atoms: interned strings.
 *
 * An atom is the unique flat string (flag JS_STR_ATOM) for its content, so
 * property keys compare by pointer. The table is weak: an atom nothing else
 * references is dropped at the next collection.
 *
 * Static atoms (the runtime's names below, and compiler-emitted literals) are
 * flagged ATOM at build time. That is only sound if no two static atoms share
 * content: registration treats a duplicate as a fatal bug, and the compiler
 * references the runtime's atoms instead of emitting its own copies.
 */
#ifndef JS_ATOMS_H
#define JS_ATOMS_H

#include <stddef.h>

#include "jsstring.h"

typedef struct JSRuntime JSRuntime;

typedef struct JSAtomTable {
    struct JSAtomEntry { JSString *str; uint32_t hash; } *entries;  /* open addressing; str NULL = empty */
    size_t cap, count;
} JSAtomTable;

/* ---- The runtime's predefined atoms ------------------------------------ */

#define JS_ATOM_DEF(id, len, hash, chars) \
    typedef JS_STATIC_LATIN1_TYPE(len) js_atom_##id##_t; extern const js_atom_##id##_t js_atom_##id;
#include "js_atoms.gen.h"
#undef JS_ATOM_DEF

#define JS_ATOM(id) js_cell((JSCell *)&js_atom_##id)

/* ---- API --------------------------------------------------------------- */

static inline bool js_is_atom(JSValue v) {
    if (!js_is_cell(v)) return false;
    JSCell *c = js_as_cell(v);
    return c->kind == JS_CELL_STR_FLAT && (c->flags & JS_STR_ATOM);
}

/* The atom with the content of string `s`. Doesn't copy when `s` is a heap
 * flat string: it becomes the atom. */
JSValue js_atomize(JSContext *ctx, JSValue s);
JS_WARN_UNUSED JSValue js_atom_from_cstr(JSContext *ctx, const char *utf8);

/* Registers compiler-emitted static atoms at startup, before user code runs. */
void js_register_static_atoms(JSRuntime *rt, const JSString *const *cells, size_t n);

size_t js_atom_count(const JSRuntime *rt);

#endif /* JS_ATOMS_H */
