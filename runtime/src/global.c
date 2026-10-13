/* The global object and the primitives' prototypes (ECMAScript §19). */
#include "internal.h"
#include "js_atoms.h"
#include "js_console.h"
#include "js_error.h"
#include "js_generator.h"
#include "js_promise.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "jsnum.h"

/* String.prototype, Number.prototype and Boolean.prototype: where primitives look up
 * properties, and themselves wrapper objects (§22.1.3, §21.1.3, §20.3.3): of "", 0 and false. */
static void primitive_prototypes_init(JSContext *ctx) {
    JSValue object_proto = ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE];
    ctx->intrinsics[JS_INTRINSIC_STRING_PROTOTYPE] = js_new_wrapper(ctx, js_empty_string(), object_proto);  /* own length 0 */
    ctx->intrinsics[JS_INTRINSIC_NUMBER_PROTOTYPE] = js_new_wrapper(ctx, js_int32(0), object_proto);
    ctx->intrinsics[JS_INTRINSIC_BOOLEAN_PROTOTYPE] = js_new_wrapper(ctx, JS_FALSE, object_proto);
    ctx->intrinsics[JS_INTRINSIC_SYMBOL_PROTOTYPE] = js_new_object_proto(ctx, object_proto, 8);
}

static void define_function(JSContext *ctx, JSObject *o, const char *name, JSNativeFn fn, uint32_t length) {
    JSValue f = js_define_method(ctx, o, name, fn, length);
    (void)f;
}

void js_global_realm_init(JSContext *ctx) {
    primitive_prototypes_init(ctx);
    JSValue global = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 16);
    ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT] = global;
    JSObject *g = js_as_object(global);
    const uint8_t attrs = JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE;

    /* §19.1: value properties are non-writable and non-configurable */
    js_define_data(ctx, g, JS_ATOM(globalThis), global, attrs);
    js_define_data(ctx, g, JS_ATOM(Infinity), js_double(INFINITY), 0);
    js_define_data(ctx, g, JS_ATOM(NaN), js_double(NAN), 0);
    js_define_data(ctx, g, JS_ATOM(undefined), JS_UNDEFINED, 0);

    js_error_realm_init(ctx, g);
    js_builtins_realm_init(ctx, g);
    js_symbol_realm_init(ctx, g);
    js_iterator_realm_init(ctx);
    /* Promise, generators, async iteration and the weak collections are components:
     * a program gets them when its names or its syntax (async, function*, for await) reach them */
    js_jobs_realm_init(ctx, g);  /* queueMicrotask */
    define_function(ctx, g, "print", js_print, 1);  /* the test host's print */
    /* console comes from the host prelude, which every program runs first */
}

/* ---- Global name lookup ------------------------------------------------------- */

static JSValue global_lookup(JSContext *ctx, const char *name, bool for_typeof) {
    JSValue key = js_atom_from_cstr(ctx, name);
    if (js_is_exception(key)) return JS_EXCEPTION;
    JSValue global = ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT];
    int has = js_has_property(ctx, js_as_object(global), key);
    if (has < 0) return JS_EXCEPTION;
    if (!has) return for_typeof ? JS_UNDEFINED : js_throw_reference_error(ctx, "%s is not defined", name);
    return js_get(ctx, js_as_object(global), key, global);
}

JSValue js_global_name(JSContext *ctx, const char *name) { return global_lookup(ctx, name, false); }

JSValue js_global_get(JSContext *ctx, JSValue key, const char *name) {
    JSPropertyDescriptor d;
    int r = js_get_own_property(ctx, js_as_object(ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT]), key, &d);
    if (r < 0) return JS_EXCEPTION;
    if (r && (d.has & JS_DESC_VALUE)) return d.value;
    return global_lookup(ctx, name, false);  /* an accessor, the prototypes, or a ReferenceError */
}
JSValue js_global_typeof_name(JSContext *ctx, const char *name) { return global_lookup(ctx, name, true); }

/* ---- Script globals (§16.1.7 GlobalDeclarationInstantiation) ----------------------------- */

static JSObject *global_object(JSContext *ctx) { return js_as_object(ctx->intrinsics[JS_INTRINSIC_GLOBAL_OBJECT]); }

int js_declare_global_var(JSContext *ctx, JSValue key) {
    JSObject *g = global_object(ctx);
    JSPropertyDescriptor d;
    int has = js_get_own_property(ctx, g, key, &d);
    if (has < 0) return -1;
    if (has) return 0;  /* an existing property keeps its value (`var Array;` changes nothing) */
    if (!js_is_extensible(g)) {
        js_discard(js_throw_type_error(ctx, "Cannot declare a global variable: the global object is not extensible"));
        return -1;
    }
    JSPropertyDescriptor v = js_data_descriptor(JS_UNDEFINED, JS_PROP_WRITABLE | JS_PROP_ENUMERABLE);
    return js_define_own_property(ctx, g, key, &v, true) < 0 ? -1 : 0;
}

int js_declare_global_function(JSContext *ctx, JSValue key, JSValue fn) {
    JSObject *g = global_object(ctx);
    JSPropertyDescriptor d;
    int has = js_get_own_property(ctx, g, key, &d);
    if (has < 0) return -1;
    JSPropertyDescriptor v;
    if (!has || (d.attrs & JS_PROP_CONFIGURABLE)) {
        v = js_data_descriptor(fn, JS_PROP_WRITABLE | JS_PROP_ENUMERABLE);
    } else if ((d.has & JS_DESC_VALUE) && (d.attrs & JS_PROP_WRITABLE) && (d.attrs & JS_PROP_ENUMERABLE)) {
        v = (JSPropertyDescriptor){ JS_DESC_VALUE, 0, fn, JS_UNDEFINED, JS_UNDEFINED };  /* CanDeclareGlobalFunction: the value only */
    } else {
        char name[64] = "";
        if (js_is_string(key)) name[js_view_to_utf8(js_string_view(ctx, key), name, sizeof name - 1)] = '\0';
        js_discard(js_throw_type_error(ctx, "Cannot redefine property: %s", name));
        return -1;
    }
    return js_define_own_property(ctx, g, key, &v, true) < 0 ? -1 : 0;
}

int js_set_global_name(JSContext *ctx, JSValue key, JSValue v, bool strict) {
    JSObject *g = global_object(ctx);
    if (strict) {
        /* PutValue of an unresolvable reference: strict code can't create globals */
        int has = js_has_property(ctx, g, key);
        if (has < 0) return -1;
        if (!has) {
            char name[64] = "";
            if (js_is_string(key)) name[js_view_to_utf8(js_string_view(ctx, key), name, sizeof name - 1)] = '\0';
            js_discard(js_throw_reference_error(ctx, "%s is not defined", name));
            return -1;
        }
    }
    return js_set(ctx, g, key, v, js_object_value(g), strict);
}
