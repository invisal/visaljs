/*
 * jsstring.h — strings.
 *
 * A string is a sequence of UTF-16 code units. Cells are flat (characters
 * inline, Latin-1 when every unit is <= 0xFF, else UTF-16), ropes (lazy
 * concatenations, flattened on first read) or slices (long substrings, which
 * share their parent's characters). Strings built by appending in a loop are
 * slices of a buffer: a flat cell with room to grow (below). Everything that
 * reads characters goes through a JSStrView.
 */
#ifndef JSSTRING_H
#define JSSTRING_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "jscell.h"
#include "jsvalue.h"

typedef struct JSContext JSContext;

/* Cell flags (low byte of JSCell.flags) */
#define JS_STR_LATIN1  0x01u  /* flat: 1 byte per unit; rope: both sides are Latin-1; slice: the parent is */
#define JS_STR_ATOM    0x02u  /* the unique interned copy of its content */
#define JS_STR_PRIVATE 0x04u  /* a private name (#x): a property key no key listing shows */
#define JS_STR_BUFFER  0x08u  /* flat: an append buffer, only ever a slice's parent (below) */

#define JS_STRING_MAX_LENGTH ((UINT32_C(1) << 30) - 1)
#define JS_ROPE_MIN          13    /* shorter concatenations copy instead */
#define JS_ROPE_MAX_DEPTH    1024  /* deeper concatenations flatten eagerly */
#define JS_SLICE_MIN         13    /* shorter substrings copy instead */
#define JS_SLICE_MAX_WASTE   4     /* a slice is at least 1/4 of its parent; smaller ones copy */
#define JS_BUFFER_MIN_DEPTH  16    /* appending to a rope this deep continues in a buffer */

/* An append buffer is a STR_FLAT with JS_STR_BUFFER: `length` units are filled
 * and never change again, `cell.aux` is its capacity. JS code never sees one,
 * only slices of it at offset 0. Appending to the slice that ends at the fill
 * mark (the newest string built in it) writes past the mark and returns a
 * longer slice; any older one is a shorter prefix and stays valid. */

typedef struct JSString {        /* kind = STR_FLAT */
    JSCell   cell;               /* flags: STR_LATIN1, STR_ATOM, CELL_STATIC */
    uint32_t length;             /* UTF-16 code units */
    uint32_t hash;               /* 0 = not computed yet; computed hashes are never 0 */
    union { uint8_t latin1[1]; uint16_t utf16[1]; } chars;  /* flexible; Latin-1 has a trailing NUL */
} JSString;                      /* 16-byte header */

typedef struct JSRope {          /* kind = STR_ROPE */
    JSCell   cell;               /* flags: STR_LATIN1 */
    uint32_t length;
    uint16_t depth;              /* max(left depth, right depth) + 1 */
    uint16_t reserved;
    JSValue  left;               /* after flattening: the resulting STR_FLAT */
    JSValue  right;              /* after flattening: JS_EMPTY */
} JSRope;

typedef struct JSSlice {         /* kind = STR_SLICE */
    JSCell   cell;               /* flags: STR_LATIN1 */
    uint32_t length;
    uint32_t hash;               /* as in JSString */
    JSValue  parent;             /* a STR_FLAT: slices never nest */
    uint32_t offset;             /* the first unit, in the parent */
    uint32_t reserved;
} JSSlice;

#define JS_STRING_HEADER_SIZE offsetof(JSString, chars)

/* ---- Views ------------------------------------------------------------- */

typedef struct {
    const void *chars;  /* uint8_t* if latin1, else uint16_t* */
    uint32_t    length;
    bool        latin1;
} JSStrView;

static inline uint32_t js_view_at(JSStrView v, uint32_t i) {
    return v.latin1 ? ((const uint8_t *)v.chars)[i] : ((const uint16_t *)v.chars)[i];
}

static inline JSStrView js_view_latin1(const char *chars, uint32_t length) {
    return (JSStrView){ chars, length, true };
}

static inline JSStrView js_view_utf16(const uint16_t *chars, uint32_t length) {
    return (JSStrView){ chars, length, false };
}

/* The characters of string `s`, flattening a rope first (which allocates).
 * Valid while `s` is live; the chars pointer itself keeps the cell alive. */
JSStrView js_string_view(JSContext *ctx, JSValue s);

/* ---- Type tests and accessors ----------------------------------------- */

static inline bool js_is_string(JSValue v) {
    if (!js_is_cell(v)) return false;
    uint8_t k = js_as_cell(v)->kind;
    return k >= JS_CELL_STR_FLAT && k <= JS_CELL_STR_SLICE;
}

static inline uint32_t js_string_length(JSValue s) {
    JSCell *c = js_as_cell(s);
    switch (c->kind) {
    case JS_CELL_STR_FLAT: return ((JSString *)c)->length;
    case JS_CELL_STR_ROPE: return ((JSRope *)c)->length;
    default: return ((JSSlice *)c)->length;
    }
}

/* ---- Hashing (FNV-1a over UTF-16 code units; the compiler computes the same) ---- */

#define JS_HASH_INIT  UINT32_C(2166136261)
#define JS_HASH_PRIME UINT32_C(16777619)
#define JS_HASH_STEP(h, unit) ((uint32_t)(((h) ^ (uint32_t)(unit)) * JS_HASH_PRIME))
#define JS_HASH_FIX(h) ((h) ? (h) : UINT32_C(1))  /* 0 means "not computed" */

uint32_t js_hash_view(JSStrView v);
uint32_t js_string_hash(JSContext *ctx, JSValue s);  /* cached in the cell (not in static cells) */

/* ---- Static strings (compiler-emitted, never collected) ---------------- */

#define JS_STATIC_LATIN1_TYPE(n) \
    struct { _Alignas(16) JSCell cell; uint32_t length, hash; uint8_t chars[(n) + 1]; }
#define JS_STATIC_UTF16_TYPE(n) \
    struct { _Alignas(16) JSCell cell; uint32_t length, hash; uint16_t chars[(n) ? (n) : 1]; }
#define JS_STATIC_LATIN1_INIT(len, hash, ...) \
    { JS_CELL_HEADER(JS_CELL_STR_FLAT, JS_CELL_STATIC | JS_STR_LATIN1), (len), (hash), __VA_ARGS__ }
#define JS_STATIC_ATOM_INIT(len, hash, ...) \
    { JS_CELL_HEADER(JS_CELL_STR_FLAT, JS_CELL_STATIC | JS_STR_LATIN1 | JS_STR_ATOM), (len), (hash), __VA_ARGS__ }
#define JS_STATIC_UTF16_INIT(len, hash, ...) \
    { JS_CELL_HEADER(JS_CELL_STR_FLAT, JS_CELL_STATIC), (len), (hash), __VA_ARGS__ }
#define JS_STATIC_UTF16_ATOM_INIT(len, hash, ...) \
    { JS_CELL_HEADER(JS_CELL_STR_FLAT, JS_CELL_STATIC | JS_STR_ATOM), (len), (hash), __VA_ARGS__ }
#define JS_STATIC_STR(s) js_cell((JSCell *)&(s))

/* "" and every single code unit 0…255: static atoms, never allocated. */
JSValue js_empty_string(void);
typedef JS_STATIC_LATIN1_TYPE(1) JSStaticChar;
extern const JSStaticChar js_char_strings[256];
/* Inline: generated code names one-character keys (`o.x`) with it at every access. */
static inline JSValue js_char_string(uint8_t unit) { return js_cell((JSCell *)&js_char_strings[unit]); }

/* ---- Creating strings -------------------------------------------------- */

/* Each narrows to Latin-1 when it can, and returns the static cells for "" and
 * single units <= 0xFF. Longer than JS_STRING_MAX_LENGTH: RangeError. */
JS_WARN_UNUSED JSValue js_new_string_latin1(JSContext *ctx, const uint8_t *chars, uint32_t length);
JS_WARN_UNUSED JSValue js_new_string_utf16(JSContext *ctx, const uint16_t *chars, uint32_t length);
JS_WARN_UNUSED JSValue js_new_string_view(JSContext *ctx, JSStrView v);
/* Decodes UTF-8; invalid sequences become U+FFFD. */
JS_WARN_UNUSED JSValue js_new_string_utf8(JSContext *ctx, const char *s, size_t length);
JS_WARN_UNUSED JSValue js_new_string_cstr(JSContext *ctx, const char *s);  /* UTF-8, NUL-terminated */

/* ---- Operations -------------------------------------------------------- */

/* RangeError if the result would exceed JS_STRING_MAX_LENGTH. */
JS_WARN_UNUSED JSValue js_concat(JSContext *ctx, JSValue a, JSValue b);
/* Code units [start, end) of s; 0 <= start <= end <= length. */
JSValue js_substring(JSContext *ctx, JSValue s, uint32_t start, uint32_t end);
bool js_string_equals(JSContext *ctx, JSValue a, JSValue b);
/* <0, 0, >0 by code units (the relational operators on strings). */
int js_string_compare(JSContext *ctx, JSValue a, JSValue b);

/* Number::toString(n) as a string cell. `n` is an int32 or a double. */
JSValue js_number_to_string(JSContext *ctx, JSValue n);

/* ---- Output ------------------------------------------------------------ */

/* UTF-8 encoding of a view; lone surrogates become U+FFFD. Writes at most `cap`
 * bytes (no NUL) and returns the full length needed. */
size_t js_view_to_utf8(JSStrView v, char *out, size_t cap);

#endif /* JSSTRING_H */
