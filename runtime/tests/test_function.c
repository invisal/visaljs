/* Function objects, calls and conversions through them. */
#include <string.h>

#include "js_builtins.h"
#include "js_convert.h"
#include "js_function.h"
#include "js_ops.h"
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

static JSValue atom(const char *s) {
    JSValue a = js_atom_from_cstr(ctx, s);
    return a;
}

static const char *text(JSValue s) {
    static char buf[256];
    buf[js_view_to_utf8(js_string_view(ctx, s), buf, sizeof buf - 1)] = '\0';
    return buf;
}

static const char *error_text(void) { return take_error_text(ctx); }

#define ARG(i) ((i) < argc ? argv[i] : JS_UNDEFINED)

static JSValue native_add(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)callee, (void)this_val, (void)nt;
    return js_add(c, ARG(0), ARG(1));
}

static JSValue native_this(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)c, (void)callee, (void)argc, (void)argv, (void)nt;
    return this_val;
}

/* What the compiler emits for:  function Point(x) { this.x = x; }  */
static JSValue point_generic(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)callee, (void)nt;
    if (js_set_value(c, this_val, js_atom_from_cstr(c, "x"), ARG(0), true) < 0) return JS_EXCEPTION;
    return JS_UNDEFINED;
}
static const JS_STATIC_LATIN1_TYPE(5) point_name = JS_STATIC_LATIN1_INIT(5, 0, "Point");
static const JSFunctionInfo point_info = { point_generic, (const JSString *)&point_name, 1, JS_FN_CONSTRUCTOR | JS_FN_ORDINARY, NULL, "t.js", 0, 0 };

/* function Box() { return { boxed: true }; } — an object result replaces `this` */
static JSValue box_generic(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)nt;
    JSValue o = js_new_object(c);
    js_define_data(c, js_as_object(o), js_atom_from_cstr(c, "boxed"), JS_TRUE, JS_PROP_DEFAULT);
    return o;
}
static const JSFunctionInfo box_info = { box_generic, NULL, 0, JS_FN_CONSTRUCTOR | JS_FN_ORDINARY, NULL, "t.js", 0, 0 };

TEST(fn_call) {
    setup();
    JSValue add = js_new_native(ctx, native_add, atom("add"), 2, JS_FN_STRICT);
    CHECK(js_is_function(add) && js_is_callable(add) && !js_is_constructor(add));
    JSValue args[] = { js_int32(2), js_int32(40) };
    JSValue r = js_call(ctx, add, JS_UNDEFINED, 2, args);
    CHECK(js_is_int32(r) && js_as_int32(r) == 42);
    r = js_call(ctx, add, JS_UNDEFINED, 1, args);  /* missing arguments are the callee's business */
    CHECK(js_is_double(r) && js_as_double(r) != js_as_double(r));
    JSValue self = js_new_native(ctx, native_this, atom("self"), 0, JS_FN_STRICT);
    JSValue obj = js_new_object(ctx);
    CHECK(js_same_bits(js_call(ctx, self, obj, 0, NULL), obj));
    /* own properties: length and name, not enumerable, configurable */
    JSPropertyDescriptor d;
    CHECK_EQ_INT(js_get_own_property(ctx, js_as_object(add), JS_ATOM(length), &d), 1);
    CHECK(js_as_int32(d.value) == 2 && d.attrs == JS_PROP_CONFIGURABLE);
    CHECK(strcmp(text(js_get_value(ctx, add, JS_ATOM(name))), "add") == 0);
    CHECK(js_same_bits(js_get_prototype_of(js_as_object(add)), ctx->intrinsics[JS_INTRINSIC_FUNCTION_PROTOTYPE]));
    /* Function.prototype is callable and returns undefined */
    CHECK(js_is_undefined(js_call(ctx, ctx->intrinsics[JS_INTRINSIC_FUNCTION_PROTOTYPE], JS_UNDEFINED, 0, NULL)));
    CHECK(strcmp(text(js_typeof(ctx, add)), "function") == 0);
    CHECK(strcmp(text(js_typeof(ctx, obj)), "object") == 0);
    teardown();
}

TEST(fn_not_callable) {
    setup();
    CHECK(js_is_exception(js_call_site(ctx, js_int32(1), JS_UNDEFINED, 0, NULL, "o.m")));
    CHECK(strcmp(error_text(), "TypeError: o.m is not a function") == 0);
    CHECK(js_is_exception(js_call(ctx, JS_UNDEFINED, JS_UNDEFINED, 0, NULL)));
    CHECK(strcmp(error_text(), "TypeError: undefined is not a function") == 0);
    JSValue add = js_new_native(ctx, native_add, atom("add"), 2, JS_FN_STRICT);
    CHECK(js_is_exception(js_construct(ctx, add, 0, NULL, JS_UNDEFINED, "add")));
    CHECK(strcmp(error_text(), "TypeError: add is not a constructor") == 0);
    teardown();
}

TEST(fn_construct) {
    setup();
    JSValue point = js_new_function(ctx, &point_info);
    JSValue args[] = { js_int32(7) };
    JSValue p = js_construct(ctx, point, 1, args, JS_UNDEFINED, "Point");
    CHECK(js_is_object(p));
    CHECK_EQ_INT(js_as_int32(js_get_value(ctx, p, atom("x"))), 7);
    /* prototype was created lazily, with constructor pointing back */
    JSValue proto = js_get_value(ctx, point, JS_ATOM(prototype));
    CHECK(js_is_object(proto));
    CHECK(js_same_bits(js_get_prototype_of(js_as_object(p)), proto));
    CHECK(js_same_bits(js_get_value(ctx, proto, JS_ATOM(constructor)), point));
    CHECK(js_same_bits(js_instanceof(ctx, p, point), JS_TRUE));
    CHECK(js_same_bits(js_instanceof(ctx, js_new_object(ctx), point), JS_FALSE));
    CHECK(js_same_bits(js_instanceof(ctx, js_int32(1), point), JS_FALSE));
    /* own keys, in order: length, name, prototype */
    JSValueArray *keys = (JSValueArray *)js_as_cell(js_own_keys(ctx, js_as_object(point)));
    CHECK_EQ_INT(keys->cell.aux, 3);
    CHECK(js_same_bits(keys->values[2], JS_ATOM(prototype)));
    /* an object returned from a constructor replaces `this` */
    JSValue box = js_new_function(ctx, &box_info);
    JSValue b = js_construct(ctx, box, 0, NULL, JS_UNDEFINED, "Box");
    CHECK(js_same_bits(js_get_value(ctx, b, atom("boxed")), JS_TRUE));
    CHECK(js_same_bits(js_instanceof(ctx, b, box), JS_FALSE));
    CHECK(strcmp(text(js_get_value(ctx, box, JS_ATOM(name))), "") == 0);
    teardown();
}

static JSValue getter(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)callee, (void)argc, (void)argv, (void)nt;
    JSValue v = js_get_value(c, this_val, js_atom_from_cstr(c, "hidden"));
    if (js_is_exception(v)) return v;
    return js_mul(c, v, js_int32(2));
}

static JSValue setter(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)callee, (void)nt;
    if (js_set_value(c, this_val, js_atom_from_cstr(c, "hidden"), ARG(0), true) < 0) return JS_EXCEPTION;
    return JS_UNDEFINED;
}

TEST(fn_accessors) {
    setup();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), atom("hidden"), js_int32(5), JS_PROP_DEFAULT);
    JSPropertyDescriptor d = { JS_DESC_GET | JS_DESC_SET | JS_DESC_CONFIGURABLE, JS_PROP_CONFIGURABLE, JS_UNDEFINED,
                               js_new_native(ctx, getter, atom("get double"), 0, 0),
                               js_new_native(ctx, setter, atom("set double"), 1, 0) };
    CHECK_EQ_INT(js_define_own_property(ctx, js_as_object(o), atom("double"), &d, true), 1);
    CHECK_EQ_INT(js_as_int32(js_get_value(ctx, o, atom("double"))), 10);
    CHECK_EQ_INT(js_set_value(ctx, o, atom("double"), js_int32(21), true), 1);
    CHECK_EQ_INT(js_as_int32(js_get_value(ctx, o, atom("double"))), 42);
    /* inherited: the getter sees the receiver, not the holder */
    JSValue child = js_new_object_proto(ctx, o, 4);
    js_define_data(ctx, js_as_object(child), atom("hidden"), js_int32(100), JS_PROP_DEFAULT);
    CHECK_EQ_INT(js_as_int32(js_get_value(ctx, child, atom("double"))), 200);
    teardown();
}

static JSValue value_of_42(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)c, (void)callee, (void)this_val, (void)argc, (void)argv, (void)nt;
    return js_int32(42);
}

static JSValue to_string_obj(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)callee, (void)this_val, (void)argc, (void)argv, (void)nt;
    JSValue s = js_new_string_cstr(c, "[obj]");
    return s;
}

TEST(fn_to_primitive) {
    setup();
    JSValue o = js_new_object(ctx);
    js_define_method(ctx, js_as_object(o), "valueOf", value_of_42, 0);
    js_define_method(ctx, js_as_object(o), "toString", to_string_obj, 0);
    JSValue sum = js_add(ctx, o, js_int32(1));                  /* default hint: valueOf */
    CHECK(js_is_int32(sum) && js_as_int32(sum) == 43);
    CHECK(strcmp(text(js_to_string(ctx, o)), "[obj]") == 0);   /* string hint: toString */
    CHECK(strcmp(text(js_add(ctx, js_new_string_cstr(ctx, "x"), o)), "x42") == 0);
    CHECK(js_same_bits(js_eq(ctx, o, js_int32(42)), JS_TRUE));
    CHECK(js_same_bits(js_lt(ctx, o, js_int32(50)), JS_TRUE));
    JSValue key = js_to_property_key(ctx, o);
    CHECK(js_same_bits(key, js_atom_from_cstr(ctx, "[obj]")));

    JSValue bare = js_new_object_proto(ctx, JS_NULL, 4);        /* no valueOf, no toString */
    CHECK(js_is_exception(js_to_string(ctx, bare)));
    CHECK(strcmp(error_text(), "TypeError: Cannot convert object to primitive value") == 0);
    CHECK(js_same_bits(js_eq(ctx, bare, bare), JS_TRUE));        /* objects: identity, no conversion */
    CHECK(js_same_bits(js_eq(ctx, bare, js_new_object(ctx)), JS_FALSE));
    teardown();
}

TEST(fn_instanceof_in) {
    setup();
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), atom("k"), js_int32(1), JS_PROP_DEFAULT);
    CHECK(js_same_bits(js_in(ctx, js_new_string_cstr(ctx, "k"), o), JS_TRUE));
    CHECK(js_same_bits(js_in(ctx, js_new_string_cstr(ctx, "nope"), o), JS_FALSE));
    CHECK(js_is_exception(js_in(ctx, js_new_string_cstr(ctx, "k"), js_new_string_cstr(ctx, "str"))));
    CHECK(strcmp(error_text(), "TypeError: Cannot use 'in' operator to search for 'k' in str") == 0);
    CHECK(js_is_exception(js_instanceof(ctx, o, o)));
    CHECK(strcmp(error_text(), "TypeError: Right-hand side of 'instanceof' is not callable") == 0);
    CHECK(js_is_exception(js_instanceof(ctx, o, js_int32(1))));
    CHECK(strcmp(error_text(), "TypeError: Right-hand side of 'instanceof' is not an object") == 0);
    teardown();
}
