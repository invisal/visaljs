/* Objects and shapes. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "js_builtins.h"
#include "js_atoms.h"
#include "js_object.h"
#include "jstest.h"
#include "test_util.h"

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

static JSValue key(const char *s) {
    JSValue k = js_atom_from_cstr(ctx, s);
    return k;
}

static JSValue get(JSValue o, const char *k) {
    JSValue v = js_get_value(ctx, o, key(k));
    return v;
}

static int set(JSValue o, const char *k, JSValue v) {
    int r = js_set_value(ctx, o, key(k), v, true);
    return r;
}

static int32_t get_int(JSValue o, const char *k) {
    JSValue v = get(o, k);
    return js_is_int32(v) ? js_as_int32(v) : -999;
}

static JSShape *shape_of(JSValue o) { return js_as_object(o)->shape; }

TEST(obj_shapes_are_shared) {
    setup();
    JSValue a = js_new_object(ctx), b = js_new_object(ctx), c = js_new_object(ctx);
    CHECK(shape_of(a) == shape_of(b));
    CHECK_EQ_INT(set(a, "x", js_int32(1)), 1);
    CHECK_EQ_INT(set(a, "y", js_int32(2)), 1);
    CHECK_EQ_INT(set(b, "x", js_int32(5)), 1);
    CHECK_EQ_INT(set(b, "y", js_int32(9)), 1);
    CHECK_EQ_INT(set(c, "y", js_int32(0)), 1);
    CHECK_EQ_INT(set(c, "x", js_int32(0)), 1);
    CHECK(shape_of(a) == shape_of(b));       /* same order, same shape */
    CHECK(shape_of(a) != shape_of(c));       /* different order */
    CHECK(shape_of(a)->parent == shape_of(b)->parent);
    CHECK_EQ_INT(get_int(a, "x"), 1);
    CHECK_EQ_INT(get_int(b, "y"), 9);
    CHECK(js_is_undefined(get(a, "z")));
    CHECK_EQ_INT(set(a, "x", js_int32(7)), 1);  /* overwriting keeps the shape */
    CHECK(shape_of(a) == shape_of(b));
    CHECK_EQ_INT(get_int(a, "x"), 7);
    teardown();
}

TEST(obj_many_properties) {
    setup();
    JSValue o = js_new_object(ctx);
    char name[16];
    for (int i = 0; i < 100; i++) {
        snprintf(name, sizeof name, "p%d", i);
        CHECK_EQ_INT(set(o, name, js_int32(i * 3)), 1);
    }
    CHECK(js_as_object(o)->ool != NULL);        /* beyond the 4 inline slots */
    CHECK(!(shape_of(o)->flags & JS_SHAPE_DICTIONARY));
    int ok = 1;
    for (int i = 0; i < 100; i++) {
        snprintf(name, sizeof name, "p%d", i);
        ok &= get_int(o, name) == i * 3;
    }
    CHECK(ok);
    for (int i = 100; i < 200; i++) {           /* past the dictionary threshold */
        snprintf(name, sizeof name, "p%d", i);
        CHECK_EQ_INT(set(o, name, js_int32(i * 3)), 1);
    }
    CHECK(shape_of(o)->flags & JS_SHAPE_DICTIONARY);
    ok = 1;
    for (int i = 0; i < 200; i++) {
        snprintf(name, sizeof name, "p%d", i);
        ok &= get_int(o, name) == i * 3;
    }
    CHECK(ok);
    JSValueArray *keys = (JSValueArray *)js_as_cell(js_own_keys(ctx, js_as_object(o)));
    CHECK_EQ_INT(keys->cell.aux, 200);
    CHECK(js_same_bits(keys->values[0], key("p0")) && js_same_bits(keys->values[199], key("p199")));
    teardown();
}

TEST(obj_prototype_chain) {
    setup();
    JSValue proto = js_new_object(ctx);
    CHECK_EQ_INT(set(proto, "shared", js_int32(1)), 1);
    JSValue o = js_new_object_proto(ctx, proto, 4);
    CHECK_EQ_INT(get_int(o, "shared"), 1);                    /* inherited */
    CHECK_EQ_INT(js_has_property(ctx, js_as_object(o), key("shared")), 1);
    CHECK_EQ_INT(set(o, "shared", js_int32(2)), 1);           /* shadows, doesn't write the proto */
    CHECK_EQ_INT(get_int(o, "shared"), 2);
    CHECK_EQ_INT(get_int(proto, "shared"), 1);

    /* a read-only inherited property blocks the assignment */
    js_define_data(ctx, js_as_object(proto), key("fixed"), js_int32(10), 0);
    CHECK_EQ_INT(js_set_value(ctx, o, key("fixed"), js_int32(11), false), 0);
    CHECK_EQ_INT(js_set_value(ctx, o, key("fixed"), js_int32(11), true), -1);
    CHECK(js_has_exception(ctx));
    js_discard(js_take_exception(ctx));
    CHECK(js_is_undefined(js_get_value(ctx, o, key("fixed"))) == false);

    /* setPrototypeOf, and no cycles */
    CHECK_EQ_INT(js_set_prototype_of(ctx, js_as_object(proto), o), 0);
    CHECK_EQ_INT(js_set_prototype_of(ctx, js_as_object(o), JS_NULL), 1);
    CHECK(js_is_undefined(get(o, "fixed")));
    teardown();
}

TEST(obj_delete) {
    setup();
    JSValue o = js_new_object(ctx);
    set(o, "a", js_int32(1));
    set(o, "b", js_int32(2));
    JSShape *with_a = shape_of(o)->parent;
    CHECK_EQ_INT(js_delete_property(ctx, js_as_object(o), key("b"), true), 1);
    CHECK(shape_of(o) == with_a);                         /* the last-added property: back to the parent */
    set(o, "b", js_int32(2));
    set(o, "c", js_int32(3));
    set(o, "d", js_int32(4));
    CHECK_EQ_INT(js_delete_property(ctx, js_as_object(o), key("b"), true), 1);
    CHECK(shape_of(o)->flags & JS_SHAPE_DICTIONARY);      /* any other: a dictionary */
    CHECK(js_is_undefined(get(o, "b")));
    CHECK_EQ_INT(get_int(o, "a") + get_int(o, "c") + get_int(o, "d"), 8);
    JSValueArray *keys = (JSValueArray *)js_as_cell(js_own_keys(ctx, js_as_object(o)));
    CHECK_EQ_INT(keys->cell.aux, 3);                      /* insertion order kept */
    CHECK(js_same_bits(keys->values[0], key("a")) && js_same_bits(keys->values[1], key("c")) && js_same_bits(keys->values[2], key("d")));
    set(o, "e", js_int32(5));
    CHECK_EQ_INT(get_int(o, "e"), 5);
    CHECK_EQ_INT(js_delete_property(ctx, js_as_object(o), key("missing"), true), 1);
    js_define_data(ctx, js_as_object(o), key("locked"), js_int32(0), JS_PROP_WRITABLE);
    CHECK_EQ_INT(js_delete_property(ctx, js_as_object(o), key("locked"), false), 0);
    CHECK_EQ_INT(js_delete_property(ctx, js_as_object(o), key("locked"), true), -1);
    js_discard(js_take_exception(ctx));
    teardown();
}

TEST(obj_define_property) {
    setup();
    JSObject *o = js_as_object(js_new_object(ctx));
    JSPropertyDescriptor d = js_data_descriptor(js_int32(1), 0);  /* non-writable, non-configurable */
    CHECK_EQ_INT(js_define_own_property(ctx, o, key("k"), &d, true), 1);
    JSPropertyDescriptor got;
    CHECK_EQ_INT(js_get_own_property(ctx, o, key("k"), &got), 1);
    CHECK(got.attrs == 0 && js_as_int32(got.value) == 1);
    /* same value: allowed; different value, or making it writable: rejected */
    CHECK_EQ_INT(js_define_own_property(ctx, o, key("k"), &d, true), 1);
    JSPropertyDescriptor other = js_data_descriptor(js_int32(2), 0);
    CHECK_EQ_INT(js_define_own_property(ctx, o, key("k"), &other, false), 0);
    JSPropertyDescriptor writable = { JS_DESC_WRITABLE, JS_PROP_WRITABLE, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    CHECK_EQ_INT(js_define_own_property(ctx, o, key("k"), &writable, false), 0);
    /* a configurable property can change attributes and become an accessor */
    js_define_data(ctx, o, key("c"), js_int32(5), JS_PROP_DEFAULT);
    JSPropertyDescriptor acc = { JS_DESC_GET, 0, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    CHECK_EQ_INT(js_define_own_property(ctx, o, key("c"), &acc, true), 1);
    CHECK_EQ_INT(js_get_own_property(ctx, o, key("c"), &got), 1);
    CHECK((got.has & JS_DESC_GET) && !(got.has & JS_DESC_VALUE));
    CHECK(got.attrs == (JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE));
    CHECK(js_is_undefined(js_get(ctx, o, key("c"), js_object_value(o))));  /* no getter: undefined */
    /* non-extensible objects take no new properties, but keep their own */
    CHECK_EQ_INT(js_prevent_extensions(ctx, o), 1);
    CHECK(!js_is_extensible(o));
    CHECK_EQ_INT(js_set_value(ctx, js_object_value(o), key("new"), js_int32(1), false), 0);
    CHECK_EQ_INT(js_as_int32(js_get(ctx, o, key("k"), js_object_value(o))), 1);
    teardown();
}

TEST(obj_property_keys) {
    setup();
    struct { JSValue in; int32_t index; const char *atom; } cases[] = {
        { js_int32(5), 5, NULL },
        { js_double(3.0), 3, NULL },
        { js_double(-0.0), 0, NULL },
        { js_double(1.5), -1, "1.5" },
        { js_int32(-1), -1, "-1" },
        { js_double(4294967295.0), -1, "4294967295" },
        { JS_TRUE, -1, "true" },
        { JS_NULL, -1, "null" },
        { js_new_string_cstr(ctx, "42"), 42, NULL },
        { js_new_string_cstr(ctx, "042"), -1, "042" },
        { js_new_string_cstr(ctx, "0"), 0, NULL },
        { js_new_string_cstr(ctx, "2147483647"), 2147483647, NULL },  /* ≥ 2^31: a double key */
        { js_new_string_cstr(ctx, "4294967294"), -1, NULL },          /* 2^32 - 2: the largest index */
        { js_new_string_cstr(ctx, "4294967295"), -1, "4294967295" },
        { js_new_string_cstr(ctx, "name"), -1, "name" },
    };
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        JSValue k = js_to_property_key(ctx, cases[i].in);
        if (cases[i].index >= 0) {
            if (!js_key_is_index(k) || js_key_index(k) != (uint32_t)cases[i].index) JST_FAIL_("case %zu: not index %d", i, cases[i].index);
        } else if (!cases[i].atom) {
            if (!js_key_is_index(k) || js_key_index(k) != 4294967294u) JST_FAIL_("case %zu: not index 4294967294", i);
        } else if (!js_is_atom(k) || !js_same_bits(k, key(cases[i].atom))) {
            JST_FAIL_("case %zu: not the atom %s", i, cases[i].atom);
        }
    }
    teardown();
}

TEST(obj_nullish_errors) {
    setup();
    CHECK(js_is_exception(js_get_value(ctx, JS_UNDEFINED, key("x"))));
    CHECK(strcmp(take_error_text(ctx), "TypeError: Cannot read properties of undefined (reading 'x')") == 0);
    CHECK_EQ_INT(js_set_value(ctx, JS_NULL, key("y"), js_int32(1), false), -1);
    CHECK(strcmp(take_error_text(ctx), "TypeError: Cannot set properties of null (setting 'y')") == 0);
    teardown();
}

static NOINLINE JST_NO_ASAN void scrub(void) {
    volatile char buf[64 * 1024];
    for (size_t i = 0; i < sizeof buf; i++) buf[i] = 0;
}

/* Objects built with one-off keys: their shapes (and transitions to them) die with them. */
static NOINLINE void one_off_objects(int n) {
    char name[16];
    for (int i = 0; i < n; i++) {
        JSValue o = js_new_object_proto(ctx, js_new_object(ctx), 2);  /* a fresh prototype: a fresh root */
        snprintf(name, sizeof name, "k%d", i);
        js_discard(js_atom_from_cstr(ctx, name));
        int r = js_set_value(ctx, o, js_atom_from_cstr(ctx, name), js_int32(i), true);
        (void)r;
    }
}

static NOINLINE void keep_object(JSValue *slot) {
    JSValue o = js_new_object(ctx);
    for (int i = 0; i < 20; i++) {
        char name[16];
        snprintf(name, sizeof name, "f%d", i);
        int r = js_set_value(ctx, o, js_atom_from_cstr(ctx, name), js_int32(i), true);
        (void)r;
    }
    *slot = o;
}

static NOINLINE int kept_intact(const JSValue *slot) {
    for (int i = 0; i < 20; i++) {
        char name[16];
        snprintf(name, sizeof name, "f%d", i);
        JSValue v = js_get_value(ctx, *slot, js_atom_from_cstr(ctx, name));
        if (!js_is_int32(v) || js_as_int32(v) != i) return 0;
    }
    return 1;
}

TEST(obj_gc) {
    setup();
    JSValue *root = malloc(sizeof *root);
    *root = JS_UNDEFINED;
    js_add_root(rt, root);
    keep_object(root);
    size_t roots_before = rt->shapes.root_count;
    one_off_objects(500);
#ifndef JS_GC_STRESS  /* stress builds have collected them already */
    CHECK(rt->shapes.root_count >= roots_before + 500);
#endif
    scrub();
    js_gc(ctx);
    scrub();
    js_gc(ctx);
    CHECK(kept_intact(root));                            /* a live object keeps its shape chain */
    CHECK(rt->shapes.root_count <= roots_before);        /* dead roots dropped */
    js_remove_root(rt, root);
    free(root);
    teardown();
}

/* ---- Arrays and elements -------------------------------------------------- */

static JSValue at(JSValue a, uint32_t i) {
    JSValue v = js_get_value(ctx, a, js_index_key(i));
    return v;
}

static int put(JSValue a, uint32_t i, JSValue v) {
    int r = js_set_value(ctx, a, js_index_key(i), v, true);
    return r;
}

static uint32_t len(JSValue a) { return js_array_length(js_as_object(a)); }

TEST(arr_basics) {
    setup();
    JSValue values[] = { js_int32(10), js_int32(20), js_int32(30) };
    JSValue a = js_new_array_from(ctx, values, 3);
    CHECK(js_is_array(a));
    CHECK_EQ_INT(len(a), 3);
    JSValue empty = js_new_array_from(ctx, NULL, 0);  /* `[]`: keeps the static empty store */
    CHECK(js_is_array(empty) && len(empty) == 0 && js_as_object(empty)->elements == &js_empty_elements);
    CHECK_EQ_INT(js_as_int32(at(a, 1)), 20);
    CHECK(js_is_undefined(at(a, 3)));
    CHECK_EQ_INT(js_as_int32(get(a, "length")), 3);                  /* length is a property */
    CHECK(js_same_bits(js_get_prototype_of(js_as_object(a)), ctx->intrinsics[JS_INTRINSIC_ARRAY_PROTOTYPE]));
    CHECK(js_is_array(ctx->intrinsics[JS_INTRINSIC_ARRAY_PROTOTYPE]));  /* Array.prototype is an array */

    CHECK_EQ_INT(put(a, 5, js_int32(60)), 1);                         /* past the end: grows, with holes */
    CHECK_EQ_INT(len(a), 6);
    CHECK(js_is_undefined(at(a, 4)));
    JSPropertyDescriptor d;
    CHECK_EQ_INT(js_get_own_property(ctx, js_as_object(a), js_index_key(4), &d), 0);  /* a hole, not undefined */
    CHECK_EQ_INT(js_array_push(ctx, js_as_object(a), js_int32(70)), 1);
    CHECK_EQ_INT(len(a), 7);
    CHECK_EQ_INT(js_as_int32(at(a, 6)), 70);

    /* the string "2" and the number 2 are the same key */
    CHECK_EQ_INT(js_as_int32(js_get_value(ctx, a, js_to_property_key(ctx, js_new_string_cstr(ctx, "2")))), 30);
    CHECK(js_is_undefined(js_get_value(ctx, a, js_to_property_key(ctx, js_new_string_cstr(ctx, "02")))));
    teardown();
}

TEST(arr_length) {
    setup();
    JSValue a = js_new_array(ctx, 0);
    for (uint32_t i = 0; i < 10; i++) CHECK_EQ_INT(put(a, i, js_int32((int32_t)i)), 1);
    CHECK_EQ_INT(set(a, "length", js_int32(4)), 1);                  /* truncates */
    CHECK_EQ_INT(len(a), 4);
    CHECK(js_is_undefined(at(a, 5)));
    CHECK_EQ_INT(set(a, "length", js_int32(8)), 1);                  /* grows with holes */
    CHECK_EQ_INT(len(a), 8);
    CHECK(js_is_undefined(at(a, 3)) == false);
    CHECK(js_is_undefined(at(a, 5)));
    /* invalid lengths are a RangeError */
    CHECK_EQ_INT(js_set_value(ctx, a, key("length"), js_double(1.5), true), -1);
    CHECK(strcmp(take_error_text(ctx), "RangeError: Invalid array length") == 0);
    CHECK_EQ_INT(js_set_value(ctx, a, key("length"), js_double(-1), false), -1);
    js_discard(js_take_exception(ctx));
    /* a non-writable length blocks growth and truncation */
    JSPropertyDescriptor frozen = { JS_DESC_WRITABLE, 0, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
    CHECK_EQ_INT(js_define_own_property(ctx, js_as_object(a), key("length"), &frozen, true), 1);
    CHECK_EQ_INT(js_set_value(ctx, a, key("length"), js_int32(2), false), 0);
    CHECK_EQ_INT(put(a, 20, js_int32(1)) , -1);
    js_discard(js_take_exception(ctx));
    CHECK_EQ_INT(len(a), 8);
    CHECK_EQ_INT(js_delete_property(ctx, js_as_object(a), key("length"), false), 0);
    teardown();
}

TEST(arr_sparse) {
    setup();
    JSValue a = js_new_array(ctx, 0);
    CHECK_EQ_INT(put(a, 0, js_int32(1)), 1);
    CHECK_EQ_INT(put(a, 1000000, js_int32(2)), 1);                   /* far past the end: sparse */
    CHECK_EQ_INT(js_as_object(a)->elements->kind, JS_ELEMENTS_SPARSE);
    CHECK_EQ_INT(len(a), 1000001);
    CHECK_EQ_INT(js_as_int32(at(a, 1000000)), 2);
    CHECK_EQ_INT(js_as_int32(at(a, 0)), 1);
    CHECK(js_is_undefined(at(a, 500)));
    /* indices up to 2^32 - 2 are real indices, and set length */
    CHECK_EQ_INT(put(a, 3000000000u, js_int32(3)), 1);
    CHECK_EQ_INT(len(a), 3000000001u);
    CHECK_EQ_INT(js_as_int32(at(a, 3000000000u)), 3);
    /* a non-configurable element stops truncation */
    JSPropertyDescriptor fixed = js_data_descriptor(js_int32(9), JS_PROP_WRITABLE);
    CHECK_EQ_INT(js_define_own_property(ctx, js_as_object(a), js_index_key(50), &fixed, true), 1);
    CHECK_EQ_INT(js_set_value(ctx, a, key("length"), js_int32(10), false), 0);
    CHECK_EQ_INT(len(a), 51);
    CHECK_EQ_INT(js_as_int32(at(a, 50)), 9);
    CHECK(js_is_undefined(at(a, 1000000)));
    teardown();
}

TEST(arr_key_order) {
    setup();
    JSValue o = js_new_object(ctx);
    set(o, "b", js_int32(0));
    CHECK_EQ_INT(put(o, 2, js_int32(0)), 1);                          /* plain objects have elements too */
    set(o, "a", js_int32(0));
    CHECK_EQ_INT(put(o, 0, js_int32(0)), 1);
    JSValueArray *keys = (JSValueArray *)js_as_cell(js_own_keys(ctx, js_as_object(o)));
    CHECK_EQ_INT(keys->cell.aux, 4);                                  /* 0, 2, "b", "a" */
    CHECK(js_same_bits(keys->values[0], js_int32(0)) && js_same_bits(keys->values[1], js_int32(2)));
    CHECK(js_same_bits(keys->values[2], key("b")) && js_same_bits(keys->values[3], key("a")));
    JSValue values[] = { js_int32(1), js_int32(2) };
    JSValue a = js_new_array_from(ctx, values, 2);
    set(a, "tag", js_int32(0));
    keys = (JSValueArray *)js_as_cell(js_own_keys(ctx, js_as_object(a)));
    CHECK_EQ_INT(keys->cell.aux, 4);                                  /* 0, 1, "length", "tag" */
    CHECK(js_same_bits(keys->values[2], JS_ATOM(length)) && js_same_bits(keys->values[3], key("tag")));
    teardown();
}

static NOINLINE void fill_sparse(JSValue *slot) {
    JSValue a = js_new_array(ctx, 0);
    for (uint32_t i = 0; i < 2000; i++) {
        JSValue s = js_number_to_string(ctx, js_int32((int32_t)i));
        if (put(a, i * 5000, s) != 1) return;
    }
    *slot = a;
}

TEST(arr_gc) {
    setup();
    JSValue *root = malloc(sizeof *root);
    *root = JS_UNDEFINED;
    js_add_root(rt, root);
    fill_sparse(root);
    scrub();
    js_gc(ctx);
    js_gc(ctx);
    int ok = 1;
    for (uint32_t i = 0; i < 2000; i += 7) {
        JSValue v = at(*root, i * 5000);
        ok &= js_is_string(v) && js_string_equals(ctx, v, js_number_to_string(ctx, js_int32((int32_t)i)));
    }
    CHECK(ok);
    js_remove_root(rt, root);
    free(root);
    teardown();
}
