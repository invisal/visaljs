/* Atoms. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "js_builtins.h"
#include "js_exception.h"
#include "jstest.h"

#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#endif

#ifdef JS_GC_STRESS
#define SCALED(n) ((n) / 100 + 1)
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

static JSValue str(const char *s) {
    JSValue v = js_new_string_cstr(ctx, s);
    return v;
}

static JSValue atom(const char *s) {
    JSValue v = js_atom_from_cstr(ctx, s);
    return v;
}

TEST(atom_identity) {
    setup();
    JSValue a = str("some property name"), b = str("some property name");
    CHECK(!js_same_bits(a, b));
    JSValue aa = js_atomize(ctx, a), ab = js_atomize(ctx, b);
    CHECK(js_same_bits(aa, ab));
    CHECK(js_same_bits(aa, a));  /* the heap string itself became the atom: no copy */
    CHECK(js_is_atom(aa));
    CHECK(!js_is_atom(b));
    CHECK(js_same_bits(js_atomize(ctx, aa), aa));
    /* distinct atoms are known to differ without reading characters */
    CHECK(!js_string_equals(ctx, aa, atom("some property namf")));
    teardown();
}

TEST(atom_predefined) {
    setup();
    CHECK(js_same_bits(atom("length"), JS_ATOM(length)));
    CHECK(js_same_bits(atom("__proto__"), JS_ATOM(proto)));
    CHECK(js_same_bits(atom(""), js_empty_string()));
    CHECK(js_same_bits(atom("x"), js_char_string('x')));
    CHECK(js_same_bits(atom("\xc3\xa9"), js_char_string(0xE9)));  /* "é" */
    /* the generated hashes match the runtime's hash */
    JSString *len = (JSString *)js_as_cell(JS_ATOM(length));
    CHECK_EQ_U64(len->hash, js_hash_view(js_view_latin1("length", 6)));
    CHECK(js_atom_count(rt) >= 257 + 30);
    teardown();
}

TEST(atom_from_rope_and_static) {
    setup();
    JSValue rope = js_concat(ctx, str("constru"), str("ctor and more text"));
    JSValue a = js_atomize(ctx, rope);
    CHECK(js_is_atom(a));
    CHECK(js_string_equals(ctx, a, str("constructor and more text")));
    CHECK(js_same_bits(atom("constructor and more text"), a));
    CHECK(js_same_bits(js_atomize(ctx, js_concat(ctx, str("constr"), str("uctor"))), JS_ATOM(constructor)));

    /* a static string that isn't an atom: interned as a heap copy */
    static const JS_STATIC_LATIN1_TYPE(9) lit = JS_STATIC_LATIN1_INIT(9, 0, "not atom!");
    JSValue s = JS_STATIC_STR(lit);
    JSValue as = js_atomize(ctx, s);
    CHECK(js_is_atom(as) && !js_same_bits(as, s) && !js_cell_is_static(js_as_cell(as)));
    CHECK(js_string_equals(ctx, as, s));
    CHECK(js_same_bits(js_atomize(ctx, s), as));

    /* UTF-16 content */
    JSValue greek = atom("αβγ");
    CHECK(js_same_bits(js_atomize(ctx, str("αβγ")), greek));
    teardown();
}

/* Atoms nothing references are dropped (weak entries). */
static NOINLINE void make_atoms(int n, const char *prefix) {
    char buf[64];
    for (int i = 0; i < n; i++) {
        snprintf(buf, sizeof buf, "%s%d", prefix, i);
        JSValue a = atom(buf);
        (void)a;
    }
}

static NOINLINE void keep_atom(JSValue *slot, const char *s) { *slot = atom(s); }

static NOINLINE int same_atom(const JSValue *slot, const char *s) { return js_same_bits(*slot, atom(s)); }

static NOINLINE JST_NO_ASAN void scrub(void) {
    volatile char buf[64 * 1024];
    for (size_t i = 0; i < sizeof buf; i++) buf[i] = 0;
}

TEST(atom_weak) {
    setup();
    size_t base = js_atom_count(rt);
    JSValue *root = malloc(sizeof *root);
    *root = JS_UNDEFINED;
    js_add_root(rt, root);
    keep_atom(root, "a survivor");
    make_atoms(SCALED(100000), "dynamic key ");
    CHECK(js_atom_count(rt) >= base + 1);
    scrub();
    js_gc(ctx);
    CHECK_EQ_INT(js_atom_count(rt), base + 1);
    CHECK(same_atom(root, "a survivor"));  /* identity kept across collections */
    /* the table shrank back: to the live atoms (4x, rounded up to a power of two), not 100,000 */
    CHECK(rt->atoms.cap <= 512 || rt->atoms.cap < 8 * js_atom_count(rt));
    js_remove_root(rt, root);
    free(root);
    teardown();
}

TEST(atom_many) {
    setup();
    size_t base = js_atom_count(rt);
    JSValue *all = malloc(sizeof *all);
    *all = js_cell(&js_alloc_value_array(ctx, (uint32_t)SCALED(100000))->cell);
    js_add_root(rt, all);
    JSValueArray *arr = (JSValueArray *)js_as_cell(*all);
    char buf[64];
    int n = SCALED(100000);
    for (int i = 0; i < n; i++) {
        snprintf(buf, sizeof buf, "key%d", i);
        js_store(ctx, &arr->cell, &arr->values[i], atom(buf));
    }
    js_gc(ctx);
    CHECK_EQ_INT(js_atom_count(rt), base + (size_t)n);
    int ok = 1;
    for (int i = 0; ok && i < n; i += 97) {
        snprintf(buf, sizeof buf, "key%d", i);
        ok = js_same_bits(atom(buf), arr->values[i]);
    }
    CHECK(ok);
    js_remove_root(rt, all);
    free(all);
    teardown();
}

#ifndef _WIN32
static const JS_STATIC_LATIN1_TYPE(6) dup_length = JS_STATIC_ATOM_INIT(6, 0x83d03615u, "length");

/* Two static atoms with the same content would break pointer comparison. */
TEST(atom_duplicate_static_is_fatal) {
    fflush(NULL);
    pid_t pid = fork();
    if (pid == 0) {
        if (!freopen("/dev/null", "w", stderr)) _exit(99);
        JSRuntime *r = js_runtime_new();
        const JSString *cells[] = { (const JSString *)&dup_length };
        js_register_static_atoms(r, cells, 1);
        _exit(0);
    }
    int status = 0;
    waitpid(pid, &status, 0);
    CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 70);
}
#else
TEST(atom_duplicate_static_is_fatal) {}
#endif
