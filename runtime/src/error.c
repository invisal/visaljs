/* Error objects and constructors (ECMAScript §20.5). */
#include "js_error.h"

#include "internal.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "jscontext.h"

/* Ordinary behavior; the class itself is the [[ErrorData]] internal slot. `stack` keeps what
 * the `stack` accessor returns: EMPTY until it is first read (V8 formats it then). */
typedef struct JSError {
    JSObject obj;
    JSValue  stack;
} JSError;

static void error_visit(JSCell *cell, JSTracer *trc) {
    js_trace_value(trc, ((JSError *)cell)->stack);
}

const JSClass js_class_error = { "Error", sizeof(JSError), NULL, NULL, NULL, NULL, error_visit, NULL, NULL };

static JSValue error_name(JSErrorKind kind) {
    switch (kind) {
    case JS_EVAL_ERROR: return JS_ATOM(EvalError);
    case JS_RANGE_ERROR: return JS_ATOM(RangeError);
    case JS_REFERENCE_ERROR: return JS_ATOM(ReferenceError);
    case JS_SYNTAX_ERROR: return JS_ATOM(SyntaxError);
    case JS_TYPE_ERROR: return JS_ATOM(TypeError);
    case JS_URI_ERROR: return JS_ATOM(URIError);
    case JS_AGGREGATE_ERROR: return JS_ATOM(AggregateError);
    default: return JS_ATOM(Error);
    }
}

/* ---- `stack` (not in the spec) -------------------------------------------------------- */

/* `stack`, as V8 has it: an own, non-enumerable accessor installed first, whose getter formats
 * "Name: message" on the first read, with the name and message the error has then (a subclass
 * that sets this.name in its constructor shows it), and keeps it; the setter replaces it. Only
 * that first line: frames aren't recorded, so creating an error costs no
 * stack walk. */
static JSValue stack_get(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                         const JSValue *argv, JSValue new_target) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    if (!js_is_error(this_val)) return JS_UNDEFINED;
    JSError *e = (JSError *)js_as_object(this_val);
    if (js_is_empty(e->stack)) {
        JSValue line = js_error_to_string(ctx, this_val);
        if (js_is_exception(line)) return line;
        js_store(ctx, &e->obj.cell, &e->stack, line);
    }
    return e->stack;
}

static JSValue stack_set(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,
                         const JSValue *argv, JSValue new_target) {
    (void)callee, (void)new_target;
    if (js_is_error(this_val)) {
        JSError *e = (JSError *)js_as_object(this_val);
        js_store(ctx, &e->obj.cell, &e->stack, argc ? argv[0] : JS_UNDEFINED);
    }
    return JS_UNDEFINED;
}

static JSObject *error_with_proto(JSContext *ctx, JSValue proto) {
    JSError *e = (JSError *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &js_class_error, proto, JS_DEFAULT_INLINE_SLOTS));
    js_init_slot(&e->stack, JS_EMPTY);
    JSPropertyDescriptor d = { JS_DESC_GET | JS_DESC_SET | JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE, JS_PROP_CONFIGURABLE,
                               JS_UNDEFINED, ctx->intrinsics[JS_INTRINSIC_ERROR_STACK_GET], ctx->intrinsics[JS_INTRINSIC_ERROR_STACK_SET] };
    int r = js_define_own_property(ctx, &e->obj, JS_ATOM(stack), &d, false);  /* a new object: can't fail */
    (void)r;
    return &e->obj;
}

JSValue js_new_error(JSContext *ctx, JSErrorKind kind, JSValue message) {
    JSObject *e = error_with_proto(ctx, ctx->intrinsics[JS_INTRINSIC_ERROR_PROTOTYPE + kind]);
    if (!js_is_undefined(message)) js_define_data(ctx, e, JS_ATOM(message), message, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return js_object_value(e);
}

/* ---- Constructors (§20.5.1.1, §20.5.6.1) --------------------------------------- */

/* IterableToList (§7.4.12) as an array. */
static JSValue iterable_to_array(JSContext *ctx, JSValue iterable) {
    JSValue rec = js_iter_start(ctx, iterable);
    if (js_is_exception(rec)) return JS_EXCEPTION;
    JSValue list = js_new_array(ctx, 0);
    for (;;) {
        JSValue v = js_iter_next(ctx, rec);
        if (js_is_exception(v)) return JS_EXCEPTION;
        if (js_is_empty(v)) return list;
        if (js_array_push(ctx, js_as_object(list), v) < 0) return JS_EXCEPTION;
    }
}

/* Error(message, options) and the native errors: the same with or without `new`.
 * AggregateError(errors, message, options) takes the errors first. */
static JSValue construct_error(JSContext *ctx, JSErrorKind kind, JSValue callee,
                               uint32_t argc, const JSValue *argv, JSValue new_target) {
    if (js_is_undefined(new_target)) new_target = callee;
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_ERROR_PROTOTYPE + kind);
    if (js_is_exception(proto)) return JS_EXCEPTION;
    JSValue errors = JS_UNDEFINED;
    if (kind == JS_AGGREGATE_ERROR) {
        if (argc > 0) {
            errors = argv[0];
            argc--;
            argv++;
        }
    }
    JSObject *o = error_with_proto(ctx, proto);
    JSValue msg = JS_UNDEFINED;
    if (argc > 0 && !js_is_undefined(argv[0])) {
        msg = js_to_string(ctx, argv[0]);
        if (js_is_exception(msg)) return JS_EXCEPTION;
        js_define_data(ctx, o, JS_ATOM(message), msg, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    }
    /* InstallErrorCause (§20.5.8.1) */
    if (argc > 1 && js_is_object(argv[1])) {
        JSObject *options = js_as_object(argv[1]);
        int has = js_has_property(ctx, options, JS_ATOM(cause));
        if (has < 0) return JS_EXCEPTION;
        if (has) {
            JSValue cause = js_get(ctx, options, JS_ATOM(cause), argv[1]);
            if (js_is_exception(cause)) return JS_EXCEPTION;
            js_define_data(ctx, o, JS_ATOM(cause), cause, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
        }
    }
    if (kind == JS_AGGREGATE_ERROR) {
        JSValue list = iterable_to_array(ctx, errors);
        if (js_is_exception(list)) return JS_EXCEPTION;
        js_define_data(ctx, o, js_atom_from_cstr(ctx, "errors"), list, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    }
    return js_object_value(o);
}

#define ERROR_CONSTRUCTOR(fn, kind)                                                          \
    static JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc,       \
                      const JSValue *argv, JSValue new_target) {                             \
        (void)this_val;                                                                      \
        return construct_error(ctx, kind, callee, argc, argv, new_target);                   \
    }

ERROR_CONSTRUCTOR(error_ctor, JS_ERROR)
ERROR_CONSTRUCTOR(eval_error_ctor, JS_EVAL_ERROR)
ERROR_CONSTRUCTOR(range_error_ctor, JS_RANGE_ERROR)
ERROR_CONSTRUCTOR(reference_error_ctor, JS_REFERENCE_ERROR)
ERROR_CONSTRUCTOR(syntax_error_ctor, JS_SYNTAX_ERROR)
ERROR_CONSTRUCTOR(type_error_ctor, JS_TYPE_ERROR)
ERROR_CONSTRUCTOR(uri_error_ctor, JS_URI_ERROR)
ERROR_CONSTRUCTOR(aggregate_error_ctor, JS_AGGREGATE_ERROR)

static const JSNativeFn constructors[JS_ERROR_KIND_COUNT] = {
    error_ctor, eval_error_ctor, range_error_ctor, reference_error_ctor,
    syntax_error_ctor, type_error_ctor, uri_error_ctor, aggregate_error_ctor,
};

/* ---- Error.prototype.toString (§20.5.3.4) ------------------------------------------- */

/* ToString(o[key]), or `fallback` when it's undefined. */
static JSValue string_property(JSContext *ctx, JSObject *o, JSValue key, JSValue fallback) {
    JSValue v = js_get(ctx, o, key, js_object_value(o));
    if (js_is_exception(v)) return JS_EXCEPTION;
    return js_is_undefined(v) ? fallback : js_to_string(ctx, v);
}

JSValue js_error_to_string(JSContext *ctx, JSValue this_val) {
    if (!js_is_object(this_val))
        return js_throw_type_error(ctx, "Error.prototype.toString requires that 'this' be an Object");
    JSObject *o = js_as_object(this_val);
    JSValue name = string_property(ctx, o, JS_ATOM(name), JS_ATOM(Error));
    if (js_is_exception(name)) return JS_EXCEPTION;
    JSValue msg = string_property(ctx, o, JS_ATOM(message), js_empty_string());
    if (js_is_exception(msg)) return JS_EXCEPTION;
    if (js_string_length(name) == 0) return msg;
    if (js_string_length(msg) == 0) return name;
    JSValue head = js_concat(ctx, name, js_new_string_cstr(ctx, ": "));
    if (js_is_exception(head)) return JS_EXCEPTION;
    return js_concat(ctx, head, msg);
}

static JSValue error_proto_to_string(JSContext *ctx, JSValue callee, JSValue this_val,
                                     uint32_t argc, const JSValue *argv, JSValue new_target) {
    (void)callee, (void)argc, (void)argv, (void)new_target;
    return js_error_to_string(ctx, this_val);
}

/* ---- Error.captureStackTrace and Error.stackTraceLimit (V8's; not in the spec) ------------- */

/* Error.captureStackTrace(target, constructorOpt): V8's way to give any object a `stack`. Frames
 * aren't recorded, so it is the first line, as an error's own: "Name:
 * message" from the target. With Error.prepareStackTrace set (depd does it), that function makes
 * the value from the target and the call sites, which are Error.stackTraceLimit placeholders (up
 * to 10) that know no file, line or function. */
static JSValue capture_stack_trace(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv,
                                   JSValue new_target) {
    (void)callee, (void)this_val, (void)new_target;
    JSValue target = argc ? argv[0] : JS_UNDEFINED;
    if (!js_is_object(target)) return js_throw_type_error(ctx, "invalid_argument");
    JSValue error_ctor = ctx->intrinsics[JS_INTRINSIC_ERROR];
    JSValue prepare = js_get_value(ctx, error_ctor, js_atom_from_cstr(ctx, "prepareStackTrace"));
    if (js_is_exception(prepare)) return prepare;
    JSValue stack;
    if (js_is_callable(prepare)) {
        JSValue limit = js_get_value(ctx, error_ctor, js_atom_from_cstr(ctx, "stackTraceLimit"));
        if (js_is_exception(limit)) return limit;
        double n = js_is_number(limit) ? js_as_number(limit) : 0;
        uint32_t count = n > 10 ? 10 : n >= 1 ? (uint32_t)n : 0;
        JSValue sites = js_new_array(ctx, count);
        for (uint32_t i = 0; i < count; i++) {
            JSValue site = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_CALL_SITE_PROTOTYPE], 0);
            if (js_array_append(ctx, sites, site) < 0) return JS_EXCEPTION;
        }
        JSValue args[2] = { target, sites };
        stack = js_call(ctx, prepare, error_ctor, 2, args);
    } else {
        stack = js_error_to_string(ctx, target);
    }
    if (js_is_exception(stack)) return stack;
    if (js_is_error(target)) {  /* an error keeps its accessor; this is what it now returns */
        JSError *e = (JSError *)js_as_object(target);
        js_store(ctx, &e->obj.cell, &e->stack, stack);
        return JS_UNDEFINED;
    }
    JSPropertyDescriptor d = { JS_DESC_VALUE | JS_DESC_WRITABLE | JS_DESC_ENUMERABLE | JS_DESC_CONFIGURABLE,
                               JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE, stack, JS_UNDEFINED, JS_UNDEFINED };
    if (js_define_own_property(ctx, js_as_object(target), JS_ATOM(stack), &d, false) != 1)
        return js_throw_type_error(ctx, "Cannot define property stack, object is not extensible");
    return JS_UNDEFINED;
}

/* The placeholder call sites' methods (V8's CallSite): nothing is known about a frame */
#define CALL_SITE(fn, result)                                                                                   \
    static JSValue fn(JSContext *ctx, JSValue callee, JSValue this_val, uint32_t argc, const JSValue *argv, \
                      JSValue new_target) {                                                                 \
        (void)ctx, (void)callee, (void)this_val, (void)argc, (void)argv, (void)new_target;                  \
        return result;                                                                                      \
    }
CALL_SITE(site_undefined, JS_UNDEFINED)
CALL_SITE(site_null, JS_NULL)
CALL_SITE(site_false, JS_FALSE)
CALL_SITE(site_true, JS_TRUE)
CALL_SITE(site_zero, js_int32(0))
CALL_SITE(site_empty, js_empty_string())
CALL_SITE(site_to_string, js_new_string_cstr(ctx, "<anonymous>"))

static void call_site_realm_init(JSContext *ctx, JSValue error_ctor) {
    JSObject *ctor = js_as_object(error_ctor);
    js_define_method(ctx, ctor, "captureStackTrace", capture_stack_trace, 2);
    js_define_data(ctx, ctor, js_atom_from_cstr(ctx, "stackTraceLimit"), js_int32(10), JS_PROP_DEFAULT);
    JSValue proto = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE], 0);
    ctx->intrinsics[JS_INTRINSIC_CALL_SITE_PROTOTYPE] = proto;
    static const struct { const char *name; JSNativeFn fn; } METHODS[] = {
        { "getColumnNumber", site_null }, { "getEnclosingColumnNumber", site_null }, { "getEnclosingLineNumber", site_null },
        { "getEvalOrigin", site_undefined }, { "getFileName", site_undefined }, { "getFunction", site_undefined },
        { "getFunctionName", site_null }, { "getLineNumber", site_null }, { "getMethodName", site_null }, { "getPosition", site_zero },
        { "getPromiseIndex", site_null }, { "getScriptNameOrSourceURL", site_undefined }, { "getScriptHash", site_empty },
        { "getThis", site_undefined }, { "getTypeName", site_null }, { "isAsync", site_false }, { "isConstructor", site_false },
        { "isEval", site_false }, { "isNative", site_false }, { "isPromiseAll", site_false }, { "isToplevel", site_true },
        { "toString", site_to_string },
    };
    for (size_t i = 0; i < sizeof METHODS / sizeof METHODS[0]; i++) js_define_method(ctx, js_as_object(proto), METHODS[i].name, METHODS[i].fn, 0);
}

/* ---- Realm ------------------------------------------------------------------------ */

/* %Error% and the native errors, with their prototypes, defined on the global object. */
void js_error_realm_init(JSContext *ctx, JSObject *global) {
    ctx->intrinsics[JS_INTRINSIC_ERROR_STACK_GET] = js_new_native(ctx, stack_get, js_atom_from_cstr(ctx, "stack"), 0, JS_FN_STRICT);
    ctx->intrinsics[JS_INTRINSIC_ERROR_STACK_SET] = js_new_native(ctx, stack_set, js_atom_from_cstr(ctx, "stack"), 1, JS_FN_STRICT);
    JSValue error_ctor_value = JS_UNDEFINED;
    for (int kind = 0; kind < JS_ERROR_KIND_COUNT; kind++) {
        JSValue name = error_name((JSErrorKind)kind);
        /* Error.prototype is an ordinary object (§20.5.3); the others inherit from it */
        JSValue parent = kind == JS_ERROR ? ctx->intrinsics[JS_INTRINSIC_OBJECT_PROTOTYPE]
                                          : ctx->intrinsics[JS_INTRINSIC_ERROR_PROTOTYPE];
        JSValue proto = js_new_object_proto(ctx, parent, JS_DEFAULT_INLINE_SLOTS);
        ctx->intrinsics[JS_INTRINSIC_ERROR_PROTOTYPE + kind] = proto;

        JSValue ctor = js_new_native(ctx, constructors[kind], name, kind == JS_AGGREGATE_ERROR ? 2 : 1, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
        if (kind == JS_ERROR) {
            error_ctor_value = ctor;
            ctx->intrinsics[JS_INTRINSIC_ERROR] = ctor;
            call_site_realm_init(ctx, ctor);
        }
        else if (js_set_prototype_of(ctx, js_as_object(ctor), error_ctor_value) != 1) js_fatal("error realm init");
        js_define_data(ctx, js_as_object(ctor), JS_ATOM(prototype), proto, 0);

        JSObject *p = js_as_object(proto);
        const uint8_t attrs = JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE;
        js_define_data(ctx, p, JS_ATOM(constructor), ctor, attrs);
        js_define_data(ctx, p, JS_ATOM(name), name, attrs);
        js_define_data(ctx, p, JS_ATOM(message), js_empty_string(), attrs);
        if (kind == JS_ERROR) js_define_method(ctx, p, "toString", error_proto_to_string, 0);
        js_define_data(ctx, global, name, ctor, attrs);
    }
}
