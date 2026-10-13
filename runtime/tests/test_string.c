/* Strings. */
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "js_builtins.h"
#include "jscontext.h"
#include "jsstring.h"
#include "jstest.h"

#ifdef JS_GC_STRESS
#define SCALED(n) ((n) / 200 + 1)
#else
#define SCALED(n) (n)
#endif

static JSRuntime *rt;
static JSContext *ctx;
static void setup(void) {
    rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    ctx = js_context_new(rt);
}
static void teardown(void) {
    js_context_free(ctx);
    js_runtime_free(rt);
}

/* The string's content as UTF-8, in a static buffer. */
static const char *utf8(JSValue s) {
    static char buf[4096];
    size_t n = js_view_to_utf8(js_string_view(ctx, s), buf, sizeof buf - 1);
    buf[n < sizeof buf - 1 ? n : sizeof buf - 1] = '\0';
    return buf;
}

static JSValue str(const char *s) { return js_new_string_cstr(ctx, s); }
static bool is_latin1(JSValue s) { return (js_as_cell(s)->flags & JS_STR_LATIN1) != 0; }
static JSCellKind kind(JSValue s) { return js_cell_kind(js_as_cell(s)); }

#define CHECK_STR(v, expected)                                                 \
    do {                                                                       \
        const char *got_ = utf8(v);                                            \
        if (strcmp(got_, expected) != 0) JST_FAIL_("%s: \"%s\" != \"%s\"", #v, got_, expected); \
    } while (0)

/* A compiler-emitted literal: FNV-1a("hello") = 0x4f9f2cab. */
static const JS_STATIC_LATIN1_TYPE(5) lit_hello = JS_STATIC_LATIN1_INIT(5, 0x4f9f2cab, "hello");
static const JS_STATIC_UTF16_TYPE(2) lit_alpha_beta = JS_STATIC_UTF16_INIT(2, 0, { 0x3B1, 0x3B2 });
/* UTF-16 storage with Latin-1 content: width isn't canonical. */
static const JS_STATIC_UTF16_TYPE(3) lit_wide_abc = JS_STATIC_UTF16_INIT(3, 0, { 'a', 'b', 'c' });

TEST(str_static_cells) {
    setup();
    JSValue e = js_empty_string();
    CHECK(js_is_string(e) && js_string_length(e) == 0);
    CHECK(js_cell_is_static(js_as_cell(e)));
    for (unsigned u = 0; u < 256; u++) {
        JSValue c = js_char_string((uint8_t)u);
        JSString *s = (JSString *)js_as_cell(c);
        if (s->length != 1 || s->chars.latin1[0] != u || !js_cell_is_static(&s->cell) ||
            s->hash != js_hash_view(js_view_latin1((const char *)s->chars.latin1, 1))) {
            JST_FAIL_("char string %u", u);
            break;
        }
    }
    uint8_t x = 'x', hi = 0xE9;
    CHECK(js_same_bits(js_new_string_latin1(ctx, &x, 1), js_char_string('x')));
    CHECK(js_same_bits(js_new_string_latin1(ctx, &hi, 0), e));
    uint16_t u16 = 0xE9;
    CHECK(js_same_bits(js_new_string_utf16(ctx, &u16, 1), js_char_string(0xE9)));
    CHECK(js_string_equals(ctx, JS_STATIC_STR(lit_hello), str("hello")));
    CHECK_STR(JS_STATIC_STR(lit_alpha_beta), "αβ");
    teardown();
}

TEST(str_width) {
    setup();
    static const uint16_t narrow[] = { 'a', 0xE9, 0xFF };
    static const uint16_t wide[] = { 'a', 0x3B1, 'b' };
    JSValue n = js_new_string_utf16(ctx, narrow, 3), w = js_new_string_utf16(ctx, wide, 3);
    CHECK(is_latin1(n));
    CHECK(!is_latin1(w));
    CHECK_STR(n, "aéÿ");
    CHECK_STR(w, "aαb");
    CHECK_EQ_INT(js_string_length(w), 3);
    teardown();
}

TEST(str_utf8) {
    setup();
    CHECK_EQ_INT(js_string_length(str("héllo")), 5);
    CHECK(is_latin1(str("héllo")));
    JSValue euro = str("€");
    CHECK_EQ_INT(js_string_length(euro), 1);
    CHECK_EQ_INT(js_view_at(js_string_view(ctx, euro), 0), 0x20AC);
    JSValue emoji = str("a😀");
    JSStrView v = js_string_view(ctx, emoji);
    CHECK(v.length == 3 && js_view_at(v, 1) == 0xD83D && js_view_at(v, 2) == 0xDE00);
    CHECK_STR(emoji, "a😀");
    /* invalid input: a stray byte, an overlong NUL, an encoded surrogate */
    JSValue bad = js_new_string_utf8(ctx, "\xff" "\xc0\x80" "\xed\xa0\x80", 6);
    v = js_string_view(ctx, bad);
    int all_fffd = v.length == 6;
    for (uint32_t i = 0; all_fffd && i < v.length; i++) all_fffd = js_view_at(v, i) == 0xFFFD;
    CHECK(all_fffd);
    /* lone surrogates print as U+FFFD */
    static const uint16_t lone[] = { 'x', 0xD800, 'y' };
    CHECK_STR(js_new_string_utf16(ctx, lone, 3), "x\xEF\xBF\xBDy");
    teardown();
}

TEST(str_hash) {
    setup();
    CHECK_EQ_U64(js_string_hash(ctx, str("hello")), 0x4f9f2cab);
    CHECK_EQ_U64(js_string_hash(ctx, js_empty_string()), JS_HASH_INIT);
    static const uint16_t wide[] = { 'h', 'e', 'l', 'l', 'o' };
    CHECK_EQ_U64(js_hash_view(js_view_utf16(wide, 5)), js_hash_view(js_view_latin1("hello", 5)));
    JSValue s = str("some longer string");
    uint32_t h = js_string_hash(ctx, s);
    CHECK(h != 0);
    CHECK_EQ_U64(((JSString *)js_as_cell(s))->hash, h);  /* cached */
    teardown();
}

TEST(str_concat) {
    setup();
    JSValue a = str("abc"), b = str("def");
    CHECK(js_same_bits(js_concat(ctx, a, js_empty_string()), a));
    CHECK(js_same_bits(js_concat(ctx, js_empty_string(), b), b));
    JSValue small = js_concat(ctx, a, b);
    CHECK_EQ_INT(kind(small), JS_CELL_STR_FLAT);
    CHECK_STR(small, "abcdef");

    JSValue big = js_concat(ctx, str("the quick brown "), str("fox"));
    CHECK_EQ_INT(kind(big), JS_CELL_STR_ROPE);
    CHECK(is_latin1(big));
    CHECK_EQ_INT(js_string_length(big), 19);
    CHECK_STR(big, "the quick brown fox");
    CHECK(js_is_empty(((JSRope *)js_as_cell(big))->right));  /* flattened by the read */

    JSValue mixed = js_concat(ctx, str("latin1 part, "), str("then αβγ"));
    CHECK(!is_latin1(mixed));
    CHECK_STR(mixed, "latin1 part, then αβγ");
    CHECK_STR(js_concat(ctx, mixed, str("!")), "latin1 part, then αβγ!");
    teardown();
}

static NOINLINE void check_long_chain(int n, int prepend, int *failures) {
    JSValue piece = str("0123456789abcdef");
    JSValue s = js_empty_string();
    unsigned max_depth = 0;
    for (int i = 0; i < n; i++) {
        s = prepend ? js_concat(ctx, piece, s) : js_concat(ctx, s, piece);
        if (js_cell_kind(js_as_cell(s)) == JS_CELL_STR_ROPE) {
            unsigned d = ((JSRope *)js_as_cell(s))->depth;
            if (d > max_depth) max_depth = d;
        }
    }
    int before = jstest_failures;
    CHECK(max_depth <= JS_ROPE_MAX_DEPTH);
    CHECK_EQ_INT(js_string_length(s), 16 * n);
    JSStrView v = js_string_view(ctx, s);
    int ok = 1;
    for (uint32_t i = 0; ok && i < v.length; i++) ok = js_view_at(v, i) == (uint32_t)"0123456789abcdef"[i % 16];
    CHECK(ok);
    *failures = jstest_failures - before;
}

/* 100,000-deep concatenation chains in both directions stay bounded in depth. */
TEST(str_rope_depth) {
    setup();
    int failures = 0;
    check_long_chain(SCALED(100000), 0, &failures);
    check_long_chain(SCALED(100000), 1, &failures);
    CHECK_EQ_INT(failures, 0);
    teardown();
}

/* The buffer a string is a slice of, or NULL. */
static JSString *buffer_of(JSValue s) {
    if (kind(s) != JS_CELL_STR_SLICE) return NULL;
    JSString *p = (JSString *)js_as_cell(((JSSlice *)js_as_cell(s))->parent);
    return (p->cell.flags & JS_STR_BUFFER) ? p : NULL;
}

/* "x" + 20 of "0123456789abcdef"[i]: past JS_BUFFER_MIN_DEPTH appends, so in a buffer. */
static JSValue appended(int n) {
    JSValue s = str("start of an append loop: ");
    for (int i = 0; i < n; i++) s = js_concat(ctx, s, js_char_string((uint8_t)"0123456789abcdef"[i % 16]));
    return s;
}

/* Appending in a loop moves from a rope to a buffer; older strings keep their characters. */
TEST(str_append_buffer) {
    setup();
    JSValue rope = appended(JS_BUFFER_MIN_DEPTH - 1);
    CHECK_EQ_INT(kind(rope), JS_CELL_STR_ROPE);
    JSValue s = appended(40);
    JSString *buf = buffer_of(s);
    CHECK(buf != NULL);
    CHECK(buf && buf->length == js_string_length(s) && buf->cell.aux > buf->length);
    CHECK(is_latin1(s));
    CHECK_STR(s, "start of an append loop: 0123456789abcdef0123456789abcdef01234567");

    /* the newest string continues in place */
    JSValue next = js_concat(ctx, s, str("XY"));
    CHECK(buffer_of(next) == buf);
    CHECK_STR(next, "start of an append loop: 0123456789abcdef0123456789abcdef01234567XY");
    /* an older one copies: `s` and `next` keep what they had */
    JSValue fork = js_concat(ctx, s, str("Z"));
    CHECK(buffer_of(fork) != buf);
    CHECK_STR(fork, "start of an append loop: 0123456789abcdef0123456789abcdef01234567Z");
    CHECK_STR(next, "start of an append loop: 0123456789abcdef0123456789abcdef01234567XY");
    CHECK_STR(s, "start of an append loop: 0123456789abcdef0123456789abcdef01234567");

    /* appending a string to itself */
    JSValue twice = js_concat(ctx, next, next);
    CHECK_EQ_INT(js_string_length(twice), 2 * js_string_length(next));
    CHECK(js_string_equals(ctx, js_substring(ctx, twice, js_string_length(next), js_string_length(twice)), next));

    /* past the capacity: a new buffer with the old content */
    JSValue grown = next;
    for (int i = 0; i < 200; i++) grown = js_concat(ctx, grown, js_char_string('.'));
    CHECK(buffer_of(grown) != NULL && buffer_of(grown) != buf);
    CHECK_EQ_INT(js_string_length(grown), js_string_length(next) + 200);
    CHECK(js_string_equals(ctx, js_substring(ctx, grown, 0, js_string_length(next)), next));

    /* a UTF-16 unit widens into a UTF-16 buffer */
    JSValue wide = js_concat(ctx, grown, str("αβ"));
    CHECK(!is_latin1(wide) && buffer_of(wide) != NULL);
    CHECK_EQ_INT(js_view_at(js_string_view(ctx, wide), js_string_length(wide) - 1), 0x3B2);
    CHECK(js_string_equals(ctx, js_substring(ctx, wide, 0, js_string_length(grown)), grown));
    JSValue wider = js_concat(ctx, wide, str("γ!"));
    CHECK(buffer_of(wider) == buffer_of(wide));
    CHECK_EQ_INT(js_view_at(js_string_view(ctx, wider), js_string_length(wider) - 2), 0x3B3);

    /* hashing and equality see only a slice's own units */
    CHECK(js_string_hash(ctx, s) == js_string_hash(ctx, appended(40)));
    CHECK(js_string_equals(ctx, s, appended(40)));
    teardown();
}

/* A buffer is kept alive by its slices alone; appending continues after a collection. */
static NOINLINE void build_appended(JSValue *slot) { *slot = appended(500); }

TEST(str_append_buffer_gc) {
    setup();
    JSValue *root = malloc(sizeof *root);
    *root = JS_UNDEFINED;
    js_add_root(rt, root);
    build_appended(root);
    js_gc(ctx);
    js_gc(ctx);
    JSValue more = js_concat(ctx, *root, str("end"));
    CHECK(buffer_of(more) != NULL);
    JSStrView v = js_string_view(ctx, more);
    int ok = v.length == 25 + 500 + 3;
    for (uint32_t i = 0; ok && i < 500; i++) ok = js_view_at(v, 25 + i) == (uint32_t)"0123456789abcdef"[i % 16];
    CHECK(ok);
    CHECK_STR(js_substring(ctx, more, v.length - 5, v.length), "23end");
    js_remove_root(rt, root);
    free(root);
    teardown();
}

/* Append loops whose results are dropped: their buffers are collected. */
static NOINLINE size_t churn_appends(int loops, int n) {
    size_t peak = 0;
    for (int k = 0; k < loops; k++) {
        JSValue s = appended(n);
        if (js_string_length(s) != (uint32_t)(25 + n)) return SIZE_MAX;
        size_t size = js_heap_size(rt);
        if (size > peak) peak = size;
    }
    return peak;
}

TEST(str_append_bounded_memory) {
    setup();
    size_t peak = churn_appends(SCALED(2000), 5000);
    CHECK(peak != SIZE_MAX);
    CHECK(rt->heap.gc_count > 0);
    CHECK(peak <= 3 * JS_GC_MIN_HEAP);
    teardown();
}

TEST(str_substring) {
    setup();
    JSValue s = str("hello, world");
    CHECK(js_same_bits(js_substring(ctx, s, 0, 12), s));
    CHECK(js_same_bits(js_substring(ctx, s, 3, 3), js_empty_string()));
    CHECK(js_same_bits(js_substring(ctx, s, 4, 5), js_char_string('o')));
    CHECK_STR(js_substring(ctx, s, 7, 12), "world");
    JSValue w = str("αβγ and abc");
    JSValue tail = js_substring(ctx, w, 4, 11);
    CHECK_STR(tail, "and abc");
    CHECK(is_latin1(tail));  /* narrowed */
    CHECK_STR(js_substring(ctx, w, 1, 3), "βγ");
    JSValue rope = js_concat(ctx, str("0123456789"), str("abcdefghij"));
    CHECK_STR(js_substring(ctx, rope, 8, 12), "89ab");
    teardown();
}

TEST(str_equals_compare) {
    setup();
    JSValue narrow = str("abc"), wide = JS_STATIC_STR(lit_wide_abc);
    CHECK(js_string_equals(ctx, narrow, str("abc")));
    CHECK(!js_string_equals(ctx, narrow, str("abd")));
    CHECK(!js_string_equals(ctx, narrow, str("abcd")));
    CHECK(js_string_equals(ctx, narrow, wide));
    CHECK(js_string_equals(ctx, wide, narrow));
    CHECK(js_string_compare(ctx, wide, str("abd")) < 0);
    CHECK(js_string_equals(ctx, js_concat(ctx, wide, str("defghijklmnop")), str("abcdefghijklmnop")));

    CHECK(js_string_compare(ctx, str("a"), str("b")) < 0);
    CHECK(js_string_compare(ctx, str("ab"), str("abc")) < 0);
    CHECK(js_string_compare(ctx, str("abc"), str("ab")) > 0);
    CHECK(js_string_compare(ctx, str("same"), str("same")) == 0);
    CHECK(js_string_compare(ctx, str("\xc3\xbf"), str("\xc4\x80")) < 0);  /* U+00FF < U+0100 */
    CHECK(js_string_compare(ctx, str("😀"), str("\xef\xbd\xa1")) < 0);   /* by code units: D83D < FF61 */
    teardown();
}

TEST(str_number_to_string) {
    setup();
    CHECK_STR(js_number_to_string(ctx, js_int32(42)), "42");
    CHECK_STR(js_number_to_string(ctx, js_int32(-7)), "-7");
    CHECK(js_same_bits(js_number_to_string(ctx, js_int32(7)), js_char_string('7')));
    CHECK_STR(js_number_to_string(ctx, js_double(0.1)), "0.1");
    CHECK_STR(js_number_to_string(ctx, js_double(-0.0)), "0");
    CHECK_STR(js_number_to_string(ctx, js_double(NAN)), "NaN");
    CHECK_STR(js_number_to_string(ctx, js_double(1e21)), "1e+21");
    teardown();
}

/* Ropes and their children survive collections; flattening after a GC works. */
static NOINLINE void build_rope(JSValue *slot) {
    JSValue s = JS_STATIC_STR(lit_hello);
    for (int i = 0; i < 200; i++) s = js_concat(ctx, s, js_number_to_string(ctx, js_int32(i)));
    *slot = s;
}

static NOINLINE int rope_ok(const JSValue *slot) {
    JSStrView v = js_string_view(ctx, *slot);
    char expect[1024] = "hello";
    for (int i = 0; i < 200; i++) snprintf(expect + strlen(expect), sizeof expect - strlen(expect), "%d", i);
    if (v.length != strlen(expect)) return 0;
    for (uint32_t i = 0; i < v.length; i++)
        if (js_view_at(v, i) != (uint8_t)expect[i]) return 0;
    return 1;
}

TEST(str_gc) {
    setup();
    JSValue *root = malloc(sizeof *root);
    *root = JS_UNDEFINED;  /* a root must hold a valid value before it's added */
    js_add_root(rt, root);
    build_rope(root);
    js_gc(ctx);
    js_gc(ctx);
    CHECK(rope_ok(root));
    js_gc(ctx);
    CHECK(rope_ok(root));  /* the flattened result is kept alive by the rope */
    js_remove_root(rt, root);
    free(root);
    teardown();
}

/* "item " + i, joined in pairs: garbage strings, rooted only through a ring. */
static NOINLINE size_t churn_strings(JSValue *ring_slot, int n, int window) {
    JSValueArray *ring = (JSValueArray *)js_as_cell(*ring_slot);
    size_t peak = 0;
    JSValue prefix = str("item number ");
    for (int i = 0; i < n; i++) {
        JSValue s = js_concat(ctx, prefix, js_number_to_string(ctx, js_int32(i)));
        s = js_concat(ctx, s, js_number_to_string(ctx, js_double(i + 0.5)));
        js_store(ctx, &ring->cell, &ring->values[i % window], s);
        size_t size = js_heap_size(rt);
        if (size > peak) peak = size;
    }
    return peak;
}

/* Millions of strings allocated in a loop with bounded memory. */
TEST(str_bounded_memory) {
    setup();
    JSValue *ring = malloc(sizeof *ring);
    *ring = js_cell(&js_alloc_value_array(ctx, 1000)->cell);
    js_add_root(rt, ring);
    size_t peak = churn_strings(ring, SCALED(2000000), 1000);  /* 8M+ cells */
    CHECK(rt->heap.gc_count > 0);
    CHECK(peak <= 3 * JS_GC_MIN_HEAP);
    js_remove_root(rt, ring);
    free(ring);
    teardown();
}
