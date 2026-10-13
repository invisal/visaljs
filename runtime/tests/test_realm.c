/* The realm: Error objects, the global object, primitives' properties. */
#include <string.h>

#include "js_builtins.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_ops.h"
#include "js_symbol.h"
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

static JSValue str(const char *s) {
    JSValue v = js_new_string_cstr(ctx, s);
    return v;
}

static const char *text(JSValue s) {
    static char buf[256];
    if (!js_is_string(s)) return "(not a string)";
    buf[js_view_to_utf8(js_string_view(ctx, s), buf, sizeof buf - 1)] = '\0';
    return buf;
}

static JSValue global(const char *name) {
    JSValue v = js_global_name(ctx, name);
    return v;
}

static JSValue get(JSValue o, const char *key) {
    JSValue v = js_get_value(ctx, o, atom(key));
    return v;
}

static bool has_own(JSValue o, JSValue key) {
    JSPropertyDescriptor d;
    return js_get_own_property(ctx, js_as_object(o), key, &d) == 1;
}

TEST(realm_error_constructors) {
    setup();
    static const char *const names[] = { "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError" };
    JSValue error = global("Error");
    for (int i = 0; i < 7; i++) {
        JSValue ctor = global(names[i]);
        CHECK(js_is_constructor(ctor));
        CHECK(strcmp(text(get(ctor, "name")), names[i]) == 0);
        CHECK_EQ_INT(js_as_int32(get(ctor, "length")), 1);
        /* the native errors inherit from Error, constructor and prototype alike */
        JSValue proto = get(ctor, "prototype");
        CHECK(js_same_bits(proto, ctx->intrinsics[JS_INTRINSIC_ERROR_PROTOTYPE + i]));
        CHECK(js_same_bits(get(proto, "constructor"), ctor));
        CHECK(strcmp(text(get(proto, "name")), names[i]) == 0);
        CHECK(strcmp(text(get(proto, "message")), "") == 0);
        if (i > 0) {
            CHECK(js_same_bits(js_get_prototype_of(js_as_object(ctor)), error));
            CHECK(js_same_bits(js_get_prototype_of(js_as_object(proto)), get(error, "prototype")));
        }
        /* with and without new */
        JSValue args[] = { str("boom") };
        JSValue a = js_construct(ctx, ctor, 1, args, JS_UNDEFINED, NULL);
        JSValue b = js_call(ctx, ctor, JS_UNDEFINED, 1, args);
        CHECK(js_is_error(a) && js_is_error(b));
        CHECK(js_same_bits(js_get_prototype_of(js_as_object(b)), proto));
        CHECK(js_same_bits(js_instanceof(ctx, a, ctor), JS_TRUE));
        CHECK(js_same_bits(js_instanceof(ctx, a, error), JS_TRUE));
        CHECK(strcmp(text(get(b, "message")), "boom") == 0);
    }
    /* Error.prototype is not itself an error; Error.prototype.prototype is fixed */
    JSValue proto = get(error, "prototype");
    CHECK(!js_is_error(proto));
    CHECK_EQ_INT(js_set_value(ctx, error, JS_ATOM(prototype), js_int32(1), false), 0);
    teardown();
}

TEST(realm_error_message_and_cause) {
    setup();
    JSValue type_error = global("TypeError");
    /* no message: no own property; a message is ToString'd, not enumerable */
    JSValue e = js_call(ctx, type_error, JS_UNDEFINED, 0, NULL);
    CHECK(!has_own(e, JS_ATOM(message)));
    JSValue args[] = { js_int32(42), JS_UNDEFINED };
    e = js_call(ctx, type_error, JS_UNDEFINED, 1, args);
    JSPropertyDescriptor d;
    CHECK_EQ_INT(js_get_own_property(ctx, js_as_object(e), JS_ATOM(message), &d), 1);
    CHECK(strcmp(text(d.value), "42") == 0 && d.attrs == (JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE));
    /* { cause } installs cause, even when undefined; no options, no cause */
    CHECK(!has_own(e, JS_ATOM(cause)));
    JSValue options = js_new_object(ctx);
    js_define_data(ctx, js_as_object(options), JS_ATOM(cause), JS_UNDEFINED, JS_PROP_DEFAULT);
    args[1] = options;
    e = js_call(ctx, type_error, JS_UNDEFINED, 2, args);
    CHECK(has_own(e, JS_ATOM(cause)));
    args[1] = js_new_object(ctx);
    e = js_call(ctx, type_error, JS_UNDEFINED, 2, args);
    CHECK(!has_own(e, JS_ATOM(cause)));
    teardown();
}

TEST(realm_error_to_string) {
    setup();
    JSValue e = js_new_error(ctx, JS_RANGE_ERROR, str("too far"));
    CHECK(strcmp(text(js_error_to_string(ctx, e)), "RangeError: too far") == 0);
    CHECK(strcmp(text(js_error_to_string(ctx, js_new_error(ctx, JS_ERROR, JS_UNDEFINED))), "Error") == 0);
    /* Error.prototype.toString is generic: any object, name defaults to "Error" */
    JSValue o = js_new_object(ctx);
    CHECK(strcmp(text(js_error_to_string(ctx, o)), "Error") == 0);
    js_define_data(ctx, js_as_object(o), JS_ATOM(message), str("m"), JS_PROP_DEFAULT);
    CHECK(strcmp(text(js_error_to_string(ctx, o)), "Error: m") == 0);
    js_define_data(ctx, js_as_object(o), JS_ATOM(name), js_empty_string(), JS_PROP_DEFAULT);
    CHECK(strcmp(text(js_error_to_string(ctx, o)), "m") == 0);
    /* reached through the prototype, like JS does */
    JSValue to_string = get(get(global("Error"), "prototype"), "toString");
    CHECK(strcmp(text(js_call(ctx, to_string, e, 0, NULL)), "RangeError: too far") == 0);
    CHECK(js_is_exception(js_call(ctx, to_string, js_int32(1), 0, NULL)));
    CHECK(strcmp(take_error_text(ctx), "TypeError: Error.prototype.toString requires that 'this' be an Object") == 0);
    teardown();
}

/* new_target picks the prototype (subclassing); a non-object prototype falls back to the intrinsic */
static JSValue plain_ctor(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)c, (void)callee, (void)this_val, (void)argc, (void)argv, (void)nt;
    return JS_UNDEFINED;
}

TEST(realm_error_new_target) {
    setup();
    JSValue nt = js_new_native(ctx, plain_ctor, atom("MyError"), 0, JS_FN_CONSTRUCTOR);
    JSValue my_proto = js_new_object_proto(ctx, get(global("TypeError"), "prototype"), 4);
    js_define_data(ctx, js_as_object(nt), JS_ATOM(prototype), my_proto, JS_PROP_WRITABLE);
    JSValue e = js_construct(ctx, global("TypeError"), 0, NULL, nt, NULL);
    CHECK(js_is_error(e) && js_same_bits(js_get_prototype_of(js_as_object(e)), my_proto));
    CHECK(js_set_value(ctx, nt, JS_ATOM(prototype), js_int32(0), true) == 1);
    e = js_construct(ctx, global("RangeError"), 0, NULL, nt, NULL);
    CHECK(js_same_bits(js_get_prototype_of(js_as_object(e)), ctx->intrinsics[JS_INTRINSIC_RANGE_ERROR_PROTOTYPE]));
    teardown();
}

TEST(realm_thrown_errors) {
    setup();
    /* runtime errors are instances of the realm's constructors */
    CHECK(js_is_exception(js_get_value(ctx, JS_NULL, atom("x"))));
    JSValue e = js_take_exception(ctx);
    CHECK(js_same_bits(js_instanceof(ctx, e, global("TypeError")), JS_TRUE));
    CHECK(js_is_exception(global("nope")));
    e = js_take_exception(ctx);
    CHECK(js_same_bits(js_instanceof(ctx, e, global("ReferenceError")), JS_TRUE));
    CHECK(strcmp(text(get(e, "message")), "nope is not defined") == 0);
    CHECK(js_is_exception(js_throw_stack_overflow(ctx)));
    e = js_take_exception(ctx);
    CHECK(js_same_bits(js_instanceof(ctx, e, global("RangeError")), JS_TRUE));
    teardown();
}

TEST(realm_global_object) {
    setup();
    JSValue g = ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT];
    CHECK(js_is_object(g));
    CHECK(js_same_bits(global("globalThis"), g));
    CHECK(js_is_undefined(global("undefined")));
    JSValue nan = global("NaN");
    CHECK(js_is_double(nan) && js_as_double(nan) != js_as_double(nan));
    CHECK(js_is_double(global("Infinity")) && js_as_double(global("Infinity")) == INFINITY);
    /* value properties are read-only: sloppy writes fail silently, strict ones throw */
    CHECK_EQ_INT(js_set_value(ctx, g, JS_ATOM(undefined), js_int32(1), false), 0);
    CHECK_EQ_INT(js_set_value(ctx, g, JS_ATOM(NaN), js_int32(1), true), -1);
    js_discard(js_take_exception(ctx));
    CHECK_EQ_INT(js_delete_property(ctx, js_as_object(g), JS_ATOM(Infinity), false), 0);
    CHECK(js_is_undefined(global("undefined")));
    /* host functions */
    CHECK(js_is_callable(global("print")));
    /* console isn't the runtime's: the host prelude installs it */
    CHECK(js_is_exception(global("console")));  /* ReferenceError */
    js_discard(js_take_exception(ctx));
    /* a property added to the global object becomes a global name */
    CHECK_EQ_INT(js_set_value(ctx, g, atom("answer"), js_int32(42), true), 1);
    CHECK_EQ_INT(js_as_int32(global("answer")), 42);
    teardown();
}

static JSValue this_getter(JSContext *c, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue nt) {
    (void)c, (void)callee, (void)argc, (void)argv, (void)nt;
    return this_val;
}

TEST(realm_primitive_properties) {
    setup();
    JSValue s = str("héllo");
    CHECK_EQ_INT(js_as_int32(js_get_value(ctx, s, JS_ATOM(length))), 5);
    CHECK(strcmp(text(js_get_value(ctx, s, js_int32(1))), "é") == 0);
    CHECK(js_is_undefined(js_get_value(ctx, s, js_int32(5))));
    CHECK(js_is_undefined(get(s, "nope")));
    CHECK(js_is_undefined(get(js_int32(1), "nope")));
    /* lookups continue on String.prototype / Number.prototype / Boolean.prototype, with
     * the primitive itself as the receiver */
    JSValue string_proto = ctx->intrinsics[JS_INTRINSIC_STRING_PROTOTYPE];
    JSValue number_proto = ctx->intrinsics[JS_INTRINSIC_NUMBER_PROTOTYPE];
    JSValue bool_proto = ctx->intrinsics[JS_INTRINSIC_BOOLEAN_PROTOTYPE];
    JSValue self = js_new_native(ctx, this_getter, atom("self"), 0, JS_FN_STRICT);
    JSPropertyDescriptor acc = { JS_DESC_GET | JS_DESC_CONFIGURABLE, JS_PROP_CONFIGURABLE, JS_UNDEFINED, self, JS_UNDEFINED };
    CHECK_EQ_INT(js_define_own_property(ctx, js_as_object(string_proto), atom("self"), &acc, true), 1);
    CHECK_EQ_INT(js_define_own_property(ctx, js_as_object(number_proto), atom("self"), &acc, true), 1);
    CHECK(js_same_bits(get(s, "self"), s));
    CHECK(js_same_bits(get(js_double(2.5), "self"), js_double(2.5)));
    js_define_data(ctx, js_as_object(bool_proto), atom("kind"), str("bool"), JS_PROP_DEFAULT);
    CHECK(strcmp(text(get(JS_TRUE, "kind")), "bool") == 0);
    /* inherited from Object.prototype too */
    js_define_data(ctx, js_as_object(ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE]), atom("everywhere"), js_int32(9), JS_PROP_DEFAULT);
    CHECK_EQ_INT(js_as_int32(get(s, "everywhere")), 9);
    /* writes to primitives never create properties: false when sloppy, TypeError when strict */
    CHECK_EQ_INT(js_set_value(ctx, s, atom("x"), js_int32(1), false), 0);
    CHECK_EQ_INT(js_set_value(ctx, s, atom("x"), js_int32(1), true), -1);
    CHECK(strncmp(take_error_text(ctx), "TypeError: ", 11) == 0);
    CHECK_EQ_INT(js_set_value(ctx, s, JS_ATOM(length), js_int32(1), false), 0);
    CHECK_EQ_INT(js_set_value(ctx, s, js_int32(0), js_int32(1), true), -1);
    js_discard(js_take_exception(ctx));
    CHECK_EQ_INT(js_set_value(ctx, js_int32(3), atom("x"), js_int32(1), false), 0);
    teardown();
}

/* $262: createRealm makes a second realm with its own global and intrinsics */
TEST(realm_create_realm) {
    setup();
    JSValue host = js_test_host_init(ctx);
    CHECK(js_same_bits(global("$262"), host));
    CHECK(js_same_bits(get(host, "global"), ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT]));
    JSValue other = js_call(ctx, get(host, "createRealm"), host, 0, NULL);
    CHECK(js_is_object(other) && !js_same_bits(other, host));
    JSValue other_global = get(other, "global");
    CHECK(js_is_object(other_global) && !js_same_bits(other_global, ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT]));
    /* its own intrinsics and its own $262 */
    JSValue other_error = get(other_global, "Error");
    CHECK(js_is_constructor(other_error) && !js_same_bits(other_error, global("Error")));
    CHECK(js_same_bits(get(other_global, "$262"), other));
    CHECK(js_same_bits(get(other_global, "globalThis"), other_global));
    /* realms nest, and survive collections through the runtime's realm list */
    JSValue third = js_call(ctx, get(other, "createRealm"), other, 0, NULL);
    CHECK(js_is_object(get(third, "global")));
    CHECK(js_is_undefined(js_call(ctx, get(host, "gc"), host, 0, NULL)));
    CHECK(js_is_constructor(get(get(third, "global"), "TypeError")));
    teardown();  /* frees the other realms too (LSan checks it) */
}

TEST(realm_cross_realm_calls) {
    setup();
    JSValue other_global = get(js_call(ctx, get(js_test_host_init(ctx), "createRealm"), JS_UNDEFINED, 0, NULL), "global");
    JSValue other_error = get(other_global, "TypeError");
    /* a function runs in its own realm: its objects get that realm's prototypes */
    JSValue args[] = { str("x") };
    JSValue e = js_construct(ctx, other_error, 1, args, JS_UNDEFINED, NULL);
    CHECK(js_same_bits(js_get_prototype_of(js_as_object(e)), get(other_error, "prototype")));
    CHECK(js_same_bits(js_instanceof(ctx, e, global("TypeError")), JS_FALSE));
    CHECK(js_same_bits(js_instanceof(ctx, e, get(other_global, "Error")), JS_TRUE));
    /* GetFunctionRealm: a new_target from this realm whose prototype isn't an object gives
     * this realm's intrinsic, even when the constructor comes from the other one */
    JSValue nt = js_new_native(ctx, plain_ctor, atom("F"), 0, JS_FN_CONSTRUCTOR);
    js_define_data(ctx, js_as_object(nt), JS_ATOM(prototype), js_int32(0), JS_PROP_WRITABLE);
    e = js_construct(ctx, other_error, 0, NULL, nt, NULL);
    CHECK(js_same_bits(js_get_prototype_of(js_as_object(e)), ctx->intrinsics[JS_INTRINSIC_TYPE_ERROR_PROTOTYPE]));
    /* errors thrown by the other realm's builtins are its own */
    JSValue to_string = get(get(get(other_global, "Error"), "prototype"), "toString");
    CHECK(js_is_exception(js_call(ctx, to_string, js_int32(1), 0, NULL)));
    e = js_take_exception(ctx);
    CHECK(js_same_bits(js_instanceof(ctx, e, get(other_global, "TypeError")), JS_TRUE));
    teardown();
}

/* Symbols: descriptions and the registry survive collections; keys order last */
TEST(realm_symbols) {
    setup();
    JSValue sym = js_new_symbol(ctx, str("heap description"));
    JSValue args[] = { str("shared") };
    JSValue sym_for = get(global("Symbol"), "for");
    JSValue reg = js_call(ctx, sym_for, JS_UNDEFINED, 1, args);
    CHECK(js_is_symbol(sym) && js_is_symbol(reg));
    for (int i = 0; i < 3; i++) js_gc(ctx);
    CHECK(strcmp(text(js_symbol_description(sym)), "heap description") == 0);
    args[0] = str("shared");  /* a fresh string with the same content finds the same symbol */
    CHECK(js_same_bits(js_call(ctx, sym_for, JS_UNDEFINED, 1, args), reg));
    CHECK(strcmp(text(js_symbol_descriptive_string(ctx, JS_SYMBOL(iterator))), "Symbol(Symbol.iterator)") == 0);
    /* registered symbols are shared by every realm (one agent) */
    JSValue other = get(js_call(ctx, get(js_test_host_init(ctx), "createRealm"), JS_UNDEFINED, 0, NULL), "global");
    CHECK(js_same_bits(js_call(ctx, get(get(other, "Symbol"), "for"), JS_UNDEFINED, 1, args), reg));
    CHECK(js_same_bits(get(get(other, "Symbol"), "iterator"), JS_SYMBOL(iterator)));
    /* own keys: indices, strings, then symbols, each in order */
    JSValue o = js_new_object(ctx);
    js_define_data(ctx, js_as_object(o), sym, js_int32(1), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), atom("s"), js_int32(2), JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(o), js_index_key(0), js_int32(3), JS_PROP_DEFAULT);
    JSValueArray *keys = (JSValueArray *)js_as_cell(js_own_keys(ctx, js_as_object(o)));
    CHECK_EQ_INT((int)keys->cell.aux, 3);
    CHECK(js_key_is_index(keys->values[0]) && js_same_bits(keys->values[1], atom("s")) && js_same_bits(keys->values[2], sym));
    /* ToPropertyKey keeps symbols; ToString refuses them */
    CHECK(js_same_bits(js_to_property_key(ctx, sym), sym));
    CHECK(js_is_exception(js_to_string(ctx, sym)));
    CHECK(strcmp(take_error_text(ctx), "TypeError: Cannot convert a Symbol value to a string") == 0);
    teardown();
}

TEST(realm_gc) {
    setup();
    /* the realm's objects survive collections; errors made afterwards are sound */
    for (int i = 0; i < 3; i++) js_gc(ctx);
    for (int i = 0; i < 2000; i++) {
        JSValue e = js_new_error(ctx, (JSErrorKind)(i % JS_ERROR_KIND_COUNT), str("m"));
        CHECK(js_is_error(e));
    }
    js_gc(ctx);
    CHECK(js_is_exception(js_throw_type_error(ctx, "after %d collections", 4)));
    CHECK(strcmp(take_error_text(ctx), "TypeError: after 4 collections") == 0);
    CHECK(js_is_constructor(global("SyntaxError")));
    CHECK(strcmp(text(get(get(global("URIError"), "prototype"), "name")), "URIError") == 0);
    teardown();
}
