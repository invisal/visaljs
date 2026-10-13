/* Primitive wrapper objects (§20.3–§22.1 [[BooleanData]], [[NumberData]], [[StringData]],
 * [[SymbolData]]): `new Number(1)`, `Object("ab")`, a sloppy function's boxed `this`.
 *
 * A String wrapper is exotic (§10.4.3): its characters and `length` are own properties that
 * can't change. They're defined when the wrapper is created, read-only and non-configurable, so
 * the ordinary algorithms give the exotic behavior (own keys in order, failed writes and
 * deletes, defineProperty's checks). Wrappers are rare, and short-lived when they aren't. */
#include "internal.h"
#include "js_atoms.h"
#include "js_symbol.h"

typedef struct JSPrimitiveWrapper {
    JSObject obj;
    JSValue  value;   /* the primitive */
} JSPrimitiveWrapper;

static void wrapper_visit(JSCell *c, JSTracer *trc) {
    js_trace_value(trc, ((JSPrimitiveWrapper *)c)->value);
}

const JSClass js_class_primitive_wrapper = { "PrimitiveWrapper", sizeof(JSPrimitiveWrapper), NULL, NULL, NULL, NULL, wrapper_visit, NULL, NULL };

JSValue js_new_wrapper(JSContext *ctx, JSValue prim, JSValue proto) {
    if (!js_is_object(proto)) proto = js_object_value(js_primitive_prototype(ctx, prim));
    JSShape *shape = js_shape_root(ctx, &js_class_primitive_wrapper, proto, JS_DEFAULT_INLINE_SLOTS);
    JSPrimitiveWrapper *w = (JSPrimitiveWrapper *)js_alloc_object(ctx, JS_CELL_OBJECT, shape);
    w->value = prim;
    JSObject *o = &w->obj;
    if (js_is_string(prim)) {
        uint32_t len = js_string_length(prim);
        for (uint32_t i = 0; i < len; i++) {
            JSValue ch = js_substring(ctx, prim, i, i + 1);
            JSPropertyDescriptor d = js_data_descriptor(ch, JS_PROP_ENUMERABLE);
            if (js_define_own_property(ctx, o, js_index_key(i), &d, false) != 1) js_fatal("string wrapper");
        }
        js_define_data(ctx, o, JS_ATOM(length), js_int32((int32_t)len), 0);
    }
    return js_object_value(o);
}

JSValue js_to_object(JSContext *ctx, JSValue v) {
    if (js_is_object(v)) return v;
    if (js_is_nullish(v)) return js_throw_type_error(ctx, "Cannot convert undefined or null to object");
    return js_new_wrapper(ctx, v, JS_UNDEFINED);
}

bool js_is_wrapper(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &js_class_primitive_wrapper;
}

JSValue js_wrapped_value(JSValue v) {
    return ((JSPrimitiveWrapper *)js_as_object(v))->value;
}

JSValue js_this_primitive(JSValue v, bool (*is_type)(JSValue)) {
    if (is_type(v)) return v;
    if (js_is_wrapper(v) && is_type(js_wrapped_value(v))) return js_wrapped_value(v);
    return JS_EMPTY;
}
