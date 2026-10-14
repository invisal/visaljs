/* Exception propagation. */
#include <stdlib.h>
#include <string.h>

#include "js_builtins.h"
#include "js_exception.h"
#include "jsstring.h"
#include "jstest.h"
#include "test_util.h"

#ifndef _WIN32
#include <sys/wait.h>
#include <unistd.h>
#endif

/* Deliberately drops a result: gcc ignores (void) casts on warn_unused_result. */
static void discard(JSValue v) { (void)v; }

static JSRuntime *rt;
static JSContext *ctx;
static void setup(void) {
    rt = js_runtime_new();
    js_use_all_core(rt);
    js_use_all_components(rt);
    ctx = js_context_new(rt);
}
static void teardown(void) {
    js_context_free(ctx);
    js_runtime_free(rt);
}

static int str_is(JSValue s, const char *expected) {
    if (!js_is_string(s)) return 0;
    char buf[256];
    size_t n = js_view_to_utf8(js_string_view(ctx, s), buf, sizeof buf - 1);
    buf[n < sizeof buf ? n : sizeof buf - 1] = '\0';
    return strcmp(buf, expected) == 0;
}

TEST(exc_throw_take) {
    setup();
    CHECK(!js_has_exception(ctx));
    JSValue r = js_throw(ctx, js_int32(42));
    CHECK(js_is_exception(r));
    CHECK(js_has_exception(ctx));
    JSValue e = js_take_exception(ctx);
    CHECK(js_is_int32(e) && js_as_int32(e) == 42);
    CHECK(!js_has_exception(ctx));
    /* any value can be thrown, including undefined */
    r = js_throw(ctx, JS_UNDEFINED);
    CHECK(js_has_exception(ctx));
    CHECK(js_is_undefined(js_take_exception(ctx)));
    teardown();
}

static NOINLINE JSValue throw_fresh_string(void) {
    JSValue s = js_concat(ctx, js_new_string_cstr(ctx, "thrown and "), js_new_string_cstr(ctx, "then collected?"));
    return js_throw(ctx, s);
}

/* The pending exception is a GC root (invariant 4). */
TEST(exc_is_gc_root) {
    setup();
    CHECK(js_is_exception(throw_fresh_string()));
    for (int i = 0; i < 3; i++) js_gc(ctx);
    for (int i = 0; i < 50000; i++) discard(js_new_string_cstr(ctx, "garbage to reuse the freed cells"));
    CHECK(str_is(js_take_exception(ctx), "thrown and then collected?"));
    teardown();
}

TEST(exc_error_helpers) {
    setup();
    CHECK(js_is_exception(js_throw_range_error(ctx, "bad length %d", 7)));
    CHECK(strcmp(take_error_text(ctx), "RangeError: bad length 7") == 0);
    CHECK(js_is_exception(js_throw_type_error(ctx, "%s is not a function", "f")));
    CHECK(strcmp(take_error_text(ctx), "TypeError: f is not a function") == 0);
    CHECK(js_is_exception(js_throw_reference_error(ctx, "x is not defined")));
    CHECK(strcmp(take_error_text(ctx), "ReferenceError: x is not defined") == 0);
    CHECK(js_is_exception(js_throw_syntax_error(ctx, "Unexpected token")));
    CHECK(strcmp(take_error_text(ctx), "SyntaxError: Unexpected token") == 0);
    CHECK(js_is_exception(js_throw_stack_overflow(ctx)));
    JSValue e = js_take_exception(ctx);
    CHECK(js_is_error(e));
    JSValue msg = js_get_value(ctx, e, JS_ATOM(message));
    CHECK(str_is(msg, "Maximum call stack size exceeded"));
    CHECK(js_cell_is_static(js_as_cell(msg)));  /* the only allocation is the error object */
    CHECK(js_string_hash(ctx, msg) != 0);  /* computed, not cached into a static cell */
    teardown();
}

/* Doubling a rope: 16 * 2^26 = 2^30 units is one too many. */
TEST(exc_string_too_long) {
    setup();
    JSValue s = js_new_string_cstr(ctx, "0123456789abcdef");
    int doublings = 0;
    for (;;) {
        JSValue t = js_concat(ctx, s, s);
        if (js_is_exception(t)) break;
        s = t;
        doublings++;
    }
    /* 2^28 fits under JS_STRING_MAX_LENGTH (V8's 2^29 - 24); 2^29 doesn't */
    CHECK_EQ_INT(doublings, 24);
    CHECK_EQ_INT(js_string_length(s), 1 << 28);
    CHECK(strcmp(take_error_text(ctx), "RangeError: Invalid string length") == 0);
    teardown();
}

/* A recursive "generated" function: the prologue check turns runaway
 * recursion into a RangeError instead of a crash. */
static int max_depth;
static NOINLINE JSValue recurse(JSContext *c, int depth) {
    JS_CHECK_STACK(c);
    volatile char frame[128];  /* a realistic frame */
    frame[0] = (char)depth;
    if (depth > max_depth) max_depth = depth;
    JSValue r = recurse(c, depth + 1);
    if (js_is_exception(r)) return JS_EXCEPTION;
    return js_int32(js_as_int32(r) + frame[0]);  /* not a tail call */
}

TEST(exc_stack_overflow) {
    setup();
    max_depth = 0;
    JSValue r = recurse(ctx, 0);
    CHECK(js_is_exception(r));
    CHECK(max_depth > 10000);
    CHECK(strcmp(take_error_text(ctx), "RangeError: Maximum call stack size exceeded") == 0);
    /* and it's recoverable: the stack unwound, so it works again */
    CHECK(js_is_exception(recurse(ctx, 0)));
    CHECK(js_has_exception(ctx));
    discard(js_take_exception(ctx));
    teardown();
}

#if !defined(NDEBUG) && !defined(_WIN32)
/* Runs `fn` in a child process; returns its termination signal (0 if none). */
static int child_signal(void (*fn)(void)) {
    fflush(NULL);
    pid_t pid = fork();
    if (pid == 0) {
        if (!freopen("/dev/null", "w", stderr)) _exit(99);
        fn();
        _exit(0);
    }
    int status = 0;
    waitpid(pid, &status, 0);
    return WIFSIGNALED(status) ? WTERMSIG(status) : 0;
}

static void throw_twice(void) {
    setup();
    discard(js_throw(ctx, js_int32(1)));
    discard(js_throw(ctx, js_int32(2)));  /* the first one was never taken */
}

static void store_exception(void) {
    setup();
    JSValueArray *a = js_alloc_value_array(ctx, 1);
    js_store(ctx, &a->cell, &a->values[0], JS_EXCEPTION);
}

/* Debug builds catch a missed check at the first misuse. */
TEST(exc_debug_assertions) {
    CHECK(child_signal(throw_twice) != 0);
    CHECK(child_signal(store_exception) != 0);
}
#else
TEST(exc_debug_assertions) {}
#endif
