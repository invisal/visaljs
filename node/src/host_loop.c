/* The libuv loop the host modules share: node:http and node:net
 * install it on first use, so programs without I/O don't link libuv. */
#define _POSIX_C_SOURCE 200809L  /* libuv's headers: pthread_rwlock_t, struct addrinfo */
#ifndef _WIN32
#include <signal.h>
#endif

#include "js_exception.h"
#include "js_jobs.h"
#include "js_ops.h"
#include "js_uv.h"
#include "jscontext.h"

static uv_loop_t *loop;
static uv_timer_t wake;      /* ends uv_run at the next timer's deadline; unref'd between runs */
static JSContext *loop_ctx;  /* the realm callbacks run in */
static int failed;           /* exit status after an uncaught error in a callback */
static void (*flush_hook)(void);
static int call_depth;       /* js_uv_calls under way: one made from JS (a fed http parser's) nests */

static void on_wake(uv_timer_t *t) { (void)t; }

static void flush(void) {
    if (flush_hook) flush_hook();
}

static bool io_alive(JSRuntime *rt) {
    (void)rt;
    return !failed && uv_loop_alive(loop);
}

static int io_run(JSContext *ctx, int64_t timeout_ms) {
    loop_ctx = ctx;
    flush();  /* what timers wrote, before waiting */
    if (timeout_ms >= 0) {
        /* ref'd while it runs: uv_run waits for it even when only unref'd handles are open */
        uv_timer_start(&wake, on_wake, (uint64_t)timeout_ms, 0);
        uv_ref((uv_handle_t *)&wake);
    }
    uv_run(loop, UV_RUN_ONCE);
    uv_timer_stop(&wake);
    uv_unref((uv_handle_t *)&wake);
    return failed;
}

static const JSIOBackend uv_backend = { io_alive, io_run };

uv_loop_t *js_uv_loop(JSContext *ctx) {
    if (loop) return loop;
    loop = uv_default_loop();
#ifndef _WIN32
    /* a write to a connection the peer closed fails with EPIPE instead of killing the process,
     * as in Node (which ignores SIGPIPE at startup) */
    signal(SIGPIPE, SIG_IGN);
#endif
    uv_timer_init(loop, &wake);
    uv_unref((uv_handle_t *)&wake);
    loop_ctx = ctx;
    ctx->rt->io = &uv_backend;
    return loop;
}

JSContext *js_uv_context(void) { return loop_ctx; }

void js_uv_set_flush(void (*fn)(void)) { flush_hook = fn; }

bool js_uv_call(JSValue fn, uint32_t argc, JSValue *argv, JSValue *result) {
    if (failed) return false;
    JSContext *ctx = loop_ctx;
    /* under no async context: the prelude binds a callback to the one it was given in */
    JSValue saved = js_async_context(ctx);
    js_set_async_context(ctx, JS_UNDEFINED);
    call_depth++;
    JSValue r = js_call(ctx, fn, JS_UNDEFINED, argc, argv);
    call_depth--;
    js_set_async_context(ctx, saved);
    if (js_is_exception(r)) {
        failed = js_report_uncaught(ctx);
        if (failed) {
            uv_stop(loop);
            return false;
        }
        r = JS_UNDEFINED;  /* handled ('uncaughtException'): the program goes on */
    }
    /* microtasks run, and output goes out, when the outermost callback returns, as in Node: a call
     * made while JS is running (a parser fed from a 'data' listener) leaves them to it */
    if (call_depth > 0) {
        if (result) *result = r;
        return true;
    }
    if (js_run_microtasks(ctx) < 0) {
        failed = ctx->rt->failure;
        uv_stop(loop);
        return false;
    }
    flush();  /* what the callback and its microtasks wrote */
    if (result) *result = r;
    return true;
}
