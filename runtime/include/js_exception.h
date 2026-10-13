/*
 * js_exception.h — exception propagation.
 *
 * A function that fails returns JS_EXCEPTION (or < 0 for int results) and
 * leaves the error in ctx->rt->exception. Callers check and propagate.
 *
 * The js_throw_*_error helpers create an Error object of the calling realm
 * (js_error.h) with the formatted message, and throw it.
 */
#ifndef JS_EXCEPTION_H
#define JS_EXCEPTION_H

#include <assert.h>
#include <stdbool.h>

#include "jscontext.h"

/* ---- Throwing: set the pending exception, return JS_EXCEPTION ---------- */

/* Prints "jsrt: fatal: <message>" in one write and exits with status 70 (out of memory, broken
 * invariants). Public for host packages (node/). */
_Noreturn void js_fatal(const char *fmt, ...);

JS_WARN_UNUSED JSValue js_throw(JSContext *ctx, JSValue error);
JS_WARN_UNUSED JSValue js_throw_type_error(JSContext *ctx, const char *fmt, ...);
JS_WARN_UNUSED JSValue js_throw_range_error(JSContext *ctx, const char *fmt, ...);
JS_WARN_UNUSED JSValue js_throw_reference_error(JSContext *ctx, const char *fmt, ...);
JS_WARN_UNUSED JSValue js_throw_syntax_error(JSContext *ctx, const char *fmt, ...);
JS_WARN_UNUSED JSValue js_throw_uri_error(JSContext *ctx, const char *fmt, ...);
JS_WARN_UNUSED JSValue js_throw_stack_overflow(JSContext *ctx);  /* RangeError: Maximum call stack size exceeded */

/* ---- Catching ---------------------------------------------------------- */

/* Returns the pending error and clears it. A catch or finally calls this first. */
JSValue js_take_exception(JSContext *ctx);

static inline bool js_has_exception(const JSContext *ctx) {
    return !js_is_empty(ctx->rt->exception);
}

/* For hand-written runtime code; generated code writes the check itself. */
#define JS_RETURN_IF_EXC(v) \
    do { if (js_is_exception(v)) return JS_EXCEPTION; } while (0)

/* Debug builds: a JS_EXCEPTION received as an argument means a missed check upstream. */
#define JS_ASSERT_NOT_EXC(v) assert(!js_is_exception(v) && "missed exception check")

/* ---- Stack overflow ---------------------------------------------------- */

#if defined(_MSC_VER) && !defined(__clang__)
#include <intrin.h>
#define JS_FRAME_ADDRESS() ((uintptr_t)_AddressOfReturnAddress())
#else
#define JS_FRAME_ADDRESS() ((uintptr_t)__builtin_frame_address(0))
#endif

/* At the entry of every non-leaf generated function, and of runtime code
 * that recurses on user data. */
#define JS_CHECK_STACK(ctx)                                                   \
    do {                                                                      \
        if (JS_UNLIKELY(JS_FRAME_ADDRESS() < (ctx)->stack_limit))             \
            return js_throw_stack_overflow(ctx);                              \
    } while (0)

/* After every direct call between generated functions: the call is then never the caller's last
 * action, so C compilers keep it a call. Turned into a jump (tail-call elimination), JS
 * recursion would run in constant stack, and unbounded recursion would loop forever instead of
 * throwing a RangeError at the stack limit. */
#if defined(_MSC_VER) && !defined(__clang__)
#define JS_NO_TAIL_CALL() _ReadWriteBarrier()
#else
#define JS_NO_TAIL_CALL() __asm__ volatile("" ::: "memory")
#endif

/* The same in a function returning `fail` (a double or a bool: generated code's unboxed direct
 * entries): the caller sees the pending exception. */
#define JS_CHECK_STACK_OR(ctx, fail)                                          \
    do {                                                                      \
        if (JS_UNLIKELY(JS_FRAME_ADDRESS() < (ctx)->stack_limit)) {           \
            js_discard(js_throw_stack_overflow(ctx));                         \
            return (fail);                                                    \
        }                                                                     \
    } while (0)

#endif /* JS_EXCEPTION_H */
