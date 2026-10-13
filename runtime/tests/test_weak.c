/* Weak collections and references and the collector: ephemerons, cleared WeakRef
 * targets, the kept-alive set, FinalizationRegistry cleanups. Objects meant to die are made
 * in NOINLINE helpers and the stack is scrubbed before collecting, so the conservative scan
 * can't see stale pointers to them. */
#include <stdlib.h>

#include "js_builtins.h"
#include "js_runtime.h"
#include "jstest.h"
#include "test_util.h"

/* internal.h */
void js_clear_kept_objects(JSRuntime *rt);
int js_run_finalization_cleanups(JSContext *ctx);

static JSRuntime *rt;
static JSContext *ctx;
enum { MAP, ROOT_A, REF_B, REF_C, REF_K, REGISTRY, NROOTS };
static JSValue *roots;

static void setup(void) {
    rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    ctx = js_context_new(rt);
    roots = malloc(NROOTS * sizeof *roots);
    for (int i = 0; i < NROOTS; i++) roots[i] = JS_UNDEFINED;
    js_register_roots(rt, roots, NROOTS);
}
static void teardown(void) {
    js_context_free(ctx);
    js_runtime_free(rt);
    free(roots);
}

static NOINLINE JSValue construct(const char *name, uint32_t argc, JSValue *argv) {
    JSValue c = js_global_name(ctx, name);
    return js_construct(ctx, c, argc, argv, c, NULL);
}

static NOINLINE JSValue invoke(JSValue o, const char *method, uint32_t argc, JSValue *argv) {
    JSValue f = js_get_value(ctx, o, js_atom_from_cstr(ctx, method));
    return js_call(ctx, f, o, argc, argv);
}

static NOINLINE JST_NO_ASAN void scrub(void) {
    volatile char buf[64 * 1024];
    for (size_t i = 0; i < sizeof buf; i++) buf[i] = 0;
}

static NOINLINE void collect(void) {
    js_clear_kept_objects(rt);
    scrub();
    js_gc(ctx);
}

static NOINLINE bool deref_dead(int slot) { return js_is_undefined(invoke(roots[slot], "deref", 0, NULL)); }

/* map: a → b → c (only a is a root; each value is reached only through its key), and k → {k}
 * (the value refers back to its key, which nothing else holds). */
static NOINLINE void build_ephemerons(void) {
    roots[MAP] = construct("WeakMap", 0, NULL);
    JSValue a = js_new_object(ctx), b = js_new_object(ctx), c = js_new_object(ctx), k = js_new_object(ctx);
    roots[ROOT_A] = a;
    JSValue ab[2] = { a, b }, bc[2] = { b, c };
    (void)invoke(roots[MAP], "set", 2, ab);
    (void)invoke(roots[MAP], "set", 2, bc);
    JSValue back = js_new_object(ctx);
    js_define_data(ctx, js_as_object(back), js_atom_from_cstr(ctx, "key"), k, JS_PROP_DEFAULT);
    JSValue kv[2] = { k, back };
    (void)invoke(roots[MAP], "set", 2, kv);
    roots[REF_B] = construct("WeakRef", 1, &b);
    roots[REF_C] = construct("WeakRef", 1, &c);
    roots[REF_K] = construct("WeakRef", 1, &k);
}

static NOINLINE bool get_is_object(int key_slot) {
    JSValue key = roots[key_slot];
    return js_is_object(invoke(roots[MAP], "get", 1, &key));
}

TEST(weak_map_ephemerons) {
    setup();
    build_ephemerons();
    collect();
    CHECK(!deref_dead(REF_B));  /* live through a live key */
    CHECK(!deref_dead(REF_C));  /* through b, a value itself: the pass repeats */
    CHECK(deref_dead(REF_K));   /* its value pointing back doesn't keep it */
    CHECK(get_is_object(ROOT_A));
    roots[ROOT_A] = JS_UNDEFINED;  /* now the whole chain goes */
    collect();
    CHECK(deref_dead(REF_B));
    CHECK(deref_dead(REF_C));
    teardown();
}

static NOINLINE void make_ref(void) {
    JSValue o = js_new_object(ctx);
    roots[REF_K] = construct("WeakRef", 1, &o);
}

TEST(weak_ref_kept_alive) {
    setup();
    make_ref();
    scrub();
    js_gc(ctx);                 /* new WeakRef(o) kept o for the rest of the job */
    CHECK(!deref_dead(REF_K));  /* and deref() keeps it again */
    collect();                  /* ClearKeptObjects, then a collection */
    CHECK(deref_dead(REF_K));
    teardown();
}

static int cleanups;
static JSValue cleanup_cb(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)c, (void)callee, (void)this_val, (void)new_target;
    if (argc && js_is_int32(argv[0])) cleanups += js_as_int32(argv[0]);
    return JS_UNDEFINED;
}

static NOINLINE void register_targets(void) {
    JSValue cb = js_new_native(ctx, cleanup_cb, js_empty_string(), 1, JS_FN_STRICT);
    roots[REGISTRY] = construct("FinalizationRegistry", 1, &cb);
    JSValue dead[2] = { js_new_object(ctx), js_int32(1) };
    (void)invoke(roots[REGISTRY], "register", 2, dead);
    roots[ROOT_A] = js_new_object(ctx);
    JSValue live[2] = { roots[ROOT_A], js_int32(10) };
    (void)invoke(roots[REGISTRY], "register", 2, live);
    JSValue unregistered[3] = { js_new_object(ctx), js_int32(100), roots[ROOT_A] };
    (void)invoke(roots[REGISTRY], "register", 3, unregistered);
    JSValue token = roots[ROOT_A];
    (void)invoke(roots[REGISTRY], "unregister", 1, &token);
}

TEST(finalization_registry_cleanup) {
    setup();
    cleanups = 0;
    register_targets();
    collect();
    CHECK_EQ_INT(cleanups, 0);  /* never inside the collector: a task of the event loop */
    CHECK_EQ_INT(js_run_finalization_cleanups(ctx), 0);
    CHECK_EQ_INT(cleanups, 1);  /* the dead target only; the unregistered one never */
    CHECK_EQ_INT(js_run_finalization_cleanups(ctx), 0);
    CHECK_EQ_INT(cleanups, 1);  /* once */
    teardown();
}
