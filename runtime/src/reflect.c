/* Reflect (ECMAScript §28.1), an optional component: the object internal methods as
 * functions. Each checks its target is an object, then calls the internal method. */
#include <stdio.h>

#include "internal.h"
#include "builtins_util.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_function.h"
#include "js_ops.h"
#include "jscontext.h"
#include "jsstring.h"

/* The target, or NULL with V8's TypeError. */
static JSObject *target_of(JSContext *ctx, JSValue v, const char *method) {
    if (js_is_object(v)) return js_as_object(v);
    js_discard(js_throw_type_error(ctx, "Reflect.%s called on non-object", method));
    return NULL;
}

#define TARGET(method)                                  \
    JSObject *o = target_of(ctx, ARG(0), method);       \
    if (!o) return JS_EXCEPTION
#define KEY(i)                                          \
    JSValue key = js_to_property_key(ctx, ARG(i));      \
    if (js_is_exception(key)) return key

static JSValue result_of(int r) { return r < 0 ? JS_EXCEPTION : js_bool(r); }

/* "x is not a constructor", naming a function by its source text as V8 does. */
static JSValue throw_not_constructor(JSContext *ctx, JSValue v) {
    char what[256];
    if (js_is_function(v)) {
        JSValue text = js_call(ctx, js_get_value(ctx, ctx->intrinsics[JS_INTRINSIC_FUNCTION_PROTOTYPE], JS_ATOM(toString)), v, 0, NULL);
        if (js_is_exception(text)) return text;
        what[js_view_to_utf8(js_string_view(ctx, text), what, sizeof what - 1)] = '\0';
    } else {
        js_describe_value(ctx, v, what, sizeof what);
    }
    return js_throw_type_error(ctx, "%s is not a constructor", what);
}

/* Reflect.apply(target, thisArgument, argumentsList) (§28.1.1) */
BUILTIN(reflect_apply) {
    UNUSED_ARGS;
    JSValue f = ARG(0);
    if (!js_is_callable(f)) {
        char what[128];
        js_describe_value(ctx, f, what, sizeof what);
        const char *type = js_is_object(f) ? "an object" : js_is_string(f) ? "a string" : js_is_number(f) ? "a number" : js_is_bool(f) ? "a boolean"
                         : js_is_symbol(f) ? "a symbol" : js_is_null(f) ? "null" : "a undefined";
        return js_throw_type_error(ctx, "Function.prototype.apply was called on %s, which is %s and not a function", what, type);
    }
    JSValueArray *list = js_list_from_array_like(ctx, ARG(2));
    if (!list) return JS_EXCEPTION;
    JSValue r = js_call(ctx, f, ARG(1), list->cell.aux, list->values);
    JSValue held = js_cell(&list->cell);
    js_keep_alive(held);
    return r;
}

/* Reflect.construct(target, argumentsList, newTarget) (§28.1.2) */
BUILTIN(reflect_construct) {
    UNUSED_ARGS;
    JSValue f = ARG(0);
    if (!js_is_constructor(f)) return throw_not_constructor(ctx, f);
    JSValue target = argc > 2 ? argv[2] : f;
    if (!js_is_constructor(target)) return throw_not_constructor(ctx, target);
    JSValueArray *list = js_list_from_array_like(ctx, ARG(1));
    if (!list) return JS_EXCEPTION;
    JSValue r = js_construct(ctx, f, list->cell.aux, list->values, target, NULL);
    JSValue held = js_cell(&list->cell);
    js_keep_alive(held);
    return r;
}

BUILTIN(reflect_define_property) {
    UNUSED_ARGS;
    TARGET("defineProperty");
    KEY(1);
    JSPropertyDescriptor d;
    if (js_to_property_descriptor(ctx, ARG(2), &d) < 0) return JS_EXCEPTION;
    return result_of(js_define_own_property(ctx, o, key, &d, false));
}

BUILTIN(reflect_delete_property) {
    UNUSED_ARGS;
    TARGET("deleteProperty");
    KEY(1);
    return result_of(js_delete_property(ctx, o, key, false));
}

BUILTIN(reflect_get) {
    UNUSED_ARGS;
    TARGET("get");
    KEY(1);
    return js_get(ctx, o, key, argc > 2 ? argv[2] : ARG(0));
}

BUILTIN(reflect_get_own_property_descriptor) {
    UNUSED_ARGS;
    TARGET("getOwnPropertyDescriptor");
    KEY(1);
    JSPropertyDescriptor d;
    int r = js_get_own_property(ctx, o, key, &d);
    if (r < 0) return JS_EXCEPTION;
    return r ? js_from_property_descriptor(ctx, &d) : JS_UNDEFINED;
}

BUILTIN(reflect_get_prototype_of) {
    UNUSED_ARGS;
    TARGET("getPrototypeOf");
    return js_object_get_prototype_of(ctx, o);
}

BUILTIN(reflect_has) {
    UNUSED_ARGS;
    TARGET("has");
    KEY(1);
    return result_of(js_has_property(ctx, o, key));
}

BUILTIN(reflect_is_extensible) {
    UNUSED_ARGS;
    TARGET("isExtensible");
    return result_of(js_object_is_extensible(ctx, o));
}

/* Reflect.ownKeys (§28.1.10): index keys as strings, then strings, then symbols. */
BUILTIN(reflect_own_keys) {
    UNUSED_ARGS;
    TARGET("ownKeys");
    JSValue keys = js_own_keys(ctx, o);
    if (js_is_exception(keys)) return keys;
    JSValueArray *list = (JSValueArray *)js_as_cell(keys);
    JSValue out = js_new_array(ctx, list->cell.aux);
    for (uint32_t i = 0; i < list->cell.aux; i++) {
        JSValue k = list->values[i];
        if (js_is_number(k)) k = js_to_string(ctx, k);
        if (js_is_exception(k) || js_array_push(ctx, js_as_object(out), k) < 0) return JS_EXCEPTION;
    }
    js_keep_alive(keys);
    return out;
}

BUILTIN(reflect_prevent_extensions) {
    UNUSED_ARGS;
    TARGET("preventExtensions");
    return result_of(js_prevent_extensions(ctx, o));
}

BUILTIN(reflect_set) {
    UNUSED_ARGS;
    TARGET("set");
    KEY(1);
    return result_of(js_set(ctx, o, key, ARG(2), argc > 3 ? argv[3] : ARG(0), false));
}

BUILTIN(reflect_set_prototype_of) {
    UNUSED_ARGS;
    TARGET("setPrototypeOf");
    JSValue proto = ARG(1);
    if (!js_is_object(proto) && !js_is_null(proto)) {
        char what[128];
        js_describe_value(ctx, proto, what, sizeof what);
        return js_throw_type_error(ctx, "Object prototype may only be an Object or null: %s", what);
    }
    return result_of(js_set_prototype_of(ctx, o, proto));
}

static const JSBuiltin reflect_entries[] = {  /* V8's order */
    JS_BUILTIN_FN("defineProperty", reflect_define_property, 3),
    JS_BUILTIN_FN("deleteProperty", reflect_delete_property, 2),
    JS_BUILTIN_FN("apply", reflect_apply, 3),
    JS_BUILTIN_FN("construct", reflect_construct, 2),
    JS_BUILTIN_FN("get", reflect_get, 2),
    JS_BUILTIN_FN("getOwnPropertyDescriptor", reflect_get_own_property_descriptor, 2),
    JS_BUILTIN_FN("getPrototypeOf", reflect_get_prototype_of, 1),
    JS_BUILTIN_FN("has", reflect_has, 2),
    JS_BUILTIN_FN("isExtensible", reflect_is_extensible, 1),
    JS_BUILTIN_FN("ownKeys", reflect_own_keys, 1),
    JS_BUILTIN_FN("preventExtensions", reflect_prevent_extensions, 1),
    JS_BUILTIN_FN("set", reflect_set, 3),
    JS_BUILTIN_FN("setPrototypeOf", reflect_set_prototype_of, 2),
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "Reflect", JS_PROP_CONFIGURABLE),
};

static void install_reflect(JSContext *ctx, JSObject *global) {
    JSValue reflect = js_new_builtin_object(ctx, reflect_entries, JS_COUNTOF(reflect_entries));
    js_define_data(ctx, global, js_atom_from_cstr(ctx, "Reflect"), reflect, JS_BUILTIN_METHOD_ATTRS);
}

const JSComponent js_component_reflect = { "reflect", install_reflect };
