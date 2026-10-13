/* Inline caches: hits, misses that must not hit, weak reset. */
#include <string.h>

#include "js_builtins.h"
#include "js_function.h"
#include "jstest.h"
#include "test_util.h"

#ifdef _MSC_VER
#define NOINLINE __declspec(noinline)
#else
#define NOINLINE __attribute__((noinline))
#endif

static JSRuntime *rt;
static JSContext *ctx;
static JSPropCache ics[128];

static void setup(void) {
    rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    ctx = js_context_new(rt);
    memset(ics, 0, sizeof ics);
    js_register_prop_caches(rt, ics, 128);
}
static void teardown(void) {
    js_context_free(ctx);
    js_runtime_free(rt);
}

static JSValue atom(const char *s) {
    JSValue a = js_atom_from_cstr(ctx, s);
    return a;
}

static JSValue obj_with(JSValue proto, const char *k1, int v1, const char *k2, int v2) {
    JSValue o = js_new_object_proto(ctx, proto, JS_DEFAULT_INLINE_SLOTS);
    if (k1) js_define_data(ctx, js_as_object(o), atom(k1), js_int32(v1), JS_PROP_DEFAULT);
    if (k2) js_define_data(ctx, js_as_object(o), atom(k2), js_int32(v2), JS_PROP_DEFAULT);
    return o;
}

static int32_t get_int(JSValue o, const char *k, JSPropCache *ic) {
    JSValue v = js_get_prop(ctx, o, atom(k), ic);
    return js_is_int32(v) ? js_as_int32(v) : -999;
}

TEST(ic_own_get) {
    setup();
    JSValue proto = ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE];
    JSValue a = obj_with(proto, "x", 1, "y", 2), b = obj_with(proto, "x", 10, "y", 20);
    CHECK(js_as_object(a)->shape == js_as_object(b)->shape);
    CHECK_EQ_INT(get_int(a, "y", &ics[0]), 2);
    CHECK_EQ_INT(ics[0].kind, JS_IC_OWN);
    CHECK(ics[0].fast == js_as_object(a)->shape);  /* an inline slot: the inline path hits */
    CHECK_EQ_INT(get_int(b, "y", &ics[0]), 20);  /* a hit on another object with the shape */
    /* a different shape misses, answers correctly and refills */
    JSValue c = obj_with(proto, "y", 5, NULL, 0);
    CHECK_EQ_INT(get_int(c, "y", &ics[0]), 5);
    CHECK(ics[0].shape == js_as_object(c)->shape);
    /* out-of-line slots */
    JSValue big = js_new_object(ctx);
    char k[8];
    for (int i = 0; i < 12; i++) {
        snprintf(k, sizeof k, "p%d", i);
        js_define_data(ctx, js_as_object(big), atom(k), js_int32(i * 3), JS_PROP_DEFAULT);
    }
    CHECK_EQ_INT(get_int(big, "p10", &ics[1]), 30);
    CHECK_EQ_INT(get_int(big, "p10", &ics[1]), 30);
    CHECK_EQ_INT(ics[1].kind, JS_IC_OWN);
    CHECK(ics[1].fast == NULL);  /* an overflow slot: hits in the slow path */
    CHECK_EQ_INT(get_int(big, "p0", &ics[3]), 0);
    CHECK(ics[3].fast == js_as_object(big)->shape);  /* the same object's inline slots still take the inline path */
    CHECK_EQ_INT(js_set_prop(ctx, big, atom("p11"), js_int32(7), true, &ics[4]), 1);
    CHECK_EQ_INT(js_set_prop(ctx, big, atom("p11"), js_int32(8), true, &ics[4]), 1);
    CHECK_EQ_INT(ics[4].kind, JS_IC_OWN);
    CHECK(ics[4].fast == NULL);
    CHECK_EQ_INT(get_int(big, "p11", &ics[5]), 8);
    /* absent keys are undefined, and cached as absent until the receiver or a prototype changes */
    CHECK(js_is_undefined(js_get_prop(ctx, a, atom("nope"), &ics[2])));
    CHECK_EQ_INT(ics[2].kind, JS_IC_ABSENT);
    CHECK(js_is_undefined(js_get_prop(ctx, a, atom("nope"), &ics[2])));
    js_define_data(ctx, js_as_object(proto), atom("nope"), js_int32(4), JS_PROP_DEFAULT);
    CHECK_EQ_INT(get_int(a, "nope", &ics[2]), 4);
    CHECK_EQ_INT(js_delete_property(ctx, js_as_object(proto), atom("nope"), true), 1);
    teardown();
}

TEST(ic_proto_get) {
    setup();
    JSValue root = ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE];
    JSValue p2 = obj_with(root, "m", 7, NULL, 0);
    JSValue p1 = obj_with(p2, "other", 0, NULL, 0);
    JSValue o = obj_with(p1, "x", 1, NULL, 0);
    CHECK_EQ_INT(get_int(o, "m", &ics[0]), 7);
    CHECK_EQ_INT(ics[0].kind, JS_IC_PROTO);
    CHECK_EQ_INT(ics[0].depth, 2);
    CHECK_EQ_INT(get_int(o, "m", &ics[0]), 7);
    /* the holder's value changes: a hit reads the new value */
    CHECK_EQ_INT(js_set_value(ctx, p2, atom("m"), js_int32(8), true), 1);
    CHECK_EQ_INT(get_int(o, "m", &ics[0]), 8);
    /* shadowed on the way: p1 changed shape, so no stale hit */
    js_define_data(ctx, js_as_object(p1), atom("m"), js_int32(99), JS_PROP_DEFAULT);
    CHECK_EQ_INT(get_int(o, "m", &ics[0]), 99);
    /* shadowed on the receiver itself */
    js_define_data(ctx, js_as_object(o), atom("m"), js_int32(5), JS_PROP_DEFAULT);
    CHECK_EQ_INT(get_int(o, "m", &ics[0]), 5);
    /* deleted from p1 again (last added: back to its old shape) */
    CHECK_EQ_INT(get_int(obj_with(p1, "x", 1, NULL, 0), "m", &ics[1]), 99);
    CHECK_EQ_INT(js_delete_property(ctx, js_as_object(p1), atom("m"), true), 1);
    CHECK_EQ_INT(get_int(obj_with(p1, "x", 1, NULL, 0), "m", &ics[1]), 8);
    /* a getter is cached as a getter: a hit calls the accessor the holder has now */
    JSValue f = js_new_object(ctx);
    JSPropertyDescriptor acc = { JS_DESC_GET | JS_DESC_CONFIGURABLE, JS_PROP_CONFIGURABLE, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    CHECK_EQ_INT(js_define_own_property(ctx, js_as_object(f), atom("g"), &acc, true), 1);
    CHECK(js_is_undefined(js_get_prop(ctx, f, atom("g"), &ics[2])));
    CHECK_EQ_INT(ics[2].kind, JS_IC_GETTER);
    CHECK(js_is_undefined(js_get_prop(ctx, f, atom("g"), &ics[2])));
    /* replaced by a data property: the shape changes, the cache misses */
    js_define_data(ctx, js_as_object(f), atom("g"), js_int32(3), JS_PROP_DEFAULT);
    CHECK_EQ_INT(get_int(f, "g", &ics[2]), 3);
    teardown();
}

TEST(ic_own_set) {
    setup();
    JSValue a = obj_with(ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], "x", 1, "y", 2);
    JSValue b = obj_with(ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], "x", 1, "y", 2);
    CHECK_EQ_INT(js_set_prop(ctx, a, atom("y"), js_int32(3), true, &ics[0]), 1);
    CHECK_EQ_INT(ics[0].kind, JS_IC_OWN);
    CHECK(ics[0].fast == js_as_object(a)->shape);
    CHECK_EQ_INT(js_set_prop(ctx, b, atom("y"), js_int32(4), true, &ics[0]), 1);
    CHECK_EQ_INT(get_int(a, "y", &ics[1]), 3);
    CHECK_EQ_INT(get_int(b, "y", &ics[1]), 4);
    /* read-only: never cached; sloppy fails quietly, strict throws */
    JSValue r = js_new_object(ctx);
    js_define_data(ctx, js_as_object(r), atom("y"), js_int32(1), JS_PROP_ENUMERABLE);
    CHECK_EQ_INT(js_set_prop(ctx, r, atom("y"), js_int32(2), false, &ics[2]), 0);
    CHECK_EQ_INT(ics[2].kind, JS_IC_EMPTY);
    CHECK_EQ_INT(js_set_prop(ctx, r, atom("y"), js_int32(2), true, &ics[2]), -1);
    CHECK(strncmp(take_error_text(ctx), "TypeError: ", 11) == 0);
    teardown();
}

static int setter_calls;
static JSValue counting_setter(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)c, (void)callee, (void)this_val, (void)argc, (void)argv, (void)nt;
    setter_calls++;
    return JS_UNDEFINED;
}

TEST(ic_add) {
    setup();
    JSValue proto = js_new_object(ctx);
    /* the same sequence of adds on many objects: after the first, each add is a cache hit */
    static const char *const keys[] = { "a", "b", "c", "d", "e", "f", "g" };  /* past the 4 inline slots */
    JSValue objs[5];
    for (int n = 0; n < 5; n++) {
        objs[n] = js_new_object_proto(ctx, proto, JS_DEFAULT_INLINE_SLOTS);
        for (int k = 0; k < 7; k++) CHECK_EQ_INT(js_set_prop(ctx, objs[n], atom(keys[k]), js_int32(n * 10 + k), true, &ics[k]), 1);
    }
    for (int k = 0; k < 7; k++) CHECK_EQ_INT(ics[k].kind, JS_IC_ADD);
    for (int n = 0; n < 5; n++) {
        CHECK(js_as_object(objs[n])->shape == js_as_object(objs[0])->shape);
        for (int k = 0; k < 7; k++) CHECK_EQ_INT(get_int(objs[n], keys[k], &ics[20 + k]), n * 10 + k);
    }
    JSValue keys_arr = js_own_keys(ctx, js_as_object(objs[4]));
    CHECK_EQ_INT(((JSValueArray *)js_as_cell(keys_arr))->cell.aux, 7);
    /* a setter appears on the prototype: the cached add must not run */
    JSValue setter = js_new_native(ctx, counting_setter, atom("set"), 1, JS_FN_STRICT);
    JSPropertyDescriptor acc = { JS_DESC_SET | JS_DESC_CONFIGURABLE, JS_PROP_CONFIGURABLE, JS_UNDEFINED, JS_UNDEFINED, setter };
    CHECK_EQ_INT(js_define_own_property(ctx, js_as_object(proto), atom("a"), &acc, true), 1);
    JSValue o = js_new_object_proto(ctx, proto, JS_DEFAULT_INLINE_SLOTS);
    setter_calls = 0;
    CHECK_EQ_INT(js_set_prop(ctx, o, atom("a"), js_int32(1), true, &ics[0]), 1);
    CHECK_EQ_INT(setter_calls, 1);
    JSPropertyDescriptor d;
    CHECK_EQ_INT(js_get_own_property(ctx, js_as_object(o), atom("a"), &d), 0);
    /* a read-only property up the chain blocks the add too */
    JSValue p2 = js_new_object(ctx);
    JSValue o2 = js_new_object_proto(ctx, p2, JS_DEFAULT_INLINE_SLOTS);
    CHECK_EQ_INT(js_set_prop(ctx, o2, atom("z"), js_int32(1), true, &ics[10]), 1);
    CHECK_EQ_INT(ics[10].kind, JS_IC_ADD);
    js_define_data(ctx, js_as_object(p2), atom("z"), js_int32(0), 0);
    JSValue o3 = js_new_object_proto(ctx, p2, JS_DEFAULT_INLINE_SLOTS);
    CHECK_EQ_INT(js_set_prop(ctx, o3, atom("z"), js_int32(1), false, &ics[10]), 0);
    /* a non-extensible receiver */
    JSValue o4 = js_new_object_proto(ctx, proto, JS_DEFAULT_INLINE_SLOTS);
    CHECK_EQ_INT(js_prevent_extensions(ctx, js_as_object(o4)), 1);
    CHECK_EQ_INT(js_set_prop(ctx, o4, atom("b"), js_int32(1), false, &ics[1]), 0);
    teardown();
}

static JSValue noop(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)c, (void)callee, (void)this_val, (void)argc, (void)argv, (void)nt;
    return JS_UNDEFINED;
}
static const JSFunctionInfo noop_info = { noop, NULL, 0, JS_FN_CONSTRUCTOR | JS_FN_ORDINARY, NULL, "t.js", 0, 0 };

TEST(ic_uncacheable) {
    setup();
    /* dictionaries are never cached */
    JSValue d = obj_with(ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], "x", 1, "y", 2);
    CHECK_EQ_INT(js_delete_property(ctx, js_as_object(d), atom("x"), true), 1);  /* not the last: dictionary */
    CHECK_EQ_INT(get_int(d, "y", &ics[0]), 2);
    CHECK_EQ_INT(ics[0].kind, JS_IC_EMPTY);
    CHECK_EQ_INT(js_set_prop(ctx, d, atom("y"), js_int32(3), true, &ics[1]), 1);
    CHECK_EQ_INT(ics[1].kind, JS_IC_EMPTY);
    CHECK_EQ_INT(get_int(d, "y", &ics[0]), 3);
    /* exotic keys and primitives go the generic way */
    JSValue vals[] = { js_int32(1), js_int32(2), js_int32(3) };
    JSValue arr = js_new_array_from(ctx, vals, 3);
    CHECK_EQ_INT(get_int(arr, "length", &ics[2]), 3);
    CHECK_EQ_INT(js_set_prop(ctx, arr, JS_ATOM(length), js_int32(1), true, &ics[3]), 1);
    CHECK_EQ_INT(get_int(arr, "length", &ics[2]), 1);
    CHECK_EQ_INT(get_int(js_new_string_cstr(ctx, "abcd"), "length", &ics[4]), 4);
    CHECK(js_is_exception(js_get_prop(ctx, JS_NULL, atom("x"), &ics[5])));
    CHECK(strcmp(take_error_text(ctx), "TypeError: Cannot read properties of null (reading 'x')") == 0);
    /* a function's lazy prototype materializes through a cached site too */
    JSValue f1 = js_new_function(ctx, &noop_info), f2 = js_new_function(ctx, &noop_info);
    JSValue p1 = js_get_prop(ctx, f1, JS_ATOM(prototype), &ics[6]);
    JSValue p2 = js_get_prop(ctx, f2, JS_ATOM(prototype), &ics[6]);
    CHECK(js_is_object(p1) && js_is_object(p2) && !js_same_bits(p1, p2));
    CHECK(js_same_bits(js_get_prop(ctx, p2, JS_ATOM(constructor), &ics[7]), f2));
    CHECK(js_same_bits(js_get_prop(ctx, f2, JS_ATOM(prototype), &ics[6]), p2));
    teardown();
}

/* Fills caches with shapes only these objects use, then drops the objects. */
static NOINLINE void fill_with_garbage(int n) {
    for (int i = 0; i < n; i++) {
        JSValue proto = js_new_object(ctx);  /* a fresh root shape per object */
        JSValue o = obj_with(proto, "k", i, NULL, 0);
        JSValue v = js_get_prop(ctx, o, atom("k"), &ics[i]);
        (void)v;
    }
}

static NOINLINE void scrub(void) {
    volatile char junk[16384];
    memset((char *)junk, 0, sizeof junk);
}

TEST(ic_weak_reset) {
    setup();
    fill_with_garbage(100);
#ifndef JS_GC_STRESS  /* there, each allocation collects: earlier caches are already reset */
    for (int i = 0; i < 100; i++) CHECK_EQ_INT(ics[i].kind, JS_IC_OWN);
#endif
    scrub();
    js_gc(ctx);
    js_gc(ctx);
    int reset = 0;
    for (int i = 0; i < 100; i++) reset += ics[i].kind == JS_IC_EMPTY;
    CHECK(reset >= 95);  /* the conservative stack scan may keep a few alive */
    /* a live object keeps its cache */
    JSValue live = obj_with(js_new_object(ctx), "k", 1, NULL, 0);
    CHECK_EQ_INT(get_int(live, "k", &ics[120]), 1);
    js_gc(ctx);
    CHECK_EQ_INT(ics[120].kind, JS_IC_OWN);
    CHECK_EQ_INT(get_int(live, "k", &ics[120]), 1);
    teardown();
}
