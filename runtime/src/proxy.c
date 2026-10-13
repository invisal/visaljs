/* Proxy (ECMAScript §10.5, §28.2), an optional component.
 *
 * A proxy's class overrides every internal method (JSClass.methods, and the get_own_property,
 * define_own_property and delete_property hooks): each calls the handler's trap, or the target's
 * method when there is none, then checks the spec's invariants against the target. A proxy whose
 * target is callable is a function cell, so typeof, calls and `new` treat it as a function; its
 * entry runs the apply and construct traps. Revoking clears the target and the handler. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "builtins_util.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_function.h"
#include "js_ops.h"
#include "jscontext.h"
#include "jsstring.h"

typedef struct ProxyObject {
    JSObject obj;
    JSValue  target, handler;  /* null once revoked */
} ProxyObject;

/* A callable proxy is a JSFunction: home_object is the target, bound_this the handler. */
static JSValue *target_slot(JSObject *o) {
    return o->cell.kind == JS_CELL_FUNCTION ? &((JSFunction *)o)->home_object : &((ProxyObject *)o)->target;
}
static JSValue *handler_slot(JSObject *o) {
    return o->cell.kind == JS_CELL_FUNCTION ? &((JSFunction *)o)->bound_this : &((ProxyObject *)o)->handler;
}

/* ---- Helpers ---------------------------------------------------------------------------------- */

/* A key as V8 quotes it in messages: x, 0, Symbol(s). */
static void key_text(JSContext *ctx, JSValue key, char *buf, size_t cap) {
    js_describe_value(ctx, key, buf, cap);
}

/* A key as traps receive it: index keys are strings. */
static JSValue key_value(JSContext *ctx, JSValue key) {
    return js_is_number(key) ? js_to_string(ctx, key) : key;
}

/* The handler's trap: 1 with *trap set, 0 when there is none (use the target), -1. */
static int get_trap(JSContext *ctx, JSObject *o, const char *name, JSValue *handler, JSValue *target, JSValue *trap) {
    *handler = *handler_slot(o);
    if (js_is_null(*handler)) {
        js_discard(js_throw_type_error(ctx, "Cannot perform '%s' on a proxy that has been revoked", name));
        return -1;
    }
    *target = *target_slot(o);
    JSValue t = js_get_value(ctx, *handler, js_atom_from_cstr(ctx, name));
    if (js_is_exception(t)) return -1;
    if (js_is_nullish(t)) return 0;
    if (!js_is_callable(t)) {
        char what[128];
        js_describe_value(ctx, t, what, sizeof what);
        js_discard(js_throw_type_error(ctx, "'%s' returned for property '%s' of object '#<Object>' is not a function", what, name));
        return -1;
    }
    *trap = t;
    return 1;
}

static JSValue call_trap(JSContext *ctx, JSValue trap, JSValue handler, uint32_t argc, const JSValue *argv) {
    return js_call(ctx, trap, handler, argc, argv);
}

/* ToBoolean(Call(trap, handler, args)): 1, 0, or -1. */
static int call_bool_trap(JSContext *ctx, JSValue trap, JSValue handler, uint32_t argc, const JSValue *argv) {
    JSValue r = call_trap(ctx, trap, handler, argc, argv);
    return js_is_exception(r) ? -1 : js_truthy(r);
}

static int fail(JSContext *ctx, const char *fmt, const char *trap, JSValue key) {
    char k[128];
    key_text(ctx, key, k, sizeof k);
    js_discard(js_throw_type_error(ctx, fmt, trap, k));
    return -1;
}

static bool is_accessor(const JSPropertyDescriptor *d) { return (d->has & (JS_DESC_GET | JS_DESC_SET)) != 0; }
static bool is_data(const JSPropertyDescriptor *d) { return (d->has & (JS_DESC_VALUE | JS_DESC_WRITABLE)) != 0; }

/* CompletePropertyDescriptor (§6.2.6.6) */
static void complete(JSPropertyDescriptor *d) {
    if (!is_accessor(d)) {
        if (!(d->has & JS_DESC_VALUE)) d->value = JS_UNDEFINED;
        d->has |= JS_DESC_VALUE | JS_DESC_WRITABLE;
    } else {
        if (!(d->has & JS_DESC_GET)) d->get = JS_UNDEFINED;
        if (!(d->has & JS_DESC_SET)) d->set = JS_UNDEFINED;
        d->has |= JS_DESC_GET | JS_DESC_SET;
    }
    d->has |= JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE;
}

/* IsCompatiblePropertyDescriptor (§10.1.6.2): ValidateAndApplyPropertyDescriptor without an object. */
static bool is_compatible(JSContext *ctx, bool extensible, const JSPropertyDescriptor *desc, const JSPropertyDescriptor *current, bool has_current) {
    if (!has_current) return extensible;
    if (!desc->has) return true;
    if (current->attrs & JS_PROP_CONFIGURABLE) return true;
    if ((desc->has & JS_DESC_CONFIGURABLE) && (desc->attrs & JS_PROP_CONFIGURABLE)) return false;
    if ((desc->has & JS_DESC_ENUMERABLE) && ((desc->attrs ^ current->attrs) & JS_PROP_ENUMERABLE)) return false;
    bool generic = !is_accessor(desc) && !is_data(desc);
    if (!generic && is_accessor(desc) != is_accessor(current)) return false;
    if (is_accessor(current)) {
        if ((desc->has & JS_DESC_GET) && !js_same_value(ctx, desc->get, current->get)) return false;
        if ((desc->has & JS_DESC_SET) && !js_same_value(ctx, desc->set, current->set)) return false;
    } else if (!(current->attrs & JS_PROP_WRITABLE)) {
        if ((desc->has & JS_DESC_WRITABLE) && (desc->attrs & JS_PROP_WRITABLE)) return false;
        if ((desc->has & JS_DESC_VALUE) && !js_same_value(ctx, desc->value, current->value)) return false;
    }
    return true;
}

/* FromPropertyDescriptor of a possibly partial descriptor: only the fields it has. */
static JSValue from_partial(JSContext *ctx, const JSPropertyDescriptor *d) {
    JSValue r = js_new_object(ctx);
    JSObject *o = js_as_object(r);
    if (d->has & JS_DESC_VALUE) js_define_data(ctx, o, JS_ATOM(value), d->value, JS_PROP_DEFAULT);
    if (d->has & JS_DESC_WRITABLE) js_define_data(ctx, o, js_atom_from_cstr(ctx, "writable"), js_bool(d->attrs & JS_PROP_WRITABLE), JS_PROP_DEFAULT);
    if (d->has & JS_DESC_GET) js_define_data(ctx, o, JS_ATOM(get), d->get, JS_PROP_DEFAULT);
    if (d->has & JS_DESC_SET) js_define_data(ctx, o, JS_ATOM(set), d->set, JS_PROP_DEFAULT);
    if (d->has & JS_DESC_ENUMERABLE) js_define_data(ctx, o, js_atom_from_cstr(ctx, "enumerable"), js_bool(d->attrs & JS_PROP_ENUMERABLE), JS_PROP_DEFAULT);
    if (d->has & JS_DESC_CONFIGURABLE) js_define_data(ctx, o, js_atom_from_cstr(ctx, "configurable"), js_bool(d->attrs & JS_PROP_CONFIGURABLE), JS_PROP_DEFAULT);
    return r;
}

/* ---- [[GetPrototypeOf]], [[SetPrototypeOf]], [[IsExtensible]], [[PreventExtensions]] ----------- */

static JSValue proxy_get_prototype_of(JSContext *ctx, JSObject *o) {
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, "getPrototypeOf", &handler, &target, &trap);
    if (t < 0) return JS_EXCEPTION;
    if (!t) return js_object_get_prototype_of(ctx, js_as_object(target));
    JSValue proto = call_trap(ctx, trap, handler, 1, &target);
    if (js_is_exception(proto)) return proto;
    if (!js_is_object(proto) && !js_is_null(proto)) return js_throw_type_error(ctx, "'getPrototypeOf' on proxy: trap returned neither object nor null");
    int extensible = js_object_is_extensible(ctx, js_as_object(target));
    if (extensible) return extensible < 0 ? JS_EXCEPTION : proto;
    JSValue target_proto = js_object_get_prototype_of(ctx, js_as_object(target));
    if (js_is_exception(target_proto)) return target_proto;
    if (!js_same_bits(proto, target_proto))
        return js_throw_type_error(ctx, "'getPrototypeOf' on proxy: proxy target is non-extensible but the trap did not return its actual prototype");
    return proto;
}

static int proxy_set_prototype_of(JSContext *ctx, JSObject *o, JSValue proto) {
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, "setPrototypeOf", &handler, &target, &trap);
    if (t <= 0) return t < 0 ? -1 : js_set_prototype_of(ctx, js_as_object(target), proto);
    JSValue args[2] = { target, proto };
    int r = call_bool_trap(ctx, trap, handler, 2, args);
    if (r <= 0) return r;
    int extensible = js_object_is_extensible(ctx, js_as_object(target));
    if (extensible) return extensible < 0 ? -1 : 1;
    JSValue target_proto = js_object_get_prototype_of(ctx, js_as_object(target));
    if (js_is_exception(target_proto)) return -1;
    if (!js_same_bits(proto, target_proto)) {
        js_discard(js_throw_type_error(ctx, "'setPrototypeOf' on proxy: trap returned truish for setting a new prototype on the non-extensible proxy target"));
        return -1;
    }
    return 1;
}

static int proxy_is_extensible(JSContext *ctx, JSObject *o) {
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, "isExtensible", &handler, &target, &trap);
    if (t <= 0) return t < 0 ? -1 : js_object_is_extensible(ctx, js_as_object(target));
    int r = call_bool_trap(ctx, trap, handler, 1, &target);
    if (r < 0) return -1;
    int expected = js_object_is_extensible(ctx, js_as_object(target));
    if (expected < 0) return -1;
    if (r != expected) {
        js_discard(js_throw_type_error(ctx, "'isExtensible' on proxy: trap result does not reflect extensibility of proxy target (which is '%s')",
                                       expected ? "true" : "false"));
        return -1;
    }
    return r;
}

static int proxy_prevent_extensions(JSContext *ctx, JSObject *o) {
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, "preventExtensions", &handler, &target, &trap);
    if (t <= 0) return t < 0 ? -1 : js_prevent_extensions(ctx, js_as_object(target));
    int r = call_bool_trap(ctx, trap, handler, 1, &target);
    if (r <= 0) return r;
    int extensible = js_object_is_extensible(ctx, js_as_object(target));
    if (extensible < 0) return -1;
    if (extensible) {
        js_discard(js_throw_type_error(ctx, "'preventExtensions' on proxy: trap returned truish but the proxy target is extensible"));
        return -1;
    }
    return 1;
}

/* ---- [[GetOwnProperty]], [[DefineOwnProperty]], [[Delete]] (class hooks) --------------------- */

static int proxy_get_own(JSContext *ctx, JSObject *o, JSValue key, JSPropertyDescriptor *out) {
    if (js_is_private_name(key)) return JS_ORDINARY;  /* private names aren't proxied: the proxy's own */
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, "getOwnPropertyDescriptor", &handler, &target, &trap);
    if (t <= 0) return t < 0 ? -1 : js_get_own_property(ctx, js_as_object(target), key, out);
    JSValue args[2] = { target, key_value(ctx, key) };
    if (js_is_exception(args[1])) return -1;
    JSValue result = call_trap(ctx, trap, handler, 2, args);
    if (js_is_exception(result)) return -1;
    if (!js_is_object(result) && !js_is_undefined(result))
        return fail(ctx, "'%s' on proxy: trap returned neither object nor undefined for property '%s'", "getOwnPropertyDescriptor", key);
    JSPropertyDescriptor target_desc;
    int has = js_get_own_property(ctx, js_as_object(target), key, &target_desc);
    if (has < 0) return -1;
    if (js_is_undefined(result)) {
        if (!has) return 0;
        if (!(target_desc.attrs & JS_PROP_CONFIGURABLE))
            return fail(ctx, "'%s' on proxy: trap returned undefined for property '%s' which is non-configurable in the proxy target", "getOwnPropertyDescriptor", key);
        int extensible = js_object_is_extensible(ctx, js_as_object(target));
        if (extensible < 0) return -1;
        if (!extensible)
            return fail(ctx, "'%s' on proxy: trap returned undefined for property '%s' which exists in the non-extensible proxy target", "getOwnPropertyDescriptor", key);
        return 0;
    }
    int extensible = js_object_is_extensible(ctx, js_as_object(target));
    if (extensible < 0) return -1;
    JSPropertyDescriptor d;
    if (js_to_property_descriptor(ctx, result, &d) < 0) return -1;
    complete(&d);
    if (!is_compatible(ctx, extensible, &d, &target_desc, has))
        return fail(ctx, "'%s' on proxy: trap returned descriptor for property '%s' that is incompatible with the existing property in the proxy target", "getOwnPropertyDescriptor", key);
    if (!(d.attrs & JS_PROP_CONFIGURABLE)) {
        if (!has || (target_desc.attrs & JS_PROP_CONFIGURABLE))
            return fail(ctx, "'%s' on proxy: trap reported non-configurability for property '%s' which is either non-existent or configurable in the proxy target", "getOwnPropertyDescriptor", key);
        if ((d.has & JS_DESC_WRITABLE) && !(d.attrs & JS_PROP_WRITABLE) && (target_desc.attrs & JS_PROP_WRITABLE))
            return fail(ctx, "'%s' on proxy: trap reported non-configurable and writable for property '%s' which is non-configurable, non-writable in the proxy target", "getOwnPropertyDescriptor", key);
    }
    *out = d;
    return 1;
}

static int proxy_define(JSContext *ctx, JSObject *o, JSValue key, const JSPropertyDescriptor *desc, bool throw_on_fail) {
    if (js_is_private_name(key)) return JS_ORDINARY;
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, "defineProperty", &handler, &target, &trap);
    if (t <= 0) return t < 0 ? -1 : js_define_own_property(ctx, js_as_object(target), key, desc, throw_on_fail);
    JSValue args[3] = { target, key_value(ctx, key), JS_UNDEFINED };
    if (js_is_exception(args[1])) return -1;
    args[2] = from_partial(ctx, desc);
    int r = call_bool_trap(ctx, trap, handler, 3, args);
    if (r < 0) return -1;
    if (!r) return throw_on_fail ? fail(ctx, "'%s' on proxy: trap returned falsish for property '%s'", "defineProperty", key) : 0;
    JSPropertyDescriptor target_desc;
    int has = js_get_own_property(ctx, js_as_object(target), key, &target_desc);
    if (has < 0) return -1;
    int extensible = js_object_is_extensible(ctx, js_as_object(target));
    if (extensible < 0) return -1;
    bool setting_config_false = (desc->has & JS_DESC_CONFIGURABLE) && !(desc->attrs & JS_PROP_CONFIGURABLE);
    if (!has) {
        if (!extensible) return fail(ctx, "'%s' on proxy: trap returned truish for adding property '%s'  to the non-extensible proxy target", "defineProperty", key);
        if (setting_config_false)
            return fail(ctx, "'%s' on proxy: trap returned truish for defining non-configurable property '%s' which is either non-existent or configurable in the proxy target", "defineProperty", key);
        return 1;
    }
    if (!is_compatible(ctx, extensible, desc, &target_desc, true))
        return fail(ctx, "'%s' on proxy: trap returned truish for adding property '%s'  that is incompatible with the existing property in the proxy target", "defineProperty", key);
    if (setting_config_false && (target_desc.attrs & JS_PROP_CONFIGURABLE))
        return fail(ctx, "'%s' on proxy: trap returned truish for defining non-configurable property '%s' which is either non-existent or configurable in the proxy target", "defineProperty", key);
    if (is_data(&target_desc) && !(target_desc.attrs & JS_PROP_CONFIGURABLE) && (target_desc.attrs & JS_PROP_WRITABLE) &&
        (desc->has & JS_DESC_WRITABLE) && !(desc->attrs & JS_PROP_WRITABLE))
        return fail(ctx, "'%s' on proxy: trap returned truish for defining non-configurable property '%s' which cannot be non-writable, unless there exists a corresponding non-configurable, non-writable own property of the target object.", "defineProperty", key);
    return 1;
}

static int proxy_delete(JSContext *ctx, JSObject *o, JSValue key, bool throw_on_fail) {
    if (js_is_private_name(key)) return JS_ORDINARY;
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, "deleteProperty", &handler, &target, &trap);
    if (t <= 0) return t < 0 ? -1 : js_delete_property(ctx, js_as_object(target), key, throw_on_fail);
    JSValue args[2] = { target, key_value(ctx, key) };
    if (js_is_exception(args[1])) return -1;
    int r = call_bool_trap(ctx, trap, handler, 2, args);
    if (r < 0) return -1;
    if (!r) return throw_on_fail ? fail(ctx, "'%s' on proxy: trap returned falsish for property '%s'", "deleteProperty", key) : 0;
    JSPropertyDescriptor target_desc;
    int has = js_get_own_property(ctx, js_as_object(target), key, &target_desc);
    if (has <= 0) return has < 0 ? -1 : 1;
    if (!(target_desc.attrs & JS_PROP_CONFIGURABLE))
        return fail(ctx, "'%s' on proxy: trap returned truish for property '%s' which is non-configurable in the proxy target", "deleteProperty", key);
    int extensible = js_object_is_extensible(ctx, js_as_object(target));
    if (extensible < 0) return -1;
    if (!extensible) return fail(ctx, "'%s' on proxy: trap returned truish for property '%s' but the proxy target is non-extensible", "deleteProperty", key);
    return 1;
}

/* ---- [[HasProperty]], [[Get]], [[Set]] -------------------------------------------------------- */

static int proxy_has(JSContext *ctx, JSObject *o, JSValue key) {
    if (js_is_private_name(key)) {
        JSPropertyDescriptor d;
        return js_ordinary_get_own_property(ctx, o, key, &d);
    }
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, "has", &handler, &target, &trap);
    if (t <= 0) return t < 0 ? -1 : js_has_property(ctx, js_as_object(target), key);
    JSValue args[2] = { target, key_value(ctx, key) };
    if (js_is_exception(args[1])) return -1;
    int r = call_bool_trap(ctx, trap, handler, 2, args);
    if (r != 0) return r;
    JSPropertyDescriptor target_desc;
    int has = js_get_own_property(ctx, js_as_object(target), key, &target_desc);
    if (has <= 0) return has;
    if (!(target_desc.attrs & JS_PROP_CONFIGURABLE))
        return fail(ctx, "'%s' on proxy: trap returned falsish for property '%s' which exists in the proxy target as non-configurable", "has", key);
    int extensible = js_object_is_extensible(ctx, js_as_object(target));
    if (extensible < 0) return -1;
    if (!extensible) return fail(ctx, "'%s' on proxy: trap returned falsish for property '%s' but the proxy target is not extensible", "has", key);
    return 0;
}

static JSValue proxy_get(JSContext *ctx, JSObject *o, JSValue key, JSValue receiver) {
    if (js_is_private_name(key)) {
        JSPropertyDescriptor d;
        int r = js_ordinary_get_own_property(ctx, o, key, &d);
        if (r <= 0) return r < 0 ? JS_EXCEPTION : JS_UNDEFINED;
        if (d.has & JS_DESC_VALUE) return d.value;
        return js_is_undefined(d.get) ? JS_UNDEFINED : js_call(ctx, d.get, receiver, 0, NULL);
    }
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, "get", &handler, &target, &trap);
    if (t <= 0) return t < 0 ? JS_EXCEPTION : js_get(ctx, js_as_object(target), key, receiver);
    JSValue args[3] = { target, key_value(ctx, key), receiver };
    if (js_is_exception(args[1])) return JS_EXCEPTION;
    JSValue v = call_trap(ctx, trap, handler, 3, args);
    if (js_is_exception(v)) return v;
    JSPropertyDescriptor d;
    int has = js_get_own_property(ctx, js_as_object(target), key, &d);
    if (has < 0) return JS_EXCEPTION;
    if (has && !(d.attrs & JS_PROP_CONFIGURABLE)) {
        if (is_data(&d) && !(d.attrs & JS_PROP_WRITABLE) && !js_same_value(ctx, v, d.value)) {
            char k[128], expected[128], got[128];
            key_text(ctx, key, k, sizeof k);
            js_describe_value(ctx, d.value, expected, sizeof expected);
            js_describe_value(ctx, v, got, sizeof got);
            return js_throw_type_error(ctx, "'get' on proxy: property '%s' is a read-only and non-configurable data property on the proxy target but the proxy did not return its actual value (expected '%s' but got '%s')",
                                       k, expected, got);
        }
        if (is_accessor(&d) && js_is_undefined(d.get) && !js_is_undefined(v)) {
            char k[128], got[128];
            key_text(ctx, key, k, sizeof k);
            js_describe_value(ctx, v, got, sizeof got);
            return js_throw_type_error(ctx, "'get' on proxy: property '%s' is a non-configurable accessor property on the proxy target and does not have a getter function, but the trap did not return 'undefined' (got '%s')",
                                       k, got);
        }
    }
    return v;
}

static int proxy_set(JSContext *ctx, JSObject *o, JSValue key, JSValue v, JSValue receiver, bool throw_on_fail) {
    if (js_is_private_name(key)) {
        JSPropertyDescriptor d = js_data_descriptor(v, JS_PROP_WRITABLE);
        d.has = JS_DESC_VALUE;
        return js_ordinary_define_own_property(ctx, o, key, &d, throw_on_fail);
    }
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, "set", &handler, &target, &trap);
    if (t <= 0) return t < 0 ? -1 : js_set(ctx, js_as_object(target), key, v, receiver, throw_on_fail);
    JSValue args[4] = { target, key_value(ctx, key), v, receiver };
    if (js_is_exception(args[1])) return -1;
    int r = call_bool_trap(ctx, trap, handler, 4, args);
    if (r < 0) return -1;
    if (!r) return throw_on_fail ? fail(ctx, "'%s' on proxy: trap returned falsish for property '%s'", "set", key) : 0;
    JSPropertyDescriptor d;
    int has = js_get_own_property(ctx, js_as_object(target), key, &d);
    if (has < 0) return -1;
    if (has && !(d.attrs & JS_PROP_CONFIGURABLE)) {
        if (is_data(&d) && !(d.attrs & JS_PROP_WRITABLE) && !js_same_value(ctx, v, d.value))
            return fail(ctx, "'%s' on proxy: trap returned truish for property '%s' which exists in the proxy target as a non-configurable and non-writable data property with a different value", "set", key);
        if (is_accessor(&d) && js_is_undefined(d.set))
            return fail(ctx, "'%s' on proxy: trap returned truish for property '%s' which exists in the proxy target as a non-configurable and non-writable accessor property without a setter", "set", key);
    }
    return 1;
}

/* ---- [[OwnPropertyKeys]] ---------------------------------------------------------------------- */

static bool same_key(JSContext *ctx, JSValue a, JSValue b) {
    return js_same_bits(a, b) || (js_is_string(a) && js_is_string(b) && js_string_equals(ctx, a, b));
}

/* The index of key in list[0..n), or -1. */
static int64_t index_of(JSContext *ctx, const JSValue *list, uint32_t n, JSValue key) {
    for (uint32_t i = 0; i < n; i++)
        if (same_key(ctx, list[i], key)) return i;
    return -1;
}

static JSValue proxy_own_keys(JSContext *ctx, JSObject *o) {
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, "ownKeys", &handler, &target, &trap);
    if (t <= 0) return t < 0 ? JS_EXCEPTION : js_own_keys(ctx, js_as_object(target));
    JSValue array = call_trap(ctx, trap, handler, 1, &target);
    if (js_is_exception(array)) return array;
    /* CreateListFromArrayLike(array, « String, Symbol »), as property keys, without duplicates */
    if (!js_is_object(array)) return js_throw_type_error(ctx, "CreateListFromArrayLike called on non-object");
    double len;
    if (js_length_of_array_like(ctx, array, &len) < 0) return JS_EXCEPTION;
    if (len > 1e7) return js_throw_range_error(ctx, "Invalid array length");
    uint32_t n = (uint32_t)len;
    JSValueArray *keys = js_alloc_value_array(ctx, n);
    JSValue held = js_cell(&keys->cell);
    for (uint32_t i = 0; i < n; i++) {
        JSValue v = js_get_value(ctx, array, js_index_key(i));
        if (js_is_exception(v)) return v;
        if (!js_is_string(v) && !js_is_symbol(v)) {
            char what[128];
            js_describe_value(ctx, v, what, sizeof what);
            return js_throw_type_error(ctx, "%s is not a valid property name", what);
        }
        JSValue key = js_to_property_key(ctx, v);
        if (js_is_exception(key)) return key;
        if (index_of(ctx, keys->values, i, key) >= 0) return js_throw_type_error(ctx, "'ownKeys' on proxy: trap returned duplicate entries");
        js_store(ctx, &keys->cell, &keys->values[i], key);
    }
    int extensible = js_object_is_extensible(ctx, js_as_object(target));
    if (extensible < 0) return JS_EXCEPTION;
    JSValue target_keys = js_own_keys(ctx, js_as_object(target));
    if (js_is_exception(target_keys)) return target_keys;
    JSValueArray *tk = (JSValueArray *)js_as_cell(target_keys);
    /* the target's keys, non-configurable ones first */
    JSValueArray *sorted = js_alloc_value_array(ctx, tk->cell.aux);
    uint32_t nonconfig = 0, nsorted = 0;
    for (int pass = 0; pass < 2; pass++)
        for (uint32_t i = 0; i < tk->cell.aux; i++) {
            JSPropertyDescriptor d;
            int has = js_get_own_property(ctx, js_as_object(target), tk->values[i], &d);
            if (has < 0) return JS_EXCEPTION;
            bool nc = has && !(d.attrs & JS_PROP_CONFIGURABLE);
            if (nc != (pass == 0)) continue;
            js_store(ctx, &sorted->cell, &sorted->values[nsorted++], tk->values[i]);
            if (nc) nonconfig++;
        }
    if (extensible && nonconfig == 0) return held;
    /* each target key we must see: checked off a copy of the trap's list */
    bool *seen = n ? calloc(n, sizeof *seen) : NULL;
    for (uint32_t i = 0; i < nsorted; i++) {
        if (extensible && i >= nonconfig) break;
        int64_t at = index_of(ctx, keys->values, n, sorted->values[i]);
        if (at < 0 || seen[at]) {
            free(seen);
            char k[128];
            key_text(ctx, sorted->values[i], k, sizeof k);
            return js_throw_type_error(ctx, "'ownKeys' on proxy: trap result did not include '%s'", k);
        }
        seen[at] = true;
    }
    bool extra = false;
    for (uint32_t i = 0; i < n && !extensible; i++) extra |= !seen[i];
    free(seen);
    if (extra) return js_throw_type_error(ctx, "'ownKeys' on proxy: trap returned extra keys but proxy target is non-extensible");
    js_keep_alive(target_keys);
    js_keep_alive(held);
    return held;
}

/* ---- [[Call]] and [[Construct]] ---------------------------------------------------------------- */

static JSValue proxy_entry(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    JSObject *o = js_as_object(callee);
    bool construct = !js_is_undefined(new_target);
    JSValue handler, target, trap;
    int t = get_trap(ctx, o, construct ? "construct" : "apply", &handler, &target, &trap);
    if (t < 0) return JS_EXCEPTION;
    if (!t) return construct ? js_construct(ctx, target, argc, argv, new_target, NULL) : js_call(ctx, target, this_val, argc, argv);
    JSValue list = js_new_array_from(ctx, argv, argc);
    if (js_is_exception(list)) return list;
    if (!construct) {
        JSValue args[3] = { target, this_val, list };
        return call_trap(ctx, trap, handler, 3, args);
    }
    JSValue args[3] = { target, list, new_target };
    JSValue r = call_trap(ctx, trap, handler, 3, args);
    if (js_is_exception(r) || js_is_object(r)) return r;
    char what[128];
    js_describe_value(ctx, r, what, sizeof what);
    return js_throw_type_error(ctx, "'construct' on proxy: trap returned non-object ('%s')", what);
}

/* ---- Classes ----------------------------------------------------------------------------------- */

static JSValue proxy_target(JSObject *o) { return *target_slot(o); }

static const JSObjectMethods proxy_methods = {
    proxy_get_prototype_of, proxy_set_prototype_of, proxy_is_extensible, proxy_prevent_extensions,
    proxy_has, proxy_get, proxy_set, proxy_own_keys, proxy_target,
};

static void proxy_visit(JSCell *c, JSTracer *trc) {
    JSObject *o = (JSObject *)c;
    js_trace_value(trc, *target_slot(o));
    js_trace_value(trc, *handler_slot(o));
}

static const JSClass proxy_class = { "Proxy", sizeof(ProxyObject), proxy_get_own, proxy_define, proxy_delete, NULL, proxy_visit, NULL, &proxy_methods };
static const JSClass proxy_function_class = { "Proxy", sizeof(JSFunction), proxy_get_own, proxy_define, proxy_delete, NULL, proxy_visit, NULL, &proxy_methods };

/* ProxyCreate (§10.5.14) */
static JSValue proxy_create(JSContext *ctx, JSValue target, JSValue handler) {
    if (!js_is_object(target) || !js_is_object(handler)) return js_throw_type_error(ctx, "Cannot create proxy with a non-object as target or handler");
    JSObject *o;
    if (js_is_callable(target)) {
        JSFunction *f = (JSFunction *)js_alloc_object(ctx, JS_CELL_FUNCTION, js_shape_root(ctx, &proxy_function_class, JS_NULL, 0));
        f->entry = proxy_entry;
        f->realm = ctx;
        f->flags = JS_FN_STRICT | JS_FN_PROXY | (js_is_constructor(target) ? JS_FN_CONSTRUCTOR : 0);
        o = &f->obj;
    } else {
        o = js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &proxy_class, JS_NULL, 0));
    }
    js_store(ctx, &o->cell, target_slot(o), target);
    js_store(ctx, &o->cell, handler_slot(o), handler);
    return js_object_value(o);
}

BUILTIN(proxy_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_type_error(ctx, "Constructor Proxy requires 'new'");
    return proxy_create(ctx, ARG(0), ARG(1));
}

/* The revoke function: its home_object holds the proxy until it runs. */
BUILTIN(proxy_revoke) {
    (void)this_val, (void)argc, (void)argv, (void)new_target;
    JSFunction *f = js_as_function(callee);
    if (js_is_object(f->home_object)) {
        JSObject *p = js_as_object(f->home_object);
        js_store(ctx, &p->cell, target_slot(p), JS_NULL);
        js_store(ctx, &p->cell, handler_slot(p), JS_NULL);
        js_store(ctx, &f->obj.cell, &f->home_object, JS_NULL);
    }
    return JS_UNDEFINED;
}

/* Proxy.revocable(target, handler) (§28.2.2.1): { proxy, revoke } */
BUILTIN(proxy_revocable) {
    (void)callee, (void)this_val, (void)new_target;
    JSValue proxy = proxy_create(ctx, ARG(0), ARG(1));
    if (js_is_exception(proxy)) return proxy;
    JSValue revoke = js_new_native(ctx, proxy_revoke, js_empty_string(), 0, JS_FN_STRICT);
    js_store(ctx, &js_as_object(revoke)->cell, &js_as_function(revoke)->home_object, proxy);
    JSValue result = js_new_object(ctx);
    js_define_data(ctx, js_as_object(result), js_atom_from_cstr(ctx, "proxy"), proxy, JS_PROP_DEFAULT);
    js_define_data(ctx, js_as_object(result), js_atom_from_cstr(ctx, "revoke"), revoke, JS_PROP_DEFAULT);
    return result;
}

static const JSBuiltin proxy_statics[] = {
    JS_BUILTIN_FN("revocable", proxy_revocable, 2),
};

static void install_proxy(JSContext *ctx, JSObject *global) {
    JSValue key = js_atom_from_cstr(ctx, "Proxy");
    JSValue c = js_new_native(ctx, proxy_ctor, key, 2, JS_FN_STRICT | JS_FN_CONSTRUCTOR);  /* no `prototype` (§28.2.2) */
    js_define_builtins(ctx, js_as_object(c), proxy_statics, JS_COUNTOF(proxy_statics));
    js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
}

const JSComponent js_component_proxy = { "proxy", install_proxy };
