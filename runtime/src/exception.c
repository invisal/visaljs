/* Exception propagation. */
#include "js_exception.h"

#include <stdarg.h>
#include <stdio.h>

#include "js_error.h"
#include "jsstring.h"

JSValue js_throw(JSContext *ctx, JSValue error) {
    JS_ASSERT_NOT_EXC(error);
    assert(!js_has_exception(ctx) && "js_throw while an exception is pending");
    ctx->rt->exception = error;  /* a root, not a heap cell: no barrier */
    return JS_EXCEPTION;
}

JSValue js_take_exception(JSContext *ctx) {
    assert(js_has_exception(ctx) && "js_take_exception with nothing pending");
    JSValue e = ctx->rt->exception;
    ctx->rt->exception = JS_EMPTY;
    return js_is_empty(e) ? JS_UNDEFINED : e;
}

/* A new error of `kind` with the formatted message, thrown. */
static JSValue throw_error(JSContext *ctx, JSErrorKind kind, const char *fmt, va_list ap) {
    char msg[512];
    vsnprintf(msg, sizeof msg, fmt, ap);
    JSValue s = js_new_string_cstr(ctx, msg);
    if (js_is_exception(s)) return JS_EXCEPTION;
    return js_throw(ctx, js_new_error(ctx, kind, s));
}

#define DEFINE_THROW(fn, kind)                                    \
    JSValue fn(JSContext *ctx, const char *fmt, ...) {            \
        va_list ap;                                               \
        va_start(ap, fmt);                                        \
        JSValue r = throw_error(ctx, kind, fmt, ap);              \
        va_end(ap);                                               \
        return r;                                                 \
    }

DEFINE_THROW(js_throw_type_error, JS_TYPE_ERROR)
DEFINE_THROW(js_throw_range_error, JS_RANGE_ERROR)
DEFINE_THROW(js_throw_reference_error, JS_REFERENCE_ERROR)
DEFINE_THROW(js_throw_syntax_error, JS_SYNTAX_ERROR)
DEFINE_THROW(js_throw_uri_error, JS_URI_ERROR)

#define STACK_OVERFLOW_MSG "Maximum call stack size exceeded"

static const JS_STATIC_LATIN1_TYPE(sizeof STACK_OVERFLOW_MSG - 1) stack_overflow_msg =
    JS_STATIC_LATIN1_INIT(sizeof STACK_OVERFLOW_MSG - 1, 0, STACK_OVERFLOW_MSG);

/* Runs in the stack margin (JS_STACK_MARGIN): a fresh RangeError, whose message is static. */
JSValue js_throw_stack_overflow(JSContext *ctx) {
    return js_throw(ctx, js_new_error(ctx, JS_RANGE_ERROR, JS_STATIC_STR(stack_overflow_msg)));
}
