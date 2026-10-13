/*
 * js_error.h — Error objects (ECMAScript §20.5).
 *
 * An error is an ordinary object of class js_class_error (it has [[ErrorData]]).
 * The js_throw_*_error helpers in js_exception.h create and throw them.
 */
#ifndef JS_ERROR_H
#define JS_ERROR_H

#include "js_function.h"

/* The native errors, in the order of their JS_INTRINSIC_*_PROTOTYPE slots. */
typedef enum JSErrorKind {
    JS_ERROR,
    JS_EVAL_ERROR,
    JS_RANGE_ERROR,
    JS_REFERENCE_ERROR,
    JS_SYNTAX_ERROR,
    JS_TYPE_ERROR,
    JS_URI_ERROR,
    JS_AGGREGATE_ERROR,  /* §20.5.7: its constructor takes the errors first */
    JS_ERROR_KIND_COUNT
} JSErrorKind;

extern const JSClass js_class_error;

static inline bool js_is_error(JSValue v) {
    return js_is_object(v) && js_as_object(v)->shape->cls == &js_class_error;
}

/* A new error of `kind` in ctx's realm; `message` is a string, or undefined for none. */
JSValue js_new_error(JSContext *ctx, JSErrorKind kind, JSValue message);

/* Error.prototype.toString on any object: "name: message", either part omitted when empty. */
JS_WARN_UNUSED JSValue js_error_to_string(JSContext *ctx, JSValue o);

#endif /* JS_ERROR_H */
