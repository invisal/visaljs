/* Atoms: interned strings, held weakly. */
#include "js_atoms.h"

#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "jscontext.h"

/* The runtime's predefined atoms, generated with precomputed hashes. */
#define JS_ATOM_DEF(id, len, hash, chars) const js_atom_##id##_t js_atom_##id = JS_STATIC_ATOM_INIT(len, hash, chars);
#include "js_atoms.gen.h"
#undef JS_ATOM_DEF

static JSStrView view_of(const JSString *s) {
    return (JSStrView){ s->chars.latin1, s->length, (s->cell.flags & JS_STR_LATIN1) != 0 };
}

static bool same_content(JSStrView a, JSStrView b) {
    if (a.length != b.length) return false;
    if (a.latin1 == b.latin1) return memcmp(a.chars, b.chars, (size_t)a.length * (a.latin1 ? 1 : 2)) == 0;
    for (uint32_t i = 0; i < a.length; i++)
        if (js_view_at(a, i) != js_view_at(b, i)) return false;
    return true;
}

/* ---- Open-addressing table --------------------------------------------- */

static JSString *find(const JSAtomTable *t, JSStrView v, uint32_t hash) {
    size_t mask = t->cap - 1;
    for (size_t i = hash & mask; t->entries[i].str; i = (i + 1) & mask)
        if (t->entries[i].hash == hash && same_content(view_of(t->entries[i].str), v)) return t->entries[i].str;
    return NULL;
}

static void put(struct JSAtomEntry *entries, size_t cap, JSString *s, uint32_t hash) {
    size_t i = hash & (cap - 1);
    while (entries[i].str) i = (i + 1) & (cap - 1);
    entries[i] = (struct JSAtomEntry){ s, hash };
}

/* Rebuilds the table at `cap`, keeping the entries `keep` accepts. */
static void rebuild(JSAtomTable *t, size_t cap, bool (*keep)(const JSString *)) {
    struct JSAtomEntry *entries = calloc(cap, sizeof *entries);
    if (!entries) js_fatal("out of memory growing the atom table");
    size_t count = 0;
    for (size_t i = 0; i < t->cap; i++) {
        JSString *s = t->entries[i].str;
        if (s && (!keep || keep(s))) {
            put(entries, cap, s, t->entries[i].hash);
            count++;
        }
    }
    free(t->entries);
    t->entries = entries;
    t->cap = cap;
    t->count = count;
}

static void insert(JSAtomTable *t, JSString *s, uint32_t hash) {
    if (2 * (t->count + 1) > t->cap) rebuild(t, t->cap * 2, NULL);  /* load factor <= 1/2 */
    put(t->entries, t->cap, s, hash);
    t->count++;
}

/* Removes `s`, which is in the table. Linear probing: later entries of its probe run move back
 * into the hole, so that every lookup still finds them. */
static void remove_atom(JSAtomTable *t, const JSString *s) {
    size_t mask = t->cap - 1, i = s->hash & mask;
    while (t->entries[i].str != s) i = (i + 1) & mask;
    t->entries[i].str = NULL;
    t->count--;
    for (size_t j = (i + 1) & mask; t->entries[j].str; j = (j + 1) & mask) {
        size_t home = t->entries[j].hash & mask;
        bool stays = i <= j ? (i < home && home <= j) : (i < home || home <= j);
        if (!stays) {
            t->entries[i] = t->entries[j];  /* barrier: none, the table is malloc'd and weak */
            t->entries[j].str = NULL;
            i = j;
        }
    }
}

/* ---- Lifecycle --------------------------------------------------------- */

void js_register_static_atoms(JSRuntime *rt, const JSString *const *cells, size_t n) {
    for (size_t i = 0; i < n; i++) {
        JSString *s = (JSString *)cells[i];
        if ((s->cell.flags & (JS_CELL_STATIC | JS_STR_ATOM)) != (JS_CELL_STATIC | JS_STR_ATOM))
            js_fatal("js_register_static_atoms: not a static atom");
        uint32_t hash = s->hash ? s->hash : js_hash_view(view_of(s));
        if (find(&rt->atoms, view_of(s), hash)) js_fatal("duplicate static atom (%u units)", s->length);
        insert(&rt->atoms, s, hash);
    }
}

void js_atoms_init(JSRuntime *rt) {
    rt->atoms.cap = 512;
    rt->atoms.entries = calloc(rt->atoms.cap, sizeof *rt->atoms.entries);
    if (!rt->atoms.entries) js_fatal("out of memory creating the atom table");

    const JSString *builtin[257];
    builtin[0] = (const JSString *)js_as_cell(js_empty_string());
    for (unsigned u = 0; u < 256; u++) builtin[u + 1] = (const JSString *)js_as_cell(js_char_string((uint8_t)u));
    js_register_static_atoms(rt, builtin, 257);

#define JS_ATOM_DEF(id, len, hash, chars) (const JSString *)&js_atom_##id,
    static const JSString *const predefined[] = {
#include "js_atoms.gen.h"
    };
#undef JS_ATOM_DEF
    js_register_static_atoms(rt, predefined, sizeof predefined / sizeof predefined[0]);
}

static bool survives(const JSString *s) { return js_gc_is_marked(&s->cell); }

/* Drops unmarked atoms. A young collection checks only the atoms added since the last one, and
 * removes the dead ones in place. A full collection checks every atom, and resizes for the
 * survivors: load <= 1/2, shrinking after mass death (dynamic keys), never below 512 entries. */
void js_atoms_sweep(JSRuntime *rt, bool full) {
    JSAtomTable *t = &rt->atoms;
    if (!full) {
        for (size_t i = 0; i < t->young_count; i++)
            if (!survives(t->young[i])) remove_atom(t, t->young[i]);
        t->young_count = 0;
        return;
    }
    t->young_count = 0;
    size_t live = 0;
    for (size_t i = 0; i < t->cap; i++) live += t->entries[i].str && survives(t->entries[i].str);
    size_t cap = 512;
    while (cap < 4 * live) cap *= 2;  /* room to grow before the next resize */
    rebuild(t, cap, survives);
}

void js_atoms_free(JSRuntime *rt) {
    free(rt->atoms.entries);
    rt->atoms.entries = NULL;
    free(rt->atoms.young);
    rt->atoms.young = NULL;
}

size_t js_atom_count(const JSRuntime *rt) {
    return rt->atoms.count;
}

/* ---- Atomizing --------------------------------------------------------- */

JSValue js_atomize(JSContext *ctx, JSValue s) {
    if (js_is_atom(s)) return s;
    JSStrView v = js_string_view(ctx, s);  /* flattens a rope */
    uint32_t hash = js_string_hash(ctx, s);
    JSAtomTable *t = &ctx->rt->atoms;
    JSString *found = find(t, v, hash);
    if (found) return js_cell(&found->cell);

    JSCell *c = js_as_cell(s);
    JSString *flat = c->kind == JS_CELL_STR_ROPE ? (JSString *)js_as_cell(((JSRope *)c)->left) : (JSString *)c;
    if (c->kind == JS_CELL_STR_SLICE || js_cell_is_static(&flat->cell)) {
        /* A slice, or static but not an atom (e.g. an error message): intern a heap copy.
         * Length >= 2 here: "" and single units are atoms already. */
        JSValue copy = js_new_string_view(ctx, v);
        flat = (JSString *)js_as_cell(copy);
    }
    flat->cell.flags |= JS_STR_ATOM;  /* immutable content: becoming the atom changes nothing else */
    flat->hash = hash;
    insert(t, flat, hash);
    if (t->young_count == t->young_cap) {
        t->young_cap = t->young_cap ? t->young_cap * 2 : 256;
        t->young = realloc(t->young, t->young_cap * sizeof *t->young);
        if (!t->young) js_fatal("out of memory growing the atom table");
    }
    t->young[t->young_count++] = flat;
    return js_cell(&flat->cell);
}

JSValue js_atom_from_cstr(JSContext *ctx, const char *utf8) {
    /* an ASCII name already interned (the usual case: C code naming properties) is found
     * without making a string */
    size_t n = 0;
    bool ascii = true;
    for (; utf8[n]; n++) ascii &= (uint8_t)utf8[n] < 0x80;
    if (ascii && n <= UINT32_MAX) {
        JSStrView v = js_view_latin1(utf8, (uint32_t)n);
        JSString *found = find(&ctx->rt->atoms, v, js_hash_view(v));
        if (found) return js_cell(&found->cell);
    }
    JSValue s = js_new_string_cstr(ctx, utf8);
    if (js_is_exception(s)) return JS_EXCEPTION;
    return js_atomize(ctx, s);
}
