/* util.types' host primitive (node:util/types): what an object is inside, which only the runtime
 * can see — its class, a function's kind, a boxed primitive's type, a typed array's element type.
 * The prelude's is* checks compare the tag; Symbol.toStringTag and prototypes don't change it,
 * as they don't change V8's answers. */
#include <string.h>

#include "internal.h"
#include "js_buffer.h"
#include "js_console.h"
#include "js_error.h"
#include "js_object.h"
#include "js_symbol.h"
#include "jsstring.h"

static const char *const typed_array_names[] = {
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
    "BigInt64Array", "BigUint64Array", "Float16Array", "Float32Array", "Float64Array",
};

/* utilTypeTag(value) → "" for a primitive or an ordinary object; else the object's kind: its
 * class ("Date", "Map Iterator", …), "Proxy", "AsyncFunction", "GeneratorFunction",
 * "AsyncGeneratorFunction", "NumberObject" (and the other boxed primitives), a typed array's
 * constructor name, or "Error" for a native error. */
JSValue js_util_type_tag(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv,
                         JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    JSValue v = argc > 0 ? argv[0] : JS_UNDEFINED;
    if (!js_is_object(v)) return js_new_string_cstr(ctx, "");
    const char *tag = "";
    if (js_is_function(v)) {
        uint32_t flags = js_as_function(v)->flags;
        if (flags & JS_FN_PROXY) tag = "Proxy";
        else if ((flags & JS_FN_ASYNC) && (flags & JS_FN_GENERATOR)) tag = "AsyncGeneratorFunction";
        else if (flags & JS_FN_ASYNC) tag = "AsyncFunction";
        else if (flags & JS_FN_GENERATOR) tag = "GeneratorFunction";
        return js_new_string_cstr(ctx, tag);
    }
    if (js_is_error(v)) return js_new_string_cstr(ctx, "Error");
    if (js_is_wrapper(v)) {
        JSValue p = js_wrapped_value(v);
        tag = js_is_number(p) ? "NumberObject" : js_is_string(p) ? "StringObject" : js_is_bool(p) ? "BooleanObject"
            : js_is_symbol(p) ? "SymbolObject" : "BigIntObject";
        return js_new_string_cstr(ctx, tag);
    }
    const char *cls = js_as_object(v)->shape->cls->name;
    if (strcmp(cls, "TypedArray") == 0) {
        uint8_t type = ((JSTypedArray *)js_as_object(v))->type;
        return js_new_string_cstr(ctx, type < sizeof typed_array_names / sizeof *typed_array_names ? typed_array_names[type] : "");
    }
    if (strcmp(cls, "Object") == 0) return js_new_string_cstr(ctx, "");
    return js_new_string_cstr(ctx, cls);
}
