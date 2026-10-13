/* Type conversions (ECMAScript §7.1). */
#include "js_convert.h"

#include <math.h>

#include "js_atoms.h"
#include "js_function.h"
#include "js_symbol.h"
#include "jsnum.h"

/* ToPrimitive (§7.1.1): the object's @@toPrimitive if it has one, else OrdinaryToPrimitive
 * (§7.1.1.1): valueOf then toString, or the reverse for strings. */
JSValue js_to_primitive(JSContext *ctx, JSValue v, JSHint hint) {
    JS_ASSERT_NOT_EXC(v);
    if (!js_is_object(v)) return v;
    JSValue exotic = js_get(ctx, js_as_object(v), JS_SYMBOL(toPrimitive), v);
    if (js_is_exception(exotic)) return JS_EXCEPTION;
    if (!js_is_nullish(exotic)) {
        if (!js_is_callable(exotic)) return js_throw_type_error(ctx, "Symbol.toPrimitive is not a function");
        JSValue h = hint == JS_HINT_STRING ? JS_ATOM(string) : hint == JS_HINT_NUMBER ? JS_ATOM(number) : JS_ATOM(default);
        JSValue r = js_call(ctx, exotic, v, 1, &h);
        if (js_is_exception(r)) return JS_EXCEPTION;
        if (js_is_object(r)) return js_throw_type_error(ctx, "Cannot convert object to primitive value");
        return r;
    }
    return js_ordinary_to_primitive(ctx, v, hint);
}

/* OrdinaryToPrimitive (§7.1.1.1): valueOf then toString, or the reverse for strings. */
JSValue js_ordinary_to_primitive(JSContext *ctx, JSValue v, JSHint hint) {
    JSValue order[2] = { JS_ATOM(valueOf), JS_ATOM(toString) };
    if (hint == JS_HINT_STRING) {
        order[0] = JS_ATOM(toString);
        order[1] = JS_ATOM(valueOf);
    }
    for (int i = 0; i < 2; i++) {
        JSValue method = js_get(ctx, js_as_object(v), order[i], v);
        if (js_is_exception(method)) return JS_EXCEPTION;
        if (!js_is_callable(method)) continue;
        JSValue r = js_call(ctx, method, v, 0, NULL);
        if (js_is_exception(r)) return JS_EXCEPTION;
        if (!js_is_object(r)) return r;
    }
    return js_throw_type_error(ctx, "Cannot convert object to primitive value");
}

JSValue js_to_string(JSContext *ctx, JSValue v) {
    JS_ASSERT_NOT_EXC(v);
    if (js_is_string(v)) return v;
    if (js_is_number(v)) return js_number_to_string(ctx, v);
    if (js_is_undefined(v)) return JS_ATOM(undefined);
    if (js_is_null(v)) return JS_ATOM(null);
    if (js_is_bool(v)) return js_as_bool(v) ? JS_ATOM(true) : JS_ATOM(false);
    if (js_is_object(v)) {
        JSValue p = js_to_primitive(ctx, v, JS_HINT_STRING);
        if (js_is_exception(p)) return JS_EXCEPTION;
        return js_to_string(ctx, p);
    }
    if (js_is_symbol(v)) return js_throw_type_error(ctx, "Cannot convert a Symbol value to a string");
    if (js_is_bigint(v)) return ctx->rt->bigint->to_string(ctx, v, 10);
    return js_throw_type_error(ctx, "Cannot convert this value to a string");
}

int js_to_number(JSContext *ctx, double *out, JSValue v) {
    JS_ASSERT_NOT_EXC(v);
    if (js_is_number(v)) *out = js_as_number(v);
    else if (js_is_string(v)) *out = js_str_to_num(js_string_view(ctx, v));
    else if (js_is_undefined(v)) *out = NAN;
    else if (js_is_null(v)) *out = 0;
    else if (js_is_bool(v)) *out = js_as_bool(v);
    else if (js_is_object(v)) {
        JSValue p = js_to_primitive(ctx, v, JS_HINT_NUMBER);
        if (js_is_exception(p)) return -1;
        return js_to_number(ctx, out, p);
    } else {
        js_discard(js_throw_type_error(ctx, js_is_symbol(v)   ? "Cannot convert a Symbol value to a number"
                                            : js_is_bigint(v) ? "Cannot convert a BigInt value to a number"
                                                              : "Cannot convert this value to a number"));
        return -1;
    }
    return 0;
}
