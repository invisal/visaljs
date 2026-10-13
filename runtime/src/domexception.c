/* DOMException (WebIDL §3.14.1), the domexception component, as Node has it:
 * new DOMException(message, name | { name, cause }), with name, message and code getters on the
 * prototype, the legacy code constants, and Error.prototype as the prototype's prototype. An
 * instance has an own `stack`, "Name: message", which is what V8 captures (no frames, as for
 * every error here). */
#include "js_web.h"

#include <string.h>

#include "builtins_util.h"
#include "internal.h"
#include "js_atoms.h"
#include "js_convert.h"
#include "js_exception.h"
#include "jscontext.h"
#include "jsstring.h"

typedef struct DOMExceptionObject {
    JSObject obj;
    JSValue  name;     /* strings */
    JSValue  message;
} DOMExceptionObject;

static void dom_exception_visit(JSCell *c, JSTracer *trc) {
    js_trace_value(trc, ((DOMExceptionObject *)c)->name);
    js_trace_value(trc, ((DOMExceptionObject *)c)->message);
}

static const JSClass dom_exception_class = { "DOMException", sizeof(DOMExceptionObject), NULL, NULL, NULL, NULL, dom_exception_visit, NULL, NULL };

/* The names with a legacy code (WebIDL's error names table). */
static const struct { const char *name; uint8_t code; } CODES[] = {
    { "IndexSizeError", 1 }, { "HierarchyRequestError", 3 }, { "WrongDocumentError", 4 },
    { "InvalidCharacterError", 5 }, { "NoModificationAllowedError", 7 }, { "NotFoundError", 8 },
    { "NotSupportedError", 9 }, { "InUseAttributeError", 10 }, { "InvalidStateError", 11 },
    { "SyntaxError", 12 }, { "InvalidModificationError", 13 }, { "NamespaceError", 14 },
    { "InvalidAccessError", 15 }, { "TypeMismatchError", 17 }, { "SecurityError", 18 },
    { "NetworkError", 19 }, { "AbortError", 20 }, { "URLMismatchError", 21 },
    { "QuotaExceededError", 22 }, { "TimeoutError", 23 }, { "InvalidNodeTypeError", 24 },
    { "DataCloneError", 25 },
};

static DOMExceptionObject *as_dom_exception(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &dom_exception_class ? (DOMExceptionObject *)js_as_object(v) : NULL;
}

/* A new DOMException with Error.prototype.toString's "name: message" as its own `stack`. */
static JSValue create(JSContext *ctx, JSValue proto, JSValue name, JSValue message) {
    DOMExceptionObject *e = (DOMExceptionObject *)js_alloc_object(ctx, JS_CELL_OBJECT, js_shape_root(ctx, &dom_exception_class, proto, 1));
    js_init_slot(&e->name, name);
    js_init_slot(&e->message, message);
    JSValue v = js_object_value(&e->obj);
    JSValue stack = js_string_length(name) == 0 ? message
                  : js_string_length(message) == 0 ? name
                  : js_concat(ctx, js_concat(ctx, name, js_new_string_cstr(ctx, ": ")), message);
    if (js_is_exception(stack)) return stack;
    js_define_data(ctx, &e->obj, JS_ATOM(stack), stack, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return v;
}

JSValue js_new_dom_exception(JSContext *ctx, const char *name, const char *message) {
    JSValue n = js_new_string_cstr(ctx, name);
    JSValue m = js_new_string_cstr(ctx, message);
    if (js_is_exception(n) || js_is_exception(m)) return JS_EXCEPTION;
    return create(ctx, ctx->intrinsics[JS_INTRINSIC_DOM_EXCEPTION_PROTOTYPE], n, m);
}

JSValue js_throw_dom_exception(JSContext *ctx, const char *name, const char *message) {
    JSValue e = js_new_dom_exception(ctx, name, message);
    return js_is_exception(e) ? e : js_throw(ctx, e);
}

/* new DOMException(message = "", options = "Error") */
BUILTIN(dom_exception_ctor) {
    (void)callee, (void)this_val;
    if (js_is_undefined(new_target)) return js_throw_class_without_new(ctx, "DOMException");
    JSValue message = js_is_undefined(ARG(0)) ? js_empty_string() : js_to_string(ctx, ARG(0));
    if (js_is_exception(message)) return message;
    JSValue name = js_new_string_cstr(ctx, "Error");
    JSValue options = ARG(1);
    bool has_cause = false;
    JSValue cause = JS_UNDEFINED;
    if (js_is_object(options)) {
        JSValue n = js_get_value(ctx, options, JS_ATOM(name));
        if (js_is_exception(n)) return n;
        if (!js_is_undefined(n) && js_is_exception(name = js_to_string(ctx, n))) return JS_EXCEPTION;
        int has = js_has_property(ctx, js_as_object(options), JS_ATOM(cause));
        if (has < 0) return JS_EXCEPTION;
        if (has) {
            has_cause = true;
            cause = js_get_value(ctx, options, JS_ATOM(cause));
            if (js_is_exception(cause)) return cause;
        }
    } else if (!js_is_undefined(options) && js_is_exception(name = js_to_string(ctx, options))) {
        return JS_EXCEPTION;
    }
    JSValue proto = js_get_prototype_from_constructor(ctx, new_target, JS_INTRINSIC_DOM_EXCEPTION_PROTOTYPE);
    if (js_is_exception(proto)) return proto;
    JSValue e = create(ctx, proto, name, message);
    if (!js_is_exception(e) && has_cause) js_define_data(ctx, js_as_object(e), JS_ATOM(cause), cause, JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    return e;
}

#define THIS_DOM_EXCEPTION()                                                                   \
    DOMExceptionObject *e = as_dom_exception(this_val);                                        \
    if (!e) return js_throw_node_error(ctx, JS_TYPE_ERROR, "ERR_INVALID_THIS", "Value of \"this\" must be of DOMException")

BUILTIN(dom_exception_name) {
    UNUSED_ARGS;
    THIS_DOM_EXCEPTION();
    return e->name;
}

BUILTIN(dom_exception_message) {
    UNUSED_ARGS;
    THIS_DOM_EXCEPTION();
    return e->message;
}

BUILTIN(dom_exception_code) {
    UNUSED_ARGS;
    THIS_DOM_EXCEPTION();
    for (size_t i = 0; i < JS_COUNTOF(CODES); i++) {
        JSStrView v = js_string_view(ctx, e->name);
        size_t n = strlen(CODES[i].name);
        if (v.length != n) continue;
        size_t k = 0;
        while (k < n && js_view_at(v, (uint32_t)k) == (uint8_t)CODES[i].name[k]) k++;
        if (k == n) return js_int32(CODES[i].code);
    }
    return js_int32(0);
}

#define CONSTANT(name, value) JS_BUILTIN_NUMBER(name, value, JS_PROP_ENUMERABLE)

#define CONSTANTS                                                                              \
    CONSTANT("INDEX_SIZE_ERR", 1), CONSTANT("DOMSTRING_SIZE_ERR", 2), CONSTANT("HIERARCHY_REQUEST_ERR", 3), \
    CONSTANT("WRONG_DOCUMENT_ERR", 4), CONSTANT("INVALID_CHARACTER_ERR", 5), CONSTANT("NO_DATA_ALLOWED_ERR", 6), \
    CONSTANT("NO_MODIFICATION_ALLOWED_ERR", 7), CONSTANT("NOT_FOUND_ERR", 8), CONSTANT("NOT_SUPPORTED_ERR", 9), \
    CONSTANT("INUSE_ATTRIBUTE_ERR", 10), CONSTANT("INVALID_STATE_ERR", 11), CONSTANT("SYNTAX_ERR", 12), \
    CONSTANT("INVALID_MODIFICATION_ERR", 13), CONSTANT("NAMESPACE_ERR", 14), CONSTANT("INVALID_ACCESS_ERR", 15), \
    CONSTANT("VALIDATION_ERR", 16), CONSTANT("TYPE_MISMATCH_ERR", 17), CONSTANT("SECURITY_ERR", 18), \
    CONSTANT("NETWORK_ERR", 19), CONSTANT("ABORT_ERR", 20), CONSTANT("URL_MISMATCH_ERR", 21), \
    CONSTANT("QUOTA_EXCEEDED_ERR", 22), CONSTANT("TIMEOUT_ERR", 23), CONSTANT("INVALID_NODE_TYPE_ERR", 24), \
    CONSTANT("DATA_CLONE_ERR", 25)

static const JSBuiltin dom_exception_statics[] = { CONSTANTS };

static const JSBuiltin dom_exception_proto[] = {
    WEBIDL_ATTRIBUTE("name", dom_exception_name, NULL),
    WEBIDL_ATTRIBUTE("message", dom_exception_message, NULL),
    WEBIDL_ATTRIBUTE("code", dom_exception_code, NULL),
    CONSTANTS,
    JS_BUILTIN_SYMBOL_STRING(toStringTag, "DOMException", JS_PROP_CONFIGURABLE),
};

static void install_dom_exception(JSContext *ctx, JSObject *global) {
    JSValue proto = js_new_object_proto(ctx, ctx->intrinsics[JS_INTRINSIC_ERROR_PROTOTYPE], 32);
    ctx->intrinsics[JS_INTRINSIC_DOM_EXCEPTION_PROTOTYPE] = proto;
    JSValue key = js_atom_from_cstr(ctx, "DOMException");
    JSValue c = js_new_native(ctx, dom_exception_ctor, key, 0, JS_FN_STRICT | JS_FN_CONSTRUCTOR);
    js_define_builtins(ctx, js_as_object(c), dom_exception_statics, JS_COUNTOF(dom_exception_statics));
    js_define_data(ctx, js_as_object(c), JS_ATOM(prototype), proto, 0);
    js_define_data(ctx, js_as_object(proto), JS_ATOM(constructor), c, JS_BUILTIN_METHOD_ATTRS);
    js_define_builtins(ctx, js_as_object(proto), dom_exception_proto, JS_COUNTOF(dom_exception_proto));
    js_define_data(ctx, global, key, c, JS_BUILTIN_METHOD_ATTRS);
}

const JSComponent js_component_domexception = { "domexception", install_dom_exception };
