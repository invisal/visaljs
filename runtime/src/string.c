/* Strings. */
#include "jsstring.h"

#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "js_exception.h"
#include "jscontext.h"
#include "jsnum.h"

/* ---- GC classes (gc_visit.h visits them) ------------------------------- */

const JSCellClass js_flat_string_class = { "String", NULL, NULL, NULL };
const JSCellClass js_rope_class = { "Rope", NULL, NULL, NULL };
const JSCellClass js_slice_class = { "Slice", NULL, NULL, NULL };

/* ---- Static cells: "" and every unit 0…255 ----------------------------- */

#define CHAR_HASH(u) JS_HASH_FIX(JS_HASH_STEP(JS_HASH_INIT, (u)))
#define C1(u) JS_STATIC_ATOM_INIT(1, CHAR_HASH(u), { (uint8_t)(u), 0 })
#define C4(u) C1(u), C1((u) + 1), C1((u) + 2), C1((u) + 3)
#define C16(u) C4(u), C4((u) + 4), C4((u) + 8), C4((u) + 12)
#define C64(u) C16(u), C16((u) + 16), C16((u) + 32), C16((u) + 48)

const JSStaticChar js_char_strings[256] = { C64(0), C64(64), C64(128), C64(192) };
static const JS_STATIC_LATIN1_TYPE(0) empty_string = JS_STATIC_ATOM_INIT(0, JS_HASH_FIX(JS_HASH_INIT), { 0 });

JSValue js_empty_string(void) { return js_cell((JSCell *)&empty_string); }

/* ---- Flat strings ------------------------------------------------------ */

static JSValue string_too_long(JSContext *ctx) {
    return js_throw_range_error(ctx, "Invalid string length");
}

static bool cell_latin1(const JSCell *c) { return (c->flags & JS_STR_LATIN1) != 0; }

static JSStrView flat_view(const JSString *s) {
    return (JSStrView){ s->chars.latin1, s->length, cell_latin1(&s->cell) };
}

/* A slice's characters: inside its parent's. */
static JSStrView slice_view(const JSSlice *s) {
    const JSString *p = (const JSString *)js_as_cell(s->parent);
    const char *base = (const char *)p->chars.latin1;
    return (JSStrView){ base + (size_t)s->offset * (cell_latin1(&p->cell) ? 1 : 2), s->length, cell_latin1(&p->cell) };
}

/* A zero-filled flat string of `length` units, so Latin-1 is NUL-terminated.
 * The caller has checked length <= JS_STRING_MAX_LENGTH. */
static JSString *alloc_flat(JSContext *ctx, uint32_t length, bool latin1) {
    size_t size = JS_STRING_HEADER_SIZE + (latin1 ? (size_t)length + 1 : (size_t)length * 2);
    JSString *s = (JSString *)js_alloc_cell(ctx, JS_CELL_STR_FLAT, size);
    s->cell.flags = latin1 ? JS_STR_LATIN1 : 0;
    s->length = length;
    return s;
}

/* Copies view `v` into flat string `s` at unit offset `at`, widening if needed. */
static void copy_view(JSString *s, uint32_t at, JSStrView v) {
    if (cell_latin1(&s->cell)) {
        memcpy(s->chars.latin1 + at, v.chars, v.length);  /* v is Latin-1 too */
    } else if (!v.latin1) {
        memcpy(s->chars.utf16 + at, v.chars, (size_t)v.length * 2);
    } else {
        const uint8_t *src = v.chars;
        for (uint32_t i = 0; i < v.length; i++) s->chars.utf16[at + i] = src[i];
    }
}

JSValue js_new_string_latin1(JSContext *ctx, const uint8_t *chars, uint32_t length) {
    if (length == 0) return js_empty_string();
    if (length == 1) return js_char_string(chars[0]);
    if (length > JS_STRING_MAX_LENGTH) return string_too_long(ctx);
    JSString *s = alloc_flat(ctx, length, true);
    memcpy(s->chars.latin1, chars, length);
    return js_cell(&s->cell);
}

JSValue js_new_string_utf16(JSContext *ctx, const uint16_t *chars, uint32_t length) {
    if (length > JS_STRING_MAX_LENGTH) return string_too_long(ctx);
    uint16_t max = 0;
    for (uint32_t i = 0; i < length; i++) max |= chars[i];
    if (max <= 0xFF) {
        if (length == 0) return js_empty_string();
        if (length == 1) return js_char_string((uint8_t)chars[0]);
        JSString *s = alloc_flat(ctx, length, true);
        for (uint32_t i = 0; i < length; i++) s->chars.latin1[i] = (uint8_t)chars[i];
        return js_cell(&s->cell);
    }
    JSString *s = alloc_flat(ctx, length, false);
    memcpy(s->chars.utf16, chars, (size_t)length * 2);
    return js_cell(&s->cell);
}

JSValue js_new_string_view(JSContext *ctx, JSStrView v) {
    return v.latin1 ? js_new_string_latin1(ctx, v.chars, v.length) : js_new_string_utf16(ctx, v.chars, v.length);
}

/* One code point from UTF-8 at s[*i]; invalid input yields U+FFFD and consumes one byte. */
static uint32_t decode_utf8(const uint8_t *s, size_t n, size_t *i) {
    uint8_t b = s[*i];
    uint32_t cp, min;
    size_t len;
    if (b < 0x80) { (*i)++; return b; }
    if (b >= 0xC2 && b <= 0xDF) { len = 2; cp = b & 0x1F; min = 0x80; }
    else if (b >= 0xE0 && b <= 0xEF) { len = 3; cp = b & 0x0F; min = 0x800; }
    else if (b >= 0xF0 && b <= 0xF4) { len = 4; cp = b & 0x07; min = 0x10000; }
    else { (*i)++; return 0xFFFD; }
    if (*i + len > n) { (*i)++; return 0xFFFD; }
    for (size_t k = 1; k < len; k++) {
        uint8_t c = s[*i + k];
        if ((c & 0xC0) != 0x80) { (*i)++; return 0xFFFD; }
        cp = (cp << 6) | (c & 0x3F);
    }
    if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) { (*i)++; return 0xFFFD; }
    *i += len;
    return cp;
}

JSValue js_new_string_utf8(JSContext *ctx, const char *str, size_t n) {
    const uint8_t *s = (const uint8_t *)str;
    size_t units = 0;
    for (size_t i = 0; i < n;) units += decode_utf8(s, n, &i) > 0xFFFF ? 2 : 1;
    if (units > JS_STRING_MAX_LENGTH) return string_too_long(ctx);
    uint16_t small[256] = { 0 };  /* gcc -O2 cannot see that the fill loop writes every unit */
    uint16_t *buf = units <= 256 ? small : malloc(units * sizeof *buf);
    if (!buf) js_fatal("out of memory decoding UTF-8");
    size_t u = 0;
    for (size_t i = 0; i < n;) {
        uint32_t cp = decode_utf8(s, n, &i);
        if (cp > 0xFFFF) {
            cp -= 0x10000;
            buf[u++] = (uint16_t)(0xD800 + (cp >> 10));
            buf[u++] = (uint16_t)(0xDC00 + (cp & 0x3FF));
        } else {
            buf[u++] = (uint16_t)cp;
        }
    }
    JSValue result = js_new_string_utf16(ctx, buf, (uint32_t)units);
    if (buf != small) free(buf);
    return result;
}

JSValue js_new_string_cstr(JSContext *ctx, const char *s) {
    return js_new_string_utf8(ctx, s, strlen(s));
}

/* ---- Ropes ------------------------------------------------------------- */

static bool rope_flattened(const JSRope *r) { return js_is_empty(r->right); }

static unsigned depth_of(JSValue s) {
    JSCell *c = js_as_cell(s);
    return c->kind == JS_CELL_STR_ROPE && !rope_flattened((JSRope *)c) ? ((JSRope *)c)->depth : 0;
}

/* Copies the leaves of `rope` into `out` from unit 0, iteratively (ropes can be deep). */
static void copy_rope(JSString *out, JSRope *rope) {
    size_t cap = (size_t)rope->depth + 2, sp = 0;
    JSValue small[64];
    JSValue *stack = cap <= 64 ? small : malloc(cap * sizeof *stack);
    if (!stack) js_fatal("out of memory flattening a string");
    uint32_t at = 0;
    stack[sp++] = js_cell(&rope->cell);
    while (sp) {
        JSCell *c = js_as_cell(stack[--sp]);
        if (c->kind == JS_CELL_STR_ROPE) {
            JSRope *r = (JSRope *)c;
            if (rope_flattened(r)) {
                stack[sp++] = r->left;
            } else {
                stack[sp++] = r->right;  /* left is copied first */
                stack[sp++] = r->left;
            }
            continue;
        }
        JSStrView v = c->kind == JS_CELL_STR_SLICE ? slice_view((JSSlice *)c) : flat_view((JSString *)c);
        copy_view(out, at, v);
        at += v.length;
    }
    if (stack != small) free(stack);
}

/* Copies the leaves into one flat string and keeps it in the rope: left = result, right = EMPTY. */
static JSString *flatten(JSContext *ctx, JSRope *rope) {
    if (rope_flattened(rope)) return (JSString *)js_as_cell(rope->left);
    JSString *out = alloc_flat(ctx, rope->length, cell_latin1(&rope->cell));  /* may GC; nothing moves */
    copy_rope(out, rope);
    js_store(ctx, &rope->cell, &rope->left, js_cell(&out->cell));
    js_store(ctx, &rope->cell, &rope->right, JS_EMPTY);
    return out;
}

JSStrView js_string_view(JSContext *ctx, JSValue s) {
    JSCell *c = js_as_cell(s);
    switch (c->kind) {
    case JS_CELL_STR_ROPE: return flat_view(flatten(ctx, (JSRope *)c));
    case JS_CELL_STR_SLICE: return slice_view((JSSlice *)c);
    default: return flat_view((JSString *)c);
    }
}

/* ---- Append buffers ---------------------------------------------------- */

/* The buffer `a` is the newest string of (a slice ending at its fill mark), or NULL. */
static JSString *newest_in_buffer(JSValue a) {
    JSCell *c = js_as_cell(a);
    if (c->kind != JS_CELL_STR_SLICE) return NULL;
    JSSlice *slice = (JSSlice *)c;
    JSString *p = (JSString *)js_as_cell(slice->parent);
    return (p->cell.flags & JS_STR_BUFFER) && slice->offset == 0 && slice->length == p->length ? p : NULL;
}

/* A zero-filled buffer with room for `capacity` units, `used` of them filled by the caller. */
static JSString *alloc_buffer(JSContext *ctx, uint32_t used, uint32_t capacity, bool latin1) {
    JSString *s = alloc_flat(ctx, capacity, latin1);
    s->cell.flags |= JS_STR_BUFFER;
    s->cell.aux = capacity;
    s->length = used;
    return s;
}

/* a + b continuing in a buffer: in `buf` (the one `a` is the newest string of, or NULL) when `b`
 * fits, else in a new one with twice the room. Each unit is copied O(1) times on average. */
static JSValue append(JSContext *ctx, JSString *buf, JSValue a, JSValue b, uint32_t length) {
    JSStrView vb = js_string_view(ctx, b);  /* may flatten b: a, and so buf, stay live */
    if (!buf || length > buf->cell.aux || (cell_latin1(&buf->cell) && !vb.latin1)) {
        uint32_t la = js_string_length(a);
        JSCell *ca = js_as_cell(a);
        bool rope = ca->kind == JS_CELL_STR_ROPE && !rope_flattened((JSRope *)ca);
        bool latin1 = (rope ? cell_latin1(ca) : js_string_view(ctx, a).latin1) && vb.latin1;
        uint64_t capacity = (uint64_t)length * 2;
        if (capacity > JS_STRING_MAX_LENGTH) capacity = JS_STRING_MAX_LENGTH;
        buf = alloc_buffer(ctx, la, (uint32_t)capacity, latin1);  /* vb stays valid: nothing moves */
        if (rope) copy_rope(buf, (JSRope *)ca);  /* straight into the buffer: no flat copy first */
        else copy_view(buf, 0, js_string_view(ctx, a));
    }
    copy_view(buf, buf->length, vb);  /* past the fill mark: no string sees these units yet */
    buf->length = length;
    JSSlice *slice = (JSSlice *)js_alloc_cell(ctx, JS_CELL_STR_SLICE, sizeof(JSSlice));  /* buf is live */
    slice->cell.flags = cell_latin1(&buf->cell) ? JS_STR_LATIN1 : 0;
    slice->length = length;
    slice->offset = 0;
    js_init_slot(&slice->parent, js_cell(&buf->cell));
    return js_cell(&slice->cell);
}

/* a + b: a short result is copied, appending to a buffer's newest string continues in it, a deep
 * rope (an append loop) moves to a buffer, and anything else is a rope. */
JSValue js_concat(JSContext *ctx, JSValue a, JSValue b) {
    uint32_t la = js_string_length(a), lb = js_string_length(b);
    if (la == 0) return b;
    if (lb == 0) return a;
    if ((uint64_t)la + lb > JS_STRING_MAX_LENGTH) return string_too_long(ctx);
    uint32_t length = la + lb;
    JSString *buf = newest_in_buffer(a);
    if (buf) return append(ctx, buf, a, b, length);
    bool latin1 = cell_latin1(js_as_cell(a)) && cell_latin1(js_as_cell(b));

    if (length < JS_ROPE_MIN) {  /* copying is cheaper than a rope */
        JSStrView va = js_string_view(ctx, a), vb = js_string_view(ctx, b);
        JSString *s = alloc_flat(ctx, length, latin1);  /* va/vb stay valid: nothing moves */
        copy_view(s, 0, va);
        copy_view(s, la, vb);
        return js_cell(&s->cell);
    }

    if (depth_of(a) >= JS_BUFFER_MIN_DEPTH) return append(ctx, NULL, a, b, length);
    unsigned depth = (depth_of(a) > depth_of(b) ? depth_of(a) : depth_of(b)) + 1;
    if (depth > JS_ROPE_MAX_DEPTH) {  /* bound the depth: flatten the deep side(s) */
        if (depth_of(a) >= JS_ROPE_MAX_DEPTH) (void)js_string_view(ctx, a);
        if (depth_of(b) >= JS_ROPE_MAX_DEPTH) (void)js_string_view(ctx, b);
        depth = (depth_of(a) > depth_of(b) ? depth_of(a) : depth_of(b)) + 1;
    }
    JSRope *r = (JSRope *)js_alloc_cell(ctx, JS_CELL_STR_ROPE, sizeof(JSRope));
    r->cell.flags = latin1 ? JS_STR_LATIN1 : 0;
    r->length = length;
    r->depth = (uint16_t)depth;
    js_init_slot(&r->left, a);
    js_init_slot(&r->right, b);
    return js_cell(&r->cell);
}

/* ---- Substrings, hashing, comparison ---------------------------------- */

/* A long substring shares the characters of the flat string under `s` (a slice), unless it is
 * a small part of it: then it copies, so a slice never keeps more than JS_SLICE_MAX_WASTE times
 * its own size alive. Cutting the front off a string over and over (a tokenizer's
 * `src = src.substring(n)`) then costs linear time: the rest is sliced until it is a quarter of
 * the parent, copied once, and that copy becomes the next parent. */
JSValue js_substring(JSContext *ctx, JSValue s, uint32_t start, uint32_t end) {
    if (start == 0 && end == js_string_length(s)) return s;
    if (start == end) return js_empty_string();
    JSStrView v = js_string_view(ctx, s);  /* flattens a rope */
    uint32_t length = end - start;
    JSCell *c = js_as_cell(s);
    JSValue parent = c->kind == JS_CELL_STR_SLICE ? ((JSSlice *)c)->parent : c->kind == JS_CELL_STR_ROPE ? ((JSRope *)c)->left : s;
    uint32_t offset = c->kind == JS_CELL_STR_SLICE ? ((JSSlice *)c)->offset : 0;
    if (length < JS_SLICE_MIN || (uint64_t)length * JS_SLICE_MAX_WASTE < js_string_length(parent)) {
        const char *base = v.chars;
        JSStrView sub = { base + (size_t)start * (v.latin1 ? 1 : 2), length, v.latin1 };
        return js_new_string_view(ctx, sub);  /* sub.chars keeps s alive while this allocates */
    }
    JSSlice *slice = (JSSlice *)js_alloc_cell(ctx, JS_CELL_STR_SLICE, sizeof(JSSlice));  /* `parent` stays live */
    slice->cell.flags = v.latin1 ? JS_STR_LATIN1 : 0;
    slice->length = length;
    slice->offset = offset + start;
    js_init_slot(&slice->parent, parent);
    return js_cell(&slice->cell);
}

uint32_t js_hash_view(JSStrView v) {
    uint32_t h = JS_HASH_INIT;
    for (uint32_t i = 0; i < v.length; i++) h = JS_HASH_STEP(h, js_view_at(v, i));
    return JS_HASH_FIX(h);
}

uint32_t js_string_hash(JSContext *ctx, JSValue s) {
    JSCell *c = js_as_cell(s);
    if (c->kind == JS_CELL_STR_SLICE) {
        JSSlice *slice = (JSSlice *)c;
        if (!slice->hash) slice->hash = js_hash_view(slice_view(slice));
        return slice->hash;
    }
    JSString *f = c->kind == JS_CELL_STR_ROPE ? flatten(ctx, (JSRope *)c) : (JSString *)c;
    if (f->hash) return f->hash;
    uint32_t h = js_hash_view(flat_view(f));
    if (!js_cell_is_static(&f->cell)) f->hash = h;  /* static cells may live in read-only memory */
    return h;
}

static int compare_views(JSStrView a, JSStrView b) {
    uint32_t n = a.length < b.length ? a.length : b.length;
    if (a.latin1 && b.latin1) {
        int r = memcmp(a.chars, b.chars, n);
        if (r) return r;
    } else {
        for (uint32_t i = 0; i < n; i++) {
            uint32_t x = js_view_at(a, i), y = js_view_at(b, i);
            if (x != y) return x < y ? -1 : 1;
        }
    }
    return a.length < b.length ? -1 : a.length > b.length;
}

bool js_string_equals(JSContext *ctx, JSValue a, JSValue b) {
    if (js_same_bits(a, b)) return true;
    if (js_string_length(a) != js_string_length(b)) return false;
    JSCell *ca = js_as_cell(a), *cb = js_as_cell(b);
    if ((ca->flags & cb->flags & JS_STR_ATOM) != 0) return false;  /* distinct atoms differ */
    JSStrView va = js_string_view(ctx, a), vb = js_string_view(ctx, b);
    if (va.latin1 == vb.latin1) return memcmp(va.chars, vb.chars, (size_t)va.length * (va.latin1 ? 1 : 2)) == 0;
    return compare_views(va, vb) == 0;
}

int js_string_compare(JSContext *ctx, JSValue a, JSValue b) {
    if (js_same_bits(a, b)) return 0;
    JSStrView va = js_string_view(ctx, a), vb = js_string_view(ctx, b);
    return compare_views(va, vb);
}

/* ---- Numbers and output ------------------------------------------------ */

JSValue js_number_to_string(JSContext *ctx, JSValue n) {
    char buf[JS_NUM_BUF_SIZE];
    size_t len = js_is_int32(n) ? js_i32_to_cstr(buf, js_as_int32(n)) : js_num_to_cstr(buf, js_as_double(n));
    return js_new_string_latin1(ctx, (const uint8_t *)buf, (uint32_t)len);
}

size_t js_view_to_utf8(JSStrView v, char *out, size_t cap) {
    size_t n = 0;
#define PUT(byte) do { if (n < cap) out[n] = (char)(byte); n++; } while (0)
    for (uint32_t i = 0; i < v.length; i++) {
        uint32_t c = js_view_at(v, i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < v.length) {
            uint32_t d = js_view_at(v, i + 1);
            if (d >= 0xDC00 && d <= 0xDFFF) {
                c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
                i++;
            }
        }
        if (c >= 0xD800 && c <= 0xDFFF) c = 0xFFFD;  /* lone surrogate */
        if (c < 0x80) {
            PUT(c);
        } else if (c < 0x800) {
            PUT(0xC0 | (c >> 6));
            PUT(0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
            PUT(0xE0 | (c >> 12));
            PUT(0x80 | ((c >> 6) & 0x3F));
            PUT(0x80 | (c & 0x3F));
        } else {
            PUT(0xF0 | (c >> 18));
            PUT(0x80 | ((c >> 12) & 0x3F));
            PUT(0x80 | ((c >> 6) & 0x3F));
            PUT(0x80 | (c & 0x3F));
        }
    }
#undef PUT
    return n;
}
