/* Core built-ins: Object, Function.prototype, Array, String, Number and Boolean basics. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "internal.h"
#include "builtins_util.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_error.h"
#include "js_ops.h"
#include "js_symbol.h"
#include "jsnum.h"


/* ---- Helpers --------------------------------------------------------------------------- */

static JSValue cstr(JSContext *ctx, const char *s) {
    JSValue v = js_new_string_cstr(ctx, s);
    return v;
}

/* ToIntegerOrInfinity (§7.1.5). */
static int to_integer(JSContext *ctx, double *out, JSValue v) {
    double d;
    if (js_to_number(ctx, &d, v) < 0) return -1;
    *out = isnan(d) ? 0 : isinf(d) ? d : trunc(d) + 0.0;
    return 0;
}

/* LengthOfArrayLike: ToLength(obj.length) (§7.3.18). */
int js_length_of_array_like(JSContext *ctx, JSValue obj, double *out) {
    JSValue len = js_get_value(ctx, obj, JS_ATOM(length));
    if (js_is_exception(len)) return -1;
    double d;
    if (to_integer(ctx, &d, len) < 0) return -1;
    *out = d <= 0 ? 0 : d > 9007199254740991.0 ? 9007199254740991.0 : d;
    return 0;
}

/* A property key for index d (below 2^53). */
static JSValue index_key(JSContext *ctx, double d) {
    if (d <= 4294967294.0) return js_index_key((uint32_t)d);
    JSValue k = js_to_property_key(ctx, js_double(d));  /* a canonical numeric string */
    return k;
}

/* HasProperty on any value that isn't nullish (primitives: their own properties, then the prototype). */
static int has_value(JSContext *ctx, JSValue v, JSValue key) {
    if (js_is_object(v)) return js_has_property(ctx, js_as_object(v), key);
    if (js_is_string(v)) {
        if (js_same_bits(key, JS_ATOM(length))) return 1;
        if (js_key_is_index(key) && js_key_index(key) < js_string_length(v)) return 1;
    }
    return js_has_property(ctx, js_primitive_prototype(ctx, v), key);
}

/* RequireObjectCoercible for a method's `this`. */
static bool require_coercible(JSContext *ctx, JSValue v, const char *method) {
    if (!js_is_nullish(v)) return true;
    js_discard(js_throw_type_error(ctx, "%s called on null or undefined", method));
    return false;
}

static JSValue require_object(JSContext *ctx, JSValue v, const char *what) {
    if (js_is_object(v)) return v;
    return js_throw_type_error(ctx, "%s called on non-object", what);
}

/* A key as a string (index keys are numbers). */
static JSValue key_string(JSContext *ctx, JSValue key) {
    return js_is_number(key) ? js_to_string(ctx, key) : key;
}

/* The helpers other built-in files share (builtins_util.h). */
int js_to_integer_or_infinity(JSContext *ctx, double *out, JSValue v) { return to_integer(ctx, out, v); }
JSValue js_index_key_of(JSContext *ctx, double d) { return index_key(ctx, d); }
int js_has_value(JSContext *ctx, JSValue v, JSValue key) { return has_value(ctx, v, key); }
bool js_require_this(JSContext *ctx, JSValue v, const char *method) { return require_coercible(ctx, v, method); }

void js_describe_value(JSContext *ctx, JSValue v, char *buf, size_t cap) {
    if (js_is_symbol(v)) {
        JSValue d = js_symbol_description(v);
        char desc[96] = "";
        if (js_is_string(d)) desc[js_view_to_utf8(js_string_view(ctx, d), desc, sizeof desc - 1)] = '\0';
        snprintf(buf, cap, "Symbol(%s)", desc);
        return;
    }
    if (!js_is_object(v)) {
        JSValue s = js_to_string(ctx, v);
        if (js_is_exception(s)) {
            js_discard(js_take_exception(ctx));
            snprintf(buf, cap, "value");
            return;
        }
        buf[js_view_to_utf8(js_string_view(ctx, s), buf, cap - 1)] = '\0';
        return;
    }
    const JSClass *cls = js_as_object(v)->shape->cls;
    if (js_is_array(v) || strstr(cls->name, " Iterator")) {
        snprintf(buf, cap, "[object %s]", js_is_array(v) ? "Array" : cls->name);
        return;
    }
    const char *name = js_is_function(v) ? "Function" : "Object";
    for (JSValue o = js_get_prototype_of(js_as_object(v)); js_is_object(o); o = js_get_prototype_of(js_as_object(o))) {
        JSPropertyDescriptor d, n;
        if (js_get_own_property(ctx, js_as_object(o), JS_ATOM(constructor), &d) == 1 && (d.has & JS_DESC_VALUE) && js_is_function(d.value) &&
            js_get_own_property(ctx, js_as_object(d.value), JS_ATOM(name), &n) == 1 && (n.has & JS_DESC_VALUE) && js_is_string(n.value) &&
            js_string_length(n.value) != 0) {
            char s[96];
            s[js_view_to_utf8(js_string_view(ctx, n.value), s, sizeof s - 1)] = '\0';
            snprintf(buf, cap, "#<%s>", s);
            return;
        }
    }
    snprintf(buf, cap, "#<%s>", name);
}

/* ---- Property descriptors (§6.2.6.4, §6.2.6.5) ------------------------------------------- */

static int to_descriptor(JSContext *ctx, JSValue v, JSPropertyDescriptor *d) {
    if (!js_is_object(v)) {
        JSValue s = js_to_string(ctx, v);
        char buf[64] = "";
        if (!js_is_exception(s)) buf[js_view_to_utf8(js_string_view(ctx, s), buf, sizeof buf - 1)] = '\0';
        else js_discard(js_take_exception(ctx));
        js_discard(js_throw_type_error(ctx, "Property description must be an object: %s", buf));
        return -1;
    }
    JSObject *o = js_as_object(v);
    memset(d, 0, sizeof *d);
    d->value = d->get = d->set = JS_UNDEFINED;
    static const struct { const char *name; uint8_t has, attr; } flags[] = {
        { "enumerable", JS_DESC_ENUMERABLE, JS_PROP_ENUMERABLE },
        { "configurable", JS_DESC_CONFIGURABLE, JS_PROP_CONFIGURABLE },
    };
    for (unsigned i = 0; i < 2; i++) {
        JSValue key = js_atom_from_cstr(ctx, flags[i].name);
        int has = js_has_property(ctx, o, key);
        if (has < 0) return -1;
        if (!has) continue;
        JSValue x = js_get(ctx, o, key, v);
        if (js_is_exception(x)) return -1;
        d->has |= flags[i].has;
        if (js_truthy(x)) d->attrs |= flags[i].attr;
    }
    int has = js_has_property(ctx, o, JS_ATOM(value));
    if (has < 0) return -1;
    if (has) {
        d->value = js_get(ctx, o, JS_ATOM(value), v);
        if (js_is_exception(d->value)) return -1;
        d->has |= JS_DESC_VALUE;
    }
    JSValue writable = js_atom_from_cstr(ctx, "writable");
    has = js_has_property(ctx, o, writable);
    if (has < 0) return -1;
    if (has) {
        JSValue x = js_get(ctx, o, writable, v);
        if (js_is_exception(x)) return -1;
        d->has |= JS_DESC_WRITABLE;
        if (js_truthy(x)) d->attrs |= JS_PROP_WRITABLE;
    }
    for (int accessor = 0; accessor < 2; accessor++) {
        JSValue key = accessor ? JS_ATOM(set) : JS_ATOM(get);
        has = js_has_property(ctx, o, key);
        if (has < 0) return -1;
        if (!has) continue;
        JSValue f = js_get(ctx, o, key, v);
        if (js_is_exception(f)) return -1;
        if (!js_is_undefined(f) && !js_is_callable(f)) {
            js_discard(js_throw_type_error(ctx, "%s must be a function", accessor ? "Setter" : "Getter"));
            return -1;
        }
        if (accessor) d->set = f;
        else d->get = f;
        d->has |= accessor ? JS_DESC_SET : JS_DESC_GET;
    }
    if ((d->has & (JS_DESC_GET | JS_DESC_SET)) && (d->has & (JS_DESC_VALUE | JS_DESC_WRITABLE))) {
        js_discard(js_throw_type_error(ctx, "Invalid property descriptor. Cannot both specify accessors and a value or writable attribute, #<Object>"));
        return -1;
    }
    return 0;
}

static JSValue from_descriptor(JSContext *ctx, const JSPropertyDescriptor *d);
int js_to_property_descriptor(JSContext *ctx, JSValue v, JSPropertyDescriptor *d) { return to_descriptor(ctx, v, d); }
JSValue js_from_property_descriptor(JSContext *ctx, const JSPropertyDescriptor *d) { return from_descriptor(ctx, d); }

static JSValue from_descriptor(JSContext *ctx, const JSPropertyDescriptor *d) {
    JSValue r = js_new_object(ctx);
    JSObject *o = js_as_object(r);
    if (d->has & JS_DESC_VALUE) js_define_data(ctx, o, JS_ATOM(value), d->value, JS_PROP_DEFAULT);
    if (d->has & JS_DESC_WRITABLE) js_define_data(ctx, o, js_atom_from_cstr(ctx, "writable"), js_bool(d->attrs & JS_PROP_WRITABLE), JS_PROP_DEFAULT);
    if (d->has & JS_DESC_GET) js_define_data(ctx, o, JS_ATOM(get), d->get, JS_PROP_DEFAULT);
    if (d->has & JS_DESC_SET) js_define_data(ctx, o, JS_ATOM(set), d->set, JS_PROP_DEFAULT);
    js_define_data(ctx, o, js_atom_from_cstr(ctx, "enumerable"), js_bool(d->attrs & JS_PROP_ENUMERABLE), JS_PROP_DEFAULT);
    js_define_data(ctx, o, js_atom_from_cstr(ctx, "configurable"), js_bool(d->attrs & JS_PROP_CONFIGURABLE), JS_PROP_DEFAULT);
    return r;
}

/* ---- Object (§20.1) -------------------------------------------------------------------------- */

BUILTIN(object_ctor) {
    UNUSED_ARGS;
    /* new Object() from a subclass: OrdinaryCreateFromConstructor */
    if (!js_is_undefined(new_target) && !js_same_bits(new_target, callee))
        return js_create_from_constructor(ctx, new_target, JS_INTRINSIC_OBJECT_PROTOTYPE);
    JSValue v = ARG(0);
    if (js_is_object(v)) return v;
    if (js_is_nullish(v)) return js_new_object(ctx);
    return js_new_wrapper(ctx, v, JS_UNDEFINED);
}

CORE(object_define_property) {
    UNUSED_ARGS;
    JSValue o = require_object(ctx, ARG(0), "Object.defineProperty");
    if (js_is_exception(o)) return JS_EXCEPTION;
    JSValue key = js_to_property_key(ctx, ARG(1));
    if (js_is_exception(key)) return JS_EXCEPTION;
    JSPropertyDescriptor d;
    if (to_descriptor(ctx, ARG(2), &d) < 0) return JS_EXCEPTION;
    if (js_define_own_property(ctx, js_as_object(o), key, &d, true) < 0) return JS_EXCEPTION;
    return o;
}

/* Object.defineProperties(o, props) (§20.1.2.3.1): descriptors first, then the definitions. */
static JSValue define_properties(JSContext *ctx, JSValue o, JSValue props) {
    if (js_is_nullish(props)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    if (!js_is_object(props)) return o;
    JSValue all = js_own_keys(ctx, js_as_object(props));
    if (js_is_exception(all)) return all;
    JSValueArray *keys = (JSValueArray *)js_as_cell(all);
    uint32_t n = keys->cell.aux;
    JSValueArray *descs = js_alloc_value_array(ctx, 4 * n);  /* each descriptor object and its values, for the GC */
    JSPropertyDescriptor *ds = n ? calloc(n, sizeof *ds) : NULL;
    uint32_t count = 0;
    JSValue result = o;
    for (uint32_t i = 0; i < n; i++) {
        JSPropertyDescriptor own;
        int r = js_get_own_property(ctx, js_as_object(props), keys->values[i], &own);
        if (r < 0) { result = JS_EXCEPTION; goto done; }
        if (!r || !(own.attrs & JS_PROP_ENUMERABLE)) continue;
        JSValue dv = js_get(ctx, js_as_object(props), keys->values[i], props);
        if (js_is_exception(dv)) { result = JS_EXCEPTION; goto done; }
        js_store(ctx, &descs->cell, &descs->values[4 * count], dv);
        if (to_descriptor(ctx, dv, &ds[count]) < 0) { result = JS_EXCEPTION; goto done; }
        js_store(ctx, &descs->cell, &descs->values[4 * count + 1], ds[count].value);
        js_store(ctx, &descs->cell, &descs->values[4 * count + 2], ds[count].get);
        js_store(ctx, &descs->cell, &descs->values[4 * count + 3], ds[count].set);
        keys->values[count] = keys->values[i];  /* barrier: same owner */
        count++;
    }
    for (uint32_t i = 0; i < count; i++)
        if (js_define_own_property(ctx, js_as_object(o), keys->values[i], &ds[i], true) < 0) { result = JS_EXCEPTION; goto done; }
done:
    free(ds);
    JSValue held = js_cell(&descs->cell);
    js_keep_alive(held);
    return result;
}

CORE(object_define_properties) {
    UNUSED_ARGS;
    JSValue o = require_object(ctx, ARG(0), "Object.defineProperties");
    if (js_is_exception(o)) return JS_EXCEPTION;
    return define_properties(ctx, o, ARG(1));
}

/* The own property of any value (primitives: a string's length and indices). */
static int own_property_of(JSContext *ctx, JSValue v, JSValue key, JSPropertyDescriptor *d) {
    if (js_is_object(v)) return js_get_own_property(ctx, js_as_object(v), key, d);
    if (!js_is_string(v)) return 0;
    JSValue x = js_get_value(ctx, v, key);
    if (js_is_exception(x)) return -1;
    bool own = js_same_bits(key, JS_ATOM(length)) || (js_key_is_index(key) && js_key_index(key) < js_string_length(v));
    if (!own) return 0;
    *d = js_data_descriptor(x, js_same_bits(key, JS_ATOM(length)) ? 0 : JS_PROP_ENUMERABLE);
    return 1;
}

CORE(object_get_own_property_descriptor) {
    UNUSED_ARGS;
    if (js_is_nullish(ARG(0))) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    JSValue key = js_to_property_key(ctx, ARG(1));
    if (js_is_exception(key)) return JS_EXCEPTION;
    JSPropertyDescriptor d;
    int r = own_property_of(ctx, ARG(0), key, &d);
    if (r < 0) return JS_EXCEPTION;
    return r ? from_descriptor(ctx, &d) : JS_UNDEFINED;
}

/* Own string keys of any value, as an array; `enumerable_only` for Object.keys. */
static JSValue own_string_keys(JSContext *ctx, JSValue v, bool enumerable_only) {
    if (js_is_nullish(v)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    JSValue result = js_new_array(ctx, 0);
    if (js_is_string(v)) {
        uint32_t n = js_string_length(v);
        for (uint32_t i = 0; i < n; i++) {
            JSValue s = js_to_string(ctx, js_int32((int32_t)i));
            if (js_is_exception(s) || js_array_push(ctx, js_as_object(result), s) < 0) return JS_EXCEPTION;
        }
        if (!enumerable_only && js_array_push(ctx, js_as_object(result), JS_ATOM(length)) < 0) return JS_EXCEPTION;
        return result;
    }
    if (!js_is_object(v)) return result;
    JSObject *o = js_as_object(v);
    JSValue all = js_own_keys(ctx, o);
    if (js_is_exception(all)) return all;
    JSValueArray *keys = (JSValueArray *)js_as_cell(all);
    for (uint32_t i = 0; i < keys->cell.aux; i++) {
        JSValue k = keys->values[i];
        if (js_is_symbol(k)) continue;  /* last for ordinary objects; a proxy's ownKeys may mix them */
        if (enumerable_only) {
            JSPropertyDescriptor d;
            int r = js_get_own_property(ctx, o, k, &d);
            if (r < 0) return JS_EXCEPTION;
            if (!r || !(d.attrs & JS_PROP_ENUMERABLE)) continue;
        }
        JSValue s = key_string(ctx, k);
        if (js_is_exception(s) || js_array_push(ctx, js_as_object(result), s) < 0) return JS_EXCEPTION;
    }
    return result;
}

CORE(object_get_own_property_names) {
    UNUSED_ARGS;
    return own_string_keys(ctx, ARG(0), false);
}

/* Object.getOwnPropertySymbols (§20.1.2.11) */
CORE(object_get_own_property_symbols) {
    UNUSED_ARGS;
    JSValue v = ARG(0);
    if (js_is_nullish(v)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    JSValue result = js_new_array(ctx, 0);
    if (!js_is_object(v)) return result;
    JSValue all = js_own_keys(ctx, js_as_object(v));
    if (js_is_exception(all)) return all;
    JSValueArray *keys = (JSValueArray *)js_as_cell(all);
    for (uint32_t i = 0; i < keys->cell.aux; i++)
        if (js_is_symbol(keys->values[i]) && js_array_push(ctx, js_as_object(result), keys->values[i]) < 0) return JS_EXCEPTION;
    return result;
}

CORE(object_keys) {
    UNUSED_ARGS;
    return own_string_keys(ctx, ARG(0), true);
}

static JSValue proto_of_value(JSContext *ctx, JSValue v) {
    if (js_is_nullish(v)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    if (js_is_object(v)) return js_object_get_prototype_of(ctx, js_as_object(v));
    return js_object_value(js_primitive_prototype(ctx, v));
}

CORE(object_get_prototype_of) {
    UNUSED_ARGS;
    return proto_of_value(ctx, ARG(0));
}

CORE(object_set_prototype_of) {
    UNUSED_ARGS;
    JSValue o = ARG(0), proto = ARG(1);
    if (js_is_nullish(o)) return js_throw_type_error(ctx, "Object.setPrototypeOf called on null or undefined");
    if (!js_is_object(proto) && !js_is_null(proto)) return js_throw_type_error(ctx, "Object prototype may only be an Object or null");
    if (!js_is_object(o)) return o;
    int r = js_set_prototype_of(ctx, js_as_object(o), proto);
    if (r < 0) return JS_EXCEPTION;
    if (!r && !js_is_empty(js_proxy_target(o))) return js_throw_type_error(ctx, "'setPrototypeOf' on proxy: trap returned falsish for property 'undefined'");
    if (!r) return js_throw_type_error(ctx, "Cannot set the prototype of this object");
    return o;
}

CORE(object_create) {
    UNUSED_ARGS;
    JSValue proto = ARG(0);
    if (!js_is_object(proto) && !js_is_null(proto)) return js_throw_type_error(ctx, "Object prototype may only be an Object or null");
    JSValue o = js_new_object_proto(ctx, proto, JS_DEFAULT_INLINE_SLOTS);
    if (js_is_undefined(ARG(1))) return o;
    return define_properties(ctx, o, ARG(1));
}

CORE(object_prevent_extensions) {
    UNUSED_ARGS;
    if (!js_is_object(ARG(0))) return ARG(0);
    int r = js_prevent_extensions(ctx, js_as_object(ARG(0)));
    if (r == 0 && !js_is_empty(js_proxy_target(ARG(0)))) return js_throw_type_error(ctx, "'preventExtensions' on proxy: trap returned falsish");
    if (r == 0) return js_throw_type_error(ctx, "Cannot prevent extensions on this object");  /* a view of a resizable buffer */
    return r < 0 ? JS_EXCEPTION : ARG(0);
}

CORE(object_is_extensible) {
    UNUSED_ARGS;
    if (!js_is_object(ARG(0))) return JS_FALSE;
    int r = js_object_is_extensible(ctx, js_as_object(ARG(0)));
    return r < 0 ? JS_EXCEPTION : js_bool(r);
}

/* Object.prototype.toString (§20.1.3.6), without Symbol.toStringTag. */
CORE(object_proto_to_string) {
    UNUSED_ARGS;
    const char *tag = "Object";
    if (js_is_undefined(this_val)) tag = "Undefined";
    else if (js_is_null(this_val)) tag = "Null";
    JSValue prim = js_is_wrapper(this_val) ? js_wrapped_value(this_val) : this_val;  /* [[StringData]], … */
    int is_array = js_is_nullish(this_val) ? 0 : js_is_array_spec(ctx, this_val);
    if (is_array < 0) return JS_EXCEPTION;
    if (js_is_nullish(this_val)) {
    } else if (js_is_string(prim)) tag = "String";
    else if (js_is_number(prim)) tag = "Number";
    else if (js_is_bool(prim)) tag = "Boolean";
    else if (is_array) tag = "Array";
    else if (js_is_callable(this_val)) tag = "Function";
    else if (js_is_error(this_val)) tag = "Error";
    else if (js_is_arguments(this_val)) tag = "Arguments";
    else if (js_is_object(this_val) && strcmp(js_as_object(this_val)->shape->cls->name, "Date") == 0) tag = "Date";
    else if (js_is_object(this_val) && strcmp(js_as_object(this_val)->shape->cls->name, "RegExp") == 0) tag = "RegExp";
    if (!js_is_nullish(this_val)) {  /* a string @@toStringTag wins (Promise, Symbol, Generator, …) */
        JSValue t = js_get_value(ctx, this_val, JS_SYMBOL(toStringTag));
        if (js_is_exception(t)) return JS_EXCEPTION;
        if (js_is_string(t)) {
            JSValue head = js_concat(ctx, cstr(ctx, "[object "), t);
            if (js_is_exception(head)) return JS_EXCEPTION;
            return js_concat(ctx, head, cstr(ctx, "]"));
        }
    }
    char buf[32];
    snprintf(buf, sizeof buf, "[object %s]", tag);
    return cstr(ctx, buf);
}

CORE(object_proto_value_of) {
    UNUSED_ARGS;
    return js_to_object(ctx, this_val);
}

CORE(object_proto_has_own_property) {
    UNUSED_ARGS;
    JSValue key = js_to_property_key(ctx, ARG(0));
    if (js_is_exception(key)) return JS_EXCEPTION;
    if (js_is_nullish(this_val)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    JSPropertyDescriptor d;
    int r = own_property_of(ctx, this_val, key, &d);
    return r < 0 ? JS_EXCEPTION : js_bool(r);
}

CORE(object_proto_property_is_enumerable) {
    UNUSED_ARGS;
    JSValue key = js_to_property_key(ctx, ARG(0));
    if (js_is_exception(key)) return JS_EXCEPTION;
    if (js_is_nullish(this_val)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    JSPropertyDescriptor d;
    int r = own_property_of(ctx, this_val, key, &d);
    if (r < 0) return JS_EXCEPTION;
    return js_bool(r && (d.attrs & JS_PROP_ENUMERABLE));
}

CORE(object_proto_is_prototype_of) {
    UNUSED_ARGS;
    JSValue v = ARG(0);
    if (!js_is_object(v)) return JS_FALSE;
    if (js_is_nullish(this_val)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    JSValue o = js_to_object(ctx, this_val);
    if (js_is_exception(o)) return o;
    for (JSValue p = js_object_get_prototype_of(ctx, js_as_object(v));; p = js_object_get_prototype_of(ctx, js_as_object(p))) {
        if (js_is_exception(p)) return p;
        if (!js_is_object(p)) return JS_FALSE;
        if (js_same_bits(p, o)) return JS_TRUE;
    }
}

/* ---- Object, ES2015 and later (§20.1.2) ------------------------------------------------------- */


/* CreateDataPropertyOrThrow (§7.3.7). */
static int create_data_property(JSContext *ctx, JSValue o, JSValue key, JSValue v) {
    JSPropertyDescriptor d = js_data_descriptor(v, JS_PROP_DEFAULT);
    return js_define_own_property(ctx, js_as_object(o), key, &d, true) < 0 ? -1 : 0;
}

/* ToObject where only the check matters: the statics that read a value's own properties take
 * primitives as they are (own_property_of, own_string_keys), without allocating a wrapper. */
static JSValue to_object_or_throw(JSContext *ctx, JSValue v) {
    if (js_is_nullish(v)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    return v;
}

/* The values of a value's own enumerable string keys (Object.values / entries): each key is
 * checked again before its Get (§7.3.24 EnumerableOwnProperties). */
static JSValue enumerable_own(JSContext *ctx, JSValue v, bool entries) {
    if (js_is_exception(to_object_or_throw(ctx, v))) return JS_EXCEPTION;
    JSValue keys = own_string_keys(ctx, v, false);
    if (js_is_exception(keys)) return keys;
    JSValue result = js_new_array(ctx, 0);
    uint32_t n = js_array_length(js_as_object(keys));
    for (uint32_t i = 0; i < n; i++) {
        JSValue name = js_get_elem(ctx, keys, js_index_key(i));
        JSValue key = js_is_exception(name) ? name : js_to_property_key(ctx, name);
        if (js_is_exception(key)) return JS_EXCEPTION;
        JSPropertyDescriptor d;
        int r = own_property_of(ctx, v, key, &d);
        if (r < 0) return JS_EXCEPTION;
        if (!r || !(d.attrs & JS_PROP_ENUMERABLE)) continue;
        JSValue value = js_get_value(ctx, v, key);
        if (js_is_exception(value)) return value;
        JSValue item = value;
        if (entries) {
            JSValue pair[2] = { name, value };
            item = js_new_array_from(ctx, pair, 2);
            if (js_is_exception(item)) return item;
        }
        if (js_array_push(ctx, js_as_object(result), item) < 0) return JS_EXCEPTION;
    }
    js_keep_alive(keys);
    return result;
}

CORE(object_values) {
    UNUSED_ARGS;
    return enumerable_own(ctx, ARG(0), false);
}

CORE(object_entries) {
    UNUSED_ARGS;
    return enumerable_own(ctx, ARG(0), true);
}

/* Object.assign(target, ...sources) (§20.1.2.1) */
CORE(object_assign) {
    UNUSED_ARGS;
    JSValue target = js_to_object(ctx, ARG(0));
    if (js_is_exception(target)) return target;
    for (uint32_t s = 1; s < argc; s++) {
        JSValue from = argv[s];
        if (js_is_nullish(from)) continue;
        if (js_is_string(from)) {  /* its characters: own, enumerable */
            uint32_t n = js_string_length(from);
            for (uint32_t i = 0; i < n; i++)
                if (js_set_value(ctx, target, js_index_key(i), js_substring(ctx, from, i, i + 1), true) < 0) return JS_EXCEPTION;
            continue;
        }
        if (!js_is_object(from)) continue;
        JSValue keys = js_own_keys(ctx, js_as_object(from));
        if (js_is_exception(keys)) return keys;
        JSValueArray *list = (JSValueArray *)js_as_cell(keys);
        for (uint32_t i = 0; i < list->cell.aux; i++) {
            JSPropertyDescriptor d;
            int r = js_get_own_property(ctx, js_as_object(from), list->values[i], &d);
            if (r < 0) return JS_EXCEPTION;
            if (!r || !(d.attrs & JS_PROP_ENUMERABLE)) continue;
            JSValue v = js_get(ctx, js_as_object(from), list->values[i], from);
            if (js_is_exception(v) || js_set_value(ctx, target, list->values[i], v, true) < 0) return JS_EXCEPTION;
        }
        js_keep_alive(keys);
    }
    return target;
}

/* Object.fromEntries(iterable) (§20.1.2.7) */
CORE(object_from_entries) {
    UNUSED_ARGS;
    if (js_is_nullish(ARG(0))) return js_throw_type_error(ctx, "Object.fromEntries requires an iterable");
    JSValue result = js_new_object(ctx);
    JSValue rec = js_iter_start(ctx, ARG(0));
    if (js_is_exception(rec)) return rec;
    for (;;) {
        JSValue entry = js_iter_next(ctx, rec);
        if (js_is_exception(entry)) return entry;
        if (js_is_empty(entry)) return result;
        if (!js_is_object(entry)) {
            JSValue e = js_throw_type_error(ctx, "Iterator value is not an entry object");
            (void)e;
            js_iter_close_throw(ctx, rec);
            return JS_EXCEPTION;
        }
        JSValue k = js_get_elem(ctx, entry, js_index_key(0));
        JSValue v = js_is_exception(k) ? k : js_get_elem(ctx, entry, js_index_key(1));
        JSValue key = js_is_exception(v) ? v : js_to_property_key(ctx, k);
        if (js_is_exception(key) || create_data_property(ctx, result, key, v) < 0) {
            js_iter_close_throw(ctx, rec);
            return JS_EXCEPTION;
        }
    }
}

/* SetIntegrityLevel / TestIntegrityLevel (§7.3.15, §7.3.16): sealed (frozen: also read-only). */
static int seal(JSContext *ctx, JSObject *o) {
    int r = js_prevent_extensions(ctx, o);
    if (r == 0) js_discard(js_throw_type_error(ctx, "'preventExtensions' on proxy: trap returned falsish"));
    if (r <= 0) return -1;
    JSValue keys = js_own_keys(ctx, o);
    if (js_is_exception(keys)) return -1;
    JSValueArray *list = (JSValueArray *)js_as_cell(keys);
    for (uint32_t i = 0; i < list->cell.aux; i++) {
        JSPropertyDescriptor d = { JS_DESC_CONFIGURABLE, 0, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED };
        if (js_define_own_property(ctx, o, list->values[i], &d, true) < 0) return -1;
    }
    js_keep_alive(keys);
    return 0;
}

static JSValue test_integrity(JSContext *ctx, JSValue v, bool frozen) {
    if (!js_is_object(v)) return JS_TRUE;
    JSObject *o = js_as_object(v);
    int extensible = js_object_is_extensible(ctx, o);
    if (extensible) return extensible < 0 ? JS_EXCEPTION : JS_FALSE;
    JSValue keys = js_own_keys(ctx, o);
    if (js_is_exception(keys)) return keys;
    JSValueArray *list = (JSValueArray *)js_as_cell(keys);
    for (uint32_t i = 0; i < list->cell.aux; i++) {
        JSPropertyDescriptor d;
        int r = js_get_own_property(ctx, o, list->values[i], &d);
        if (r < 0) return JS_EXCEPTION;
        if (!r) continue;
        if (d.attrs & JS_PROP_CONFIGURABLE) return JS_FALSE;
        if (frozen && (d.has & JS_DESC_VALUE) && (d.attrs & JS_PROP_WRITABLE)) return JS_FALSE;
    }
    js_keep_alive(keys);
    return JS_TRUE;
}

CORE(object_freeze) {
    UNUSED_ARGS;
    if (js_is_object(ARG(0)) && js_freeze(ctx, js_as_object(ARG(0))) < 0) return JS_EXCEPTION;
    return ARG(0);
}

CORE(object_seal) {
    UNUSED_ARGS;
    if (js_is_object(ARG(0)) && seal(ctx, js_as_object(ARG(0))) < 0) return JS_EXCEPTION;
    return ARG(0);
}

CORE(object_is_frozen) {
    UNUSED_ARGS;
    return test_integrity(ctx, ARG(0), true);
}

CORE(object_is_sealed) {
    UNUSED_ARGS;
    return test_integrity(ctx, ARG(0), false);
}

/* Object.getOwnPropertyDescriptors (§20.1.2.9) */
CORE(object_get_own_property_descriptors) {
    UNUSED_ARGS;
    JSValue v = to_object_or_throw(ctx, ARG(0));
    if (js_is_exception(v)) return v;
    JSValue result = js_new_object(ctx);
    if (js_is_string(v)) {
        JSValue names = own_string_keys(ctx, v, false);
        if (js_is_exception(names)) return names;
        for (uint32_t i = 0; i < js_array_length(js_as_object(names)); i++) {
            JSValue key = js_to_property_key(ctx, js_get_elem(ctx, names, js_index_key(i)));
            JSPropertyDescriptor d;
            if (js_is_exception(key) || own_property_of(ctx, v, key, &d) < 0) return JS_EXCEPTION;
            if (create_data_property(ctx, result, key, from_descriptor(ctx, &d)) < 0) return JS_EXCEPTION;
        }
        return result;
    }
    if (!js_is_object(v)) return result;
    JSValue keys = js_own_keys(ctx, js_as_object(v));
    if (js_is_exception(keys)) return keys;
    JSValueArray *list = (JSValueArray *)js_as_cell(keys);
    for (uint32_t i = 0; i < list->cell.aux; i++) {
        JSPropertyDescriptor d;
        int r = js_get_own_property(ctx, js_as_object(v), list->values[i], &d);
        if (r < 0) return JS_EXCEPTION;
        if (!r) continue;
        JSValue desc = from_descriptor(ctx, &d);
        if (js_is_exception(desc) || create_data_property(ctx, result, list->values[i], desc) < 0) return JS_EXCEPTION;
    }
    js_keep_alive(keys);
    return result;
}

/* Object.groupBy(items, callback) (§20.1.2.12): a null-prototype object of arrays. */
CORE(object_group_by) {
    UNUSED_ARGS;
    JSValue items = ARG(0), callback = ARG(1);
    if (js_is_nullish(items)) return js_throw_type_error(ctx, "Object.groupBy requires an iterable");
    if (!js_is_callable(callback)) return js_throw_type_error(ctx, "Object.groupBy: the callback is not a function");
    JSValue groups = js_new_object_proto(ctx, JS_NULL, JS_DEFAULT_INLINE_SLOTS);
    JSValue rec = js_iter_start(ctx, items);
    if (js_is_exception(rec)) return rec;
    for (double k = 0;; k++) {
        JSValue v = js_iter_next(ctx, rec);
        if (js_is_exception(v)) return v;
        if (js_is_empty(v)) return groups;
        JSValue args[2] = { v, js_number(k) };
        JSValue key = js_call(ctx, callback, JS_UNDEFINED, 2, args);
        if (!js_is_exception(key)) key = js_to_property_key(ctx, key);
        if (js_is_exception(key)) {
            js_iter_close_throw(ctx, rec);
            return JS_EXCEPTION;
        }
        JSValue group = js_get(ctx, js_as_object(groups), key, groups);
        if (js_is_undefined(group)) {
            group = js_new_array(ctx, 0);
            if (create_data_property(ctx, groups, key, group) < 0) return JS_EXCEPTION;
        }
        if (js_is_exception(group) || js_array_push(ctx, js_as_object(group), v) < 0) return JS_EXCEPTION;
    }
}

/* Object.hasOwn(o, key) (§20.1.2.13) */
CORE(object_has_own) {
    UNUSED_ARGS;
    JSValue v = to_object_or_throw(ctx, ARG(0));
    if (js_is_exception(v)) return v;
    JSValue key = js_to_property_key(ctx, ARG(1));
    if (js_is_exception(key)) return key;
    JSPropertyDescriptor d;
    int r = own_property_of(ctx, v, key, &d);
    return r < 0 ? JS_EXCEPTION : js_bool(r);
}

/* Object.is (§20.1.2.14): SameValue. */
CORE(object_is) {
    UNUSED_ARGS;
    return js_bool(js_same_value(ctx, ARG(0), ARG(1)));
}

/* ---- Object.prototype: toLocaleString, __proto__ and the legacy accessor methods (Annex B) ---- */

CORE(object_proto_to_locale_string) {
    UNUSED_ARGS;
    JSValue f = js_get_value(ctx, this_val, JS_ATOM(toString));
    if (js_is_exception(f)) return f;
    return js_call(ctx, f, this_val, 0, NULL);
}

CORE(object_proto_get_proto) {
    UNUSED_ARGS;
    return proto_of_value(ctx, this_val);
}

CORE(object_proto_set_proto) {
    UNUSED_ARGS;
    JSValue proto = ARG(0);
    if (js_is_nullish(this_val)) return js_throw_type_error(ctx, "Object.prototype.__proto__ called on null or undefined");
    if ((!js_is_object(proto) && !js_is_null(proto)) || !js_is_object(this_val)) return JS_UNDEFINED;
    int r = js_set_prototype_of(ctx, js_as_object(this_val), proto);
    if (r < 0) return JS_EXCEPTION;
    if (!r) return js_throw_type_error(ctx, "Object.prototype.__proto__ setter failed");
    return JS_UNDEFINED;
}

static JSValue define_legacy_accessor(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, bool getter) {
    if (js_is_nullish(this_val)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    if (!js_is_callable(ARG(1))) return js_throw_type_error(ctx, getter ? "Object.prototype.__defineGetter__: Expecting function" : "Object.prototype.__defineSetter__: Expecting function");
    JSValue key = js_to_property_key(ctx, ARG(0));
    if (js_is_exception(key)) return key;
    if (!js_is_object(this_val)) return JS_UNDEFINED;
    JSPropertyDescriptor d = { (uint8_t)((getter ? JS_DESC_GET : JS_DESC_SET) | JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE),
                               JS_PROP_ENUMERABLE | JS_PROP_CONFIGURABLE, JS_UNDEFINED, getter ? ARG(1) : JS_UNDEFINED, getter ? JS_UNDEFINED : ARG(1) };
    return js_define_own_property(ctx, js_as_object(this_val), key, &d, true) < 0 ? JS_EXCEPTION : JS_UNDEFINED;
}

static JSValue lookup_legacy_accessor(JSContext *ctx, JSValue this_val, uint32_t argc, const JSValue *argv, bool getter) {
    if (js_is_nullish(this_val)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    JSValue key = js_to_property_key(ctx, ARG(0));
    if (js_is_exception(key)) return key;
    for (JSValue o = js_is_object(this_val) ? this_val : proto_of_value(ctx, this_val); js_is_object(o); o = js_object_get_prototype_of(ctx, js_as_object(o))) {
        JSPropertyDescriptor d;
        int r = js_get_own_property(ctx, js_as_object(o), key, &d);
        if (r < 0) return JS_EXCEPTION;
        if (r) return (d.has & JS_DESC_VALUE) ? JS_UNDEFINED : getter ? d.get : d.set;
    }
    return JS_UNDEFINED;
}

CORE(object_proto_define_getter) {
    UNUSED_ARGS;
    return define_legacy_accessor(ctx, this_val, argc, argv, true);
}

CORE(object_proto_define_setter) {
    UNUSED_ARGS;
    return define_legacy_accessor(ctx, this_val, argc, argv, false);
}

CORE(object_proto_lookup_getter) {
    UNUSED_ARGS;
    return lookup_legacy_accessor(ctx, this_val, argc, argv, true);
}

CORE(object_proto_lookup_setter) {
    UNUSED_ARGS;
    return lookup_legacy_accessor(ctx, this_val, argc, argv, false);
}

/* ---- Function.prototype (§20.2.3) --------------------------------------------------------------- */

JSValue js_function_proto_call(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    if (!js_is_callable(this_val)) return js_throw_type_error(ctx, "Function.prototype.call called on a non-function");
    return js_call(ctx, this_val, ARG(0), argc > 1 ? argc - 1 : 0, argv + (argc > 1 ? 1 : argc));
}

/* CreateListFromArrayLike (§7.3.20), into a GC-visible array. */
static JSValueArray *list_from_array_like(JSContext *ctx, JSValue v) {
    if (!js_is_object(v)) {
        js_discard(js_throw_type_error(ctx, "CreateListFromArrayLike called on non-object"));
        return NULL;
    }
    double len;
    if (js_length_of_array_like(ctx, v, &len) < 0) return NULL;
    if (len > 65535) {
        js_discard(js_throw_range_error(ctx, "Maximum call stack size exceeded"));  /* V8's limit on apply */
        return NULL;
    }
    JSValueArray *list = js_alloc_value_array(ctx, (uint32_t)len);
    for (uint32_t i = 0; i < (uint32_t)len; i++) {
        JSValue x = js_get_value(ctx, v, js_index_key(i));
        if (js_is_exception(x)) return NULL;
        js_store(ctx, &list->cell, &list->values[i], x);
    }
    return list;
}

JSValueArray *js_list_from_array_like(JSContext *ctx, JSValue v) { return list_from_array_like(ctx, v); }

JSValue js_function_proto_apply(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, JSValue new_target) {
    UNUSED_ARGS;
    if (!js_is_callable(this_val)) return js_throw_type_error(ctx, "Function.prototype.apply was called on a non-function");
    if (js_is_nullish(ARG(1))) return js_call(ctx, this_val, ARG(0), 0, NULL);
    /* a short dense array without holes (emit's arguments): its elements are its own data
     * properties, so reading them can't run code. Copied, as the callee may change the array. */
    if (js_is_array(ARG(1))) {
        JSObject *a = js_as_object(ARG(1));
        JSElements *e = a->elements;
        uint32_t n = js_array_length(a);
        JSValue args[8];
        if (e->kind == JS_ELEMENTS_DENSE && e->length == n && n <= 8) {
            uint32_t i = 0;
            while (i < n && !js_is_empty(e->data[i])) args[i] = e->data[i], i++;
            if (i == n) return js_call(ctx, this_val, ARG(0), n, args);
        }
    }
    JSValueArray *list = list_from_array_like(ctx, ARG(1));
    if (!list) return JS_EXCEPTION;
    JSValue r = js_call(ctx, this_val, ARG(0), list->cell.aux, list->values);
    JSValue held = js_cell(&list->cell);
    js_keep_alive(held);
    return r;
}

BUILTIN(function_proto_bind) {
    UNUSED_ARGS;
    if (!js_is_callable(this_val)) return js_throw_type_error(ctx, "Bind must be called on a function");
    return js_bind_function(ctx, this_val, ARG(0), argc > 1 ? argc - 1 : 0, argc > 1 ? argv + 1 : NULL);
}

BUILTIN(function_proto_to_string) {
    UNUSED_ARGS;
    if (!js_is_callable(this_val)) return js_throw_type_error(ctx, "Function.prototype.toString requires that 'this' be a Function");
    /* compiled functions: their exact source text (§20.2.3.5 step 2), a slice of the module's */
    const JSFunctionInfo *info = js_as_function(this_val)->info;
    if (info && info->source_text) {
        JSValue text = js_cell((JSCell *)info->source_text);
        return js_substring(ctx, text, info->source_start, info->source_start + info->source_length);
    }
    /* builtins, bound functions and proxies: NativeFunction syntax */
    if ((js_as_function(this_val)->flags & JS_FN_BOUND) || !js_is_empty(js_proxy_target(this_val))) return cstr(ctx, "function () { [native code] }");
    JSValue name = js_get_value(ctx, this_val, JS_ATOM(name));
    if (js_is_exception(name)) return JS_EXCEPTION;
    JSValue s = cstr(ctx, "function ");
    if (js_is_string(name)) s = js_concat(ctx, s, name);
    if (js_is_exception(s)) return JS_EXCEPTION;
    return js_concat(ctx, s, cstr(ctx, "() { [native code] }"));
}

/* Function(...) compiles source text at runtime: that needs eval, a non-goal. */
BUILTIN(function_ctor) {
    UNUSED_ARGS;
    return js_throw_type_error(ctx, "Function() constructor needs eval, which isn't supported");
}

/* %GeneratorFunction%, %AsyncFunction% and %AsyncGeneratorFunction% (§27.3.1, §27.7.1, §27.4.1): a
 * kind of function's constructor, which compiles source text as Function() does, so throws as it
 * does. Not globals: reached as a function's prototype's constructor, as `instanceof` needs. */
#define FUNCTION_KIND_CTOR(fn, name)                                                                 \
    BUILTIN(fn) {                                                                                    \
        UNUSED_ARGS;                                                                                 \
        return js_throw_type_error(ctx, name "() constructor needs eval, which isn't supported");    \
    }
FUNCTION_KIND_CTOR(generator_function_ctor, "GeneratorFunction")
FUNCTION_KIND_CTOR(async_function_ctor, "AsyncFunction")
FUNCTION_KIND_CTOR(async_generator_function_ctor, "AsyncGeneratorFunction")

/* The constructor of a kind of function, its prototype `proto`: [[Prototype]] %Function%, its
 * `prototype` fixed, proto's `constructor` it (not writable, configurable). */
void js_define_function_kind_ctor(JSContext *ctx, JSValue proto, int kind) {
    static const struct { const char *name; JSNativeFn fn; } KINDS[] = {
        { "GeneratorFunction", generator_function_ctor },
        { "AsyncFunction", async_function_ctor },
        { "AsyncGeneratorFunction", async_generator_function_ctor },
    };
    JSValue ctor = js_new_native(ctx, KINDS[kind].fn, js_atom_from_cstr(ctx, KINDS[kind].name), 1, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    JSValue function = js_get_value(ctx, ctx->intrinsics[JS_INTRINSIC_FUNCTION_PROTOTYPE], JS_ATOM(constructor));
    if (js_is_object(function) && js_set_prototype_of(ctx, js_as_object(ctor), function) < 0) js_discard(js_take_exception(ctx));
    js_define_data(ctx, js_as_object(ctor), JS_ATOM(prototype), proto, 0);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), ctor, JS_PROP_CONFIGURABLE);
}

/* eval (§19.2.1): a non-string comes back as is; source text would need compiling at run time.
 * Present so code can reference it (get-intrinsic lists %eval%). */
CORE(global_eval) {
    UNUSED_ARGS;
    if (!js_is_string(ARG(0))) return ARG(0);
    return js_throw_type_error(ctx, "eval() isn't supported: code can't be compiled at run time");
}

/* A relative index argument (slice, indexOf's fromIndex): clamped to 0..len. */
static int relative_index(JSContext *ctx, JSValue v, double len, double dflt, double *out) {
    if (js_is_undefined(v)) {
        *out = dflt;
        return 0;
    }
    double d;
    if (to_integer(ctx, &d, v) < 0) return -1;
    *out = d < 0 ? fmax(len + d, 0) : fmin(d, len);
    return 0;
}

/* ---- Number and Boolean (§21.1, §20.3) ---------------------------------------------------------- */

BUILTIN(boolean_ctor) {
    UNUSED_ARGS;
    JSValue b = js_bool(js_truthy(ARG(0)));
    if (js_is_undefined(new_target)) return b;
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_BOOLEAN_PROTOTYPE);
    return js_is_exception(proto) ? proto : js_new_wrapper(ctx, b, proto);
}

BUILTIN(boolean_proto_to_string) {
    UNUSED_ARGS;
    JSValue b = js_this_primitive(this_val, js_is_bool);
    if (js_is_empty(b)) return js_throw_type_error(ctx, "Boolean.prototype.toString requires that 'this' be a Boolean");
    return js_as_bool(b) ? JS_ATOM(true) : JS_ATOM(false);
}

BUILTIN(boolean_proto_value_of) {
    UNUSED_ARGS;
    JSValue b = js_this_primitive(this_val, js_is_bool);
    if (js_is_empty(b)) return js_throw_type_error(ctx, "Boolean.prototype.valueOf requires that 'this' be a Boolean");
    return b;
}

/* ---- Realm --------------------------------------------------------------------------------------- */

/* A constructor with its prototype, linked both ways, defined on the global object. */
static JSValue define_constructor(JSContext *ctx, JSObject *global, const char *name, JSNativeFn fn, uint32_t length, JSValue proto) {
    JSValue key = js_atom_from_cstr(ctx, name);
    JSValue ctor = js_new_native(ctx, fn, key, length, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    js_define_data(ctx, js_as_object(ctor), JS_ATOM(prototype), proto, 0);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), ctor, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    js_define_data(ctx, global, key, ctor, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return ctor;
}

/* Function.prototype[@@hasInstance](V): OrdinaryHasInstance(this, V) */
BUILTIN(function_proto_has_instance) {
    (void)callee, (void)new_target;
    return js_ordinary_has_instance(ctx, this_val, ARG(0));
}

void js_builtins_realm_init(JSContext *ctx, JSObject *global) {
    JSValue *in = ctx->intrinsics;

    JSValue object = define_constructor(ctx, global, "Object", object_ctor, 1, in[JS_INTRINSIC_OBJECT_PROTOTYPE]);
    static const JSBuiltin function_proto[] = {
        JS_BUILTIN_FN("call", js_function_proto_call, 1),
        JS_BUILTIN_FN("apply", js_function_proto_apply, 2),
        JS_BUILTIN_FN("bind", function_proto_bind, 1),
        JS_BUILTIN_FN("toString", function_proto_to_string, 0),
    };
    js_define_builtins(ctx, js_as_object(in[JS_INTRINSIC_FUNCTION_PROTOTYPE]), function_proto, JS_COUNTOF(function_proto));
    /* Function.prototype[@@hasInstance] (§20.2.3.6): not writable, enumerable or configurable */
    JSValue has_instance = js_new_native(ctx, function_proto_has_instance, js_new_string_cstr(ctx, "[Symbol.hasInstance]"), 1, JS_FN_STRICT);
    in[JS_INTRINSIC_FUNCTION_HAS_INSTANCE] = has_instance;
    js_define_data(ctx, js_as_object(in[JS_INTRINSIC_FUNCTION_PROTOTYPE]), JS_SYMBOL(hasInstance), has_instance, 0);
    define_constructor(ctx, global, "Function", function_ctor, 1, in[JS_INTRINSIC_FUNCTION_PROTOTYPE]);

    JSValue core[JS_CORE_TARGET_COUNT];
    core[JS_CORE_OBJECT] = object;
    core[JS_CORE_OBJECT_PROTO] = in[JS_INTRINSIC_OBJECT_PROTOTYPE];
    core[JS_CORE_ARRAY] = js_array_realm_init(ctx, global, define_constructor);  /* array.c */
    core[JS_CORE_ARRAY_PROTO] = in[JS_INTRINSIC_ARRAY_PROTOTYPE];
    core[JS_CORE_STRING] = js_string_realm_init(ctx, global, define_constructor);  /* string_builtins.c */
    core[JS_CORE_STRING_PROTO] = in[JS_INTRINSIC_STRING_PROTOTYPE];
    core[JS_CORE_NUMBER] = js_number_realm_init(ctx, global, define_constructor);  /* number.c */
    core[JS_CORE_NUMBER_PROTO] = in[JS_INTRINSIC_NUMBER_PROTOTYPE];
    core[JS_CORE_GLOBAL] = in[JS_INTRINSIC_GLOBAL_OBJECT];
    /* the methods the program names (js_core.def, in V8's order) */
    js_install_core(ctx, core);
    js_array_realm_finish(ctx);

    define_constructor(ctx, global, "Boolean", boolean_ctor, 1, in[JS_INTRINSIC_BOOLEAN_PROTOTYPE]);
    static const JSBuiltin boolean_proto[] = {
        JS_BUILTIN_FN("toString", boolean_proto_to_string, 0),
        JS_BUILTIN_FN("valueOf", boolean_proto_value_of, 0),
    };
    js_define_builtins(ctx, js_as_object(in[JS_INTRINSIC_BOOLEAN_PROTOTYPE]), boolean_proto, JS_COUNTOF(boolean_proto));
}

/* ---- Shared with the other built-in files (builtins_util.h) -------------------------------------- */

int js_relative_index(JSContext *ctx, JSValue v, double len, double dflt, double *out) {
    return relative_index(ctx, v, len, dflt, out);
}

int js_create_data_property(JSContext *ctx, JSValue o, JSValue key, JSValue v) {
    return create_data_property(ctx, o, key, v);
}

JSValue js_get_own_enumerable_string_keys(JSContext *ctx, JSValue v) {
    return own_string_keys(ctx, v, true);
}

JSValue js_object_to_string_tag(JSContext *ctx, JSValue v) {
    return js_core_object_proto_to_string(ctx, JS_UNDEFINED, v, 0, NULL, JS_UNDEFINED);
}

